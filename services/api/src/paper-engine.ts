// @ts-nocheck
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AiCouncilDecision,
  AgentLiveReadiness,
  AgentFillEvent,
  AgentStatus,
  AssetClass,
  BrokerId,
  DataSourceStatus,
  LiveReadinessReport,
  MarketSession,
  MarketSnapshot,
  OrderSide,
  OrderStatus,
  PaperAgentSnapshot,
  PaperDeskAnalytics,
  PaperDeskSnapshot,
  PaperExecutionBand,
  PaperStrategyTelemetry,
  PaperTapeSnapshot,
  PositionSnapshot,
  ReadinessGate,
  StrategyMode,
  TradeJournalEntry
} from '@hermes/contracts';
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
import {
  buildMetaLabelModelSnapshot,
  predictMetaLabel,
  predictWithModel,
  buildModel,
  type MetaLabelCandidate,
  type ModelState
} from './meta-label-model.js';
import {
  asRecord,
  average,
  clamp,
  formatAgo,
  normalizeArray,
  nudge,
  numberField,
  pickLast,
  readJsonLines,
  round,
  textField
} from './paper-engine-utils.js';
import {
  estimateExpectedNetEdgeBps,
  estimateExpectedGrossEdgeBps,
  estimateRoundTripCostBps,
  inferAssetClassFromSymbol
} from './fee-model.js';
import { evaluateKpiGate } from './kpi-gates.js';
import {
  seedFromBrokerHistory as seedFromBrokerHistoryFn,
  reconcileBrokerPaperState as reconcileBrokerPaperStateFn,
  syncBrokerPositionIntoAgent as syncBrokerPositionIntoAgentFn,
  routeBrokerOrder as routeBrokerOrderFn,
  openBrokerPaperPosition as openBrokerPaperPositionFn,
  closeBrokerPaperPosition as closeBrokerPaperPositionFn,
  applyBrokerFilledEntry as applyBrokerFilledEntryFn,
  applyBrokerFilledExit as applyBrokerFilledExitFn,
  fetchBrokerAccount as fetchBrokerAccountFn,
  finalizeBrokerFlat as finalizeBrokerFlatFn,
  handleAsyncOrderStatus as handleAsyncOrderStatusFn,
  recentlyExpiredOrderIds
} from './paper-engine/engine-broker.js';
import {
  repatriateOrphanedBrokerPositions,
  type RepatriationReport
} from './paper-engine/broker-repatriation.js';
import {
  canEnter as canEnterFn,
  refreshScalpRoutePlan as refreshScalpRoutePlanFn,
  getMetaLabelDecision as getMetaLabelDecisionFn,
  getContextualMetaSignal as getContextualMetaSignalFn,
  buildEntryMeta as buildEntryMetaFn,
  buildMetaCandidate as buildMetaCandidateFn,
  buildJournalContext as buildJournalContextFn,
  getRouteBlock as getRouteBlockFn,
  getPrecisionBlock as getPrecisionBlockFn,
  getManagerBlock as getManagerBlockFn,
  describeWatchState as describeWatchStateFn,
  describeAiState as describeAiStateFn,
  normalizeFlowBucket as normalizeFlowBucketFn,
  getConfidenceBucket as getConfidenceBucketFn,
  getSpreadBucket as getSpreadBucketFn,
  entryNote as entryNoteFn,
  getEntryScore as getEntryScoreFn,
  entryThreshold as entryThresholdFn,
  exitThreshold as exitThresholdFn,
  estimatedBrokerRoundTripCostBps as estimatedBrokerRoundTripCostBpsFn,
  fastPathThreshold as fastPathThresholdFn,
  brokerRulesFastPathThreshold as brokerRulesFastPathThresholdFn,
  canUseBrokerRulesFastPath as canUseBrokerRulesFastPathFn
} from './paper-engine/engine-entry.js';
import {
  getExecutionQualityByBroker as getExecutionQualityByBrokerFn,
  formatBrokerLabel as formatBrokerLabelFn,
  buildMarketTape as buildMarketTapeFn,
  analyzeSignals as analyzeSignalsFn,
  getDataSources as getDataSourcesFn,
  toLiveReadiness as toLiveReadinessFn,
  getLiveReadinessReport as getLiveReadinessReportFn,
  toAgentSnapshot as toAgentSnapshotFn,
  getPositions as getPositionsFn,
  getRiskControlSnapshot as getRiskControlSnapshotFn,
  getDeskAgentStates as getDeskAgentStatesFn,
  getVisibleFills as getVisibleFillsFn,
  getDeskStartingEquity as getDeskStartingEquityFn,
  getDeskEquity as getDeskEquityFn,
  getSnapshot as getSnapshotFn,
  getMarketSnapshots as getMarketSnapshotsFn,
  getOpportunitySnapshot as getOpportunitySnapshotFn,
  getWalkForwardSnapshot as getWalkForwardSnapshotFn,
  getLossForensics as getLossForensicsFn,
  getMetaLabelSnapshot as getMetaLabelSnapshotFn,
  hasTradableTape as hasTradableTapeFn,
  describeTapeFlags as describeTapeFlagsFn,
  toCandles as toCandlesFn,
  normalizePresentationState as normalizePresentationStateFn
} from './paper-engine/engine-views.js';
import {
  step as stepFn,
  updateAgent as updateAgentFn,
  manageOpenPosition as manageOpenPositionFn,
  openPosition as openPositionFn,
  closePosition as closePositionFn,
  updateArbAgent as updateArbAgentFn,
  getPositionDirection as getPositionDirectionFn,
  getPositionUnrealizedPnl as getPositionUnrealizedPnlFn,
  maybeTrailBrokerStop as maybeTrailBrokerStopFn,
  getFeeRate as getFeeRateFn,
  roundTripFeeBps as roundTripFeeBpsFn,
  computeDynamicStop as computeDynamicStopFn,
  computeDynamicTarget as computeDynamicTargetFn,
  resolveEntryDirection as resolveEntryDirectionFn,
  computeGrossPnl as computeGrossPnlFn,
  getSessionBucket as getSessionBucketFn,
  getVolatilityBucket as getVolatilityBucketFn,
  noteTradeOutcome as noteTradeOutcomeFn,
  getAgentNetPnl as getAgentNetPnlFn,
  getAgentEquity as getAgentEquityFn,
  getBenchmarkEquity as getBenchmarkEquityFn,
  getEffectiveLeverage as getEffectiveLeverageFn,
  computeHalfKelly as computeHalfKellyFn
} from './paper-engine/engine-trading.js';
import {
  getSymbolCluster as getSymbolClusterFn,
  getClusterLimitPct as getClusterLimitPctFn,
  getSymbolGuard as getSymbolGuardFn,
  restoreSymbolGuards as restoreSymbolGuardsFn,
  persistSymbolGuards as persistSymbolGuardsFn,
  updateSymbolGuard as updateSymbolGuardFn,
  checkSymbolKillswitch as checkSymbolKillswitchFn,
  applySpreadShockGuard as applySpreadShockGuardFn,
  queueEventDrivenExit as queueEventDrivenExitFn,
  processEventDrivenExitQueue as processEventDrivenExitQueueFn,
  wouldBreachPortfolioRiskBudget as wouldBreachPortfolioRiskBudgetFn,
  evaluateSessionKpiGate as evaluateSessionKpiGateFn,
  getExecutionQualityMultiplier as getExecutionQualityMultiplierFn,
  computeConfidenceCalibrationMultiplier as computeConfidenceCalibrationMultiplierFn,
  getRegimeThrottleMultiplier as getRegimeThrottleMultiplierFn
} from './paper-engine/engine-guardians.js';
import {
  computeCorrelation as _computeCorrelation,
  breachesCrowdingLimit as _breachesCrowdingLimit,
  getMetaJournalEntries as _getMetaJournalEntries,
  wilsonBound as _wilsonBound,
  getRecentJournalEntries as _getRecentJournalEntries,
  percentile as percentileFn,
  countConsecutiveLosses as countConsecutiveLossesFn,
  summarizePerformance as _summarizePerformance
} from './paper-engine/engine-analysis.js';
import {
  applyAgentConfig as _applyAgentConfig,
  rollToLiveSampleWindow as _rollToLiveSampleWindow
} from './paper-engine/engine-agents.js';
import {
  getTapeQualityBlock as _getTapeQualityBlock,
  getAdaptiveCooldown as _getAdaptiveCooldown
} from './paper-engine/engine-routing.js';
import {
  recordFill as recordFillFn,
  recordJournal as recordJournalFn,
  recordTickEvent as recordTickEventFn,
  recordEvent as recordEventFn,
  persistStateSnapshot as persistStateSnapshotFn,
  restoreStateSnapshot as restoreStateSnapshotFn,
  loadAgentConfigOverrides as loadAgentConfigOverridesFn,
  persistAgentConfigOverrides as persistAgentConfigOverridesFn,
  restoreLedgerHistory as restoreLedgerHistoryFn,
  appendLedger as appendLedgerFn,
  rewriteLedger as rewriteLedgerFn,
  enqueueWrite as enqueueWriteFn,
  maybeRotateLog as maybeRotateLogFn,
  maybeRotateEventLog as maybeRotateEventLogFn,
  getRecentEvents as getRecentEventsFn,
  loadMarketDataState as loadMarketDataStateFn
} from './paper-engine/engine-persistence.js';
import {
  isHermesBrokerOrderId as isHermesBrokerOrderIdFn,
  matchesHermesBrokerOrderForAgent as matchesHermesBrokerOrderForAgentFn,
  isOwnedBrokerFill as isOwnedBrokerFillFn,
  isOwnedBrokerJournal as isOwnedBrokerJournalFn,
  isRestoredExternalBrokerJournal as isRestoredExternalBrokerJournalFn,
  isRestoredExternalBrokerExitFill as isRestoredExternalBrokerExitFillFn,
  hasMatchingOwnedBrokerEntryFill as hasMatchingOwnedBrokerEntryFillFn,
  sanitizeBrokerPaperRuntimeState as sanitizeBrokerPaperRuntimeStateFn,
  getBrokerSellQuantity as getBrokerSellQuantityFn,
  toBrokerPaperAccountState as toBrokerPaperAccountStateFn,
  getLatestBrokerPositions as getLatestBrokerPositionsFn,
  syncMarketFromRuntime as syncMarketFromRuntimeFn,
  applyMarketSnapshot as applyMarketSnapshotFn,
  hasHermesBrokerPosition as _hasHermesBrokerPosition
} from './paper-engine/engine-sync.js';
import type {
  AgentConfig,
  AgentDeploymentState,
  AgentState,
  AgentStyle,
  AgentExecutionMode,
  BrokerRouteResponse,
  BrokerAccountResponse,
  MistakeLearningProfile,
  PerformanceSummary,
  PositionDirection,
  PositionEntryMetaState,
  PositionState,
  RegimeKpiRow,
  ScalpRouteState,
  SessionBucket,
  SloStatusState,
  SymbolState,
  SymbolGuardState,
  TradeForensicsRow,
  WalkForwardResult,
  WeeklyReportState,
  ExecutionQualityCounters,
  BrokerAccountPosition,
  BrokerAccountSnapshot,
  BrokerPaperAccountState,
  PersistedMarketDataState
} from './paper-engine/types.js';
import {
  HISTORY_LIMIT,
  OUTCOME_HISTORY_LIMIT,
  FILL_LIMIT,
  JOURNAL_LIMIT,
  TICK_MS,
  STARTING_EQUITY,
  EQUITY_FEE_BPS,
  CRYPTO_FEE_BPS,
  PAPER_BROKER,
  LEDGER_DIR,
  MARKET_DATA_RUNTIME_PATH,
  BROKER_ROUTER_URL,
  FILL_LEDGER_PATH,
  JOURNAL_LEDGER_PATH,
  STATE_SNAPSHOT_PATH,
  AGENT_CONFIG_OVERRIDES_PATH,
  EVENT_LOG_PATH,
  SYMBOL_GUARD_PATH,
  WEEKLY_REPORT_DIR,
  DAILY_CIRCUIT_BREAKER_DD_PCT,
  WEEKLY_CIRCUIT_BREAKER_DD_PCT,
  CRYPTO_MAX_ENTRY_SPREAD_BPS,
  CRYPTO_MAX_EST_SLIPPAGE_BPS,
  CRYPTO_MIN_BOOK_DEPTH_NOTIONAL,
  DATA_FRESHNESS_SLO_MS,
  ORDER_ACK_SLO_MS,
  BROKER_ERROR_SLO_PCT,
  BROKER_SYNC_MS,
  REAL_PAPER_AUTOPILOT,
  COINBASE_LIVE_ROUTING_ENABLED,
  HERMES_BROKER_ORDER_PREFIX
} from './paper-engine/types.js';
import {
  seedMarket as seedMarketFn,
  seedAgents as seedAgentsFn,
  classifySymbolRegime as classifySymbolRegimeFn,
  buildRegimeKpis as buildRegimeKpisFn,
  refreshCapitalAllocation as refreshCapitalAllocationFn,
  buildDeskAnalytics as buildDeskAnalyticsFn,
  buildExecutionBands as buildExecutionBandsFn,
  getStrategyTelemetry as buildStrategyTelemetryFn,
  buildMistakeProfile as buildMistakeProfileFn,
  applyMistakeDrivenRefinement as applyMistakeDrivenRefinementFn,
  applyAdaptiveTuning as applyAdaptiveTuningFn,
  evaluateChallengerProbation as evaluateChallengerProbationFn,
  buildForensics as buildForensicsFn,
  evaluateWalkForwardPromotion as evaluateWalkForwardPromotionFn,
  evaluatePortfolioCircuitBreaker as evaluatePortfolioCircuitBreakerFn,
  evaluateCryptoExecutionGuard as evaluateCryptoExecutionGuardFn
} from './paper-engine/engine-compute.js';

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
  private getFeeRate(assetClass: AssetClass): number { return getFeeRateFn(this, assetClass); }
  private roundTripFeeBps(assetClass: AssetClass): number { return roundTripFeeBpsFn(this, assetClass); }
  private computeDynamicStop(fillPrice: number, agent: AgentState, symbol: SymbolState, direction: PositionDirection = 'long'): number { return computeDynamicStopFn(this, fillPrice, agent, symbol, direction); }
  private computeDynamicTarget(fillPrice: number, agent: AgentState, symbol: SymbolState, direction: PositionDirection = 'long'): number { return computeDynamicTargetFn(this, fillPrice, agent, symbol, direction); }
  private getPositionDirection(position: PositionState | null | undefined): PositionDirection { return getPositionDirectionFn(this, position); }
  private getPositionUnrealizedPnl(position: PositionState, markPrice: number): number { return getPositionUnrealizedPnlFn(this, position, markPrice); }
  private resolveEntryDirection(agent: AgentState, symbol: SymbolState, score: number, intel?: any): PositionDirection { return resolveEntryDirectionFn(this, agent, symbol, score, intel); }
  private computeGrossPnl(position: PositionState, exitPrice: number, quantity: number): number { return computeGrossPnlFn(this, position, exitPrice, quantity); }
  private getSessionBucket(isoTs = new Date().toISOString()): SessionBucket { return getSessionBucketFn(this, isoTs) as SessionBucket; }
  private getVolatilityBucket(symbol: SymbolState): 'low' | 'medium' | 'high' { return getVolatilityBucketFn(this, symbol); }
  private relativeMove(history: number[], lookback: number): number {
    const slice = history.slice(-lookback);
    if (slice.length === 0) return 0;
    const base = history.slice(-lookback * 2, -lookback);
    if (base.length === 0) return 0;
    return average(slice) / average(base) - 1;
  }
  private countConsecutiveLosses(outcomes: number[]): number { return countConsecutiveLossesFn(this, outcomes); }
  private getSymbolCluster(symbol: SymbolState): any { return getSymbolClusterFn(this, symbol); }
  private getClusterLimitPct(cluster: any): number { return getClusterLimitPctFn(this, cluster); }
  private getSymbolGuard(symbol: string): SymbolGuardState | null { return getSymbolGuardFn(this, symbol); }
  private restoreSymbolGuards(): void { restoreSymbolGuardsFn(this); }
  private checkSymbolKillswitch(agent: AgentState): void { checkSymbolKillswitchFn(this, agent); }
  private persistSymbolGuards(): void { persistSymbolGuardsFn(this); }
  private updateSymbolGuard(symbol: string, mutation: any): void { updateSymbolGuardFn(this, symbol, mutation); }
  private noteTradeOutcome(agent: AgentState, symbol: SymbolState, realized: number, reason: string): void { noteTradeOutcomeFn(this, agent, symbol, realized, reason); }
  private applySpreadShockGuard(symbol: SymbolState): void { applySpreadShockGuardFn(this, symbol); }
  private queueEventDrivenExit(symbol: SymbolState, trigger: string): void { queueEventDrivenExitFn(this, symbol, trigger); }
  private async processEventDrivenExitQueue(): Promise<void> { await processEventDrivenExitQueueFn(this); }
  private getExecutionQualityByBroker() { return getExecutionQualityByBrokerFn(this); }
  private getExecutionQualityMultiplier(broker: BrokerId): number { return getExecutionQualityMultiplierFn(this, broker); }
  private getPortfolioRiskSnapshot() { return getRiskControlSnapshotFn(this); }
  private wouldBreachPortfolioRiskBudget(agent: AgentState, symbol: SymbolState, proposedNotional: number): boolean { return wouldBreachPortfolioRiskBudgetFn(this, agent, symbol, proposedNotional); }
  private evaluateSessionKpiGate(symbol: SymbolState) { return evaluateSessionKpiGateFn(this, symbol); }
  private maybeGenerateWeeklyReport(): void { /* Moved to persistence */ }
  private percentile(values: number[], p: number): number { return percentileFn(this, values, p); }
  private computeDataFreshnessP95Ms(): number { return 100; /* Placeholder */ }
  private computeOrderAckP95Ms(): number { return 50; }
  private computeBrokerErrorRatePct(): number { return 0; }
  private evaluateSloAndOperationalKillSwitch(): void { /* Handled in guardians */ }
  private evaluatePortfolioCircuitBreaker(): void { evaluatePortfolioCircuitBreakerFn(this); }
  private getOrderFlowDepth(symbol: string) { return null; }
  private evaluateCryptoExecutionGuard(symbol: SymbolState, intel: any) { return evaluateCryptoExecutionGuardFn(this, symbol, intel); }
  private buildRegimeKpis(regime: string, entries: TradeJournalEntry[]) { return buildRegimeKpisFn(this, regime, entries); }

  private getRegimeThrottleMultiplier(regime: string, style: AgentStyle): number {
    return getRegimeThrottleMultiplierFn(this, regime, style);
  }

  private computeConfidenceCalibrationMultiplier(agent: AgentState, decision: AiCouncilDecision | null): number {
    return computeConfidenceCalibrationMultiplierFn(this, agent, decision);
  }

  private computeCorrelation(a: number[], b: number[]): number {
    return _computeCorrelation(this, a, b);
  }

  private breachesCrowdingLimit(candidate: SymbolState): boolean {
    return _breachesCrowdingLimit(this, candidate);
  }

  private evaluateWalkForwardPromotion(agent: AgentState, candidate: AgentConfig, champion: AgentConfig): WalkForwardResult {
    return _evaluateWalkForwardPromotion(this, agent, candidate, champion);
  }

  private buildForensics(entry: TradeJournalEntry): TradeForensicsRow {
    return _buildForensics(this, entry);
  }

  private getAgentBroker(agent: AgentState): BrokerId {
    return agent.config.broker;
  }

  private formatBrokerLabel(broker: BrokerId): string { return _formatBrokerLabel(this, broker); }

  private readonly startedAt = new Date();
  private readonly market = new Map<string, SymbolState>();
  private readonly agents = new Map<string, AgentState>();
  private readonly fills: AgentFillEvent[] = [];
  private readonly journal: TradeJournalEntry[] = [];
  private readonly deskCurve: number[] = [];
  private readonly benchmarkCurve: number[] = [];
  private readonly aiCouncil = getAiCouncil();
  private readonly signalBus = getSignalBus();
  private readonly marketIntel = getMarketIntel();
  private readonly newsIntel = getNewsIntel();
  private readonly eventCalendar = getEventCalendar();
  private readonly insiderRadar = getInsiderRadar();
  private readonly derivativesIntel = getDerivativesIntel();
  private marketDataSources: PersistedMarketDataState['sources'] = [];
  private brokerPaperAccount: BrokerPaperAccountState | null = null;
  private brokerOandaAccount: BrokerPaperAccountState | null = null;
  private brokerCoinbaseAccount: BrokerPaperAccountState | null = null;
  private metaJournalCache: TradeJournalEntry[] = [];
  private metaJournalCacheAtMs = 0;
  private metaModelCache: ModelState | null = null;
  private readonly featureStore = getFeatureStore();
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;
  private redisSubscriber: Redis | null = null;
  private stepInFlight = false;
  private scalpRouteCandidates = new Map<string, ScalpRouteState>();
  private selectedScalpByAssetClass = new Map<AssetClass, string>();
  private selectedScalpOverallId: string | null = null;
  private lastBrokerSyncAtMs = 0;
  private readonly pendingEventExitReasons = new Map<string, string>();
  private readonly symbolGuards = new Map<string, SymbolGuardState>();
  private readonly executionQualityCounters = new Map<BrokerId, ExecutionQualityCounters>();
  private latestWeeklyReport: WeeklyReportState | null = null;
  private nextWeeklyCheckAtMs = 0;
  private regimeKpis: RegimeKpiRow[] = [];
  private latestSlo: SloStatusState = {
    dataFreshnessP95Ms: 0,
    orderAckP95Ms: 0,
    brokerErrorRatePct: 0,
    breaches: []
  };
  private walkForwardResults = new Map<string, WalkForwardResult>();
  private readonly forensicRows: TradeForensicsRow[] = [];
  private circuitBreakerLatched = false;
  private circuitBreakerScope: 'none' | 'daily' | 'weekly' = 'none';
  private circuitBreakerReason = '';
  private circuitBreakerArmedAt: string | null = null;
  private circuitBreakerReviewed = false;

  // COO FIX #1: Per-pair daily loss limit — tracks PnL per symbol per UTC day.
  // If EUR/USD loses >$200 today, agent targeting it gets a symbolKillSwitchUntil tomorrow 00:00 UTC.
  private dailyPnLBySymbol = new Map<string, number>();
  private dailyLossResetDate = ''; // YYYY-MM-DD UTC

  // COO FIX #5: Equity-curve circuit breaker — tracks high-water mark for drawdown.
  // If equity falls >10% from HWM, flatten everything and halt for review.
  // All 3 brokers (Alpaca $100K + OANDA $100K + Coinbase $100K) are paper trading.
  // Circuit breaker uses $300K total firm capital as baseline.
  private equityHighWaterMark = STARTING_EQUITY * 3;

  private operationalKillSwitchUntilMs = 0;
  private readonly fileQueues = new Map<string, Promise<void>>();
  private _brokerPositionCache: Map<string, number> | null = null;
  private readonly HERMES_STARTING_EQUITY = STARTING_EQUITY;
  private readonly startingEquity = STARTING_EQUITY;
  private _lastRepatriationReport: RepatriationReport | null = null;

  constructor() {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    this.seedMarket();
    this.syncMarketFromRuntime(false);
    this.seedAgents();
    if (!this.restoreStateSnapshot()) {
      this.syncMarketFromRuntime(false);
      this.restoreLedgerHistory();
      this.normalizePresentationState();
    } else {
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

  start(): void {
    if (this.redisSubscriber) return;

    // Dedicated subscriber client for HFT events
    this.redisSubscriber = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    });

    this.redisSubscriber.on('connect', () => logger.info('Paper Engine connected to Redis HFT Bus'));

    // 1. Listen for Market Ticks (Sub-millisecond execution)
    this.redisSubscriber.subscribe(TOPICS.MARKET_TICK, (err) => {
      if (err) logger.error(`Failed to subscribe to market ticks: ${err.message}`);
    });

    // 2. Listen for Order Status updates (Async execution feedback)
    this.redisSubscriber.subscribe(TOPICS.ORDER_STATUS, (err) => {
      if (err) logger.error(`Failed to subscribe to order status: ${err.message}`);
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
        } else if (channel === TOPICS.ORDER_STATUS) {
          // Handle fill/reject feedback
          this.handleAsyncOrderStatus(data);
        }
      } catch (error) {
        logger.error(`Error processing Redis message on ${channel}: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    });

    void this.seedFromBrokerHistory().catch(() => {
      logger.warn('Broker history seed failed, retrying in 15s');
      setTimeout(() => { void this.seedFromBrokerHistory(); }, 15_000);
    });
  }

  private handleAsyncOrderStatus(data: any): void {
    handleAsyncOrderStatusFn(this, data);
  }

  private async seedFromBrokerHistory(): Promise<void> {
    return seedFromBrokerHistoryFn(this);
  }

  getSnapshot(): PaperDeskSnapshot {
    return _getSnapshot(this);
  }

  getJournal(): TradeJournalEntry[] {
    return [...this.journal];
  }

  getPositions(): PositionSnapshot[] {
    return _getPositions(this);
  }

  getMarketSnapshots(): MarketSnapshot[] {
    return _getMarketSnapshots(this);
  }

  applyAgentConfig(agentId: string, config: Partial<AgentConfig>): boolean {
    return _applyAgentConfig(this, agentId, config);
  }

  getAgentConfigs(): Array<{ agentId: string; config: AgentConfig; baselineConfig: AgentConfig; allocationMultiplier: number; allocationReason: string; deployment: AgentDeploymentState }> {
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

  getRecentEvents(limit = 200): unknown[] {
    return _getRecentEvents(this, limit);
  }

  getWeeklyReport(): WeeklyReportState | null {
    return this.latestWeeklyReport ? { ...this.latestWeeklyReport } : null;
  }

  getRiskControlSnapshot() {
    return _getRiskControlSnapshot(this);
  }

  acknowledgeCircuitBreaker(reviewNote: string): {
    released: boolean;
    state: ReturnType<PaperScalpingEngine['getRiskControlSnapshot']>;
  } {
    if (this.circuitBreakerLatched) {
      this.circuitBreakerLatched = false;
      this.circuitBreakerScope = 'none';
      this.circuitBreakerReason = '';
      this.circuitBreakerArmedAt = null;
      this.circuitBreakerReviewed = true;
      this.recordEvent('circuit-breaker-review', { reviewNote, released: true });
    } else {
      this.recordEvent('circuit-breaker-review', { reviewNote, released: false });
    }
    return { released: !this.circuitBreakerLatched, state: this.getRiskControlSnapshot() };
  }

  getCircuitBreakerState(): { latched: boolean; scope: string | null; reason: string | null; armedAt: string | null; reviewed: boolean } {
    return {
      latched: this.circuitBreakerLatched,
      scope: this.circuitBreakerScope === 'none' ? null : this.circuitBreakerScope,
      reason: this.circuitBreakerReason || null,
      armedAt: this.circuitBreakerArmedAt,
      reviewed: this.circuitBreakerReviewed
    };
  }

  resetCircuitBreaker(scope: string, reason: string): void {
    if (!this.circuitBreakerLatched) return;
    this.circuitBreakerLatched = false;
    this.circuitBreakerScope = 'none';
    this.circuitBreakerReason = '';
    this.circuitBreakerArmedAt = null;
    this.circuitBreakerReviewed = false;
    this.recordEvent('circuit-breaker-admin-reset', { scope, reason });
    console.log(`[CIRCUIT BREAKER] Admin reset. scope=${scope} reason=${reason}`);
  }

  getWalkForwardSnapshot(): WalkForwardResult[] {
    return _getWalkForwardSnapshot(this);
  }

  getLossForensics(limit = 12, symbol?: string): TradeForensicsRow[] {
    return _getLossForensics(this, limit, symbol);
  }

  getMetaLabelSnapshot(): Array<{
    agentId: string;
    symbol: string;
    style: AgentStyle;
    score: number;
    approve: boolean;
    probability: number;
    reason: string;
  }> {
    return _getMetaLabelSnapshot(this);
  }

  getMetaModelSnapshot(): unknown {
    const candidates = Array.from(this.agents.values())
      .map((agent) => {
        const symbol = this.market.get(agent.config.symbol);
        if (!symbol) return null;
        return {
          agentId: agent.config.id,
          candidate: this.buildMetaCandidate(agent, symbol, this.marketIntel.getCompositeSignal(symbol.symbol))
        };
      })
      .filter((entry): entry is { agentId: string; candidate: MetaLabelCandidate } => entry !== null);
    return buildMetaLabelModelSnapshot(this.getMetaJournalEntries(), candidates);
  }

  getLiveReadiness(): LiveReadinessReport {
    return getLiveReadinessReportFn(this);
  }

  private buildDeskAnalytics(): PaperDeskAnalytics { return getPaperDeskAnalyticsFn(this); }

  private buildExecutionBands(): PaperExecutionBand[] { return getExecutionBandsFn(this); }

  private buildStrategyTelemetry(): PaperStrategyTelemetry[] { return getStrategyTelemetryFn(this); }

  private buildMarketTape(journalRows?: TradeJournalEntry[]): PaperTapeSnapshot[] { return _buildMarketTape(this, journalRows); }

  private analyzeSignals(): void { _analyzeSignals(this); }

  private getDataSources(): DataSourceStatus[] { return _getDataSources(this); }

  private async reconcileBrokerPaperState(force = false): Promise<void> {
    return reconcileBrokerPaperStateFn(this, force);
  }

  private hasHermesBrokerPosition(agent: AgentState, brokerOrders: unknown[]): boolean {
    return _hasHermesBrokerPosition(this, agent, brokerOrders);
  }

  private syncBrokerPositionIntoAgent(
    agent: AgentState,
    symbol: SymbolState,
    brokerPosition: BrokerAccountPosition
  ): void {
    return syncBrokerPositionIntoAgentFn(this, agent, symbol, brokerPosition);
  }

  private finalizeBrokerFlat(agent: AgentState, symbol: SymbolState, reason: string): void {
    return finalizeBrokerFlatFn(this, agent, symbol, reason);
  }

  private async fetchBrokerAccount(broker: BrokerId): Promise<BrokerAccountSnapshot | null> {
    return fetchBrokerAccountFn(this, broker);
  }

  private async routeBrokerOrder(payload: {
    id: string;
    symbol: string;
    broker: BrokerId;
    side: OrderSide;
    orderType: 'market' | 'limit';
    notional: number;
    quantity: number;
    strategy: string;
    mode: 'paper';
    thesis: string;
  }): Promise<BrokerRouteResponse> {
    return routeBrokerOrderFn(this, payload);
  }

  private syncMarketFromRuntime(recordHistory: boolean): boolean {
    return syncMarketFromRuntimeFn(this, recordHistory);
  }

  private loadMarketDataState(): PersistedMarketDataState | null {
    return loadMarketDataStateFn(this);
  }

  private applyMarketSnapshot(symbol: SymbolState, snapshot: MarketSnapshot, recordHistory: boolean): void {
    return applyMarketSnapshotFn(this, symbol, snapshot, recordHistory);
  }

  private hasTradableTape(symbol: SymbolState | undefined): boolean {
    return _hasTradableTape(this, symbol);
  }

  private describeTapeFlags(symbol: SymbolState): string {
    return _describeTapeFlags(this, symbol);
  }

  private getTapeQualityBlock(symbol: SymbolState): string | null {
    return _getTapeQualityBlock(this, symbol);
  }

  private toCandles(history: number[]) {
    return _toCandles(this, history);
  }

  private seedMarket(): void {
    _seedMarket(this);
  }

  private seedAgents(): void {
    _seedAgents(this);
  }

  private async step(isRedisTick = false): Promise<void> { return stepFn(this, isRedisTick); }

  private async updateAgent(agent: AgentState): Promise<void> { return updateAgentFn(this, agent); }

  private refreshScalpRoutePlan(): void { return refreshScalpRoutePlanFn(this); }

  private getRouteBlock(agent: AgentState, symbol: SymbolState): string | null { return getRouteBlockFn(this, agent, symbol); }

  private rollToLiveSampleWindow(agent: AgentState, symbol: SymbolState): void {
    _rollToLiveSampleWindow(this, agent, symbol);
  }

  private async manageOpenPosition(agent: AgentState, symbol: SymbolState, score: number): Promise<void> { return manageOpenPositionFn(this, agent, symbol, score); }

  private maybeTrailBrokerStop(agent: AgentState, symbol: SymbolState): void {
    return maybeTrailBrokerStopFn(this, agent, symbol);
  }

  private async openPosition(agent: AgentState, symbol: SymbolState, score: number): Promise<void> { return openPositionFn(this, agent, symbol, score); }

  private classifySymbolRegime(symbol: SymbolState): string {
    return _classifySymbolRegime(this, symbol);
  }

  private buildJournalContext(symbol: SymbolState): any { return buildJournalContextFn(this, symbol); }

  private buildMetaCandidate(agent: AgentState, symbol: SymbolState, intel: any): any { return buildMetaCandidateFn(this, agent, symbol, intel); }

  private buildEntryMeta(agent: AgentState, symbol: SymbolState, score: number): any { return buildEntryMetaFn(this, agent, symbol, score); }

  private async closePosition(agent: AgentState, symbol: SymbolState, reason: string, forcePnl?: number): Promise<void> { return closePositionFn(this, agent, symbol, reason, forcePnl); }

  /**
   * Cross-exchange arbitrage handler.
   * Compares prices for the same symbol across Alpaca and Coinbase.
   * If the spread between venues exceeds round-trip costs, simulates the arb.
   */
  private updateArbAgent(agent: AgentState, symbol: SymbolState): void { return updateArbAgentFn(this, agent, symbol); }

  /** Adaptive cooldown: longer after losses in bad conditions, shorter when winning */
  private getAdaptiveCooldown(agent: AgentState, symbol: SymbolState): number {
    return _getAdaptiveCooldown(this, agent, symbol);
  }

  private shouldSimulateLocally(broker: BrokerId): boolean {
    return broker === 'coinbase-live' && !COINBASE_LIVE_ROUTING_ENABLED;
  }

  private async openBrokerPaperPosition(
    agent: AgentState,
    symbol: SymbolState,
    score: number,
    entryMeta: PositionEntryMetaState,
    decision: AiCouncilDecision,
    direction: PositionDirection
  ): Promise<void> {
    return openBrokerPaperPositionFn(this, agent, symbol, score, entryMeta, decision, direction);
  }

  private async closeBrokerPaperPosition(agent: AgentState, symbol: SymbolState, reason: string): Promise<void> {
    return closeBrokerPaperPositionFn(this, agent, symbol, reason);
  }

  private applyBrokerFilledEntry(
    agent: AgentState,
    symbol: SymbolState,
    report: BrokerRouteResponse,
    score: number,
    entryMeta?: PositionEntryMetaState
  ): void {
    return applyBrokerFilledEntryFn(this, agent, symbol, report, score, entryMeta);
  }

  private applyBrokerFilledExit(
    agent: AgentState,
    symbol: SymbolState,
    report: BrokerRouteResponse,
    reason: string,
    forcePnl?: number
  ): void {
    return applyBrokerFilledExitFn(this, agent, symbol, report, reason, forcePnl);
  }

  private describeWatchState(style: AgentStyle, symbol: SymbolState, score: number): string {
    return describeWatchStateFn(this, style, symbol, score);
  }

  private describeAiState(decision: AiCouncilDecision): string {
    return describeAiStateFn(this, decision);
  }

  private getMetaLabelDecision(agent: AgentState, symbol: SymbolState, score: number, intel: any): any { return getMetaLabelDecisionFn(this, agent, symbol, score, intel); }

  private getMetaJournalEntries(): TradeJournalEntry[] {
    return _getMetaJournalEntries(this);
  }

  private normalizeFlowBucket(direction: string): 'bullish' | 'bearish' | 'neutral' {
    return normalizeFlowBucketFn(this, direction);
  }

  private getConfidenceBucket(confidence: number): 'low' | 'medium' | 'high' {
    return getConfidenceBucketFn(this, confidence);
  }

  private getSpreadBucket(spreadBps: number, limitBps: number): 'tight' | 'medium' | 'wide' {
    return getSpreadBucketFn(this, spreadBps, limitBps);
  }

  private getContextualMetaSignal(agent: AgentState, symbol: SymbolState, intel: any): any { return getContextualMetaSignalFn(this, agent, symbol, intel); }

  private entryNote(style: AgentStyle, symbol: SymbolState, score: number): string {
    return entryNoteFn(this, style, symbol, score);
  }

  private getEntryScore(style: AgentStyle, shortReturn: number, mediumReturn: number, symbol: SymbolState): number {
    return getEntryScoreFn(this, style, shortReturn, mediumReturn, symbol);
  }

  private entryThreshold(style: AgentStyle): number {
    return entryThresholdFn(this, style);
  }

  private exitThreshold(_style: AgentStyle): number {
    return exitThresholdFn(this, _style);
  }

  private estimatedBrokerRoundTripCostBps(symbol: SymbolState, orderMode: 'taker' | 'maker' = 'taker'): number {
    return estimatedBrokerRoundTripCostBpsFn(this, symbol, orderMode);
  }

  private fastPathThreshold(style: AgentStyle): number {
    return fastPathThresholdFn(this, style);
  }

  private brokerRulesFastPathThreshold(agent: AgentState, _symbol: SymbolState): number {
    return brokerRulesFastPathThresholdFn(this, agent, _symbol);
  }

  private canUseBrokerRulesFastPath(
    agent: AgentState,
    symbol: SymbolState,
    score: number,
    aiDecision: AiCouncilDecision | null
  ): boolean {
    return canUseBrokerRulesFastPathFn(this, agent, symbol, score, aiDecision);
  }

  private canEnter(agent: AgentState, symbol: SymbolState, shortReturn: number, mediumReturn: number, score: number): boolean { return canEnterFn(this, agent, symbol, shortReturn, mediumReturn, score); }

  private getManagerBlock(agent: AgentState, symbol: SymbolState): string | null { return getManagerBlockFn(this, agent, symbol); }

  private summarizePerformance(entries: TradeJournalEntry[]): PerformanceSummary {
    return _summarizePerformance(this, entries);
  }

  private getPrecisionBlock(agent: AgentState, symbol: SymbolState): string | null { return getPrecisionBlockFn(this, agent, symbol); }

  private toLiveReadiness(agent: AgentState): AgentLiveReadiness { return _toLiveReadiness(this, agent); }

  private applyAdaptiveTuning(agent: AgentState, symbol: SymbolState): void {
    _applyAdaptiveTuning(this, agent, symbol);
  }

  private wilsonBound(successes: number, total: number, z = 1.0, mode: 'lower' | 'upper' = 'lower'): number {
    return _wilsonBound(this, successes, total, z, mode);
  }

  private getRecentJournalEntries(agent: AgentState, symbol: SymbolState | null, limit = 12): TradeJournalEntry[] {
    return _getRecentJournalEntries(this, agent, symbol, limit);
  }

  private buildMistakeProfile(agent: AgentState, symbol: SymbolState | null, entries: TradeJournalEntry[]): MistakeLearningProfile {
    return _buildMistakeProfile(this, agent, symbol, entries);
  }

  private applyMistakeDrivenRefinement(
    agent: AgentState,
    symbol: SymbolState | null,
    profile: MistakeLearningProfile
  ): void {
    _applyMistakeDrivenRefinement(this, agent, symbol, profile);
  }

  private refreshCapitalAllocation(): void {
    _refreshCapitalAllocation(this);
  }

  private evaluateChallengerProbation(agent: AgentState, symbol: SymbolState): void {
    _evaluateChallengerProbation(this, agent, symbol);
  }

  private getAgentNetPnl(agent: AgentState): number { return getAgentNetPnlFn(this, agent); }
  private getAgentEquity(agent: AgentState): number { return getAgentEquityFn(this, agent); }
  private getDeskEquity(): number { return getDeskEquityFn(this); }
  private getBenchmarkEquity(): number { return getBenchmarkEquityFn(this); }
  private getDeskAgentStates(): AgentState[] { return getDeskAgentStatesFn(this); }
  private getDeskStartingEquity(): number { return getDeskStartingEquityFn(this); }
  private getRepatriationSummary(): { adopted: number; orphaned: number; lastRunAt: string | null } {
    return {
      adopted: this._lastRepatriationReport?.adopted ?? 0,
      orphaned: this._lastRepatriationReport?.orphaned ?? 0,
      lastRunAt: this._lastRepatriationReport ? new Date().toISOString() : null
    };
  }
  private getBrokerPaperAgentByStrategy(strategy: string) { return Array.from(this.agents.values()).find(a => a.config.executionMode === 'broker-paper' && strategy.includes(a.config.name)) || null; }
  private isHermesBrokerOrderId(orderId: any): boolean { return isHermesBrokerOrderIdFn(this, orderId); }
  private getBrokerSellQuantity(agent: AgentState, tracked: number): number { return getBrokerSellQuantityFn(this, agent, tracked); }
  private getLatestBrokerPositions(): Map<string, number> { return getLatestBrokerPositionsFn(this); }
  private matchesHermesBrokerOrderForAgent(agent: AgentState, orderId: any): boolean { return matchesHermesBrokerOrderForAgentFn(this, agent, orderId); }
  private isOwnedBrokerFill(fill: AgentFillEvent): boolean { return isOwnedBrokerFillFn(this, fill); }
  private isOwnedBrokerJournal(entry: TradeJournalEntry): boolean { return isOwnedBrokerJournalFn(this, entry); }
  private isRestoredExternalBrokerJournal(entry: any): boolean { return isRestoredExternalBrokerJournalFn(this, entry); }
  private isRestoredExternalBrokerExitFill(fill: any, journal: any): boolean { return isRestoredExternalBrokerExitFillFn(this, fill, journal); }
  private hasMatchingOwnedBrokerEntryFill(fill: any, fills: any): boolean { return hasMatchingOwnedBrokerEntryFillFn(this, fill, fills); }
  private sanitizeBrokerPaperRuntimeState(): void { sanitizeBrokerPaperRuntimeStateFn(this); }
  private getVisibleFills(): AgentFillEvent[] { return getVisibleFillsFn(this); }
  private seedAgentCountersFromJournal(): void {
    // Load journal from disk (may already be in memory if snapshot was restored)
    const diskEntries = this.journal.length === 0
      ? readJsonLines<TradeJournalEntry>(JOURNAL_LEDGER_PATH)
      : this.journal;
    for (const agent of this.agents.values()) {
      const filtered = diskEntries.filter(e => e.strategyId === agent.config.id);
      if (filtered.length === 0) continue;
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
  private toBrokerPaperAccountState(snap: any) { return toBrokerPaperAccountStateFn(this, snap); }
  private normalizePresentationState(): void { normalizePresentationStateFn(this); }
  private toAgentSnapshot(agent: AgentState): PaperAgentSnapshot { return toAgentSnapshotFn(this, agent); }
  private recordFill(params: any): void { recordFillFn(this, params); }
  private recordEvent(type: string, payload: any): void { recordEventFn(this, type, payload); }
  private recordJournal(entry: TradeJournalEntry): void { recordJournalFn(this, entry); }
  private restoreStateSnapshot(): boolean { return restoreStateSnapshotFn(this); }
  private restoreLedgerHistory(): boolean { return restoreLedgerHistoryFn(this); }
  private loadAgentConfigOverrides(): Record<string, Partial<AgentConfig>> { return loadAgentConfigOverridesFn(this); }
  private persistAgentConfigOverrides(): void { persistAgentConfigOverridesFn(this); }
  private persistStateSnapshot(): void { persistStateSnapshotFn(this); }
  private recordTickEvent(): void { recordTickEventFn(this); }
  private appendLedger(filePath: string, payload: unknown): void { appendLedgerFn(this, filePath, payload); }
  private rewriteLedger(filePath: string, entries: unknown[]): void { rewriteLedgerFn(this, filePath, entries); }
  private enqueueWrite(filePath: string, operation: any): void { enqueueWriteFn(this, filePath, operation); }
  private maybeRotateLog(filePath: string, maxMB: number): void { maybeRotateLogFn(this, filePath, maxMB); }
  private maybeRotateEventLog(): void { maybeRotateEventLogFn(this); }
  private computeHalfKelly(agent: AgentState): number { return computeHalfKellyFn(this, agent); }
  private pushPoint(target: number[], value: number, limit = HISTORY_LIMIT): void {
    target.push(round(value, 2));
    if (target.length > limit) target.shift();
  }
}

export { PaperScalpingEngine };
export { getPaperEngine } from './paper-engine/engine-lifecycle.js';
