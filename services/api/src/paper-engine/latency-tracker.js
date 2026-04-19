// @ts-nocheck
// ── Rolling median tracker ──────────────────────────────────────────
const WINDOW_SIZE = 50; // rolling window for median computation
const samples = [];
const alerts = [];
function percentile(arr, p) {
    if (arr.length === 0)
        return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}
function rollingMedian(values) {
    return percentile(values, 50);
}
function addSample(sample) {
    samples.push(sample);
    if (samples.length > 5000)
        samples.splice(0, samples.length - 5000); // bound memory
    checkDrift(sample);
}
function checkDrift(sample) {
    const key = `${sample.venue}:${sample.symbol}`;
    const recent = samples.filter(s => s.venue === sample.venue && s.symbol === sample.symbol);
    if (recent.length < 5)
        return; // need min samples for baseline
    const s2sValues = recent.slice(0, -1).map(s => s.signalToSubmitMs);
    const s2fValues = recent.slice(0, -1).map(s => s.signalToFillMs);
    const s2sMedian = rollingMedian(s2sValues);
    const s2fMedian = rollingMedian(s2fValues);
    // Alert: current sample > 2× median AND > 500ms
    const s2sDrift = s2sMedian > 0 && sample.signalToSubmitMs > 2 * s2sMedian && sample.signalToSubmitMs > 500;
    const s2fDrift = s2fMedian > 0 && sample.signalToFillMs > 2 * s2fMedian && sample.signalToFillMs > 500;
    if (s2sDrift) {
        const msg = `[LATENCY-ALERT] ${key}: signal→submit ${sample.signalToSubmitMs}ms (2×median=${Math.round(s2sMedian)}ms) — DRIFT DETECTED`;
        console.warn(msg);
        alerts.unshift(msg);
    }
    if (s2fDrift) {
        const msg = `[LATENCY-ALERT] ${key}: signal→fill ${sample.signalToFillMs}ms (2×median=${Math.round(s2fMedian)}ms) — DRIFT DETECTED`;
        console.warn(msg);
        alerts.unshift(msg);
    }
    if (alerts.length > 100)
        alerts.splice(100);
}
function buildBucket(venue, symbol) {
    const bucket = samples.filter(s => s.venue === venue && s.symbol === symbol);
    const s2s = bucket.map(s => s.signalToSubmitMs);
    const s2f = bucket.map(s => s.signalToFillMs);
    return {
        venue,
        symbol,
        count: bucket.length,
        signalToSubmitMsP50: percentile(s2s, 50),
        signalToSubmitMsP90: percentile(s2s, 90),
        signalToSubmitMsP99: percentile(s2s, 99),
        submitToFillMsP50: 0,
        submitToFillMsP90: 0,
        submitToFillMsP99: 0,
        signalToFillMsP50: percentile(s2f, 50),
        signalToFillMsP90: percentile(s2f, 90),
        signalToFillMsP99: percentile(s2f, 99),
    };
}
export function recordLatency(sample) {
    addSample(sample);
}
export function getLatencyReport() {
    const venues = [...new Set(samples.map(s => s.venue))];
    const symbols = [...new Set(samples.map(s => s.symbol))];
    const buckets = [];
    for (const venue of venues) {
        for (const symbol of symbols) {
            const bucketSamples = samples.filter(s => s.venue === venue && s.symbol === symbol);
            if (bucketSamples.length > 0) {
                buckets.push(buildBucket(venue, symbol));
            }
        }
    }
    return {
        asOf: new Date().toISOString(),
        buckets,
        totalSamples: samples.length,
        alerts: alerts.slice(0, 20), // last 20 alerts
    };
}
export function getLatencySamples() {
    return [...samples];
}
// ── Pending signal map: tracks signalAt per agent for broker-paper entries ──
// Key: agentId|symbol — cleared when fill is acknowledged
const pendingSignalAt = new Map();
export function setPendingSignal(agentId, symbol, signalAt) {
    pendingSignalAt.set(`${agentId}|${symbol}`, { signalAt, venue: 'unknown', symbol });
}
export function getAndClearPendingSignal(agentId, symbol) {
    const key = `${agentId}|${symbol}`;
    const val = pendingSignalAt.get(key);
    pendingSignalAt.delete(key);
    return val ?? null;
}
export function setPendingVenue(agentId, symbol, venue) {
    const key = `${agentId}|${symbol}`;
    const existing = pendingSignalAt.get(key);
    if (existing) {
        pendingSignalAt.set(key, { ...existing, venue });
    }
}
