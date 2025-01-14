import { v4 as uuidv4 } from "uuid";
import { StableBTreeMap, ic } from "azle";
import express from "express";
import rateLimit from 'express-rate-limit';

/**
 * @title Maternal Health Tracking System
 * @description A comprehensive system for tracking maternal health data and managing prenatal care
 * @version 1.0.0
 */

// Enums with comprehensive documentation
export enum RiskLevel {
    LOW = "LOW",       // Regular monitoring needed
    MEDIUM = "MEDIUM", // Increased monitoring required
    HIGH = "HIGH",     // Immediate medical attention needed
}

export enum Trimester {
    FIRST = "FIRST",   // Weeks 1-12
    SECOND = "SECOND", // Weeks 13-26
    THIRD = "THIRD",   // Weeks 27-40
}

// Interfaces with proper validation constraints
interface HealthcareProvider {
    id: string;
    name: string;
    specialization: string;
    licenseNumber: string;
    contactInfo: string;
    facilityId: string;
    isActive: boolean;       // Track active status of provider
    lastUpdated: bigint;
}

interface MaternalProfile {
    id: string;
    name: string;
    age: number;
    bloodType: string;
    emergencyContact: string;
    dueDate: bigint;
    currentTrimester: Trimester;
    riskLevel: RiskLevel;
    primaryCareProviderId: string;
    createdAt: bigint;
    lastUpdated: bigint;
    medicalHistory: string[];    // Added to track medical history
    allergies: string[];         // Added for allergy tracking
    isHighRiskPregnancy: boolean;
}

interface HealthMetrics {
    id: string;
    maternalProfileId: string;
    recordedAt: bigint;
    weight: number;
    bloodPressureSystolic: number;
    bloodPressureDiastolic: number;
    bloodSugar: number;
    hemoglobinLevels: number;
    fetalHeartRate: number | null;
    notes: string;
    recordedById: string;    // ID of healthcare provider who recorded metrics
    isFlaggedForReview: boolean;
}

interface PrenatalVisit {
    id: string;
    maternalProfileId: string;
    providerId: string;
    scheduledDate: bigint;
    completed: boolean;
    visitType: string;
    findings: string;
    recommendations: string;
    nextVisitDate: bigint | null;
    prescriptions: string[];     // Added to track medications
    followUpRequired: boolean;
    cancellationReason?: string;
}

interface HealthAlert {
    id: string;
    maternalProfileId: string;
    createdAt: bigint;
    severity: RiskLevel;
    description: string;
    recommendedAction: string;
    resolved: boolean;
    resolvedAt: bigint | null;
    providerId: string;
    resolutionNotes?: string;
    escalationLevel: number;     // 1-3 for alert escalation tracking
}

// Initialize storage with proper error handling
const maternalProfileStorage = StableBTreeMap<string, MaternalProfile>(0);
const providerStorage = StableBTreeMap<string, HealthcareProvider>(1);
const metricsStorage = StableBTreeMap<string, HealthMetrics>(2);
const visitStorage = StableBTreeMap<string, PrenatalVisit>(3);
const alertStorage = StableBTreeMap<string, HealthAlert>(4);

// Input validation functions
function sanitizeString(input: string): string {
    return input.replace(/[<>]/g, ''); // Basic XSS prevention
}

function validateProfile(profile: Partial<MaternalProfile>): string | null {
    if (!profile.name || profile.name.trim().length < 2 || profile.name.length > 100) {
        return "Name must be between 2 and 100 characters";
    }
    
    if (profile.medicalHistory?.some(history => history.length > 1000)) {
        return "Medical history entries cannot exceed 1000 characters";
    }
    
    if (!profile.age || profile.age < 16 || profile.age > 60) {
        return "Age must be between 16 and 60";
    }
    if (!profile.bloodType || !["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].includes(profile.bloodType)) {
        return "Invalid blood type";
    }
    return null;
}

function validateHealthMetrics(metrics: Partial<HealthMetrics>): string | null {
    if (metrics.bloodPressureSystolic && (metrics.bloodPressureSystolic < 70 || metrics.bloodPressureSystolic > 190)) {
        return "Invalid systolic blood pressure range";
    }
    if (metrics.bloodPressureDiastolic && (metrics.bloodPressureDiastolic < 40 || metrics.bloodPressureDiastolic > 120)) {
        return "Invalid diastolic blood pressure range";
    }
    if (metrics.bloodSugar && (metrics.bloodSugar < 30 || metrics.bloodSugar > 500)) {
        return "Invalid blood sugar range";
    }
    return null;
}

// Express app setup with error handling
const app = express();
app.use(express.json());

// Fix time conversion constant
const NANOS_PER_MILLISECOND = 1_000_000n;

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

app.use(limiter);

// Enhanced route handlers with validation and error handling
app.post("/maternal-profiles", (req, res) => {
    try {
        // Sanitize string inputs
        if (req.body.name) {
            req.body.name = sanitizeString(req.body.name);
        }
        if (req.body.emergencyContact) {
            req.body.emergencyContact = sanitizeString(req.body.emergencyContact);
        }

        const validationError = validateProfile(req.body);
        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        const providerOpt = providerStorage.get(req.body.primaryCareProviderId);
        if (!providerOpt || "None" in providerOpt) {
            return res.status(404).json({ error: "Healthcare provider not found" });
        }

        const provider = providerOpt.Some;
        if (!provider.isActive) {
            return res.status(400).json({ error: "Selected healthcare provider is not active" });
        }

        const profile: MaternalProfile = {
            id: uuidv4(),
            createdAt: BigInt(ic.time()),
            lastUpdated: BigInt(ic.time()),
            currentTrimester: Trimester.FIRST,
            riskLevel: RiskLevel.LOW,
            medicalHistory: [],
            allergies: [],
            isHighRiskPregnancy: false,
            ...req.body,
            dueDate: BigInt(new Date(req.body.dueDate).getTime()) * NANOS_PER_MILLISECOND,
        };

        maternalProfileStorage.insert(profile.id, profile);
        res.json(serializeProfile(profile));
    } catch (error) {
        console.error('Error creating maternal profile:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Add maternal profile verification in health metrics
app.post("/health-metrics", (req, res) => {
    try {
        const profileOpt = maternalProfileStorage.get(req.body.maternalProfileId);
        if (!profileOpt || "None" in profileOpt) {
            return res.status(404).json({ error: "Maternal profile not found" });
        }

        const validationError = validateHealthMetrics(req.body);
        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        const metrics: HealthMetrics = {
            id: uuidv4(),
            recordedAt: BigInt(ic.time()),
            isFlaggedForReview: false,
            ...req.body
        };

        // Automated risk assessment
        const isHighRisk = assessRisk(metrics);
        if (isHighRisk) {
            metrics.isFlaggedForReview = true;
            createHighRiskAlert(metrics);
        }

        metricsStorage.insert(metrics.id, metrics);
        res.json(serializeMetrics(metrics));
    } catch (error) {
        console.error('Error recording health metrics:', error);
        res.status(500).json({ error: "Failed to record health metrics" });
    }
});

// Helper Functions
function assessRisk(metrics: HealthMetrics): boolean {
    return (
        metrics.bloodPressureSystolic >= 140 ||
        metrics.bloodPressureDiastolic >= 90 ||
        metrics.bloodSugar > 140 ||
        metrics.hemoglobinLevels < 9
    );
}

function createHighRiskAlert(metrics: HealthMetrics): void {
    const alert: HealthAlert = {
        id: uuidv4(),
        maternalProfileId: metrics.maternalProfileId,
        createdAt: BigInt(ic.time()),
        severity: RiskLevel.HIGH,
        description: "Abnormal health metrics detected",
        recommendedAction: "Immediate medical review required",
        resolved: false,
        resolvedAt: null,
        providerId: metrics.recordedById,
        escalationLevel: 1
    };

    alertStorage.insert(alert.id, alert);
}

// Improve serialize functions with safe date handling
function serializeProfile(profile: MaternalProfile) {
    try {
        return {
            ...profile,
            dueDate: new Date(Number(profile.dueDate / NANOS_PER_MILLISECOND)).toISOString(),
            createdAt: new Date(Number(profile.createdAt / NANOS_PER_MILLISECOND)).toISOString(),
            lastUpdated: new Date(Number(profile.lastUpdated / NANOS_PER_MILLISECOND)).toISOString(),
        };
    } catch (error) {
        console.error('Error serializing profile:', error);
        return {
            ...profile,
            dueDate: "Invalid Date",
            createdAt: "Invalid Date",
            lastUpdated: "Invalid Date"
        };
    }
}

function serializeMetrics(metrics: HealthMetrics) {
    try {
        return {
            ...metrics,
            recordedAt: new Date(Number(metrics.recordedAt / NANOS_PER_MILLISECOND)).toISOString()
        };
    } catch (error) {
        console.error('Error serializing metrics:', error);
        throw new Error('Failed to serialize metrics data');
    }
}

function serializeVisit(visit: PrenatalVisit) {
    try {
        return {
            ...visit,
            scheduledDate: new Date(Number(visit.scheduledDate / NANOS_PER_MILLISECOND)).toISOString(),
            nextVisitDate: visit.nextVisitDate
                ? new Date(Number(visit.nextVisitDate / NANOS_PER_MILLISECOND)).toISOString()
                : null
        };
    } catch (error) {
        console.error('Error serializing visit:', error);
        throw new Error('Failed to serialize visit data');
    }
}

function serializeAlert(alert: HealthAlert) {
    try {
        return {
            ...alert,
            createdAt: new Date(Number(alert.createdAt / NANOS_PER_MILLISECOND)).toISOString(),
            resolvedAt: alert.resolvedAt
                ? new Date(Number(alert.resolvedAt / NANOS_PER_MILLISECOND)).toISOString()
                : null
        };
    } catch (error) {
        console.error('Error serializing alert:', error);
        throw new Error('Failed to serialize alert data');
    }
}

app.get("/maternal-profiles", (req, res) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 10;
        const skip = (page - 1) * limit;
        
        const profiles = Array.from(maternalProfileStorage.values())
            .slice(skip, skip + limit)
            .map(serializeProfile);
            
        res.json({
            data: profiles,
            page,
            limit,
            total: maternalProfileStorage.len()
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch profiles" });
    }
});

app.listen();

export default app;