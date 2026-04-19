/**
 * Meta-Label Model Service
 *
 * Loads and runs the Phase 3 meta-label model as a 7th council voter.
 * Pure-TS logistic regression inference (no external deps).
 */
import fs from 'node:fs';
import path from 'node:path';
const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const DEFAULT_MODEL_PATH = process.env.META_LABEL_MODEL_PATH
    ?? path.resolve(WORKSPACE_ROOT, 'services/api/.runtime/paper-ledger/meta-label-model.json');
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_CALLS_PER_WINDOW = 10;
const MODEL_RELOAD_INTERVAL_MS = 60 * 60 * 1000; // 60 min
/** Sigmoid function for logistic regression */
function sigmoid(z) {
    if (z > 20)
        return 0.999999999;
    if (z < -20)
        return 0.000000001;
    return 1 / (1 + Math.exp(-z));
}
/** Standardize a feature vector */
function standardize(features, means, stds) {
    return features.map((f, i) => (f - means[i]) / stds[i]);
}
export class MetaLabelModel {
    model = null;
    modelPath;
    lastLoadAttempt = 0;
    loadCooldownMs = 10_000;
    callTimestamps = [];
    reloadInterval = null;
    constructor(modelPath = DEFAULT_MODEL_PATH) {
        this.modelPath = modelPath;
    }
    /** Load model from JSON file */
    async load(modelPath) {
        if (modelPath)
            this.modelPath = modelPath;
        const now = Date.now();
        if (now - this.lastLoadAttempt < this.loadCooldownMs) {
            return this.model !== null;
        }
        this.lastLoadAttempt = now;
        try {
            if (!fs.existsSync(this.modelPath)) {
                console.log('[meta-label-model] model file not found:', this.modelPath);
                return false;
            }
            const content = fs.readFileSync(this.modelPath, 'utf8');
            this.model = JSON.parse(content);
            console.log(`[meta-label-model] loaded v${this.model.version} (${this.model.samples} samples, test acc ${(this.model.testAccuracy * 100).toFixed(1)}%)`);
            return true;
        }
        catch (error) {
            console.error('[meta-label-model] load failed:', error instanceof Error ? error.message : error);
            return false;
        }
    }
    /** Lazy load on first predict if not loaded */
    async ensureLoaded() {
        if (this.model)
            return true;
        return this.load();
    }
    /** Start auto-reload interval */
    startAutoReload() {
        if (this.reloadInterval)
            return;
        this.reloadInterval = setInterval(() => {
            void this.load();
        }, MODEL_RELOAD_INTERVAL_MS);
    }
    stopAutoReload() {
        if (this.reloadInterval) {
            clearInterval(this.reloadInterval);
            this.reloadInterval = null;
        }
    }
    /** Check if model is trained and loaded */
    isReady() {
        return this.model !== null;
    }
    /** Get model metadata */
    getMetadata() {
        if (!this.model)
            return { trained: false };
        return {
            trained: true,
            version: this.model.version,
            trainedAt: this.model.trainedAt,
            samples: this.model.samples,
            testAccuracy: this.model.testAccuracy,
        };
    }
    /** Internal rate limit check */
    checkRateLimit() {
        const now = Date.now();
        const windowStart = now - RATE_LIMIT_WINDOW_MS;
        this.callTimestamps = this.callTimestamps.filter((ts) => ts > windowStart);
        if (this.callTimestamps.length >= MAX_CALLS_PER_WINDOW) {
            return true;
        }
        this.callTimestamps.push(now);
        return false;
    }
    /** Predict on raw features */
    async predict(features) {
        if (this.checkRateLimit()) {
            return { label: 0, probability: 0.5 };
        }
        if (!(await this.ensureLoaded())) {
            return { label: 0, probability: 0.5 };
        }
        const m = this.model;
        const rawFeatures = [
            features.holdTicks,
            features.entryConfidence,
            features.sessionQuality,
            features.regime,
            features.realizedCostBps,
        ];
        const x = standardize(rawFeatures, m.featureMeans, m.featureStds);
        const z = m.coefficients[0] + x.reduce((s, xi, i) => s + m.coefficients[i + 1] * xi, 0);
        const prob = sigmoid(z);
        // Map probability to label
        let label;
        if (prob >= 0.6)
            label = 1;
        else if (prob <= 0.4)
            label = -1;
        else
            label = 0;
        return { label, probability: prob };
    }
    /** Feature engineer from a trade candidate */
    engineerFeatures(candidate) {
        // Map candidate fields to model features
        // holdTicks: estimate from mediumReturnPct vs shortReturnPct
        const holdTicks = Math.round(Math.abs(candidate.mediumReturnPct - candidate.shortReturnPct) * 10);
        // entryConfidence: from score normalized to 0-1
        const entryConfidence = Math.max(0, Math.min(1, candidate.score / 10));
        // sessionQuality: placeholder (would come from market intel in production)
        const sessionQuality = 0.5;
        // regime: 0 = unknown (would come from strategy director)
        const regime = 0;
        // realizedCostBps: placeholder at entry time (available only at exit in journal)
        const realizedCostBps = 0;
        return { holdTicks, entryConfidence, sessionQuality, regime, realizedCostBps };
    }
    /** Score a candidate and return a council-shaped vote */
    async scoreCandidate(candidate) {
        const start = Date.now();
        const features = this.engineerFeatures(candidate);
        if (!this.isReady()) {
            return {
                provider: 'meta-label',
                source: 'rules',
                action: 'review',
                confidence: 0,
                thesis: 'Meta-label model not trained yet.',
                riskNote: 'Insufficient TP/SL barrier hits in trade journal.',
                latencyMs: Date.now() - start,
                timestamp: new Date().toISOString(),
            };
        }
        const pred = await this.predict(features);
        const meta = this.getMetadata();
        // Map model output to council action
        let action;
        let confidence;
        let thesis;
        let riskNote;
        if (pred.label === 1) {
            action = 'approve';
            confidence = Math.round(pred.probability * 100);
            thesis = `Meta-label model predicts +1 (${confidence}% confidence). Historical TP/SL barriers favor this trade setup.`;
            riskNote = `Model trained on ${meta.samples} samples, ${((meta.testAccuracy ?? 0) * 100).toFixed(1)}% test accuracy.`;
        }
        else if (pred.label === -1) {
            action = 'reject';
            confidence = Math.round((1 - pred.probability) * 100);
            thesis = `Meta-label model predicts -1 (${confidence}% confidence). Historical TP/SL barriers suggest this trade may not hold.`;
            riskNote = `Model trained on ${meta.samples} samples, ${((meta.testAccuracy ?? 0) * 100).toFixed(1)}% test accuracy.`;
        }
        else {
            action = 'review';
            confidence = 50;
            thesis = 'Meta-label model is uncertain (boundary case). Requires human judgment.';
            riskNote = 'Model confidence too low to make a strong recommendation.';
        }
        return {
            provider: 'meta-label',
            source: 'rules',
            action,
            confidence,
            thesis,
            riskNote,
            latencyMs: Date.now() - start,
            timestamp: new Date().toISOString(),
        };
    }
    /** Evaluate interface matching RateAwareProvider */
    async evaluate(candidate, _decisionId) {
        return this.scoreCandidate(candidate);
    }
    getRole() {
        return 'meta-label';
    }
    isRateLimited() {
        return this.checkRateLimit();
    }
}
// Singleton instance
let instance = null;
export function getMetaLabelModel() {
    if (!instance) {
        instance = new MetaLabelModel();
    }
    return instance;
}
