// @ts-nocheck
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAiCouncil } from './ai-council.js';
import { getSignalBus } from './signal-bus.js';
import { getMarketIntel } from './market-intel.js';
import { getNewsIntel } from './news-intel.js';
import { getEventCalendar } from './event-calendar.js';
import { getInsiderRadar } from './insider-radar.js';
import { getDerivativesIntel } from './derivatives-intel.js';
import { getFeatureStore } from './feature-store.js';
import { redis, TOPICS } from '@hermes/infra';
import { logger } from '@hermes/logger';
import Redis from 'ioredis';
import { buildAgentConfigs, getDefaultAgentConfig, withAgentConfigDefaults } from './paper-engine-config.js';
import { buildMetaLabelModelSnapshot, predictMetaLabel, predictWithModel, buildModel } from './meta-label-model.js';
import { asRecord, average, clamp, formatAgo, normalizeArray, nudge, numberField, pickLast, readJsonLines, round, textField } from './paper-engine-utils.js';
import { estimateExpectedNetEdgeBps, estimateExpectedGrossEdgeBps, estimateRoundTripCostBps, inferAssetClassFromSymbol } from './fee-model.js';
import { evaluateKpiGate } from './kpi-gates.js';
import { seedFromBrokerHistory as seedFromBrokerHistoryFn, reconcileBrokerPaperState as reconcileBrokerPaperStateFn, syncBrokerPositionIntoAgent as syncBrokerPositionIntoAgentFn, routeBrokerOrder as routeBrokerOrderFn, openBrokerPaperPosition as openBrokerPaperPositionFn, closeBrokerPaperPosition as closeBrokerPaperPositionFn, applyBrokerFilledEntry as applyBrokerFilledEntryFn, applyBrokerFilledExit as applyBrokerFilledExitFn, fetchBrokerAccount as fetchBrokerAccountFn, finalizeBrokerFlat as finalizeBrokerFlatFn, handleAsyncOrderStatus as handleAsyncOrderStatusFn, recentlyExpiredOrderIds } from './paper-engine/engine-broker.js';
import { repatriateOrphanedBrokerPositions } from './paper-engine/broker-repatriation.js';
import { canEnter as canEnterFn, refreshScalpRoutePlan as refreshScalpRoutePlanFn, getMetaLabelDecision as getMetaLabelDecisionFn, getContextualMetaSignal as getContextualMetaSignalFn, buildEntryMeta as buildEntryMetaFn, buildMetaCandidate as buildMetaCandidateFn, buildJournalContext as buildJournalContextFn, getRouteBlock as getRouteBlockFn, getPrecisionBlock as getPrecisionBlockFn, getManagerBlock as getManagerBlockFn, describeWatchState as describeWatchStateFn, describeAiState as describeAiStateFn, normalizeFlowBucket as normalizeFlowBucketFn, getConfidenceBucket as getConfidenceBucketFn, getSpreadBucket as getSpreadBucketFn, entryNote as entryNoteFn, getEntryScore as getEntryScoreFn, entryThreshold as entryThresholdFn, exitThreshold as exitThresholdFn, estimatedBrokerRoundTripCostBps as estimatedBrokerRoundTripCostBpsFn, fastPathThreshold as fastPathThresholdFn, brokerRulesFastPathThreshold as brokerRulesFastPathThresholdFn, canUseBrokerRulesFastPath as canUseBrokerRulesFastPathFn } from './paper-engine/engine-entry.js';
import { recordLatency as recordLatencyFn, getLatencyReport as getLatencyReportFn, setPendingSignal as setPendingSignalFn } from './paper-engine/latency-tracker.js';
import { getExecutionQualityByBroker as getExecutionQualityByBrokerFn, formatBrokerLabel as formatBrokerLabelFn, buildMarketTape as buildMarketTapeFn, analyzeSignals as analyzeSignalsFn, getDataSources as getDataSourcesFn, toLiveReadiness as toLiveReadinessFn, getLiveReadinessReport as getLiveReadinessReportFn, toAgentSnapshot as toAgentSnapshotFn, getPositions as getPositionsFn, getRiskControlSnapshot as getRiskControlSnapshotFn, getDeskAgentStates as getDeskAgentStatesFn, getVisibleFills as getVisibleFillsFn, getDeskStartingEquity as getDeskStartingEquityFn, getDeskEquity as getDeskEquityFn, getSnapshot as getSnapshotFn, getMarketSnapshots as getMarketSnapshotsFn, getOpportunitySnapshot as getOpportunitySnapshotFn, getWalkForwardSnapshot as getWalkForwardSnapshotFn, getLossForensics as getLossForensicsFn, getMetaLabelSnapshot as getMetaLabelSnapshotFn, hasTradableTape as hasTradableTapeFn, describeTapeFlags as describeTapeFlagsFn, toCandles as toCandlesFn, normalizePresentationState as normalizePresentationStateFn } from './paper-engine/engine-views.js';
import { step as stepFn, updateAgent as updateAgentFn, manageOpenPosition as manageOpenPositionFn, openPosition as openPositionFn, closePosition as closePositionFn, updateArbAgent as updateArbAgentFn, getPositionDirection as getPositionDirectionFn, getPositionUnrealizedPnl as getPositionUnrealizedPnlFn, maybeTrailBrokerStop as maybeTrailBrokerStopFn, getFeeRate as getFeeRateFn, roundTripFeeBps as roundTripFeeBpsFn, computeDynamicStop as computeDynamicStopFn, computeDynamicTarget as computeDynamicTargetFn, resolveEntryDirection as resolveEntryDirectionFn, computeGrossPnl as computeGrossPnlFn, getSessionBucket as getSessionBucketFn, getVolatilityBucket as getVolatilityBucketFn, noteTradeOutcome as noteTradeOutcomeFn, getAgentNetPnl as getAgentNetPnlFn, getAgentEquity as getAgentEquityFn, getBenchmarkEquity as getBenchmarkEquityFn, getEffectiveLeverage as getEffectiveLeverageFn, computeHalfKelly as computeHalfKellyFn } from './paper-engine/engine-trading.js';
import { getSymbolCluster as getSymbolClusterFn, getClusterLimitPct as getClusterLimitPctFn, getSymbolGuard as getSymbolGuardFn, restoreSymbolGuards as restoreSymbolGuardsFn, persistSymbolGuards as persistSymbolGuardsFn, updateSymbolGuard as updateSymbolGuardFn, checkSymbolKillswitch as checkSymbolKillswitchFn, applySpreadShockGuard as applySpreadShockGuardFn, queueEventDrivenExit as queueEventDrivenExitFn, processEventDrivenExitQueue as processEventDrivenExitQueueFn, wouldBreachPortfolioRiskBudget as wouldBreachPortfolioRiskBudgetFn, evaluateSessionKpiGate as evaluateSessionKpiGateFn, getExecutionQualityMultiplier as getExecutionQualityMultiplierFn, computeConfidenceCalibrationMultiplier as computeConfidenceCalibrationMultiplierFn, getRegimeThrottleMultiplier as getRegimeThrottleMultiplierFn } from './paper-engine/engine-guardians.js';
import { computeCorrelation as _computeCorrelation, breachesCrowdingLimit as _breachesCrowdingLimit, getMetaJournalEntries as _getMetaJournalEntries, wilsonBound as _wilsonBound, getRecentJournalEntries as _getRecentJournalEntries, percentile as percentileFn, countConsecutiveLosses as countConsecutiveLossesFn, summarizePerformance as _summarizePerformance } from './paper-engine/engine-analysis.js';
import { applyAgentConfig as _applyAgentConfig, rollToLiveSampleWindow as _rollToLiveSampleWindow } from './paper-engine/engine-agents.js';
import { getTapeQualityBlock as _getTapeQualityBlock, getAdaptiveCooldown as _getAdaptiveCooldown } from './paper-engine/engine-routing.js';
import { recordFill as recordFillFn, recordJournal as recordJournalFn, recordTickEvent as recordTickEventFn, recordEvent as recordEventFn, persistStateSnapshot as persistStateSnapshotFn, restoreStateSnapshot as restoreStateSnapshotFn, loadAgentConfigOverrides as loadAgentConfigOverridesFn, persistAgentConfigOverrides as persistAgentConfigOverridesFn, restoreLedgerHistory as restoreLedgerHistoryFn, appendLedger as appendLedgerFn, rewriteLedger as rewriteLedgerFn, enqueueWrite as enqueueWriteFn, maybeRotateLog as maybeRotateLogFn, maybeRotateEventLog as maybeRotateEventLogFn, getRecentEvents as getRecentEventsFn, loadMarketDataState as loadMarketDataStateFn } from './paper-engine/engine-persistence.js';
import { isHermesBrokerOrderId as isHermesBrokerOrderIdFn, matchesHermesBrokerOrderForAgent as matchesHermesBrokerOrderForAgentFn, isOwnedBrokerFill as isOwnedBrokerFillFn, isOwnedBrokerJournal as isOwnedBrokerJournalFn, isRestoredExternalBrokerJournal as isRestoredExternalBrokerJournalFn, isRestoredExternalBrokerExitFill as isRestoredExternalBrokerExitFillFn, hasMatchingOwnedBrokerEntryFill as hasMatchingOwnedBrokerEntryFillFn, sanitizeBrokerPaperRuntimeState as sanitizeBrokerPaperRuntimeStateFn, getBrokerSellQuantity as getBrokerSellQuantityFn, toBrokerPaperAccountState as toBrokerPaperAccountStateFn, getLatestBrokerPositions as getLatestBrokerPositionsFn, syncMarketFromRuntime as syncMarketFromRuntimeFn, applyMarketSnapshot as applyMarketSnapshotFn, hasHermesBrokerPosition as _hasHermesBrokerPosition } from './paper-engine/engine-sync.js';
import { HISTORY_LIMIT, OUTCOME_HISTORY_LIMIT, FILL_LIMIT, JOURNAL_LIMIT, TICK_MS, STARTING_EQUITY, EQUITY_FEE_BPS, CRYPTO_FEE_BPS, PAPER_BROKER, LEDGER_DIR, MARKET_DATA_RUNTIME_PATH, BROKER_ROUTER_URL, FILL_LEDGER_PATH, JOURNAL_LEDGER_PATH, STATE_SNAPSHOT_PATH, AGENT_CONFIG_OVERRIDES_PATH, EVENT_LOG_PATH, SYMBOL_GUARD_PATH, WEEKLY_REPORT_DIR, DAILY_CIRCUIT_BREAKER_DD_PCT, WEEKLY_CIRCUIT_BREAKER_DD_PCT, CRYPTO_MAX_ENTRY_SPREAD_BPS, CRYPTO_MAX_EST_SLIPPAGE_BPS, CRYPTO_MIN_BOOK_DEPTH_NOTIONAL, DATA_FRESHNESS_SLO_MS, ORDER_ACK_SLO_MS, BROKER_ERROR_SLO_PCT, BROKER_SYNC_MS, REAL_PAPER_AUTOPILOT, COINBASE_LIVE_ROUTING_ENABLED, HERMES_BROKER_ORDER_PREFIX } from './paper-engine/types.js';
import { seedMarket as seedMarketFn, seedAgents as seedAgentsFn, classifySymbolRegime as classifySymbolRegimeFn, buildRegimeKpis as buildRegimeKpisFn, refreshCapitalAllocation as refreshCapitalAllocationFn, buildDeskAnalytics as buildDeskAnalyticsFn, buildExecutionBands as buildExecutionBandsFn, getStrategyTelemetry as buildStrategyTelemetryFn, buildMistakeProfile as buildMistakeProfileFn, applyMistakeDrivenRefinement as applyMistakeDrivenRefinementFn, applyAdaptiveTuning as applyAdaptiveTuningFn, evaluateChallengerProbation as evaluateChallengerProbationFn, buildForensics as buildForensicsFn, evaluateWalkForwardPromotion as evaluateWalkForwardPromotionFn, evaluatePortfolioCircuitBreaker as evaluatePortfolioCircuitBreakerFn, evaluateCryptoExecutionGuard as evaluateCryptoExecutionGuardFn } from './paper-engine/engine-compute.js';
// Aliases: reconcile _xxx naming convention with xxxFn imports
const _evaluateWalkForwardPromotion = evaluateWalkForwardPromotionFn;
const _buildForensics = buildForensicsFn;
const _formatBrokerLabel = formatBrokerLabelFn;
const _getSnapshot = getSnapshotFn;
const _getPositions = getPositionsFn;
const _getMarketSnapshots = getMarketSnapshotsFn;
const _getOpportunitySnapshot = getOpportunitySnapshotFn;
const _getRecentEvents = getRecentEventsFn;
const _getRiskControlSnapshot = getRiskControlSnapshotFn;
const _getWalkForwardSnapshot = getWalkForwardSnapshotFn;
const _getLossForensics = getLossForensicsFn;
const _getMetaLabelSnapshot = getMetaLabelSnapshotFn;
const _toLiveReadiness = toLiveReadinessFn;
const _buildMarketTape = buildMarketTapeFn;
const _analyzeSignals = analyzeSignalsFn;
const _getDataSources = getDataSourcesFn;
const _hasTradableTape = hasTradableTapeFn;
const _describeTapeFlags = describeTapeFlagsFn;
const _toCandles = toCandlesFn;
const _seedMarket = seedMarketFn;
const _seedAgents = seedAgentsFn;
const _classifySymbolRegime = classifySymbolRegimeFn;
const _applyAdaptiveTuning = applyAdaptiveTuningFn;
const _buildMistakeProfile = buildMistakeProfileFn;
const _applyMistakeDrivenRefinement = applyMistakeDrivenRefinementFn;
const _refreshCapitalAllocation = refreshCapitalAllocationFn;
const _evaluateChallengerProbation = evaluateChallengerProbationFn;
const getPaperDeskAnalyticsFn = buildDeskAnalyticsFn;
const getExecutionBandsFn = buildExecutionBandsFn;
const getStrategyTelemetryFn = buildStrategyTelemetryFn;
class PaperScalpingEngine {
    getFeeRate(assetClass) { return getFeeRateFn(this, assetClass); }
    roundTripFeeBps(assetClass) { return roundTripFeeBpsFn(this, assetClass); }
    computeDynamicStop(fillPrice, agent, symbol, direction = 'long') { return computeDynamicStopFn(this, fillPrice, agent, symbol, direction); }
    computeDynamicTarget(fillPrice, agent, symbol, direction = 'long') { return computeDynamicTargetFn(this, fillPrice, agent, symbol, direction); }
    getPositionDirection(position) { return getPositionDirectionFn(this, position); }
    getPositionUnrealizedPnl(position, markPrice) { return getPositionUnrealizedPnlFn(this, position, markPrice); }
    resolveEntryDirection(agent, symbol, score, intel) { return resolveEntryDirectionFn(this, agent, symbol, score, intel); }
    computeGrossPnl(position, exitPrice, quantity) { return computeGrossPnlFn(this, position, exitPrice, quantity); }
    getSessionBucket(isoTs = new Date().toISOString()) { return getSessionBucketFn(this, isoTs); }
    getVolatilityBucket(symbol) { return getVolatilityBucketFn(this, symbol); }
    relativeMove(history, lookback) {
        const slice = history.slice(-lookback);
        if (slice.length === 0)
            return 0;
        const base = history.slice(-lookback * 2, -lookback);
        if (base.length === 0)
            return 0;
        return average(slice) / average(base) - 1;
    }
    countConsecutiveLosses(outcomes) { return countConsecutiveLossesFn(this, outcomes); }
    getSymbolCluster(symbol) { return getSymbolClusterFn(this, symbol); }
    getClusterLimitPct(cluster) { return getClusterLimitPctFn(this, cluster); }
    getSymbolGuard(symbol) { return getSymbolGuardFn(this, symbol); }
    restoreSymbolGuards() { restoreSymbolGuardsFn(this); }
    checkSymbolKillswitch(agent) { checkSymbolKillswitchFn(this, agent); }
    persistSymbolGuards() { persistSymbolGuardsFn(this); }
    updateSymbolGuard(symbol, mutation) { updateSymbolGuardFn(this, symbol, mutation); }
    noteTradeOutcome(agent, symbol, realized, reason) { noteTradeOutcomeFn(this, agent, symbol, realized, reason); }
    applySpreadShockGuard(symbol) { applySpreadShockGuardFn(this, symbol); }
    queueEventDrivenExit(symbol, trigger) { queueEventDrivenExitFn(this, symbol, trigger); }
    async processEventDrivenExitQueue() { await processEventDrivenExitQueueFn(this); }
    getExecutionQualityByBroker() { return getExecutionQualityByBrokerFn(this); }
    getExecutionQualityMultiplier(broker) { return getExecutionQualityMultiplierFn(this, broker); }
    getPortfolioRiskSnapshot() { return getRiskControlSnapshotFn(this); }
    wouldBreachPortfolioRiskBudget(agent, symbol, proposedNotional) { return wouldBreachPortfolioRiskBudgetFn(this, agent, symbol, proposedNotional); }
    evaluateSessionKpiGate(symbol) { return evaluateSessionKpiGateFn(this, symbol); }
    maybeGenerateWeeklyReport() { }
    percentile(values, p) { return percentileFn(this, values, p); }
    computeDataFreshnessP95Ms() { return 100; /* Placeholder */ }
    computeOrderAckP95Ms() { return 50; }
    computeBrokerErrorRatePct() { return 0; }
    evaluateSloAndOperationalKillSwitch() { }
    evaluatePortfolioCircuitBreaker() { evaluatePortfolioCircuitBreakerFn(this); }
    getOrderFlowDepth(symbol) { return null; }
    evaluateCryptoExecutionGuard(symbol, intel) { return evaluateCryptoExecutionGuardFn(this, symbol, intel); }
    buildRegimeKpis(regime, entries) { return buildRegimeKpisFn(this, regime, entries); }
    getRegimeThrottleMultiplier(regime, style) {
        return getRegimeThrottleMultiplierFn(this, regime, style);
    }
    computeConfidenceCalibrationMultiplier(agent, decision) {
        return computeConfidenceCalibrationMultiplierFn(this, agent, decision);
    }
    computeCorrelation(a, b) {
        return _computeCorrelation(this, a, b);
    }
    breachesCrowdingLimit(candidate) {
        return _breachesCrowdingLimit(this, candidate);
    }
    evaluateWalkForwardPromotion(agent, candidate, champion) {
        return _evaluateWalkForwardPromotion(this, agent, candidate, champion);
    }
    buildForensics(entry) {
        return _buildForensics(this, entry);
    }
    getAgentBroker(agent) {
        return agent.config.broker;
    }
    formatBrokerLabel(broker) { return _formatBrokerLabel(this, broker); }
    startedAt = new Date();
    market = new Map();
    agents = new Map();
    fills = [];
    journal = [];
    deskCurve = [];
    benchmarkCurve = [];
    aiCouncil = getAiCouncil();
    signalBus = getSignalBus();
    marketIntel = getMarketIntel();
    newsIntel = getNewsIntel();
    eventCalendar = getEventCalendar();
    insiderRadar = getInsiderRadar();
    derivativesIntel = getDerivativesIntel();
    marketDataSources = [];
    brokerPaperAccount = null;
    brokerOandaAccount = null;
    brokerCoinbaseAccount = null;
    metaJournalCache = [];
    metaJournalCacheAtMs = 0;
    metaModelCache = null;
    featureStore = getFeatureStore();
    // §4.1 LATENCY TRACKING: signal→submit→fill latency tracker
    latencyTracker = {
        recordLatency: (sample) => recordLatencyFn(sample),
        getReport: () => getLatencyReportFn(),
        setPendingSignal: (agentId, symbol, signalAt) => setPendingSignalFn(agentId, symbol, signalAt)
    };
    tick = 0;
    timer = null;
    redisSubscriber = null;
    stepInFlight = false;
    scalpRouteCandidates = new Map();
    selectedScalpByAssetClass = new Map();
    selectedScalpOverallId = null;
    lastBrokerSyncAtMs = 0;
    pendingEventExitReasons = new Map();
    symbolGuards = new Map();
    executionQualityCounters = new Map();
    latestWeeklyReport = null;
    /** Latest firm capital allocator snapshot — set each tick before refreshCapitalAllocation runs. */
    _capitalAllocSnapshot = null;
    nextWeeklyCheckAtMs = 0;
    regimeKpis = [];
    latestSlo = {
        dataFreshnessP95Ms: 0,
        orderAckP95Ms: 0,
        brokerErrorRatePct: 0,
        breaches: []
    };
    walkForwardResults = new Map();
    forensicRows = [];
    circuitBreakerLatched = false;
    circuitBreakerScope = 'none';
    circuitBreakerReason = '';
    circuitBreakerArmedAt = null;
    circuitBreakerReviewed = false;
    // COO FIX #1: Per-pair daily loss limit — tracks PnL per symbol per UTC day.
    // If EUR/USD loses >$200 today, agent targeting it gets a symbolKillSwitchUntil tomorrow 00:00 UTC.
    dailyPnLBySymbol = new Map();
    dailyLossResetDate = ''; // YYYY-MM-DD UTC
    // COO FIX #5: Equity-curve circuit breaker — tracks high-water mark for drawdown.
    // If equity falls >10% from HWM, flatten everything and halt for review.
    // All 3 brokers (Alpaca $100K + OANDA $100K + Coinbase $100K) are paper trading.
    // Circuit breaker uses $300K total firm capital as baseline.
    equityHighWaterMark = STARTING_EQUITY * 3;
    operationalKillSwitchUntilMs = 0;
    fileQueues = new Map();
    _brokerPositionCache = null;
    HERMES_STARTING_EQUITY = STARTING_EQUITY;
    startingEquity = STARTING_EQUITY;
    _lastRepatriationReport = null;
    constructor() {
        fs.mkdirSync(LEDGER_DIR, { recursive: true });
        this.seedMarket();
        this.syncMarketFromRuntime(false);
        // Restore snapshot FIRST to avoid duplicate agents — seedAgents() unconditionally adds
        // agents, so calling it after restore would create duplicates for every agent in the snapshot.
        if (!this.restoreStateSnapshot()) {
            this.seedAgents();
            this.syncMarketFromRuntime(false);
            this.restoreLedgerHistory();
            this.normalizePresentationState();
        }
        else {
            this.syncMarketFromRuntime(false);
            this.restoreLedgerHistory();
        }
        this.sanitizeBrokerPaperRuntimeState();
        this.restoreSymbolGuards();
        this.normalizePresentationState();
        this.persistStateSnapshot();
        this.seedAgentCountersFromJournal();
        // Adopt orphaned broker positions after agent state is hydrated from journal
        void repatriateOrphanedBrokerPositions(this).then((report) => {
            this._lastRepatriationReport = report;
        }).catch((err) => {
            console.error('[paper-engine] repatriateOrphanedBrokerPositions failed:', err instanceof Error ? err.message : err);
        });
    }
    start() {
        if (this.redisSubscriber)
            return;
        // Dedicated subscriber client for HFT events
        this.redisSubscriber = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379'),
        });
        this.redisSubscriber.on('connect', () => logger.info('Paper Engine connected to Redis HFT Bus'));
        // 1. Listen for Market Ticks (Sub-millisecond execution)
        this.redisSubscriber.subscribe(TOPICS.MARKET_TICK, (err) => {
            if (err)
                logger.error(`Failed to subscribe to market ticks: ${err.message}`);
        });
        // 2. Listen for Order Status updates (Async execution feedback)
        this.redisSubscriber.subscribe(TOPICS.ORDER_STATUS, (err) => {
            if (err)
                logger.error(`Failed to subscribe to order status: ${err.message}`);
        });
        this.redisSubscriber.on('message', (channel, message) => {
            try {
                const data = JSON.parse(message);
                if (channel === TOPICS.MARKET_TICK) {
                    // Update specific symbol price and trigger step
                    const symbol = this.market.get(data.symbol);
                    if (symbol) {
                        this.applyMarketSnapshot(symbol, data, true);
                        void this.step(true);
                    }
                }
                else if (channel === TOPICS.ORDER_STATUS) {
                    // Handle fill/reject feedback
                    this.handleAsyncOrderStatus(data);
                }
            }
            catch (error) {
                logger.error(`Error processing Redis message on ${channel}: ${error instanceof Error ? error.message : 'unknown'}`);
            }
        });
        void this.seedFromBrokerHistory().catch(() => {
            logger.warn('Broker history seed failed, retrying in 15s');
            setTimeout(() => { void this.seedFromBrokerHistory(); }, 15_000);
        });
    }
    handleAsyncOrderStatus(data) {
        handleAsyncOrderStatusFn(this, data);
    }
    async seedFromBrokerHistory() {
        return seedFromBrokerHistoryFn(this);
    }
    getSnapshot() {
        return _getSnapshot(this);
    }
    getJournal() {
        return [...this.journal];
    }
    getPositions() {
        return _getPositions(this);
    }
    getMarketSnapshots() {
        return _getMarketSnapshots(this);
    }
    applyAgentConfig(agentId, config) {
        return _applyAgentConfig(this, agentId, config);
    }
    getAgentConfigs() {
        return Array.from(this.agents.values()).map((agent) => ({
            agentId: agent.config.id,
            config: { ...agent.config },
            baselineConfig: { ...agent.baselineConfig },
            allocationMultiplier: agent.allocationMultiplier,
            allocationReason: agent.allocationReason,
            deployment: { ...agent.deployment }
        }));
    }
    getOpportunitySnapshot() {
        return _getOpportunitySnapshot(this);
    }
    getRecentEvents(limit = 200) {
        return _getRecentEvents(this, limit);
    }
    getWeeklyReport() {
        return this.latestWeeklyReport ? { ...this.latestWeeklyReport } : null;
    }
    getRiskControlSnapshot() {
        return _getRiskControlSnapshot(this);
    }
    acknowledgeCircuitBreaker(reviewNote) {
        if (this.circuitBreakerLatched) {
            this.circuitBreakerLatched = false;
            this.circuitBreakerScope = 'none';
            this.circuitBreakerReason = '';
            this.circuitBreakerArmedAt = null;
            this.circuitBreakerReviewed = true;
            this.recordEvent('circuit-breaker-review', { reviewNote, released: true });
        }
        else {
            this.recordEvent('circuit-breaker-review', { reviewNote, released: false });
        }
        return { released: !this.circuitBreakerLatched, state: this.getRiskControlSnapshot() };
    }
    getCircuitBreakerState() {
        return {
            latched: this.circuitBreakerLatched,
            scope: this.circuitBreakerScope === 'none' ? null : this.circuitBreakerScope,
            reason: this.circuitBreakerReason || null,
            armedAt: this.circuitBreakerArmedAt,
            reviewed: this.circuitBreakerReviewed
        };
    }
    resetCircuitBreaker(scope, reason) {
        if (!this.circuitBreakerLatched)
            return;
        this.circuitBreakerLatched = false;
        this.circuitBreakerScope = 'none';
        this.circuitBreakerReason = '';
        this.circuitBreakerArmedAt = null;
        this.circuitBreakerReviewed = false;
        this.recordEvent('circuit-breaker-admin-reset', { scope, reason });
        console.log(`[CIRCUIT BREAKER] Admin reset. scope=${scope} reason=${reason}`);
    }
    getWalkForwardSnapshot() {
        return _getWalkForwardSnapshot(this);
    }
    getLossForensics(limit = 12, symbol) {
        return _getLossForensics(this, limit, symbol);
    }
    getMetaLabelSnapshot() {
        return _getMetaLabelSnapshot(this);
    }
    getMetaModelSnapshot() {
        const candidates = Array.from(this.agents.values())
            .map((agent) => {
            const symbol = this.market.get(agent.config.symbol);
            if (!symbol)
                return null;
            return {
                agentId: agent.config.id,
                candidate: this.buildMetaCandidate(agent, symbol, this.marketIntel.getCompositeSignal(symbol.symbol))
            };
        })
            .filter((entry) => entry !== null);
        return buildMetaLabelModelSnapshot(this.getMetaJournalEntries(), candidates);
    }
    getLiveReadiness() {
        return getLiveReadinessReportFn(this);
    }
    buildDeskAnalytics() { return getPaperDeskAnalyticsFn(this); }
    buildExecutionBands() { return getExecutionBandsFn(this); }
    buildStrategyTelemetry() { return getStrategyTelemetryFn(this); }
    buildMarketTape(journalRows) { return _buildMarketTape(this, journalRows); }
    analyzeSignals() { _analyzeSignals(this); }
    getDataSources() { return _getDataSources(this); }
    async reconcileBrokerPaperState(force = false) {
        return reconcileBrokerPaperStateFn(this, force);
    }
    hasHermesBrokerPosition(agent, brokerOrders) {
        return _hasHermesBrokerPosition(this, agent, brokerOrders);
    }
    syncBrokerPositionIntoAgent(agent, symbol, brokerPosition) {
        return syncBrokerPositionIntoAgentFn(this, agent, symbol, brokerPosition);
    }
    finalizeBrokerFlat(agent, symbol, reason) {
        return finalizeBrokerFlatFn(this, agent, symbol, reason);
    }
    async fetchBrokerAccount(broker) {
        return fetchBrokerAccountFn(this, broker);
    }
    async routeBrokerOrder(payload) {
        return routeBrokerOrderFn(this, payload);
    }
    syncMarketFromRuntime(recordHistory) {
        return syncMarketFromRuntimeFn(this, recordHistory);
    }
    loadMarketDataState() {
        return loadMarketDataStateFn(this);
    }
    applyMarketSnapshot(symbol, snapshot, recordHistory) {
        return applyMarketSnapshotFn(this, symbol, snapshot, recordHistory);
    }
    hasTradableTape(symbol) {
        return _hasTradableTape(this, symbol);
    }
    describeTapeFlags(symbol) {
        return _describeTapeFlags(this, symbol);
    }
    getTapeQualityBlock(symbol) {
        return _getTapeQualityBlock(this, symbol);
    }
    toCandles(history) {
        return _toCandles(this, history);
    }
    seedMarket() {
        _seedMarket(this);
    }
    seedAgents() {
        _seedAgents(this);
    }
    async step(isRedisTick = false) { return stepFn(this, isRedisTick); }
    async updateAgent(agent) { return updateAgentFn(this, agent); }
    refreshScalpRoutePlan() { return refreshScalpRoutePlanFn(this); }
    getRouteBlock(agent, symbol) { return getRouteBlockFn(this, agent, symbol); }
    rollToLiveSampleWindow(agent, symbol) {
        _rollToLiveSampleWindow(this, agent, symbol);
    }
    async manageOpenPosition(agent, symbol, score) { return manageOpenPositionFn(this, agent, symbol, score); }
    maybeTrailBrokerStop(agent, symbol) {
        return maybeTrailBrokerStopFn(this, agent, symbol);
    }
    async openPosition(agent, symbol, score) { return openPositionFn(this, agent, symbol, score); }
    classifySymbolRegime(symbol) {
        return _classifySymbolRegime(this, symbol);
    }
    buildJournalContext(symbol) { return buildJournalContextFn(this, symbol); }
    buildMetaCandidate(agent, symbol, intel) { return buildMetaCandidateFn(this, agent, symbol, intel); }
    buildEntryMeta(agent, symbol, score) { return buildEntryMetaFn(this, agent, symbol, score); }
    async closePosition(agent, symbol, reason, forcePnl) { return closePositionFn(this, agent, symbol, reason, forcePnl); }
    /**
     * Cross-exchange arbitrage handler.
     * Compares prices for the same symbol across Alpaca and Coinbase.
     * If the spread between venues exceeds round-trip costs, simulates the arb.
     */
    updateArbAgent(agent, symbol) { return updateArbAgentFn(this, agent, symbol); }
    /** Adaptive cooldown: longer after losses in bad conditions, shorter when winning */
    getAdaptiveCooldown(agent, symbol) {
        return _getAdaptiveCooldown(this, agent, symbol);
    }
    shouldSimulateLocally(broker) {
        return broker === 'coinbase-live' && !COINBASE_LIVE_ROUTING_ENABLED;
    }
    async openBrokerPaperPosition(agent, symbol, score, entryMeta, decision, direction) {
        return openBrokerPaperPositionFn(this, agent, symbol, score, entryMeta, decision, direction);
    }
    async closeBrokerPaperPosition(agent, symbol, reason) {
        return closeBrokerPaperPositionFn(this, agent, symbol, reason);
    }
    applyBrokerFilledEntry(agent, symbol, report, score, entryMeta) {
        return applyBrokerFilledEntryFn(this, agent, symbol, report, score, entryMeta);
    }
    applyBrokerFilledExit(agent, symbol, report, reason, forcePnl) {
        return applyBrokerFilledExitFn(this, agent, symbol, report, reason, forcePnl);
    }
    describeWatchState(style, symbol, score) {
        return describeWatchStateFn(this, style, symbol, score);
    }
    describeAiState(decision) {
        return describeAiStateFn(this, decision);
    }
    getMetaLabelDecision(agent, symbol, score, intel) { return getMetaLabelDecisionFn(this, agent, symbol, score, intel); }
    getMetaJournalEntries() {
        return _getMetaJournalEntries(this);
    }
    normalizeFlowBucket(direction) {
        return normalizeFlowBucketFn(this, direction);
    }
    getConfidenceBucket(confidence) {
        return getConfidenceBucketFn(this, confidence);
    }
    getSpreadBucket(spreadBps, limitBps) {
        return getSpreadBucketFn(this, spreadBps, limitBps);
    }
    getContextualMetaSignal(agent, symbol, intel) { return getContextualMetaSignalFn(this, agent, symbol, intel); }
    entryNote(style, symbol, score) {
        return entryNoteFn(this, style, symbol, score);
    }
    getEntryScore(style, shortReturn, mediumReturn, symbol) {
        return getEntryScoreFn(this, style, shortReturn, mediumReturn, symbol);
    }
    entryThreshold(style) {
        return entryThresholdFn(this, style);
    }
    exitThreshold(_style) {
        return exitThresholdFn(this, _style);
    }
    estimatedBrokerRoundTripCostBps(symbol, orderMode = 'taker') {
        return estimatedBrokerRoundTripCostBpsFn(this, symbol, orderMode);
    }
    fastPathThreshold(style) {
        return fastPathThresholdFn(this, style);
    }
    brokerRulesFastPathThreshold(agent, _symbol) {
        return brokerRulesFastPathThresholdFn(this, agent, _symbol);
    }
    canUseBrokerRulesFastPath(agent, symbol, score, aiDecision) {
        return canUseBrokerRulesFastPathFn(this, agent, symbol, score, aiDecision);
    }
    canEnter(agent, symbol, shortReturn, mediumReturn, score) { return canEnterFn(this, agent, symbol, shortReturn, mediumReturn, score); }
    getManagerBlock(agent, symbol) { return getManagerBlockFn(this, agent, symbol); }
    summarizePerformance(entries) {
        return _summarizePerformance(this, entries);
    }
    getPrecisionBlock(agent, symbol) { return getPrecisionBlockFn(this, agent, symbol); }
    toLiveReadiness(agent) { return _toLiveReadiness(this, agent); }
    applyAdaptiveTuning(agent, symbol) {
        _applyAdaptiveTuning(this, agent, symbol);
    }
    wilsonBound(successes, total, z = 1.0, mode = 'lower') {
        return _wilsonBound(this, successes, total, z, mode);
    }
    getRecentJournalEntries(agent, symbol, limit = 12) {
        return _getRecentJournalEntries(this, agent, symbol, limit);
    }
    buildMistakeProfile(agent, symbol, entries) {
        return _buildMistakeProfile(this, agent, symbol, entries);
    }
    applyMistakeDrivenRefinement(agent, symbol, profile) {
        _applyMistakeDrivenRefinement(this, agent, symbol, profile);
    }
    refreshCapitalAllocation(snapshot) {
        _refreshCapitalAllocation(this, snapshot ?? this._capitalAllocSnapshot ?? undefined);
    }
    evaluateChallengerProbation(agent, symbol) {
        _evaluateChallengerProbation(this, agent, symbol);
    }
    getAgentNetPnl(agent) { return getAgentNetPnlFn(this, agent); }
    getAgentEquity(agent) { return getAgentEquityFn(this, agent); }
    getDeskEquity() { return getDeskEquityFn(this); }
    getBenchmarkEquity() { return getBenchmarkEquityFn(this); }
    getDeskAgentStates() { return getDeskAgentStatesFn(this); }
    getDeskStartingEquity() { return getDeskStartingEquityFn(this); }
    getRepatriationSummary() {
        return {
            adopted: this._lastRepatriationReport?.adopted ?? 0,
            orphaned: this._lastRepatriationReport?.orphaned ?? 0,
            lastRunAt: this._lastRepatriationReport ? new Date().toISOString() : null
        };
    }
    getBrokerPaperAgentByStrategy(strategy) { return Array.from(this.agents.values()).find(a => a.config.executionMode === 'broker-paper' && strategy.includes(a.config.name)) || null; }
    isHermesBrokerOrderId(orderId) { return isHermesBrokerOrderIdFn(this, orderId); }
    getBrokerSellQuantity(agent, tracked) { return getBrokerSellQuantityFn(this, agent, tracked); }
    getLatestBrokerPositions() { return getLatestBrokerPositionsFn(this); }
    matchesHermesBrokerOrderForAgent(agent, orderId) { return matchesHermesBrokerOrderForAgentFn(this, agent, orderId); }
    isOwnedBrokerFill(fill) { return isOwnedBrokerFillFn(this, fill); }
    isOwnedBrokerJournal(entry) { return isOwnedBrokerJournalFn(this, entry); }
    isRestoredExternalBrokerJournal(entry) { return isRestoredExternalBrokerJournalFn(this, entry); }
    isRestoredExternalBrokerExitFill(fill, journal) { return isRestoredExternalBrokerExitFillFn(this, fill, journal); }
    hasMatchingOwnedBrokerEntryFill(fill, fills) { return hasMatchingOwnedBrokerEntryFillFn(this, fill, fills); }
    sanitizeBrokerPaperRuntimeState() { sanitizeBrokerPaperRuntimeStateFn(this); }
    getVisibleFills() { return getVisibleFillsFn(this); }
    seedAgentCountersFromJournal() {
        // Load journal from disk (may already be in memory if snapshot was restored)
        const diskEntries = this.journal.length === 0
            ? readJsonLines(JOURNAL_LEDGER_PATH)
            : this.journal;
        for (const agent of this.agents.values()) {
            const filtered = diskEntries.filter(e => e.strategyId === agent.config.id);
            if (filtered.length === 0)
                continue;
            agent.trades = filtered.length;
            agent.wins = filtered.filter(e => e.realizedPnl > 0).length;
            agent.losses = filtered.filter(e => e.realizedPnl < 0).length;
            agent.realizedPnl = round(filtered.reduce((s, e) => s + e.realizedPnl, 0), 2);
            agent.recentOutcomes = filtered.slice(-30).map(e => e.realizedPnl);
            agent.lastExitPnl = filtered[filtered.length - 1].realizedPnl;
            agent.lastSymbol = agent.config.symbol;
            logger.info(`[paper-engine] seeded ${agent.config.id}: ${agent.trades} trades, ${agent.wins}/${agent.losses}, $${agent.realizedPnl}`);
        }
    }
    toBrokerPaperAccountState(snap) { return toBrokerPaperAccountStateFn(this, snap); }
    normalizePresentationState() { normalizePresentationStateFn(this); }
    toAgentSnapshot(agent) { return toAgentSnapshotFn(this, agent); }
    recordFill(params) { recordFillFn(this, params); }
    recordEvent(type, payload) { recordEventFn(this, type, payload); }
    recordJournal(entry) { recordJournalFn(this, entry); }
    restoreStateSnapshot() { return restoreStateSnapshotFn(this); }
    restoreLedgerHistory() { return restoreLedgerHistoryFn(this); }
    loadAgentConfigOverrides() { return loadAgentConfigOverridesFn(this); }
    persistAgentConfigOverrides() { persistAgentConfigOverridesFn(this); }
    persistStateSnapshot(force = false) { persistStateSnapshotFn(this, force); }
    recordTickEvent() { recordTickEventFn(this); }
    appendLedger(filePath, payload) { appendLedgerFn(this, filePath, payload); }
    rewriteLedger(filePath, entries) { rewriteLedgerFn(this, filePath, entries); }
    enqueueWrite(filePath, operation) { enqueueWriteFn(this, filePath, operation); }
    maybeRotateLog(filePath, maxMB) { maybeRotateLogFn(this, filePath, maxMB); }
    maybeRotateEventLog() { maybeRotateEventLogFn(this); }
    computeHalfKelly(agent) { return computeHalfKellyFn(this, agent); }
    pushPoint(target, value, limit = HISTORY_LIMIT) {
        target.push(round(value, 2));
        if (target.length > limit)
            target.shift();
    }
}
export { PaperScalpingEngine };
export { getPaperEngine } from './paper-engine/engine-lifecycle.js';
