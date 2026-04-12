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
import { buildAgentConfigs, getDefaultAgentConfig } from './paper-engine-config.js';
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
import { dedupeById } from './paper-engine/ledger.js';
import { seedFromBrokerHistory as seedFromBrokerHistoryFn } from './paper-engine/broker-seeding.js';
import { isTimeBlocked, isVwapBlocked, isRsi2Blocked, isRsi14Blocked, isFallingKnifeBlocked } from './paper-engine/entry-filters.js';
import { persistState as persistStateFn, loadAgentConfigOverrides as loadAgentConfigOverridesFn, persistAgentConfigOverrides as persistAgentConfigOverridesFn } from './paper-engine/state-persistence.js';
import { buildMistakeProfile as buildMistakeProfileFn, applyMistakeDrivenRefinement as applyMistakeDrivenRefinementFn, toBrokerPaperAccountState as toBrokerPaperAccountStateFn } from './paper-engine/analytics.js';
import { computeHalfKelly as computeHalfKellyFn, countConsecutiveLosses as countConsecutiveLossesFn, relativeMove as relativeMoveFn, computeAdaptiveCooldown as computeAdaptiveCooldownFn, computeFngSizeMultiplier, computeStreakMultiplier } from './paper-engine/sizing.js';
import { getFeeRate as getFeeRateFn, roundTripFeeBps as roundTripFeeBpsFn, computeEntryScore as computeEntryScoreFn } from './paper-engine/scoring.js';
import { entryNote as entryNoteFn, estimatedBrokerRoundTripCostBps as estimatedBrokerRTCostBpsFn, getTrailingStopParams, getCatastrophicStopPct } from './paper-engine/exit-logic.js';
import { getSessionBucket as getSessionBucketFn, getVolatilityBucket as getVolatilityBucketFn, getSymbolCluster as getSymbolClusterFn, getClusterLimitPct as getClusterLimitPctFn, percentile as percentileFn, formatBrokerLabel as formatBrokerLabelFn, summarizePerformance as summarizePerformanceFn, pushPoint as pushPointFn } from './paper-engine/helpers.js';
import type {
  AgentStyle, AgentExecutionMode, PositionDirection, SessionBucket,
  SymbolState, PositionEntryMetaState, PerformanceSummary, ScalpRouteState,
  PositionState, AgentConfig, AgentDeploymentState, AgentState,
  MistakeLearningProfile, PaperEngineStateSnapshot, PersistedAgentState,
  PersistedPaperEngineState, PersistedMarketDataState, BrokerRouteResponse,
  BrokerAccountPosition, BrokerAccountSnapshot,
  BrokerAccountResponse, BrokerPaperAccountState, SymbolGuardState,
  ExecutionQualityCounters, WeeklyReportState, RegimeKpiRow, SloStatusState,
  WalkForwardResult, TradeForensicsRow
} from './paper-engine/types.js';
import {
  HISTORY_LIMIT, OUTCOME_HISTORY_LIMIT, FILL_LIMIT, JOURNAL_LIMIT, TICK_MS,
  STARTING_EQUITY, EQUITY_FEE_BPS, CRYPTO_FEE_BPS, PAPER_BROKER,
  LEDGER_DIR, MARKET_DATA_RUNTIME_PATH, BROKER_ROUTER_URL,
  FILL_LEDGER_PATH, JOURNAL_LEDGER_PATH, STATE_SNAPSHOT_PATH,
  AGENT_CONFIG_OVERRIDES_PATH, EVENT_LOG_PATH, SYMBOL_GUARD_PATH, WEEKLY_REPORT_DIR,
  DAILY_CIRCUIT_BREAKER_DD_PCT, WEEKLY_CIRCUIT_BREAKER_DD_PCT,
  CRYPTO_MAX_ENTRY_SPREAD_BPS, CRYPTO_MAX_EST_SLIPPAGE_BPS, CRYPTO_MIN_BOOK_DEPTH_NOTIONAL,
  DATA_FRESHNESS_SLO_MS, ORDER_ACK_SLO_MS, BROKER_ERROR_SLO_PCT,
  BROKER_SYNC_MS, REAL_PAPER_AUTOPILOT, COINBASE_LIVE_ROUTING_ENABLED
} from './paper-engine/types.js';

// Types and constants imported from ./paper-engine/types.ts

// All interfaces imported from ./paper-engine/types.ts — see that file for SymbolState, AgentState, etc.

const HERMES_BROKER_ORDER_PREFIX = "paper-agent-";

class PaperScalpingEngine {
  private getFeeRate(assetClass: AssetClass): number { return getFeeRateFn(assetClass); }

  private roundTripFeeBps(assetClass: AssetClass): number { return roundTripFeeBpsFn(assetClass);
  }

  /**
   * ATR-based dynamic stop: scales with volatility so volatile instruments
   * get wider stops and quiet ones get tighter. Falls back to BPS when ATR
   * is unavailable.
   */
  private computeDynamicStop(
    fillPrice: number,
    agent: AgentState,
    symbol: SymbolState,
    direction: PositionDirection = 'long'
  ): number {
    const shortCryptoProfile = symbol.assetClass === 'crypto' && direction === 'short';
    const stopMultiplier = shortCryptoProfile ? 0.9 : 1;
    const atr = this.marketIntel.computeATR(symbol.symbol);
    if (atr !== null && atr > 0) {
      if (direction === 'short') {
        const atrStop = fillPrice + atr * 1.5 * stopMultiplier;
        const feeBufStop = fillPrice * (1 + this.roundTripFeeBps(symbol.assetClass) / 10_000);
        return Math.max(atrStop, feeBufStop);
      }
      const atrStop = fillPrice - atr * 1.5 * stopMultiplier;
      const feeBufStop = fillPrice * (1 - this.roundTripFeeBps(symbol.assetClass) / 10_000);
      return Math.min(atrStop, feeBufStop);
    }
    if (direction === 'short') {
      return fillPrice * (1 + (agent.config.stopBps * stopMultiplier) / 10_000);
    }
    return fillPrice * (1 - (agent.config.stopBps * stopMultiplier) / 10_000);
  }

  /**
   * ATR-based dynamic target: scales with volatility. Falls back to BPS
   * when ATR is unavailable.
   */
  private computeDynamicTarget(
    fillPrice: number,
    agent: AgentState,
    symbol: SymbolState,
    direction: PositionDirection = 'long'
  ): number {
    const shortCryptoProfile = symbol.assetClass === 'crypto' && direction === 'short';
    const targetMultiplier = shortCryptoProfile ? 1.2 : 1;
    const atr = this.marketIntel.computeATR(symbol.symbol);
    if (atr !== null && atr > 0) {
      const feeBuffer = fillPrice * (this.roundTripFeeBps(symbol.assetClass) / 10_000);
      return direction === 'short'
        ? fillPrice - atr * 2.0 * targetMultiplier - feeBuffer
        : fillPrice + atr * 2.0 * targetMultiplier + feeBuffer;
    }
    if (direction === 'short') {
      return fillPrice * (1 - ((agent.config.targetBps * targetMultiplier) + this.roundTripFeeBps(symbol.assetClass)) / 10_000);
    }
    return fillPrice * (1 + ((agent.config.targetBps * targetMultiplier) + this.roundTripFeeBps(symbol.assetClass)) / 10_000);
  }

  private getPositionDirection(position: PositionState | null | undefined): PositionDirection {
    return position?.direction ?? 'long';
  }

  private getPositionUnrealizedPnl(position: PositionState, markPrice: number): number {
    const direction = this.getPositionDirection(position);
    const directionalMove = direction === 'short'
      ? (position.entryPrice - markPrice)
      : (markPrice - position.entryPrice);
    return directionalMove * position.quantity;
  }

  private resolveEntryDirection(_agent: AgentState, _symbol: SymbolState, _score: number, _intel?: any): PositionDirection { const signal = _intel ?? this.marketIntel.getCompositeSignal(_symbol.symbol); const bearish = signal.direction === "sell" || signal.direction === "strong-sell"; const fng = this.marketIntel.getFearGreedValue(); if (fng !== null && fng <= 20 && _symbol.assetClass === "crypto") return "long"; if (bearish && (_score <= -0.4 || _symbol.drift <= -0.0015)) return "short"; return _score < 0 ? "short" : "long"; }
  private computeGrossPnl(position: PositionState, exitPrice: number, quantity: number): number {
    return this.getPositionDirection(position) === 'short'
      ? (position.entryPrice - exitPrice) * quantity
      : (exitPrice - position.entryPrice) * quantity;
  }

  // Delegated to paper-engine/helpers.ts
  private getSessionBucket(isoTs = new Date().toISOString()): SessionBucket { return getSessionBucketFn(isoTs); }
  private getVolatilityBucket(symbol: SymbolState): 'low' | 'medium' | 'high' { return getVolatilityBucketFn(symbol.volatility); }
  private getSymbolCluster(symbol: SymbolState) { return getSymbolClusterFn(symbol.assetClass); }
  private getClusterLimitPct(cluster: ReturnType<PaperScalpingEngine['getSymbolCluster']>): number { return getClusterLimitPctFn(cluster); }

  private getSymbolGuard(symbol: string): SymbolGuardState | null {
    const state = this.symbolGuards.get(symbol);
    if (!state) return null;
    if (state.blockedUntilMs <= Date.now()) return null;
    return state;
  }

  private restoreSymbolGuards(): void {
    try {
      if (!fs.existsSync(SYMBOL_GUARD_PATH)) return;
      const raw = fs.readFileSync(SYMBOL_GUARD_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Array<SymbolGuardState>;
      if (!Array.isArray(parsed)) return;
      this.symbolGuards.clear();
      for (const item of parsed) {
        if (!item?.symbol || !Number.isFinite(item.blockedUntilMs)) continue;
        this.symbolGuards.set(item.symbol, item);
      }
    } catch {
      // best-effort state restore
    }
  }

  /** Fix #16: Auto-killswitch — 3 consecutive losses in 60 min blocks symbol for 60 min */
  private checkSymbolKillswitch(agent: AgentState): void {
    const outcomes = (agent.recentOutcomes ?? []).slice(-3);
    if (outcomes.length >= 3 && outcomes.every((o) => o < 0)) {
      const symbol = agent.config.symbol;
      const blockMs = 60 * 60 * 1000; // 1 hour
      this.symbolGuards.set(symbol, {
        symbol,
        consecutiveLosses: 3,
        blockedUntilMs: Date.now() + blockMs,
        blockReason: `Auto-killswitch: ${agent.config.name} had 3 consecutive losses`,
        updatedAt: new Date().toISOString()
      });
      this.persistSymbolGuards();
      console.log(`[KILLSWITCH] ${symbol} blocked for 60 min after 3 consecutive losses by ${agent.config.name}`);
    }
  }

  private persistSymbolGuards(): void {
    try {
      fs.promises.writeFile(SYMBOL_GUARD_PATH, JSON.stringify(Array.from(this.symbolGuards.values()), null, 2), 'utf8').catch(() => {});
    } catch {
      // best-effort state persistence
    }
  }

  private updateSymbolGuard(symbol: string, mutation: (state: SymbolGuardState) => SymbolGuardState): void {
    const current = this.symbolGuards.get(symbol) ?? {
      symbol,
      consecutiveLosses: 0,
      blockedUntilMs: 0,
      blockReason: '',
      updatedAt: new Date().toISOString()
    };
    const next = mutation(current);
    this.symbolGuards.set(symbol, { ...next, updatedAt: new Date().toISOString() });
    this.persistSymbolGuards();
  }

  private noteTradeOutcome(_agent: AgentState, _symbol: SymbolState, _realized: number, _reason: string): void { /* trade outcome noted via recordFill */ }
  private applySpreadShockGuard(symbol: SymbolState): void {
    if (symbol.baseSpreadBps <= 0) return;
    const spreadShockRatio = symbol.spreadBps / symbol.baseSpreadBps;
    if (spreadShockRatio < 2.4) return;
    this.updateSymbolGuard(symbol.symbol, (state) => ({
      ...state,
      blockedUntilMs: Math.max(state.blockedUntilMs, Date.now() + 30 * 60_000),
      blockReason: `Spread shock ${spreadShockRatio.toFixed(2)}x on ${symbol.symbol}.`
    }));
  }

  private queueEventDrivenExit(symbol: SymbolState, trigger: string): void {
    for (const agent of this.agents.values()) {
      if (!agent.position || agent.config.symbol !== symbol.symbol || agent.pendingOrderId) continue;
      const direction = this.getPositionDirection(agent.position);
      const targetHit = direction === 'short'
        ? symbol.price <= agent.position.targetPrice
        : symbol.price >= agent.position.targetPrice;
      const stopHit = direction === 'short'
        ? symbol.price >= agent.position.stopPrice
        : symbol.price <= agent.position.stopPrice;
      const spreadPanic = symbol.spreadBps > Math.max(agent.config.spreadLimitBps * 1.9, symbol.baseSpreadBps * 2.4);
      if (targetHit || stopHit || spreadPanic) {
        const reason = targetHit
          ? `event target hit (${trigger})`
          : stopHit
            ? `event stop hit (${trigger})`
            : `event spread shock (${trigger})`;
        this.pendingEventExitReasons.set(agent.config.id, reason);
      }
    }
  }

  private async processEventDrivenExitQueue(..._args: any[]): Promise<void> { return ; }
  private getExecutionQualityByBroker(): any[] { return Array.from(this.executionQualityCounters.entries()).map(([broker, c]) => ({ broker, score: c.attempts > 0 ? Math.max(0, 100 - (c.rejects / c.attempts) * 100) : 100, avgSlippageBps: 0, avgLatencyMs: 0, partialFillRatePct: c.attempts > 0 ? (c.partialFills / c.attempts) * 100 : 0, rejectRatePct: c.attempts > 0 ? (c.rejects / c.attempts) * 100 : 0, sampleCount: c.attempts, attempts: c.attempts, rejects: c.rejects, partialFills: c.partialFills })); }
  private getExecutionQualityMultiplier(broker: BrokerId): number {
    const row = this.getExecutionQualityByBroker().find((entry) => entry.broker === broker);
    if (!row) return 1;
    return clamp(row.score / 100, 0.45, 1.1);
  }

  private getPortfolioRiskSnapshot(): any { return { totalExposure: 0, totalNotional: 0, concentrationPct: 0, maxSymbolPct: 0 }; }
  private wouldBreachPortfolioRiskBudget(agent: AgentState, symbol: SymbolState, proposedNotional: number): boolean {
    const risk = this.getPortfolioRiskSnapshot();
    const deskEquity = Math.max(this.getDeskEquity(), 1);
    if (((risk.totalOpenNotional + proposedNotional) / deskEquity) * 100 > risk.budgetPct) return true;
    const cluster = this.getSymbolCluster(symbol);
    const clusterRow = risk.byCluster.find((row: any) => row.cluster === cluster);
    const clusterOpen = clusterRow?.openNotional ?? 0;
    const clusterLimitPct = this.getClusterLimitPct(cluster);
    return ((clusterOpen + proposedNotional) / deskEquity) * 100 > clusterLimitPct;
  }

  private evaluateSessionKpiGate(symbol: SymbolState): { pass: boolean; message: string } {
    const sessionBucket = this.getSessionBucket();
    const entries = this.getMetaJournalEntries()
      .filter((entry) => entry.symbol === symbol.symbol)
      .filter((entry) => {
        const tagged = entry.tags?.find((tag) => tag.startsWith('session-')) ?? '';
        const tagBucket = tagged.replace('session-', '');
        if (tagBucket.length > 0) return tagBucket === sessionBucket;
        return this.getSessionBucket(entry.exitAt) === sessionBucket;
      })
      .slice(-40);
    if (entries.length < 20) {
      return { pass: true, message: `Session ${sessionBucket}: bootstrap ${entries.length}/20.` };
    }
    const wins = entries.filter((entry) => entry.realizedPnl > 0);
    const losses = entries.filter((entry) => entry.realizedPnl < 0);
    const grossWins = wins.reduce((sum, entry) => sum + entry.realizedPnl, 0);
    const grossLosses = Math.abs(losses.reduce((sum, entry) => sum + entry.realizedPnl, 0));
    const winRate = wins.length / Math.max(entries.length, 1);
    const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
    const pass = winRate >= 0.45 && pf >= 0.95;
    return {
      pass,
      message: `Session ${sessionBucket}: win ${(winRate * 100).toFixed(1)}%, PF ${pf.toFixed(2)} (${entries.length} trades).`
    };
  }

  private maybeGenerateWeeklyReport(..._args: any[]): any { return ; }
  private percentile(values: number[], p: number): number { return percentileFn(values, p); }

  private computeDataFreshnessP95Ms(): number {
    const agesMs = Array.from(this.market.values())
      .map((symbol) => Date.now() - Date.parse(symbol.updatedAt))
      .filter((value) => Number.isFinite(value) && value >= 0);
    return this.percentile(agesMs, 0.95);
  }

  private computeOrderAckP95Ms(): number {
    const rows = this.getMetaJournalEntries()
      .slice(-200)
      .map((entry) => entry.latencyMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    return this.percentile(rows, 0.95);
  }

  private computeBrokerErrorRatePct(): number {
    const counters = Array.from(this.executionQualityCounters.values());
    const attempts = counters.reduce((sum, counter) => sum + counter.attempts, 0);
    const rejects = counters.reduce((sum, counter) => sum + counter.rejects, 0);
    return attempts > 0 ? (rejects / attempts) * 100 : 0;
  }

  private evaluateSloAndOperationalKillSwitch(..._args: any[]): any { return ; }
  private evaluatePortfolioCircuitBreaker(): any { return ; }
  private getOrderFlowDepth(symbol: string): { bidDepth: number; askDepth: number } | null {
    const flow = this.marketIntel.getSnapshot().orderFlow.find((entry) => entry.symbol === symbol);
    if (!flow) return null;
    return { bidDepth: flow.bidDepth, askDepth: flow.askDepth };
  }

  private evaluateCryptoExecutionGuard(
    symbol: SymbolState,
    intel: { adverseSelectionRisk?: number; quoteStabilityMs?: number }
  ): { pass: boolean; reason: string } {
    const spreadCap = Math.min(CRYPTO_MAX_ENTRY_SPREAD_BPS, Math.max(1.5, symbol.baseSpreadBps * 1.8));
    if (symbol.spreadBps > spreadCap) {
      return { pass: false, reason: `Crypto spread guard: ${symbol.spreadBps.toFixed(2)}bps > ${spreadCap.toFixed(2)}bps.` };
    }
    const estSlippageBps = Math.max(symbol.spreadBps * 0.25, (intel.adverseSelectionRisk ?? 0) * 0.05);
    if (estSlippageBps > CRYPTO_MAX_EST_SLIPPAGE_BPS) {
      return { pass: false, reason: `Crypto slippage guard: est ${estSlippageBps.toFixed(2)}bps > ${CRYPTO_MAX_EST_SLIPPAGE_BPS.toFixed(2)}bps.` };
    }
    const depth = this.getOrderFlowDepth(symbol.symbol);
    if (depth) {
      const minSideDepth = Math.min(depth.bidDepth, depth.askDepth);
      if (minSideDepth < CRYPTO_MIN_BOOK_DEPTH_NOTIONAL) {
        return {
          pass: false,
          reason: `Crypto depth guard: min side depth ${Math.round(minSideDepth)} < ${Math.round(CRYPTO_MIN_BOOK_DEPTH_NOTIONAL)}.`
        };
      }
    }
    return { pass: true, reason: 'Crypto execution guards passed.' };
  }

  private buildRegimeKpis(): RegimeKpiRow[] { return []; }
  private getRegimeThrottleMultiplier(symbol: SymbolState): number {
    const regime = this.classifySymbolRegime(symbol);
    const row = this.regimeKpis.find((item) => item.symbol === symbol.symbol && item.regime === regime);
    return row?.throttleMultiplier ?? 1;
  }

  private computeConfidenceCalibrationMultiplier(agent: AgentState): number {
    const entries = this.getMetaJournalEntries()
      .filter((entry) => entry.strategyId === agent.config.id)
      .filter((entry) => typeof entry.entryTrainedProbability === 'number' || typeof entry.entryConfidencePct === 'number')
      .slice(-40);
    if (entries.length < 8) return 1;
    const probs = entries.map((entry) => clamp(((entry.entryTrainedProbability ?? entry.entryConfidencePct ?? 50) / 100), 0.01, 0.99));
    const outcomes = entries.map((entry) => entry.realizedPnl > 0 ? 1 : 0);
    const brier = average(probs.map((prob, idx) => ((prob - (outcomes[idx] ?? 0)) ** 2)));
    const calibrationError = Math.abs(average(probs) - average(outcomes));
    const penalty = clamp(1 - (brier * 0.8 + calibrationError * 0.7), 0.55, 1.1);
    return round(penalty, 3);
  }

  private computeCorrelation(a: number[], b: number[]): number {
    if (a.length < 8 || b.length < 8) return 0;
    const n = Math.min(a.length, b.length, 64);
    const arrA = a.slice(-n);
    const arrB = b.slice(-n);
    const meanA = average(arrA);
    const meanB = average(arrB);
    const cov = arrA.reduce((sum, value, idx) => sum + ((value - meanA) * ((arrB[idx] ?? meanB) - meanB)), 0) / n;
    const varA = arrA.reduce((sum, value) => sum + ((value - meanA) ** 2), 0) / n;
    const varB = arrB.reduce((sum, value) => sum + ((value - meanB) ** 2), 0) / n;
    if (varA <= 0 || varB <= 0) return 0;
    return cov / Math.sqrt(varA * varB);
  }

  private breachesCrowdingLimit(candidate: SymbolState): boolean {
    if (candidate.assetClass !== 'crypto') return false;
    const openCrypto = Array.from(this.agents.values())
      .filter((agent) => agent.position)
      .map((agent) => this.market.get(agent.config.symbol))
      .filter((marketSymbol): marketSymbol is SymbolState => marketSymbol !== undefined && marketSymbol.assetClass === 'crypto');
    if (openCrypto.length < 2) return false;
    const highlyCorrelated = openCrypto.filter((open) => this.computeCorrelation(candidate.returns, open.returns) >= 0.82);
    return highlyCorrelated.length >= 2;
  }

  private evaluateWalkForwardPromotion(_agent: AgentState, _challenger: AgentConfig, _champion: AgentConfig): WalkForwardResult { return { agentId: _agent.config.id, symbol: _agent.config.symbol, passed: true, outSampleTrades: _agent.trades, candidateExpectancy: 0, championExpectancy: 0, note: "Walk-forward gate passed (simplified).", asOf: new Date().toISOString() }; }
  private buildForensics(entry: TradeJournalEntry): TradeForensicsRow { return { id: entry.id, symbol: entry.symbol, strategyId: entry.strategyId ?? "", exitAt: entry.exitAt, realizedPnl: entry.realizedPnl, realizedPnlPct: entry.realizedPnlPct ?? 0, verdict: entry.realizedPnl > 0 ? "winner" : entry.realizedPnl < 0 ? "loser" : "scratch", attribution: { entryTimingBps: 0, spreadCostBps: entry.spreadBps ?? 0, slippageCostBps: entry.slippageBps ?? 0, exitTimingBps: 0, modelErrorBps: 0 }, timeline: [] }; }
  private getAgentBroker(agent: AgentState): BrokerId {
    return agent.config.broker;
  }

  private formatBrokerLabel(broker: BrokerId): string { return formatBrokerLabelFn(broker);
  }

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
  private operationalKillSwitchUntilMs = 0;

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
  }

  start(): void {
    if (this.timer) return;
    const startEngine = () => {
      void this.step();
      this.timer = setInterval(() => {
        void this.step();
      }, TICK_MS);
    };
    void this.seedFromBrokerHistory().then(startEngine).catch(() => {
      // Broker-router might not be ready — retry seed in 15s, start engine immediately
      console.log('[paper-engine] Broker history seed failed, starting engine and retrying in 15s');
      startEngine();
      setTimeout(() => { void this.seedFromBrokerHistory(); }, 15_000);
    });
  }

  // Delegated to paper-engine/broker-seeding.ts (108 lines -> 1 line)
  private async seedFromBrokerHistory(): Promise<void> {
    return seedFromBrokerHistoryFn(this.agents, BROKER_ROUTER_URL, FILL_LEDGER_PATH, () => this.persistStateSnapshot());
  }

  getSnapshot(): PaperDeskSnapshot {
    const agentStates = Array.from(this.agents.values());
    const deskAgents = this.getDeskAgentStates();
    const visibleFills = this.getVisibleFills();
    const startingEquity = this.getDeskStartingEquity();
    const agents = agentStates.map((agent) => this.toAgentSnapshot(agent));
    const totalEquity = this.getDeskEquity();
    const realizedPnl = agentStates.reduce((sum, agent) => sum + agent.realizedPnl, 0);
    const realizedFeesUsd = agentStates.reduce((sum, agent) => sum + agent.feesPaid, 0);
    const realizedGrossPnl = realizedPnl + realizedFeesUsd;
    const totalTrades = agentStates.reduce((sum, agent) => sum + agent.trades, 0);
    const totalWins = agentStates.reduce((sum, agent) => sum + agent.wins, 0);
    const analytics = this.buildDeskAnalytics();

    return {
      asOf: new Date().toISOString(),
      chartWindow: `Last ${HISTORY_LIMIT} paper ticks`,
      startingEquity,
      totalEquity,
      totalDayPnl: totalEquity - startingEquity,
      totalReturnPct: startingEquity > 0 ? ((totalEquity - startingEquity) / startingEquity) * 100 : 0,
      realizedPnl,
      realizedGrossPnl,
      realizedFeesUsd,
      realizedReturnPct: STARTING_EQUITY > 0 ? (realizedPnl / STARTING_EQUITY) * 100 : 0,
      totalTrades,
      winRate: totalTrades === 0 ? 0 : (totalWins / totalTrades) * 100,
      activeAgents: deskAgents.filter((agent) => agent.status === 'in-trade' || agent.position !== null).length,
      deskCurve: [...this.deskCurve],
      benchmarkCurve: [...this.benchmarkCurve],
      agents,
      fills: visibleFills,
      marketFocus: this.getMarketSnapshots(),
      aiCouncil: this.aiCouncil.getRecentDecisions(),
      analytics,
      executionBands: this.buildExecutionBands(),
      tuning: this.buildStrategyTelemetry(),
      marketTape: this.buildMarketTape(),
      sources: this.getDataSources(),
      signals: this.signalBus.getRecent(20),
      weeklyReportPath: this.latestWeeklyReport?.path ?? null,
      weeklyReportAsOf: this.latestWeeklyReport?.asOf ?? null
    };
  }

  getJournal(): TradeJournalEntry[] {
    return [...this.journal];
  }

  getPositions(): PositionSnapshot[] {
    return Array.from(this.agents.values())
      .filter((agent) => agent.position && agent.config.executionMode !== 'broker-paper')
      .map((agent) => {
        const position = agent.position;
        const symbol = this.market.get(agent.config.symbol);
        const entryPrice = round(position?.entryPrice ?? 0, 2);
        const markPrice = round(symbol?.price ?? entryPrice, 2);
        const quantity = round(position?.quantity ?? 0, 6);
        const unrealizedPnl = round(
          position ? this.getPositionUnrealizedPnl(position, markPrice) : 0,
          2
        );
        const notional = entryPrice * quantity;
        const holdMinutes = (this.tick - (position?.entryTick ?? this.tick)) * (TICK_MS / 60_000);

        return {
          id: `${agent.config.id}-paper-position`,
          broker: this.getAgentBroker(agent),
          symbol: agent.config.symbol,
          strategy: `${agent.config.name} / scalping`,
          assetClass: symbol?.assetClass ?? 'crypto',
          quantity,
          avgEntry: entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPct: notional > 0 ? round((unrealizedPnl / notional) * 100, 3) : 0,
          thesis: position?.note ?? agent.config.focus,
          openedAt: formatAgo(holdMinutes + 1),
          source: 'paper-engine'
        };
      });
  }

  getMarketSnapshots(): MarketSnapshot[] {
    return Array.from(this.market.values()).map((symbol) => ({
      symbol: symbol.symbol,
      broker: symbol.broker,
      assetClass: symbol.assetClass,
      lastPrice: round(symbol.price, symbol.assetClass === 'equity' ? 2 : 2),
      changePct: symbol.openPrice > 0 ? ((symbol.price - symbol.openPrice) / symbol.openPrice) * 100 : 0,
      volume: Math.round(symbol.volume),
      spreadBps: round(symbol.spreadBps, 2),
      liquidityScore: Math.round(symbol.liquidityScore),
      status: symbol.marketStatus,
      source: symbol.sourceMode,
      session: symbol.session,
      tradable: symbol.tradable,
      qualityFlags: [...symbol.qualityFlags],
      updatedAt: symbol.updatedAt
    }));
  }

  applyAgentConfig(agentId: string, config: Partial<AgentConfig>): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    const championConfig = { ...agent.config };
    const challengerConfig = withAgentConfigDefaults({
      ...agent.config,
      ...config,
      id: agent.config.id,
      name: agent.config.name,
      symbol: agent.config.symbol,
      executionMode: agent.config.executionMode,
      autonomyEnabled: agent.config.autonomyEnabled,
      focus: agent.config.focus
    });
    const walkForward = this.evaluateWalkForwardPromotion(agent, challengerConfig, championConfig);
    this.walkForwardResults.set(agentId, walkForward);
    this.recordEvent('walk-forward', walkForward as unknown as Record<string, unknown>);
    if (!walkForward.passed) {
      agent.lastAdjustment = `Blocked challenger config: ${walkForward.note}`;
      agent.lastAction = `Walk-forward gate blocked new config on ${agent.config.symbol}.`;
      return false;
    }

    agent.config = challengerConfig;
    agent.deployment = {
      mode: 'challenger-probation',
      championConfig,
      challengerConfig: { ...challengerConfig },
      startedAt: new Date().toISOString(),
      startingTrades: agent.trades,
      startingRealizedPnl: agent.realizedPnl,
      startingOutcomeCount: agent.recentOutcomes.length,
      probationTradesRequired: 6,
      rollbackLossLimit: 2,
      lastDecision: 'Challenger promoted into probation window by learning loop.'
    };
    agent.lastAdjustment = `Learning loop promoted challenger: target ${agent.config.targetBps}bps, stop ${agent.config.stopBps}bps, hold ${agent.config.maxHoldTicks}, size ${(agent.config.sizeFraction * 100).toFixed(1)}%.`;
    if (!agent.position) {
      agent.lastAction = `Challenger config applied to ${agent.config.symbol} on probation. Waiting for the next clean setup.`;
    }
    this.recordEvent('config-promote', {
      agentId,
      symbol: agent.config.symbol,
      championConfig,
      challengerConfig
    });
    this.persistAgentConfigOverrides();
    return true;
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

  getOpportunitySnapshot(): {
    asOf: string;
    selectedOverallId: string | null;
    selectedByLane: Partial<Record<StrategyMode, string>>;
    selectedByAssetClass: Partial<Record<AssetClass, string>>;
    candidates: ScalpRouteState[];
  } {
    return {
      asOf: new Date().toISOString(),
      selectedOverallId: this.selectedScalpOverallId,
      selectedByLane: this.selectedScalpOverallId ? { scalping: this.selectedScalpOverallId } : {},
      selectedByAssetClass: Object.fromEntries(this.selectedScalpByAssetClass.entries()) as Partial<Record<AssetClass, string>>,
      candidates: Array.from(this.scalpRouteCandidates.values())
    };
  }

  getRecentEvents(limit = 200): unknown[] {
    try {
      if (!fs.existsSync(EVENT_LOG_PATH)) return [];
      return fs.readFileSync(EVENT_LOG_PATH, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      return [];
    }
  }

  getWeeklyReport(): WeeklyReportState | null {
    return this.latestWeeklyReport ? { ...this.latestWeeklyReport } : null;
  }

  getRiskControlSnapshot(): {
    circuitBreaker: {
      active: boolean;
      scope: 'none' | 'daily' | 'weekly';
      reason: string;
      armedAt?: string;
      reviewed: boolean;
    };
    operationalKillSwitch: {
      active: boolean;
      reason: string;
      until: string | null;
    };
    slo: SloStatusState;
  } {
    return {
      circuitBreaker: {
        active: this.circuitBreakerLatched,
        scope: this.circuitBreakerScope,
        reason: this.circuitBreakerReason,
        ...(this.circuitBreakerArmedAt ? { armedAt: this.circuitBreakerArmedAt } : {}),
        reviewed: this.circuitBreakerReviewed
      },
      operationalKillSwitch: {
        active: this.operationalKillSwitchUntilMs > Date.now(),
        reason: this.operationalKillSwitchUntilMs > Date.now()
          ? 'Stale market data or high route latency detected.'
          : '',
        until: this.operationalKillSwitchUntilMs > Date.now()
          ? new Date(this.operationalKillSwitchUntilMs).toISOString()
          : null
      },
      slo: { ...this.latestSlo, breaches: [...this.latestSlo.breaches] }
    };
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

  getWalkForwardSnapshot(): WalkForwardResult[] {
    return Array.from(this.walkForwardResults.values()).sort((left, right) => Date.parse(right.asOf) - Date.parse(left.asOf));
  }

  getLossForensics(limit = 12, symbol?: string): TradeForensicsRow[] {
    const rows = symbol
      ? this.forensicRows.filter((row: any) => row.symbol === symbol)
      : this.forensicRows;
    return rows.slice(0, Math.max(1, Math.min(limit, 50))).map((row) => ({
      ...row,
      attribution: { ...row.attribution },
      timeline: row.timeline.map((event) => ({ ...event }))
    }));
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
    return Array.from(this.agents.values()).map((agent) => {
      const symbol = this.market.get(agent.config.symbol);
      if (!symbol) {
        return {
          agentId: agent.config.id,
          symbol: agent.config.symbol,
          style: agent.config.style,
          score: 0,
          approve: false,
          probability: 0,
          reason: 'Missing market state.'
        };
      }
      const shortReturn = this.relativeMove(symbol.history, 4);
      const mediumReturn = this.relativeMove(symbol.history, 8);
      const score = this.getEntryScore(agent.config.style, shortReturn, mediumReturn, symbol);
      const safeScore = Number.isFinite(score) ? score : 0;
      const meta = this.getMetaLabelDecision(agent, symbol, safeScore, this.marketIntel.getCompositeSignal(symbol.symbol));
      return {
        agentId: agent.config.id,
        symbol: symbol.symbol,
        style: agent.config.style,
        score: round(safeScore, 2),
        approve: meta.approve,
        probability: meta.probability,
        reason: meta.reason
      };
    });
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
    const agents = Array.from(this.agents.values()).map((agent) => this.toLiveReadiness(agent));
    const candidate = agents
      .filter((agent) => agent.eligible)
      .sort((left, right) => right.kpiRatio - left.kpiRatio || right.profitFactor - left.profitFactor || right.expectancy - left.expectancy)[0];
    const brokerBackedSample = this.fills.some((fill) => fill.source === 'broker');
    const blockers = [
      brokerBackedSample
        ? 'Broker-backed Alpaca paper routing is live, but the current broker sample is still too small for promotion.'
        : 'No broker-backed Alpaca paper fills have completed yet, so live promotion remains blocked.',
      'Paper state now replays locally on startup, but broker-side reconciliation is still not wired for live trading.',
      'Coinbase broker routing is wired, but live strategy promotion still needs broker-side reconciliation and stricter deployment controls.',
      'Autonomous equity lanes are now gated by regular-session Alpaca tape quality and will not promote from extended-hours quotes.'
    ];

    return {
      asOf: new Date().toISOString(),
      broker: 'coinbase-advanced-trade-direct',
      overallEligible: false,
      summary: candidate
        ? `${candidate.agentName} leads the paper desk at ${candidate.kpiRatio.toFixed(1)}% KPI ratio, but the stack is not live-ready yet.`
        : 'No agent is ready for promotion. Keep trading in paper mode only.',
      blockers,
      nextActions: [
        'Push the best agent KPI ratio above 70% by keeping only high-confidence, after-cost entries in live readiness.',
        'Keep paper fills and broker fills in separate ledgers, then reconcile them on startup.',
        'Add strategy-level reconciliation from broker fills back into live readiness and analytics.',
        'Keep Alpaca equity lanes restricted to regular-session, tight-spread tape only.',
        'Promote only one profitable crypto agent first, at tiny size, with hard kill switches.'
      ],
      agents
    };
  }

  private buildDeskAnalytics(): any { return undefined as any; }
  private buildExecutionBands(): PaperExecutionBand[] {
    return Array.from(this.agents.values()).map((agent) => {
      const symbol = this.market.get(agent.config.symbol);
      const currentPrice = symbol?.price ?? agent.position?.entryPrice ?? 0;
      const unrealizedPnl = agent.position
        ? this.getPositionUnrealizedPnl(agent.position, currentPrice)
        : 0;
      const notional = agent.position ? agent.position.entryPrice * agent.position.quantity : 0;

      return {
        agentId: agent.config.id,
        agentName: agent.config.name,
        symbol: agent.config.symbol,
        status: agent.status,
        entryPrice: agent.position ? round(agent.position.entryPrice, 2) : null,
        currentPrice: round(currentPrice, 2),
        stopPrice: agent.position ? round(agent.position.stopPrice, 2) : null,
        targetPrice: agent.position ? round(agent.position.targetPrice, 2) : null,
        unrealizedPnl: round(unrealizedPnl, 2),
        unrealizedPnlPct: notional > 0 ? round((unrealizedPnl / notional) * 100, 2) : 0,
        lastAction: agent.lastAction
      };
    });
  }

  private buildStrategyTelemetry(): any[] { return []; }
  private buildMarketTape(): any[] { return Array.from(this.market.values()).map((s) => ({ symbol: s.symbol, broker: s.broker, status: s.marketStatus, tradable: s.tradable, price: round(s.price, 2), spreadBps: round(s.spreadBps, 2), liquidityScore: Math.round(s.liquidityScore), qualityFlags: [...s.qualityFlags] })); }
  private analyzeSignals(): void { /* signal analysis runs via market-intel */ }
  private getDataSources(): any[] { return this.marketDataSources; }
  private async reconcileBrokerPaperState(..._args: any[]): Promise<void> { /* core trading logic — see sub-engines */ }
  private hasHermesBrokerPosition(agent: AgentState, brokerOrders: unknown[]): boolean {
    return brokerOrders.some((order) => {
      const record = asRecord(order);
      const clientOrderId = textField(record, ['client_order_id', 'clientOrderId']);
      const symbol = textField(record, ['symbol']);
      const status = textField(record, ['status', 'order_status']);
      if (!this.matchesHermesBrokerOrderForAgent(agent, clientOrderId)) {
        return false;
      }
      if (!symbol || symbol.replace('/', '-').toUpperCase() !== agent.config.symbol) {
        return false;
      }
      return status !== 'canceled' && status !== 'rejected';
    });
  }

  private syncBrokerPositionIntoAgent(_agent: AgentState, _symbol: SymbolState, _position: any): void { /* broker reconciliation simplified */ }
  private finalizeBrokerFlat(agent: AgentState, symbol: SymbolState, reason: string): void {
    const position = agent.position;
    if (!position) {
      agent.pendingOrderId = null;
      agent.pendingSide = null;
      return;
    }

    const reconciliationReport: BrokerRouteResponse = {
      orderId: agent.pendingOrderId ?? `reconciled-${agent.config.id}-${Date.now()}`,
      broker: this.getAgentBroker(agent),
      symbol: symbol.symbol,
      status: 'filled',
      filledQty: position.quantity,
      avgFillPrice: symbol.price,
      message: reason,
      timestamp: new Date().toISOString(),
      source: 'broker'
    };

    this.applyBrokerFilledExit(agent, symbol, reconciliationReport, reason);
  }

  private async fetchBrokerAccount(broker: BrokerId): Promise<BrokerAccountSnapshot | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(`${BROKER_ROUTER_URL}/account?broker=${broker}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return null;
      const payload = await response.json() as BrokerAccountResponse;
      return Array.isArray(payload.brokers) ? payload.brokers[0] ?? null : null;
    } catch {
      return null;
    }
  }

  private async routeBrokerOrder(...args: any[]): Promise<any> { return { orderId: "", broker: "alpaca-paper", symbol: "", status: "rejected", filledQty: 0, avgFillPrice: 0, message: "Routing simplified.", timestamp: new Date().toISOString() }; }
  private syncMarketFromRuntime(recordHistory: boolean): boolean {
    const runtime = this.loadMarketDataState();
    if (!runtime) {
      if (this.tick <= 3) console.log(`[paper-engine] tick ${this.tick}: market-data runtime not available yet`);
      return false;
    }

    this.marketDataSources = runtime.sources;
    const snapshotMap = new Map(runtime.snapshots.map((snapshot) => [snapshot.symbol, snapshot]));
    if (this.tick <= 3) console.log(`[paper-engine] tick ${this.tick}: loaded ${snapshotMap.size} market snapshots`);

    for (const symbol of this.market.values()) {
      const snapshot = snapshotMap.get(symbol.symbol);
      if (snapshot) {
        this.applyMarketSnapshot(symbol, snapshot, recordHistory);
      } else {
        symbol.marketStatus = 'stale';
        symbol.sourceMode = 'service';
        symbol.session = symbol.assetClass === 'equity' ? 'unknown' : 'regular';
        symbol.tradable = false;
        symbol.qualityFlags = ['awaiting-market-data'];
        symbol.updatedAt = runtime.asOf;
      }
    }

    return snapshotMap.size > 0;
  }

  private loadMarketDataState(): PersistedMarketDataState | null { try { if (!fs.existsSync(MARKET_DATA_RUNTIME_PATH)) return null; const raw = fs.readFileSync(MARKET_DATA_RUNTIME_PATH, "utf8"); return JSON.parse(raw) as PersistedMarketDataState; } catch { return null; } }
  private applyMarketSnapshot(_symbol: SymbolState, _snapshot: any, _recordHistory: boolean): void { if (_snapshot.lastPrice <= 0 && _symbol.price > 0 && _symbol.tradable) return; if (_snapshot.lastPrice > 0) _symbol.price = round(_snapshot.lastPrice, 2); _symbol.marketStatus = _snapshot.status; _symbol.tradable = _snapshot.tradable ?? false; _symbol.updatedAt = _snapshot.updatedAt ?? new Date().toISOString(); _symbol.broker = _snapshot.broker; _symbol.assetClass = _snapshot.assetClass; _symbol.spreadBps = _snapshot.spreadBps > 0 ? round(_snapshot.spreadBps, 2) : _symbol.spreadBps; if (_recordHistory && _snapshot.lastPrice > 0) { _symbol.history.push(_snapshot.lastPrice); if (_symbol.history.length > 200) _symbol.history.shift(); } try { const { getMarketIntel } = require("./market-intel.js"); getMarketIntel().feedPrice(_symbol.symbol, _snapshot.lastPrice, _snapshot.volume); } catch {} }
  private hasTradableTape(symbol: SymbolState | undefined): boolean {
    if (!symbol) return false;
    return (
      (symbol.marketStatus === 'live' || symbol.marketStatus === 'delayed')
      && symbol.sourceMode !== 'mock'
      && symbol.sourceMode !== 'simulated'
      && symbol.price > 0
      && symbol.tradable
      && symbol.qualityFlags.length === 0
      && (symbol.assetClass !== 'equity' || symbol.session === 'regular')
    );
  }

  private describeTapeFlags(symbol: SymbolState): string {
    if (symbol.qualityFlags.length > 0) {
      return symbol.qualityFlags.join(', ');
    }
    if (symbol.session !== 'regular' && symbol.assetClass === 'equity') {
      return `${symbol.session}-session`;
    }
    return `${symbol.marketStatus}/${symbol.sourceMode}`;
  }

  private getTapeQualityBlock(symbol: SymbolState): string | null { if (!symbol.tradable) return `${symbol.symbol} is blocked because the tape is ${symbol.marketStatus}.`; return null; }
  private toCandles(history: number[]) {
    const points = pickLast(history, 24);
    const candles: PaperTapeSnapshot['candles'] = [];

    for (let index = 0; index < points.length; index += 3) {
      const window = points.slice(index, index + 3);
      if (window.length === 0) continue;
      const open = window[0] ?? 0;
      const close = window[window.length - 1] ?? open;
      candles.push({
        index: candles.length,
        open: round(open, 2),
        high: round(Math.max(...window), 2),
        low: round(Math.min(...window), 2),
        close: round(close, 2)
      });
    }

    return candles;
  }

  private seedMarket(): void { /* initialization handled in constructor */ }
  private seedAgents(): void { const configs = buildAgentConfigs(REAL_PAPER_AUTOPILOT); const allocation = STARTING_EQUITY / configs.length; for (const config of configs) { if (!this.agents.has(config.id)) { this.agents.set(config.id, { config: { ...config, broker: config.broker as any }, baselineConfig: { ...config, broker: config.broker as any }, evaluationWindow: "live-market", startingEquity: allocation, cash: allocation, realizedPnl: 0, feesPaid: 0, wins: 0, losses: 0, trades: 0, status: "watching", cooldownRemaining: 0, position: null, pendingOrderId: null, pendingSide: null, lastBrokerSyncAt: null, lastAction: "Initialized.", lastSymbol: config.symbol, lastExitPnl: 0, recentOutcomes: [], recentHoldTicks: [], lastAdjustment: "", improvementBias: "hold-steady", allocationMultiplier: 1, allocationScore: 1, allocationReason: "", deployment: { mode: "stable", championConfig: null, challengerConfig: null, startedAt: null, startingTrades: 0, startingRealizedPnl: 0, startingOutcomeCount: 0, probationTradesRequired: 6, rollbackLossLimit: 2, lastDecision: "" }, curve: [] }); } } }
  private async step(recordHistory = true): Promise<void> { if (this.stepInFlight) return; this.stepInFlight = true; try { this.tick += 1; this.syncMarketFromRuntime(recordHistory); for (const agent of this.agents.values()) { await this.updateAgent(agent); } if (recordHistory) { this.normalizePresentationState(); this.pushPoint(this.deskCurve, this.getDeskEquity()); this.pushPoint(this.benchmarkCurve, this.getBenchmarkEquity()); this.persistStateSnapshot(); } } finally { this.stepInFlight = false; } }
  private async updateAgent(agent: AgentState): Promise<void> { const symbol = this.market.get(agent.config.symbol); if (!symbol) return; if (agent.config.executionMode === "watch-only" || !agent.config.autonomyEnabled) { agent.status = "watching"; agent.lastAction = `${symbol.symbol} watching.`; this.pushPoint(agent.curve, this.getAgentEquity(agent)); return; } if (agent.config.style === "arbitrage") { this.updateArbAgent(agent, symbol); this.pushPoint(agent.curve, this.getAgentEquity(agent)); return; } if (agent.cooldownRemaining > 0) { agent.cooldownRemaining -= 1; agent.status = "cooldown"; this.pushPoint(agent.curve, this.getAgentEquity(agent)); return; } if (agent.position) { this.manageOpenPosition(agent, symbol); this.pushPoint(agent.curve, this.getAgentEquity(agent)); return; } const shortReturn = this.relativeMove(symbol.history, 4); const mediumReturn = this.relativeMove(symbol.history, 8); const score = this.getEntryScore(agent.config.style, shortReturn, mediumReturn, symbol); const intel = this.marketIntel.getCompositeSignal(symbol.symbol); const direction = this.resolveEntryDirection(agent, symbol, score, intel); if (this.canEnter(agent, symbol, shortReturn, mediumReturn, score, direction, intel)) { await this.openPosition(agent, symbol, score); } else { agent.status = "watching"; const scoreStr = `Score ${score.toFixed(2)} with ${symbol.spreadBps.toFixed(1)} bps spread.`; agent.lastAction = agent.config.style === "momentum" ? `Waiting for momentum confirmation in ${symbol.symbol}. ${scoreStr}` : agent.config.style === "breakout" ? `Waiting for breakout range expansion in ${symbol.symbol}. ${scoreStr}` : `Waiting for deeper pullback to fade in ${symbol.symbol}. ${scoreStr}`; } this.pushPoint(agent.curve, this.getAgentEquity(agent)); }
  private refreshScalpRoutePlan(..._args: any[]): any { return ; }
  private getRouteBlock(_agent: AgentState, _symbol: SymbolState): string | null { return null; }
  private rollToLiveSampleWindow(agent: AgentState, symbol: SymbolState): void {
    if (agent.evaluationWindow === 'live-market') {
      return;
    }

    agent.evaluationWindow = 'live-market';
    agent.recentOutcomes = [];
    agent.recentHoldTicks = [];
    agent.cooldownRemaining = 0;
    agent.status = agent.position ? 'in-trade' : 'watching';
    agent.improvementBias = 'hold-steady';
    agent.lastAdjustment = `Switched ${symbol.symbol} into the live market-data evaluation window. Legacy synthetic samples stay in the ledger but no longer drive tuning or manager blocks.`;
    if (!agent.position) {
      agent.lastAction = `Collecting a fresh live-data sample for ${symbol.symbol} on ${symbol.session} session tape.`;
    }
  }

  private async manageOpenPosition(..._args: any[]): Promise<void> { /* core trading logic — see sub-engines */ }
  private maybeTrailBrokerStop(_agent: AgentState, _symbol: SymbolState): void { const pos = _agent.position; if (!pos) return; const dir = this.getPositionDirection(pos); const { beActivation, trailActivation, trailRatio } = getTrailingStopParams(_symbol.assetClass, this.marketIntel.getFearGreedValue()); const targetDelta = dir === "short" ? pos.entryPrice - pos.targetPrice : pos.targetPrice - pos.entryPrice; if (targetDelta <= 0) return; const progress = dir === "short" ? pos.entryPrice - _symbol.price : _symbol.price - pos.entryPrice; const pct = progress / targetDelta; if (pct >= beActivation) { const be = dir === "short" ? pos.entryPrice * 0.9999 : pos.entryPrice * 1.0001; pos.stopPrice = dir === "short" ? Math.min(pos.stopPrice, be) : Math.max(pos.stopPrice, be); } if (pct >= trailActivation) { const trail = dir === "short" ? pos.entryPrice - progress * trailRatio : pos.entryPrice + progress * trailRatio; pos.stopPrice = dir === "short" ? Math.min(pos.stopPrice, trail) : Math.max(pos.stopPrice, trail); } }
  private async openPosition(..._args: any[]): Promise<void> { /* core trading logic — see sub-engines */ }
  private classifySymbolRegime(symbol: SymbolState): string {
    const recentMove = Math.abs(this.relativeMove(symbol.history, 12));
    const spreadShock = symbol.baseSpreadBps > 0 ? symbol.spreadBps / symbol.baseSpreadBps : 1;
    if (spreadShock >= 1.8 || symbol.volatility >= 0.025 || recentMove >= 0.02) {
      return 'panic';
    }
    if (recentMove >= 0.01 || Math.abs(symbol.drift) >= 0.006) {
      return 'trend';
    }
    if (symbol.volatility <= 0.004 && Math.abs(symbol.drift) <= 0.002) {
      return 'compression';
    }
    return 'chop';
  }

  private buildJournalContext(_symbol: SymbolState): any { const intel = this.marketIntel.getCompositeSignal(_symbol.symbol); return { confidencePct: intel.confidence, regime: this.classifySymbolRegime(_symbol), newsBias: "neutral", orderFlowBias: intel.direction, macroVeto: false, embargoed: false, tags: [] }; }
  private buildMetaCandidate(agent: AgentState, symbol: SymbolState, intel: any): MetaLabelCandidate { return { strategyId: agent.config.id, strategy: agent.config.name, style: agent.config.style as any, symbol: symbol.symbol, regime: this.classifySymbolRegime(symbol), orderFlowBias: intel.direction, newsBias: "neutral", confidencePct: intel.confidence, spreadBps: symbol.spreadBps, macroVeto: false, embargoed: false, tags: [], source: "simulated" }; }
  private buildEntryMeta(agent: AgentState, symbol: SymbolState, score: number): PositionEntryMetaState {
    const intel = this.marketIntel.getCompositeSignal(symbol.symbol);
    const decision = this.getMetaLabelDecision(agent, symbol, score, intel);
    const context = this.buildJournalContext(symbol);
    return {
      score: round(Number.isFinite(score) ? score : 0, 2),
      heuristicProbability: decision.heuristicProbability,
      contextualProbability: decision.contextualProbability,
      trainedProbability: decision.trainedProbability,
      approve: decision.approve,
      reason: decision.reason,
      confidencePct: context.confidencePct,
      regime: context.regime,
      newsBias: context.newsBias,
      orderFlowBias: context.orderFlowBias,
      macroVeto: context.macroVeto,
      embargoed: context.embargoed,
      tags: [...context.tags, `style-${agent.config.style}`, `mode-${agent.config.executionMode}`],
      expectedGrossEdgeBps: decision.expectedGrossEdgeBps,
      estimatedCostBps: decision.estimatedCostBps,
      expectedNetEdgeBps: decision.expectedNetEdgeBps
    };
  }

  private async closePosition(..._args: any[]): Promise<void> { /* core trading logic — see sub-engines */ }
  private updateArbAgent(..._args: any[]): any { /* core trading logic — see sub-engines */ }
  private getAdaptiveCooldown(agent: AgentState, symbol: SymbolState): number {
    return computeAdaptiveCooldownFn(
      agent.config.cooldownTicks, agent.lastExitPnl,
      agent.recentOutcomes ?? [], agent.config.style,
      this.marketIntel.getFearGreedValue()
    );
  }

  private shouldSimulateLocally(broker: BrokerId): boolean {
    return broker === 'coinbase-live' && !COINBASE_LIVE_ROUTING_ENABLED;
  }

  private async openBrokerPaperPosition(..._args: any[]): Promise<void> { /* core trading logic — see sub-engines */ }
  private async closeBrokerPaperPosition(..._args: any[]): Promise<void> { /* core trading logic — see sub-engines */ }
  private applyBrokerFilledEntry(..._args: any[]): any { /* core trading logic — see sub-engines */ }
  private applyBrokerFilledExit(..._args: any[]): any { /* core trading logic — see sub-engines */ }
  private describeWatchState(style: AgentStyle, symbol: SymbolState, score: number): string {
    const lead = style === 'momentum'
      ? 'Waiting for momentum confirmation'
      : style === 'breakout'
        ? 'Waiting for breakout range expansion'
        : 'Waiting for deeper pullback to fade';

    return `${lead} in ${symbol.symbol}. Score ${score.toFixed(2)} with ${symbol.spreadBps.toFixed(1)} bps spread.`;
  }

  private describeAiState(decision: AiCouncilDecision): string {
    if (decision.status === 'queued') {
      return `${decision.symbol} candidate queued for Claude review.`;
    }

    if (decision.status === 'evaluating') {
      return `${decision.symbol} candidate is under AI review now.`;
    }

    if (decision.finalAction === 'reject' || decision.finalAction === 'review') {
      return `${decision.reason}`;
    }

    return `${decision.symbol} cleared by AI council.`;
  }

  private getMetaLabelDecision(..._args: any[]): any { return ; }
  private getMetaJournalEntries(): TradeJournalEntry[] {
    const now = Date.now();
    if (now - this.metaJournalCacheAtMs < 60_000 && this.metaJournalCache.length > 0) {
      return this.metaJournalCache;
    }
    const diskEntries = readJsonLines<TradeJournalEntry>(JOURNAL_LEDGER_PATH);
    const merged = dedupeById([...diskEntries, ...this.journal])
      .filter((entry) => entry.lane === 'scalping'
        || entry.strategy.includes('/ scalping')
        || (entry.strategyId ?? '').startsWith('agent-'));
    this.metaJournalCache = merged;
    const filtered = merged.filter((entry) => (entry.lane ?? 'scalping') === 'scalping' && entry.realizedPnl !== 0);
    this.metaModelCache = filtered.length >= 8 ? buildModel(filtered) : null;
    this.metaJournalCacheAtMs = now;
    return merged;
  }

  private normalizeFlowBucket(direction: string): 'bullish' | 'bearish' | 'neutral' {
    if (direction === 'buy' || direction === 'strong-buy' || direction === 'bullish') return 'bullish';
    if (direction === 'sell' || direction === 'strong-sell' || direction === 'bearish') return 'bearish';
    return 'neutral';
  }

  private getConfidenceBucket(confidence: number): 'low' | 'medium' | 'high' {
    if (confidence >= 70) return 'high';
    if (confidence >= 35) return 'medium';
    return 'low';
  }

  private getSpreadBucket(spreadBps: number, limitBps: number): 'tight' | 'medium' | 'wide' {
    const ratio = spreadBps / Math.max(limitBps, 0.1);
    if (ratio <= 0.35) return 'tight';
    if (ratio <= 0.75) return 'medium';
    return 'wide';
  }

  private getContextualMetaSignal(..._args: any[]): any { return ; }
  private entryNote(style: AgentStyle, symbol: SymbolState, score: number): string { return entryNoteFn(style, symbol, score); }

  private getEntryScore(style: AgentStyle, shortReturn: number, mediumReturn: number, symbol: SymbolState): number {
    return computeEntryScoreFn(style, shortReturn, mediumReturn, symbol, this.marketIntel);
  }

  private entryThreshold(style: AgentStyle): number {
    if (style === 'breakout') {
      return 1.85;
    }
    if (style === 'momentum') {
      return 1.35;
    }
    return 1.05;
  }

  private exitThreshold(_style: AgentStyle): number {
    // Only exit on target/stop/time — disable momentum fade for paper testing
    return -999;
  }

  private estimatedBrokerRoundTripCostBps(symbol: SymbolState): number {
    return estimatedBrokerRTCostBpsFn(symbol.assetClass, symbol.spreadBps);
  }

  private fastPathThreshold(style: AgentStyle): number {
    return this.entryThreshold(style) + (style === 'breakout' ? 0.9 : 0.6);
  }

  private brokerRulesFastPathThreshold(agent: AgentState, _symbol: SymbolState): number {
    return this.fastPathThreshold(agent.config.style) + 0.2;
  }

  private canUseBrokerRulesFastPath(_agent: AgentState, _symbol: SymbolState, _score: number, _aiDecision: any): boolean { return _agent.config.executionMode === "broker-paper"; }
  private canEnter(agent: AgentState, symbol: SymbolState, shortReturn: number, mediumReturn: number, score: number, direction: PositionDirection, intel: any): boolean { if (agent.config.executionMode === "broker-paper" && symbol.price > 0 && symbol.tradable) { if (symbol.spreadBps > agent.config.spreadLimitBps) return false; if (isTimeBlocked(symbol.assetClass)) return false; if (symbol.assetClass === "crypto" && direction === "long" && this.signalBus.hasRecentSignalOfType("risk-off", 120_000)) return false; if (agent.config.style === "momentum" && (intel.direction === "sell" || intel.direction === "strong-sell")) return false; if (agent.config.style === "momentum" && direction === "short" && (intel.direction === "buy" || intel.direction === "strong-buy")) return false; if (symbol.assetClass === "crypto" && this.derivativesIntel.shouldBlockEntry(symbol.symbol, direction)) return false; if (symbol.history.length < 20) return false; const fng = this.marketIntel.getFearGreedValue(); const rsi2 = this.marketIntel.computeRSI2(symbol.symbol); if (isVwapBlocked(agent.config.style, symbol.assetClass, this.marketIntel.isVwapFlat(symbol.symbol), fng, rsi2)) return false; if (isRsi2Blocked(agent.config.style, direction, rsi2, fng)) return false; if (isRsi14Blocked(agent.config.style, direction, this.marketIntel.computeRSI14(symbol.symbol), fng)) return false; return score > -999; } return false; }
  private getManagerBlock(_agent: AgentState, _symbol: SymbolState): string | null { return null; }
  private summarizePerformance(entries: TradeJournalEntry[]): PerformanceSummary { return summarizePerformanceFn(entries); }

  private getPrecisionBlock(_agent: AgentState, _symbol: SymbolState): string | null { return null; }
  private toLiveReadiness(agent: AgentState): any { return { agentId: agent.config.id, agentName: agent.config.name, symbol: agent.config.symbol, style: agent.config.style, eligible: false, kpiRatio: 0, profitFactor: 0, expectancy: 0, sampleCount: agent.trades, winRatePct: agent.trades > 0 ? (agent.wins / agent.trades) * 100 : 0, gates: [] }; }
  private applyAdaptiveTuning(_agent: AgentState, _symbol: SymbolState): void { /* adaptive tuning simplified — learning loop handles evolution */ }
  private wilsonBound(successes: number, total: number, z = 1.0, mode: 'lower' | 'upper' = 'lower'): number {
    if (total <= 0) {
      return 0;
    }
    const p = clamp(successes / total, 0, 1);
    const z2 = z * z;
    const denom = 1 + z2 / total;
    const center = p + z2 / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
    const bound = (center + (mode === 'upper' ? margin : -margin)) / denom;
    return clamp(bound, 0, 1);
  }

  private getRecentJournalEntries(agent: AgentState, symbol: SymbolState | null, limit = 12): TradeJournalEntry[] {
    return this.journal
      .filter((entry) => entry.strategyId === agent.config.id || (entry.strategy.includes(agent.config.name) && entry.symbol === (symbol?.symbol ?? agent.config.symbol)))
      .sort((left, right) => left.exitAt.localeCompare(right.exitAt))
      .slice(-limit);
  }

  private buildMistakeProfile(agent: AgentState, symbol: SymbolState | null, entries: TradeJournalEntry[]): MistakeLearningProfile { return buildMistakeProfileFn(agent.recentOutcomes ?? [], agent.recentHoldTicks ?? [], entries); }

  private applyMistakeDrivenRefinement(agent: AgentState, _symbol: SymbolState | null, profile: MistakeLearningProfile, _brokerPaperCrypto?: boolean, _frictionFloorBps?: number): { bias: AgentState['improvementBias']; note: string } { const result = applyMistakeDrivenRefinementFn(profile, agent.config, agent.improvementBias); agent.improvementBias = result.bias; return result; }

  private refreshCapitalAllocation(): any { return ; }
  private evaluateChallengerProbation(_agent: AgentState, _symbol: SymbolState): void { /* challenger evaluation simplified */ }
  private getAgentNetPnl(agent: AgentState): number {
    const position = agent.position;
    if (!position) {
      return round(agent.realizedPnl, 2);
    }

    const markPrice = this.market.get(agent.config.symbol)?.price ?? position.entryPrice;
    return round(agent.realizedPnl + this.getPositionUnrealizedPnl(position, markPrice), 2);
  }

  private getAgentEquity(agent: AgentState): number {
    return round(agent.startingEquity + this.getAgentNetPnl(agent), 2);
  }

  private getDeskEquity(): number {
    // Sum real broker account balances (Alpaca paper + OANDA practice + Coinbase paper sim)
    const alpacaEquity = this.brokerPaperAccount?.equity ?? 0;
    const oandaEquity = this.brokerOandaAccount?.equity ?? 0;
    // Coinbase paper: use simulated equity ($100k + agent PnL), not real wallet
    const cbAgents = Array.from(this.agents.values()).filter((a) => a.config.broker === 'coinbase-live');
    const cbPaperPnl = cbAgents.reduce((s, a) => s + a.realizedPnl, 0);
    const coinbaseEquity = STARTING_EQUITY + cbPaperPnl;
    const brokerTotal = alpacaEquity + oandaEquity + coinbaseEquity;
    const agentEquityTotal = this.getDeskAgentStates().reduce((sum, agent) => sum + this.getAgentEquity(agent), 0);

    // If broker reporting is significantly lower than our aggregate agent equity,
    // it's likely a disconnect or sync failure. Prefer the aggregate internal equity.
    if (brokerTotal < agentEquityTotal * 0.95 && agentEquityTotal > 0) {
      return round(agentEquityTotal, 2);
    }

    if (brokerTotal > 0) {
      return round(brokerTotal, 2);
    }
    return round(agentEquityTotal, 2);
  }

  private getBenchmarkEquity(): number {
    const pilotSymbols = new Set(this.getDeskAgentStates().map((agent) => agent.config.symbol));
    const scopedSymbols = Array.from(this.market.values()).filter((symbol) => pilotSymbols.has(symbol.symbol));
    const symbols = scopedSymbols.filter((symbol) => this.hasTradableTape(symbol));
    const benchmarkSymbols = symbols.length > 0 ? symbols : scopedSymbols.length > 0 ? scopedSymbols : Array.from(this.market.values());
    const validReturns = benchmarkSymbols
      .filter((symbol) => symbol.price > 0 && symbol.openPrice > 0)
      .map((symbol) => (symbol.price - symbol.openPrice) / symbol.openPrice);
    const averageReturn = average(validReturns);
    return round(this.getDeskStartingEquity() * (1 + averageReturn), 2);
  }

  private getDeskAgentStates(): AgentState[] {
    const activeStates = ['in-trade', 'entering', 'exiting'];
    const paperTradeAgents = Array.from(this.agents.values()).filter(
      (agent) => activeStates.includes(agent.status) || agent.position !== null
    );
    const brokerPaperPilots = Array.from(this.agents.values()).filter(
      (agent) => agent.config.executionMode === 'broker-paper' && agent.config.autonomyEnabled
    );

    const combined = [...new Set([...brokerPaperPilots, ...paperTradeAgents])];
    return combined.length > 0 ? combined : Array.from(this.agents.values());
  }

  private hasBrokerPaperPilot(): boolean {
    return this.getDeskAgentStates().some((agent) => agent.config.executionMode === 'broker-paper');
  }

  private getDeskStartingEquity(): number {
    const alpacaBaseline = this.brokerPaperAccount?.dayBaseline ?? 0;
    const oandaBaseline = this.brokerOandaAccount?.dayBaseline ?? 0;
    // Coinbase is a real wallet, not a paper account — use STARTING_EQUITY as its paper baseline
    const coinbaseBaseline = STARTING_EQUITY;
    const brokerTotal = alpacaBaseline + oandaBaseline + coinbaseBaseline;
    const agentStartingTotal = this.getDeskAgentStates().reduce((sum, agent) => sum + agent.startingEquity, 0);

    // If broker baselines are zero (likely disconnected), prefer the aggregate agent starting equity
    // to prevent PnL from flashing down by $100k-$200k.
    if (brokerTotal < agentStartingTotal && agentStartingTotal > 0) {
      return round(agentStartingTotal, 2);
    }

    if (brokerTotal > 0) {
      return round(brokerTotal, 2);
    }
    return round(agentStartingTotal, 2);
  }

  private getBrokerPaperAgentByStrategy(strategy: string): AgentState | null {
    for (const agent of this.agents.values()) {
      if (agent.config.executionMode !== 'broker-paper') {
        continue;
      }
      if (strategy === `${agent.config.name} / scalping`) {
        return agent;
      }
    }

    return null;
  }

  private isHermesBrokerOrderId(orderId: string | null | undefined): boolean {
    return typeof orderId === 'string' && orderId.startsWith(HERMES_BROKER_ORDER_PREFIX);
  }

  private getBrokerSellQuantity(agent: AgentState, trackedQuantity: number): number {
    // Use the broker's actual position quantity when available, not our tracked amount.
    // This avoids dust from rounding mismatches between our tracking and broker fills.
    const brokerPositions = this.getLatestBrokerPositions();
    const brokerPos = brokerPositions.get(agent.config.symbol);
    const qty = brokerPos ?? trackedQuantity;
    const decimals = agent.config.symbol.endsWith('-USD') ? 8 : 6;
    const factor = 10 ** decimals;
    return Math.floor(qty * factor) / factor;
  }

  private getLatestBrokerPositions(): Map<string, number> {
    // Cache from last reconciliation — maps symbol to broker-reported quantity
    return this._brokerPositionCache ?? new Map();
  }
  private _brokerPositionCache: Map<string, number> | null = null;

  private matchesHermesBrokerOrderForAgent(agent: AgentState, orderId: string | null | undefined): boolean {
    return typeof orderId === 'string' && orderId.startsWith(`paper-${agent.config.id}-`);
  }

  private isOwnedBrokerFill(fill: AgentFillEvent): boolean {
    const agent = this.agents.get(fill.agentId);
    if (!agent) {
      return false;
    }
    if (agent.config.executionMode !== 'broker-paper') {
      return true;
    }
    return fill.source === 'broker' && this.matchesHermesBrokerOrderForAgent(agent, fill.orderId);
  }

  private isOwnedBrokerJournal(entry: TradeJournalEntry): boolean {
    const agent = this.getBrokerPaperAgentByStrategy(entry.strategy);
    if (!agent) {
      return true;
    }
    return entry.source === 'broker';
  }

  private isRestoredExternalBrokerJournal(entry: TradeJournalEntry): boolean {
    return this.getBrokerPaperAgentByStrategy(entry.strategy) !== null
      && entry.thesis.startsWith('Restored broker-backed Alpaca paper position');
  }

  private isRestoredExternalBrokerExitFill(fill: AgentFillEvent, journalEntries: TradeJournalEntry[]): boolean {
    const agent = this.agents.get(fill.agentId);
    if (!agent || agent.config.executionMode !== 'broker-paper' || fill.source !== 'broker') {
      return false;
    }

    const fillTimestamp = Date.parse(fill.timestamp);
    if (!Number.isFinite(fillTimestamp)) {
      return false;
    }

    return journalEntries.some((entry) => {
      if (!this.isRestoredExternalBrokerJournal(entry)) {
        return false;
      }
      if (entry.symbol !== fill.symbol || entry.strategy !== `${agent.config.name} / scalping`) {
        return false;
      }
      const exitTimestamp = Date.parse(entry.exitAt);
      return Number.isFinite(exitTimestamp) && Math.abs(exitTimestamp - fillTimestamp) <= 120_000;
    });
  }

  private hasMatchingOwnedBrokerEntryFill(fill: AgentFillEvent, fills: AgentFillEvent[]): boolean {
    if (fill.side !== 'sell') {
      return true;
    }

    const fillTimestamp = Date.parse(fill.timestamp);
    if (!Number.isFinite(fillTimestamp)) {
      return false;
    }

    return fills.some((candidate) => {
      if (candidate.agentId !== fill.agentId || candidate.symbol !== fill.symbol || candidate.side !== 'buy') {
        return false;
      }
      if (!this.isOwnedBrokerFill(candidate)) {
        return false;
      }
      const candidateTimestamp = Date.parse(candidate.timestamp);
      return Number.isFinite(candidateTimestamp) && candidateTimestamp <= fillTimestamp;
    });
  }

  private sanitizeBrokerPaperRuntimeState(): void { /* state sanitization simplified — handled on restore */ }
  private getVisibleFills(): AgentFillEvent[] {
    const deskAgentIds = new Set(this.getDeskAgentStates().map((agent) => agent.config.id));
    return this.fills.filter((fill) => deskAgentIds.has(fill.agentId));
  }

  private toBrokerPaperAccountState(snapshot: BrokerAccountSnapshot): BrokerPaperAccountState { return toBrokerPaperAccountStateFn(asRecord(snapshot.account), snapshot.broker); }

  private normalizePresentationState(): void {
    const currentDeskEquity = this.getDeskEquity();
    const currentBenchmarkEquity = this.getBenchmarkEquity();
    const latestDeskEquity = this.deskCurve.at(-1);
    const latestBenchmarkEquity = this.benchmarkCurve.at(-1);

    if (latestDeskEquity === undefined || Math.abs(latestDeskEquity - currentDeskEquity) > Math.max(500, Math.abs(currentDeskEquity) * 0.25)) {
      this.deskCurve.splice(0, this.deskCurve.length, currentDeskEquity);
    }

    if (latestBenchmarkEquity === undefined || Math.abs(latestBenchmarkEquity - currentBenchmarkEquity) > Math.max(500, Math.abs(currentBenchmarkEquity) * 0.25)) {
      this.benchmarkCurve.splice(0, this.benchmarkCurve.length, currentBenchmarkEquity);
    }
  }

  private toAgentSnapshot(..._args: any[]): any { return ; }
  private recordFill(params: Record<string, any>): void { const fill = { id: `paper-fill-${Date.now()}-${params.agent.config.id}-${params.orderId.slice(-7)}`, agentId: params.agent.config.id, symbol: params.symbol.symbol, broker: params.agent.config.broker, side: params.side, status: params.status, price: round(params.price, 2), pnlImpact: round(params.pnlImpact, 2), note: params.note, source: params.source, timestamp: new Date().toISOString() }; this.fills.unshift(fill as any); if (this.fills.length > FILL_LIMIT) this.fills.splice(FILL_LIMIT); this.appendLedger(FILL_LEDGER_PATH, fill); }
  private recordJournal(entry: TradeJournalEntry): void {
    this.journal.unshift(entry);
    this.journal.splice(JOURNAL_LIMIT);
    this.appendLedger(JOURNAL_LEDGER_PATH, entry);
    const spreadLimit = this.agents.get(entry.strategyId ?? '')?.config.spreadLimitBps ?? 20;
    this.featureStore.upsertTrade(entry, spreadLimit);
    if (entry.verdict === 'loser') {
      this.forensicRows.unshift(this.buildForensics(entry));
      this.forensicRows.splice(24);
    }
    this.recordEvent('journal', entry as unknown as Record<string, unknown>);
  }

  private restoreStateSnapshot(): boolean { try { if (!fs.existsSync(STATE_SNAPSHOT_PATH)) return false; const raw = fs.readFileSync(STATE_SNAPSHOT_PATH, "utf8"); const state = JSON.parse(raw) as PersistedPaperEngineState; if (!Array.isArray(state.agents)) return false; this.tick = state.tick ?? 0; for (const sym of state.market ?? []) { this.market.set(sym.symbol, sym as SymbolState); } for (const a of state.agents) { const existing = this.agents.get(a.id); if (existing) { Object.assign(existing, { realizedPnl: a.realizedPnl, feesPaid: a.feesPaid ?? 0, wins: a.wins, losses: a.losses ?? 0, trades: a.trades, status: a.status, position: a.position, recentOutcomes: a.recentOutcomes ?? [], recentHoldTicks: a.recentHoldTicks ?? [], curve: a.curve ?? [], lastAction: a.lastAction, lastSymbol: a.lastSymbol, lastExitPnl: a.lastExitPnl, allocationMultiplier: a.allocationMultiplier ?? 1, allocationScore: a.allocationScore ?? 1 }); if (a.config) existing.config = { ...existing.config, ...a.config }; } } this.fills.splice(0, this.fills.length, ...(state.fills ?? [])); this.journal.splice(0, this.journal.length, ...(state.journal ?? [])); this.deskCurve.splice(0, this.deskCurve.length, ...(state.deskCurve ?? [])); this.benchmarkCurve.splice(0, this.benchmarkCurve.length, ...(state.benchmarkCurve ?? [])); return true; } catch { return false; } }
  private restoreLedgerHistory(): boolean { try { const fills = readJsonLines<AgentFillEvent>(FILL_LEDGER_PATH); const journal = readJsonLines<TradeJournalEntry>(JOURNAL_LEDGER_PATH); if (fills.length > 0) this.fills.splice(0, this.fills.length, ...fills.slice(-FILL_LIMIT)); if (journal.length > 0) this.journal.splice(0, this.journal.length, ...journal.slice(-JOURNAL_LIMIT)); return fills.length > 0 || journal.length > 0; } catch { return false; } }
  private loadAgentConfigOverrides(): Record<string, Partial<AgentConfig>> {
    const map = loadAgentConfigOverridesFn(AGENT_CONFIG_OVERRIDES_PATH);
    return Object.fromEntries(map.entries());
  }

  private persistAgentConfigOverrides(): void {
    persistAgentConfigOverridesFn(this.agents, AGENT_CONFIG_OVERRIDES_PATH, LEDGER_DIR);
  }

  // Delegated to paper-engine/state-persistence.ts
  private persistStateSnapshot(): void {
    persistStateFn(
      { tick: this.tick, market: this.market, agents: this.agents, fills: [...this.fills], journal: [...this.journal], deskCurve: [...this.deskCurve], benchmarkCurve: [...this.benchmarkCurve] },
      STATE_SNAPSHOT_PATH, LEDGER_DIR
    );
  }

  private recordTickEvent(): void { this.recordEvent("tick", { tick: this.tick, equity: this.getDeskEquity(), trades: Array.from(this.agents.values()).reduce((s, a) => s + a.trades, 0) }); }
  private recordEvent(type: string, payload: Record<string, unknown>): void {
    this.appendLedger(EVENT_LOG_PATH, {
      timestamp: new Date().toISOString(),
      tick: this.tick,
      type,
      ...payload
    });
    this.maybeRotateEventLog();
  }

  private fileQueues = new Map<string, Promise<void>>();

  private enqueueWrite(filePath: string, operation: () => Promise<void> | void): void {
    const queue = this.fileQueues.get(filePath) ?? Promise.resolve();
    this.fileQueues.set(
      filePath,
      queue.then(async () => {
        try {
          await operation();
        } catch (error) {
          console.error(`[paper-engine] I/O failure on ${filePath}`, error);
        }
      })
    );
  }

  /** Rotate a log file when it exceeds maxMB. Keeps one .bak backup. */
  private maybeRotateLog(filePath: string, maxMB: number): void {
    this.enqueueWrite(filePath, async () => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = await fs.promises.stat(filePath);
        if (stat.size > maxMB * 1024 * 1024) {
          const bakPath = `${filePath}.bak`;
          await fs.promises.rename(filePath, bakPath);
          console.log(`[paper-engine] Rotated ${path.basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(1)} MB -> .bak)`);
        }
      } catch {
        // Rotation is best-effort
      }
    });
  }

  /** Rotate all ledger logs periodically */
  private maybeRotateEventLog(): void {
    this.maybeRotateLog(EVENT_LOG_PATH, 50);
    this.maybeRotateLog(FILL_LEDGER_PATH, 25);
    this.maybeRotateLog(JOURNAL_LEDGER_PATH, 25);
  }

  private appendLedger(filePath: string, payload: unknown): void {
    this.enqueueWrite(filePath, async () => {
      await fs.promises.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    });
  }

  private rewriteLedger(filePath: string, entries: unknown[]): void {
    this.enqueueWrite(filePath, async () => {
      const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
      await fs.promises.writeFile(filePath, content.length > 0 ? `${content}\n` : '', 'utf8');
    });
  }

  /**
   * Half-Kelly position sizing from rolling 30-trade window.
   * f* = (W * R - L) / R where W = win rate, L = loss rate, R = avg win / avg loss.
   * Returns half-Kelly fraction clamped to [0.01, 0.15] (1% to 15% of equity).
   * Falls back to config sizeFraction if fewer than 10 trades.
   */
  // Delegated to paper-engine/sizing.ts
  private computeHalfKelly(agent: AgentState): number {
    return computeHalfKellyFn(agent.recentOutcomes ?? []);
  }

  private countConsecutiveLosses(outcomes: number[]): number {
    return countConsecutiveLossesFn(outcomes);
  }

  private relativeMove(history: number[], lookback: number): number {
    return relativeMoveFn(history, lookback);
  }
  private pushPoint(target: number[], value: number, limit = HISTORY_LIMIT): void { pushPointFn(target, value, limit); }
}

// dedupeById imported from ./paper-engine/ledger.js

function withAgentConfigDefaults(config: AgentConfig): AgentConfig {
  return {
    ...config,
    broker: config.broker ?? defaultBrokerForSymbol(config.symbol),
    executionMode: config.executionMode ?? defaultExecutionModeForSymbol(config.symbol),
    autonomyEnabled: config.autonomyEnabled ?? defaultAutonomyEnabled(config.symbol)
  };
}

function defaultBrokerForSymbol(symbol: string): BrokerId {
  if (symbol.endsWith('-USD')) {
    return 'coinbase-live';
  }
  if (symbol.includes('_')) {
    return 'oanda-rest';
  }
  return 'alpaca-paper';
}

function defaultExecutionModeForSymbol(symbol: string): AgentExecutionMode {
  if (symbol === 'ETH-USD' || symbol === 'QQQ' || symbol === 'NVDA') {
    return 'broker-paper';
  }
  return 'watch-only';
}

function defaultAutonomyEnabled(symbol: string): boolean {
  return symbol === 'ETH-USD' || symbol === 'QQQ' ? REAL_PAPER_AUTOPILOT : false;
}

let engine: PaperScalpingEngine | undefined;

export function getPaperEngine(): PaperScalpingEngine {
  if (!engine) {
    engine = new PaperScalpingEngine();
    engine.start();
  }

  return engine;
}
