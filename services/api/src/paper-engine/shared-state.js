/**
 * Shared Engine State
 *
 * Centralized mutable state shared across all sub-engines.
 * This is the single source of truth — sub-engines read and write to this.
 */
export class SharedState {
    tick = 0;
    market = new Map();
    agents = new Map();
    fills = [];
    journal = [];
    deskCurve = [];
    benchmarkCurve = [];
    // Broker account snapshots
    brokerPaperAccount = null;
    brokerOandaAccount = null;
    brokerCoinbaseAccount = null;
    // Scalp route planning
    scalpRouteCandidates = new Map();
    selectedScalpOverallId = null;
    selectedScalpByAssetClass = new Map();
    // Risk controls
    symbolGuards = new Map();
    // COO: Track engine startup time for circuit breaker warmup grace period
    startedAt = new Date().toISOString();
    circuitBreakerLatched = false;
    circuitBreakerScope = 'none';
    circuitBreakerReason = '';
    circuitBreakerArmedAt = null;
    circuitBreakerReviewed = false;
    operationalKillSwitchUntilMs = 0;
    // Performance tracking
    regimeKpis = [];
    latestSlo = { dataFreshnessP95Ms: 0, orderAckP95Ms: 0, brokerErrorRatePct: 0, breaches: [] };
    walkForwardResults = new Map();
    forensicRows = [];
    executionQuality = new Map();
    latestWeeklyReport = null;
    // Market data sources
    marketDataSources = [];
    // Replay / strategy state
    strategyReplayTick = 0;
    stepInFlight = false;
    // File write queue
    fileQueues = new Map();
    // Coinbase fee tier downgrade guard — set when makerBps >= takerBps
    // All maker strategy quoting is gated on this flag.
    makerStrategiesBlocked = false;
    makerBlockReason = '';
}
