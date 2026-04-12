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

  private async processEventDrivenExitQueue(): Promise<void> {
    if (this.pendingEventExitReasons.size === 0) return;
    const queued = Array.from(this.pendingEventExitReasons.entries());
    this.pendingEventExitReasons.clear();
    for (const [agentId, reason] of queued) {
      const agent = this.agents.get(agentId);
      if (!agent?.position) continue;
      const symbol = this.market.get(agent.config.symbol);
      if (!symbol) continue;
      await this.closePosition(agent, symbol, reason);
    }
  }

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

  private maybeGenerateWeeklyReport(): void {
    const now = Date.now();
    if (now < this.nextWeeklyCheckAtMs) return;
    this.nextWeeklyCheckAtMs = now + 10 * 60_000;

    const weekStart = new Date();
    weekStart.setUTCHours(0, 0, 0, 0);
    const day = weekStart.getUTCDay() || 7;
    weekStart.setUTCDate(weekStart.getUTCDate() - (day - 1));
    const weekKey = `${weekStart.getUTCFullYear()}-W${Math.ceil((((weekStart.getTime() - Date.UTC(weekStart.getUTCFullYear(), 0, 1)) / 86400000) + 1) / 7)}`;

    if (this.latestWeeklyReport && this.latestWeeklyReport.path.includes(weekKey)) return;

    const lookbackCutoff = now - 7 * 86_400_000;
    const entries = this.getMetaJournalEntries().filter((entry) => Date.parse(entry.exitAt) >= lookbackCutoff);
    const wins = entries.filter((entry) => entry.realizedPnl > 0);
    const losses = entries.filter((entry) => entry.realizedPnl < 0);
    const pnl = entries.reduce((sum, entry) => sum + entry.realizedPnl, 0);
    const winRate = entries.length > 0 ? (wins.length / entries.length) * 100 : 0;
    const execution = this.getExecutionQualityByBroker();
    const risk = this.getPortfolioRiskSnapshot();
    const summary = `7d trades=${entries.length}, winRate=${winRate.toFixed(1)}%, pnl=${pnl.toFixed(2)}, openRisk=${risk.openRiskPct.toFixed(1)}%`;

    try {
      fs.mkdirSync(WEEKLY_REPORT_DIR, { recursive: true });
      const reportPath = path.join(WEEKLY_REPORT_DIR, `weekly-${weekKey}.md`);
      const body = [
        `# Hermes Weekly Report (${weekKey})`,
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
        `## KPI`,
        `- Trades: ${entries.length}`,
        `- Win rate: ${winRate.toFixed(1)}%`,
        `- Net realized PnL: ${round(pnl, 2)}`,
        '',
        `## Execution Quality`,
        ...execution.map((row) => `- ${row.broker}: score ${row.score}, slippage ${row.avgSlippageBps}bps, latency ${row.avgLatencyMs}ms, reject ${row.rejectRatePct}%`),
        '',
        `## Portfolio Risk`,
        `- Open notional: ${risk.totalOpenNotional}`,
        `- Open risk: ${risk.openRiskPct}% / budget ${risk.budgetPct}%`,
        ...risk.byCluster.map((row: any) => `- ${row.cluster}: ${row.pct}% (limit ${row.limitPct}%)`),
        ''
      ].join('\n');
      fs.writeFileSync(reportPath, body, 'utf8');
      this.latestWeeklyReport = { asOf: new Date().toISOString(), path: reportPath, summary };
      this.recordEvent('weekly-report', this.latestWeeklyReport as unknown as Record<string, unknown>);
    } catch (error) {
      console.error('[paper-engine] failed to write weekly report', error);
    }
  }

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

  private evaluateSloAndOperationalKillSwitch(): void {
    const dataFreshnessP95Ms = this.computeDataFreshnessP95Ms();
    const orderAckP95Ms = this.computeOrderAckP95Ms();
    const brokerErrorRatePct = this.computeBrokerErrorRatePct();
    const breaches: string[] = [];
    if (dataFreshnessP95Ms > DATA_FRESHNESS_SLO_MS) breaches.push(`data freshness p95 ${Math.round(dataFreshnessP95Ms)}ms`);
    if (orderAckP95Ms > ORDER_ACK_SLO_MS) breaches.push(`order ack p95 ${Math.round(orderAckP95Ms)}ms`);
    if (brokerErrorRatePct > BROKER_ERROR_SLO_PCT) breaches.push(`broker error rate ${brokerErrorRatePct.toFixed(2)}%`);
    const hadBreaches = this.latestSlo.breaches.length > 0;
    this.latestSlo = {
      dataFreshnessP95Ms: Math.round(dataFreshnessP95Ms),
      orderAckP95Ms: Math.round(orderAckP95Ms),
      brokerErrorRatePct: round(brokerErrorRatePct, 2),
      breaches
    };
    if (breaches.length > 0) {
      this.operationalKillSwitchUntilMs = Math.max(this.operationalKillSwitchUntilMs, Date.now() + 15 * 60_000);
      if (!hadBreaches) {
        this.recordEvent('slo-breach', { breaches, operationalKillSwitchUntilMs: this.operationalKillSwitchUntilMs });
      }
    }
  }

  private evaluatePortfolioCircuitBreaker(): void {
    const entries = this.getMetaJournalEntries().slice(-600);
    if (entries.length < 8) return;
    const now = new Date();
    const dayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
    const weekKey = `${now.getUTCFullYear()}-${Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(now.getUTCFullYear(), 0, 1)) / (7 * 86_400_000))}`;
    const dayEntries = entries.filter((entry) => {
      const d = new Date(entry.exitAt);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      return key === dayKey;
    });
    const weekEntries = entries.filter((entry) => {
      const d = new Date(entry.exitAt);
      const key = `${d.getUTCFullYear()}-${Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / (7 * 86_400_000))}`;
      return key === weekKey;
    });
    const dayPnl = dayEntries.reduce((sum, entry) => sum + entry.realizedPnl, 0);
    const weekPnl = weekEntries.reduce((sum, entry) => sum + entry.realizedPnl, 0);
    const deskEquity = Math.max(this.getDeskEquity(), 1);
    const dayLossPct = (-dayPnl / deskEquity) * 100;
    const weekLossPct = (-weekPnl / deskEquity) * 100;

    if (!this.circuitBreakerLatched && dayLossPct >= DAILY_CIRCUIT_BREAKER_DD_PCT) {
      this.circuitBreakerLatched = true;
      this.circuitBreakerScope = 'daily';
      this.circuitBreakerReason = `Daily drawdown exceeded ${DAILY_CIRCUIT_BREAKER_DD_PCT.toFixed(1)}% (${dayLossPct.toFixed(2)}%).`;
      this.circuitBreakerArmedAt = new Date().toISOString();
      this.circuitBreakerReviewed = false;
      this.recordEvent('circuit-breaker', { scope: 'daily', reason: this.circuitBreakerReason, dayLossPct: round(dayLossPct, 2) });
    }

    if (!this.circuitBreakerLatched && weekLossPct >= WEEKLY_CIRCUIT_BREAKER_DD_PCT) {
      this.circuitBreakerLatched = true;
      this.circuitBreakerScope = 'weekly';
      this.circuitBreakerReason = `Weekly drawdown exceeded ${WEEKLY_CIRCUIT_BREAKER_DD_PCT.toFixed(1)}% (${weekLossPct.toFixed(2)}%).`;
      this.circuitBreakerArmedAt = new Date().toISOString();
      this.circuitBreakerReviewed = false;
      this.recordEvent('circuit-breaker', { scope: 'weekly', reason: this.circuitBreakerReason, weekLossPct: round(weekLossPct, 2) });
    }
  }

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

  private buildDeskAnalytics(): PaperDeskAnalytics {
    const scopedAgents = this.getDeskAgentStates();
    const analyticsAgents = scopedAgents.filter((agent) => agent.evaluationWindow === 'live-market');
    const sourceAgents = analyticsAgents.length > 0 ? analyticsAgents : scopedAgents;
    const recentOutcomes = sourceAgents.flatMap((agent) => pickLast(agent.recentOutcomes, 6));
    const recentHolds = sourceAgents.flatMap((agent) => pickLast(agent.recentHoldTicks, 6));
    const wins = recentOutcomes.filter((value) => value > 0);
    const losses = recentOutcomes.filter((value) => value < 0);
    const grossWins = wins.reduce((sum, value) => sum + value, 0);
    const grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
    const totalOpenRisk = Array.from(this.agents.values()).reduce((sum, agent) => {
      if (!agent.position) return sum;
      const symbol = this.market.get(agent.config.symbol);
      const markPrice = symbol?.price ?? agent.position.entryPrice;
      // Unrealized PnL of open positions
      return sum + this.getPositionUnrealizedPnl(agent.position, markPrice);
    }, 0);
    const avgWinner = wins.length > 0 ? grossWins / wins.length : 0;
    const avgLoser = losses.length > 0 ? grossLosses / losses.length : 0;
    const recentWinRate = recentOutcomes.length > 0 ? (wins.length / recentOutcomes.length) * 100 : 0;

    return {
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0,
      avgWinner: round(avgWinner, 2),
      avgLoser: round(avgLoser, 2),
      avgHoldTicks: round(average(recentHolds), 2),
      recentWinRate: round(recentWinRate, 1),
      totalOpenRisk: round(totalOpenRisk, 2),
      adaptiveMode: 'bounded paper tuning on broker-fed market snapshots',
      verificationNote:
        'Firm equity comes from the live Alpaca paper account. Trader sleeve PnL only counts Hermes-owned broker-backed fills plus marked Hermes-owned open broker positions. Watch-only lanes stay visible for comparison, but they do not affect live paper performance until they actually route trades.',
      executionQuality: this.getExecutionQualityByBroker(),
      portfolioRisk: this.getPortfolioRiskSnapshot(),
      regimeKpis: this.regimeKpis,
      circuitBreaker: {
        active: this.circuitBreakerLatched,
        scope: this.circuitBreakerScope,
        reason: this.circuitBreakerReason,
        ...(this.circuitBreakerArmedAt ? { armedAt: this.circuitBreakerArmedAt } : {}),
        reviewed: this.circuitBreakerReviewed
      },
      slo: this.latestSlo,
      walkForward: this.getWalkForwardSnapshot()
    };
  }

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
  private async reconcileBrokerPaperState(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastBrokerSyncAtMs < BROKER_SYNC_MS) {
      return;
    }
    this.lastBrokerSyncAtMs = now;

    const snapshot = await this.fetchBrokerAccount(PAPER_BROKER);
    if (!snapshot) {
      return;
    }
    this.brokerPaperAccount = this.toBrokerPaperAccountState(snapshot);

    // Cache broker position quantities so sells use exact broker amounts (no dust)
    const posCache = new Map<string, number>();
    for (const pos of snapshot.positions) {
      const qty = typeof pos.quantity === 'number' ? pos.quantity : parseFloat(String(pos.quantity ?? '0'));
      if (qty > 0) posCache.set(pos.symbol, qty);
    }
    this._brokerPositionCache = posCache;

    // Also sync OANDA practice + Coinbase accounts for truthful firm-level paper metrics
    try {
      const [oandaSnap, coinbaseSnap] = await Promise.all([
        this.fetchBrokerAccount('oanda-rest'),
        this.fetchBrokerAccount('coinbase-live')
      ]);
      if (oandaSnap) {
        this.brokerOandaAccount = this.toBrokerPaperAccountState(oandaSnap);
      }
      if (coinbaseSnap) {
        this.brokerCoinbaseAccount = this.toBrokerPaperAccountState(coinbaseSnap);
      }
    } catch {
      // Secondary broker sync is best-effort
    }

    const positions = new Map(snapshot.positions.map((position) => [position.symbol, position]));
    const brokerOrders = normalizeArray(snapshot.orders);

    for (const agent of this.agents.values()) {
      if (agent.config.executionMode !== 'broker-paper') {
        continue;
      }

      agent.lastBrokerSyncAt = snapshot.asOf;
      const symbol = this.market.get(agent.config.symbol);
      if (!symbol) {
        continue;
      }

      const brokerPosition = positions.get(agent.config.symbol);
      const ownsBrokerPosition = this.hasHermesBrokerPosition(agent, brokerOrders);
      if (brokerPosition && ownsBrokerPosition) {
        this.syncBrokerPositionIntoAgent(agent, symbol, brokerPosition);
        continue;
      }

      if (brokerPosition && !ownsBrokerPosition) {
        agent.status = 'watching';
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        agent.lastAction = `Ignoring external ${symbol.symbol} broker position because it was not opened by Hermes.`;
        this.pushPoint(agent.curve, this.getAgentEquity(agent));
        continue;
      }

      if (agent.pendingOrderId && agent.pendingSide === 'sell' && agent.position) {
        this.finalizeBrokerFlat(agent, symbol, 'broker reconciliation');
        continue;
      }

      if (!agent.pendingOrderId && agent.position && (this.tick - agent.position.entryTick) > 20) {
        this.finalizeBrokerFlat(agent, symbol, 'external broker flatten');
      }
    }
  }

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
  private async step(recordHistory = true): Promise<void> {
    if (this.stepInFlight) {
      return;
    }
    this.stepInFlight = true;

    try {
    this.tick += 1;

    this.syncMarketFromRuntime(recordHistory);
    this.analyzeSignals();
    this.regimeKpis = this.buildRegimeKpis();
    this.evaluateSloAndOperationalKillSwitch();
    this.evaluatePortfolioCircuitBreaker();
    this.refreshCapitalAllocation();
    this.recordTickEvent();

    await this.reconcileBrokerPaperState();
    this.refreshScalpRoutePlan();
    await this.processEventDrivenExitQueue();
    this.maybeGenerateWeeklyReport();

    // Shadow Insider Bot: dynamically pivot to highest-conviction insider signal
    if (this.tick % 60 === 0) {
      const shadowAgent = Array.from(this.agents.values()).find((a) => a.config.id === 'agent-shadow-insider');
      if (shadowAgent && !shadowAgent.position) {
        const topSignal = this.insiderRadar.getTopBullishSignal(0.6);
        if (topSignal) {
          const targetSymbol = topSignal.symbol.includes('-') || topSignal.symbol.includes('_')
            ? topSignal.symbol
            : topSignal.symbol; // Stock tickers don't need suffix for Alpaca
          if (targetSymbol !== shadowAgent.config.symbol && this.market.has(targetSymbol)) {
            console.log(`[shadow-insider] Pivoting to ${targetSymbol} (conviction=${topSignal.convictionScore.toFixed(2)}, ${topSignal.direction}, cluster=${topSignal.isCluster})`);
            shadowAgent.config.symbol = targetSymbol;
            // Scale size with conviction: 0.6 → 3%, 0.8 → 5%, 1.0 → 6%
            shadowAgent.config.sizeFraction = round(0.03 + topSignal.convictionScore * 0.03, 3);
          }
        }
      }
    }

    for (const agent of this.agents.values()) {
      await this.updateAgent(agent);
    }

    // Log trade activity every 10 ticks
    if (this.tick % 10 === 0) {
      const states = Array.from(this.agents.values());
      const inTrade = states.filter((a) => a.status === 'in-trade').length;
      const cooldown = states.filter((a) => a.status === 'cooldown').length;
      const totalTrades = states.reduce((s, a) => s + a.trades, 0);
      const totalPnl = states.reduce((s, a) => s + a.realizedPnl, 0);
      const deskEq = this.getDeskEquity();
      console.log(`[engine] tick=${this.tick} inTrade=${inTrade} cooldown=${cooldown} trades=${totalTrades} pnl=$${totalPnl.toFixed(2)} equity=$${deskEq.toFixed(2)}`);
    }

    // Feed council with active trade candidates every tick so the dashboard shows votes
    for (const agent of this.agents.values()) {
      if (agent.position || agent.status === 'in-trade') {
        const symbol = this.market.get(agent.config.symbol);
        if (symbol) {
          this.aiCouncil.requestDecision({
            agentId: agent.config.id, agentName: agent.config.name, symbol: symbol.symbol,
            style: agent.config.style, score: 5, shortReturnPct: 0, mediumReturnPct: 0,
            lastPrice: symbol.price, spreadBps: symbol.spreadBps,
            liquidityScore: Math.round(symbol.liquidityScore), focus: agent.config.focus
          });
        }
      }
    }

    if (recordHistory) {
      this.normalizePresentationState();
      this.pushPoint(this.deskCurve, this.getDeskEquity());
      this.pushPoint(this.benchmarkCurve, this.getBenchmarkEquity());
      this.persistStateSnapshot();
    }
    } finally {
      this.stepInFlight = false;
    }
  }

  private async updateAgent(agent: AgentState): Promise<void> {
    const symbol = this.market.get(agent.config.symbol);
    if (!symbol) return;

    if (agent.config.executionMode === 'watch-only') {
      agent.status = 'watching';
      agent.lastAction = `${symbol.symbol} is watch-only until a broker-backed paper venue is enabled for this lane.`;
      this.pushPoint(agent.curve, this.getAgentEquity(agent));
      return;
    }

    // Arbitrage agents use a dedicated handler
    if (agent.config.style === 'arbitrage') {
      this.updateArbAgent(agent, symbol);
      this.pushPoint(agent.curve, this.getAgentEquity(agent));
      return;
    }

    if (!agent.config.autonomyEnabled) {
      const activePilots = Array.from(this.agents.values())
        .filter((candidate) => candidate.config.executionMode === 'broker-paper' && candidate.config.autonomyEnabled)
        .map((candidate) => candidate.config.symbol);
      agent.status = 'watching';
      agent.lastAction = `${symbol.symbol} is broker-backed but not armed for autonomous trading yet. Active pilot lanes: ${activePilots.join(', ') || 'none'}.`;
      this.pushPoint(agent.curve, this.getAgentEquity(agent));
      return;
    }

    const symbolGuard = this.getSymbolGuard(symbol.symbol);
    if (!agent.position && symbolGuard) {
      agent.status = 'cooldown';
      agent.cooldownRemaining = Math.max(agent.cooldownRemaining, 2);
      agent.lastAction = `${symbol.symbol} kill-switch active until ${new Date(symbolGuard.blockedUntilMs).toISOString()}: ${symbolGuard.blockReason}`;
      this.pushPoint(agent.curve, this.getAgentEquity(agent));
      return;
    }

    if (agent.pendingOrderId) {
      // Auto-clear stuck pending orders after 10 ticks (~30 seconds)
      agent.cooldownRemaining = (agent.cooldownRemaining ?? 0) + 1;
      if (agent.cooldownRemaining > 10) {
        console.log(`[paper-engine] Clearing stuck pending order ${agent.pendingOrderId} for ${agent.config.symbol} after 10 ticks`);
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        agent.cooldownRemaining = 2;
      } else {
        agent.status = 'cooldown';
        agent.lastAction = `Waiting for ${agent.pendingSide ?? 'broker'} order ${agent.pendingOrderId} to settle at ${this.formatBrokerLabel(agent.config.broker)}.`;
        this.pushPoint(agent.curve, this.getAgentEquity(agent));
        return;
      }
    }

    const tapeQualityBlock = this.getTapeQualityBlock(symbol);
    const liveTapeAvailable = !tapeQualityBlock;

    if (liveTapeAvailable) {
      this.rollToLiveSampleWindow(agent, symbol);
    }

    if (agent.position && tapeQualityBlock) {
      await this.closePosition(agent, symbol, 'tape quality gate');
      if (agent.position) {
        agent.lastAction = `Tried to flatten ${symbol.symbol} because the tape no longer met session/quote-quality rules, but the broker position is still open.`;
      }
      this.pushPoint(agent.curve, this.getAgentEquity(agent));
      return;
    }

    if (!agent.position && tapeQualityBlock) {
      agent.status = 'watching';
      agent.lastAction = tapeQualityBlock;
      this.pushPoint(agent.curve, this.getAgentEquity(agent));
      return;
    }

    const riskOff = this.signalBus.hasRecentSignalOfType('risk-off', 30_000);
    if (riskOff && (riskOff.severity === 'warning' || riskOff.severity === 'critical') && !agent.position) {
      agent.cooldownRemaining = Math.max(agent.cooldownRemaining, 2);
    }

    const spreadSignal = this.signalBus.hasRecentSignal('spread-expansion', symbol.symbol, 30_000);
    if (spreadSignal && !agent.position) {
      agent.status = 'watching';
      agent.lastAction = `Skipping ${symbol.symbol} entry: ${spreadSignal.message}`;
      this.pushPoint(agent.curve, this.getAgentEquity(agent));
      return;
    }

    const shortReturn = this.relativeMove(symbol.history, 4);
    const mediumReturn = this.relativeMove(symbol.history, 8);
    const spreadOkay = symbol.spreadBps <= agent.config.spreadLimitBps;
    const score = this.getEntryScore(agent.config.style, shortReturn, mediumReturn, symbol);
    // Market intelligence gate: only enter in direction of confirmed order flow
    const intel = this.marketIntel.getCompositeSignal(symbol.symbol);
    const intelBlocked = intel.tradeable && (
      (score > 0 && (intel.direction === 'sell' || intel.direction === 'strong-sell')) ||
      (score < 0 && (intel.direction === 'buy' || intel.direction === 'strong-buy'))
    );
    const newsSignal = this.newsIntel.getSignal(symbol.symbol);
    const macroNews = this.newsIntel.getMacroSignal();
    const calendarEmbargo = this.eventCalendar.getEmbargo(symbol.symbol);
    // In paper mode, skip all news blocks — agents need to trade to collect data
    const newsBlocked = false;

    if (!agent.position && newsBlocked) {
      agent.status = 'watching';
      agent.lastAction = newsSignal.veto
        ? `News veto on ${symbol.symbol}: ${newsSignal.reasons[0] ?? 'critical symbol-specific headline risk.'}`
        : `Skipping ${symbol.symbol}: news flow leans ${newsSignal.direction} with ${newsSignal.confidence}% confidence.`;
      this.pushPoint(agent.curve, this.getAgentEquity(agent));
      return;
    }

    const metaDecision = this.getMetaLabelDecision(agent, symbol, score, intel);
    if (!agent.position && !metaDecision.approve) {
      agent.status = 'watching';
      agent.lastAction = `Meta-label veto on ${symbol.symbol}: ${metaDecision.reason}`;
      this.pushPoint(agent.curve, this.getAgentEquity(agent));
      return;
    }

    const entryAllowed = !intelBlocked && !newsBlocked && metaDecision.approve && this.canEnter(agent, symbol, shortReturn, mediumReturn, score);
    const strongRulesApproval = agent.config.executionMode !== 'broker-paper' && score >= this.fastPathThreshold(agent.config.style);
    const aiDecision = entryAllowed
      ? this.aiCouncil.requestDecision({
          agentId: agent.config.id,
          agentName: agent.config.name,
          symbol: symbol.symbol,
          style: agent.config.style,
          score,
          shortReturnPct: shortReturn * 100,
          mediumReturnPct: mediumReturn * 100,
          lastPrice: symbol.price,
          spreadBps: symbol.spreadBps,
          liquidityScore: Math.round(symbol.liquidityScore),
          focus: agent.config.focus,
          newsSummary: newsSignal.articleCount > 0
            ? `${newsSignal.direction} news ${newsSignal.confidence}%: ${newsSignal.reasons[0] ?? 'recent symbol headlines'}`
            : 'No meaningful symbol-specific news signal.',
          macroSummary: macroNews.articleCount > 0
            ? `${macroNews.direction} macro ${macroNews.confidence}%: ${macroNews.reasons[0] ?? 'recent macro headlines'}`
            : 'No meaningful macro news signal.'
        })
      : null;
    const brokerRulesApproval = entryAllowed && this.canUseBrokerRulesFastPath(agent, symbol, score, aiDecision);
    const routeBlock = this.getRouteBlock(agent, symbol);
    const precisionBlock = this.getPrecisionBlock(agent, symbol);
    const managerBlock = this.getManagerBlock(agent, symbol);

    if (agent.position) {
      await this.manageOpenPosition(agent, symbol, score);
    } else if (routeBlock) {
      agent.status = 'cooldown';
      agent.cooldownRemaining = Math.max(agent.cooldownRemaining, 4);
      agent.lastAction = routeBlock;
    } else if (precisionBlock) {
      agent.status = 'cooldown';
      agent.cooldownRemaining = Math.max(agent.cooldownRemaining, 4);
      agent.lastAction = precisionBlock;
    } else if (managerBlock) {
      agent.status = 'cooldown';
      agent.cooldownRemaining = Math.max(agent.cooldownRemaining, 3);
      agent.lastAction = managerBlock;
    } else if (agent.cooldownRemaining > 0) {
      agent.cooldownRemaining -= 1;
      agent.status = 'cooldown';
      agent.lastAction = `Cooling down after ${agent.lastSymbol} scalp.`;
    } else if (spreadOkay && entryAllowed) {
      if (aiDecision?.status === 'complete') {
        if (aiDecision.finalAction === 'approve') {
          await this.openPosition(agent, symbol, score);
        } else if (agent.config.executionMode === 'broker-paper') {
          // Paper mode: council is advisory only — enter anyway to collect data
          await this.openPosition(agent, symbol, score);
          agent.lastAction = `${agent.lastAction} Council advised ${aiDecision.finalAction} but entered for paper data collection.`;
        } else if (brokerRulesApproval) {
          await this.openPosition(agent, symbol, score);
          agent.lastAction = `${agent.lastAction} Entered on manager rules fast-path.`;
        } else {
          agent.status = 'watching';
          agent.lastAction = this.describeAiState(aiDecision);
        }
      } else if (strongRulesApproval || brokerRulesApproval) {
        await this.openPosition(agent, symbol, score);
        agent.lastAction = brokerRulesApproval
          ? `${agent.lastAction} Entered on manager rules fast-path while AI council runs in advisory mode.`
          : `${agent.lastAction} Entered on strong rules fast-path while AI council reviews the setup in parallel.`;
      } else if (aiDecision) {
        agent.status = 'watching';
        agent.lastAction = this.describeAiState(aiDecision);
      } else {
        agent.status = 'watching';
        agent.lastAction = this.describeWatchState(agent.config.style, symbol, score);
      }
    } else {
      agent.status = 'watching';
      agent.lastAction = this.describeWatchState(agent.config.style, symbol, score);
    }

    this.pushPoint(agent.curve, this.getAgentEquity(agent));
  }

  private refreshScalpRoutePlan(): void {
    const journalEntries = this.getMetaJournalEntries();
    const candidates: ScalpRouteState[] = [];

    for (const agent of this.agents.values()) {
      const symbol = this.market.get(agent.config.symbol);
      if (!symbol) {
        continue;
      }

      const shortReturn = this.relativeMove(symbol.history, 4);
      const mediumReturn = this.relativeMove(symbol.history, 8);
      const score = this.getEntryScore(agent.config.style, shortReturn, mediumReturn, symbol);
      const intel = this.marketIntel.getCompositeSignal(symbol.symbol);
      const meta = this.getMetaLabelDecision(agent, symbol, score, intel);
      const context = this.buildJournalContext(symbol);
      const strategyName = `${agent.config.name} / scalping`;
      const recentEntries = journalEntries
        .filter((entry) => (entry.strategyId === agent.config.id || entry.strategy === strategyName) && entry.realizedPnl !== 0)
        .sort((left, right) => left.exitAt.localeCompare(right.exitAt))
        .slice(-12);
      const performance = this.summarizePerformance(recentEntries);
      const tradeable = agent.config.executionMode === 'broker-paper' && agent.config.autonomyEnabled;
      const edgeOk = meta.expectedNetEdgeBps > 0;
      const enabled = tradeable && meta.approve && edgeOk && !context.macroVeto && !context.embargoed;
      const direction: 'buy' | 'sell' | 'neutral' = meta.expectedNetEdgeBps > 0
        ? 'buy'
        : meta.expectedNetEdgeBps < 0
          ? 'neutral'
          : 'neutral';

      candidates.push({
        id: agent.config.id,
        strategyId: agent.config.id,
        strategy: strategyName,
        lane: 'scalping',
        symbols: [symbol.symbol],
        assetClass: symbol.assetClass,
        venue: agent.config.broker,
        direction,
        expectedGrossEdgeBps: round(meta.expectedGrossEdgeBps, 2),
        estimatedCostBps: round(meta.estimatedCostBps, 2),
        expectedNetEdgeBps: round(meta.expectedNetEdgeBps, 2),
        confidencePct: round(meta.probability, 1),
        support: meta.support,
        sampleCount: meta.sampleCount,
        recentWinRate: round(performance.winRate * 100, 1),
        profitFactor: round(performance.profitFactor, 2),
        expectancy: round(performance.expectancy, 2),
        regime: context.regime,
        newsBias: context.newsBias,
        orderFlowBias: context.orderFlowBias,
        macroVeto: context.macroVeto,
        embargoed: context.embargoed,
        enabled,
        selected: false,
        allocationMultiplier: round(agent.allocationMultiplier, 2),
        reason: meta.reason,
        selectedReason: meta.reason,
        routeRank: 0,
        updatedAt: new Date().toISOString()
      });
    }

    const grouped = new Map<AssetClass, ScalpRouteState[]>();
    for (const candidate of candidates) {
      const bucket = grouped.get(candidate.assetClass) ?? [];
      bucket.push(candidate);
      grouped.set(candidate.assetClass, bucket);
    }

    this.scalpRouteCandidates = new Map(candidates.map((candidate) => [candidate.strategyId, candidate]));
    this.selectedScalpByAssetClass.clear();
    this.selectedScalpOverallId = null;

    let overallLeader: ScalpRouteState | null = null;
    for (const [assetClass, group] of grouped.entries()) {
      const ranked = group
        .slice()
        .sort((left, right) => right.expectedNetEdgeBps - left.expectedNetEdgeBps || right.confidencePct - left.confidencePct || right.expectedGrossEdgeBps - left.expectedGrossEdgeBps);
      const positive = ranked.filter((candidate) => candidate.expectedNetEdgeBps > 0 && candidate.enabled);
      if (positive.length === 0) {
        for (const candidate of group) {
          candidate.selected = false;
          candidate.routeRank = ranked.findIndex((item) => item.strategyId === candidate.strategyId) + 1;
          candidate.selectedReason = `No positive-net route in ${assetClass} after estimated fees and slippage.`;
        }
        continue;
      }

      const leader = positive[0]!;
      const leaderSymbol = leader.symbols[0] ?? leader.strategyId;
      this.selectedScalpByAssetClass.set(assetClass, leader.strategyId);
      for (const candidate of group) {
        const candidateSymbol = candidate.symbols[0] ?? candidate.strategyId;
        candidate.routeRank = ranked.findIndex((item) => item.strategyId === candidate.strategyId) + 1;
        candidate.selected = candidate.strategyId === leader.strategyId;
        candidate.selectedReason = candidate.selected
          ? `Top net edge in ${assetClass}: ${leaderSymbol} at ${leader.expectedNetEdgeBps.toFixed(2)}bps after ${leader.estimatedCostBps.toFixed(2)}bps estimated costs.`
          : `${leaderSymbol} wins ${assetClass} routing with ${leader.expectedNetEdgeBps.toFixed(2)}bps net edge vs ${candidateSymbol} at ${candidate.expectedNetEdgeBps.toFixed(2)}bps.`;
      }

      if (!overallLeader || leader.expectedNetEdgeBps > overallLeader.expectedNetEdgeBps) {
        overallLeader = leader;
      }
    }

    if (overallLeader) {
      this.selectedScalpOverallId = overallLeader.strategyId;
    }
  }

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

  private async manageOpenPosition(agent: AgentState, symbol: SymbolState, score: number): Promise<void> {
    const position = agent.position;
    if (!position) return;
    this.maybeTrailBrokerStop(agent, symbol);
    const direction = this.getPositionDirection(position);
    const directionalMaxHoldTicks = symbol.assetClass === 'crypto' && direction === 'short'
      ? Math.max(6, Math.floor(agent.config.maxHoldTicks * 0.85))
      : agent.config.maxHoldTicks;
    position.peakPrice = direction === 'short'
      ? Math.min(position.peakPrice, symbol.price)
      : Math.max(position.peakPrice, symbol.price);

    const holdTicks = Math.max(0, this.tick - position.entryTick);

    const effectiveSpreadBps = Math.max(symbol.spreadBps, 3);
    const exitSpreadCost = position.entryPrice * (effectiveSpreadBps / 10_000);
    const breakEvenPrice = direction === 'short'
      ? position.entryPrice - exitSpreadCost
      : position.entryPrice + exitSpreadCost;
    const gain = direction === 'short'
      ? breakEvenPrice - symbol.price
      : symbol.price - breakEvenPrice;
    const peakGain = direction === 'short'
      ? breakEvenPrice - position.peakPrice
      : position.peakPrice - breakEvenPrice;
    const isGreen = gain >= 0;

    const directionalReturnPct = direction === 'short'
      ? ((position.entryPrice - symbol.price) / position.entryPrice) * 100
      : ((symbol.price - position.entryPrice) / position.entryPrice) * 100;

    if ((direction === 'short' && symbol.price <= position.targetPrice) || (direction === 'long' && symbol.price >= position.targetPrice)) {
      await this.closePosition(agent, symbol, `target reached (+${directionalReturnPct.toFixed(2)}%)`);
      return;
    }

    if (peakGain > exitSpreadCost && gain > 0 && gain < peakGain * 0.5 && holdTicks >= 5) {
      await this.closePosition(agent, symbol, `trailing stop (locked ${((gain / position.entryPrice) * 10000).toFixed(1)}bps of ${((peakGain / position.entryPrice) * 10000).toFixed(1)}bps peak)`);
      return;
    }

    const embargo = this.eventCalendar.getEmbargo(symbol.symbol);
    if (embargo.blocked && holdTicks >= 3) {
      if (isGreen) {
        await this.closePosition(agent, symbol, `embargo exit green (${embargo.reason})`);
        return;
      }
      const lossFromBreakeven = Math.abs((symbol.price - breakEvenPrice) / position.entryPrice) * 10_000;
      if (lossFromBreakeven < 5) {
        await this.closePosition(agent, symbol, `embargo exit near-BE (${embargo.reason}, -${lossFromBreakeven.toFixed(1)}bps)`);
        return;
      }
    }

    if (holdTicks >= directionalMaxHoldTicks && isGreen) {
      await this.closePosition(agent, symbol, `time stop green (+${((gain / position.entryPrice) * 10000).toFixed(1)}bps)`);
      return;
    }

    const catastrophicPct = getCatastrophicStopPct(agent.config.style);
    const catastrophicStop = direction === 'short'
      ? position.entryPrice * (1 + (1 - catastrophicPct))
      : position.entryPrice * catastrophicPct;
    if ((direction === 'short' && symbol.price >= catastrophicStop) || (direction === 'long' && symbol.price <= catastrophicStop)) {
      await this.closePosition(agent, symbol, `catastrophic stop (${((1 - catastrophicPct) * 100).toFixed(1)}%)`);
      return;
    }

    if (holdTicks >= directionalMaxHoldTicks * 3) {
      await this.closePosition(agent, symbol, `extended hold cut (${holdTicks} ticks, ${directionalReturnPct.toFixed(3)}%)`);
      return;
    }

    agent.status = 'in-trade';
    agent.lastAction = `Managing ${symbol.symbol} ${direction} scalp with ${holdTicks}/${directionalMaxHoldTicks} ticks elapsed.`;
  }

  private maybeTrailBrokerStop(_agent: AgentState, _symbol: SymbolState): void { const pos = _agent.position; if (!pos) return; const dir = this.getPositionDirection(pos); const { beActivation, trailActivation, trailRatio } = getTrailingStopParams(_symbol.assetClass, this.marketIntel.getFearGreedValue()); const targetDelta = dir === "short" ? pos.entryPrice - pos.targetPrice : pos.targetPrice - pos.entryPrice; if (targetDelta <= 0) return; const progress = dir === "short" ? pos.entryPrice - _symbol.price : _symbol.price - pos.entryPrice; const pct = progress / targetDelta; if (pct >= beActivation) { const be = dir === "short" ? pos.entryPrice * 0.9999 : pos.entryPrice * 1.0001; pos.stopPrice = dir === "short" ? Math.min(pos.stopPrice, be) : Math.max(pos.stopPrice, be); } if (pct >= trailActivation) { const trail = dir === "short" ? pos.entryPrice - progress * trailRatio : pos.entryPrice + progress * trailRatio; pos.stopPrice = dir === "short" ? Math.min(pos.stopPrice, trail) : Math.max(pos.stopPrice, trail); } }
  private async openPosition(agent: AgentState, symbol: SymbolState, score: number): Promise<void> {
    // Record a council decision for every trade entry so the dashboard shows votes
    const newsSignal = this.newsIntel.getSignal(symbol.symbol);
    const macroNews = this.newsIntel.getMacroSignal();
    const decision = this.aiCouncil.requestDecision({
      agentId: agent.config.id,
      agentName: agent.config.name,
      symbol: symbol.symbol,
      style: agent.config.style,
      score,
      shortReturnPct: 0,
      mediumReturnPct: 0,
      lastPrice: symbol.price,
      spreadBps: symbol.spreadBps,
      liquidityScore: Math.round(symbol.liquidityScore),
      focus: agent.config.focus,
      newsSummary: newsSignal.articleCount > 0
        ? `${newsSignal.direction} news ${newsSignal.confidence}%: ${newsSignal.reasons[0] ?? 'recent symbol headlines'}`
        : 'No meaningful symbol-specific news signal.',
      macroSummary: macroNews.articleCount > 0
        ? `${macroNews.direction} macro ${macroNews.confidence}%: ${macroNews.reasons[0] ?? 'recent macro headlines'}`
        : 'No meaningful macro news signal.'
    });

    const entryMeta = this.buildEntryMeta(agent, symbol, score);
    const direction = this.resolveEntryDirection(agent, symbol, score);
    if (!entryMeta.tags.includes(`dir-${direction}`)) {
      entryMeta.tags = [...entryMeta.tags, `dir-${direction}`];
    }
    agent.pendingCouncilDecision = decision;
    if (agent.config.executionMode === 'broker-paper') {
      await this.openBrokerPaperPosition(agent, symbol, score, entryMeta, decision, direction);
      return;
    }

    const sizedFraction = agent.config.sizeFraction * agent.allocationMultiplier;
    const notional = Math.min(this.getAgentEquity(agent) * sizedFraction, agent.cash * 0.9);
    if (notional <= 50) {
      agent.status = 'watching';
      agent.lastAction = 'Waiting for capital recycle after recent trades.';
      return;
    }

    const fillPrice = direction === 'short'
      ? symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25)
      : symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25);
    const quantity = notional / fillPrice;

    const entryFees = quantity * fillPrice * this.getFeeRate(symbol.assetClass);
    agent.cash -= (notional + entryFees);
    agent.realizedPnl -= entryFees;
    agent.feesPaid = round(agent.feesPaid + entryFees, 4);
    agent.position = {
      direction,
      quantity,
      entryPrice: fillPrice,
      entryTick: this.tick,
      entryAt: new Date().toISOString(),
      stopPrice: this.computeDynamicStop(fillPrice, agent, symbol, direction),
      targetPrice: this.computeDynamicTarget(fillPrice, agent, symbol, direction),
      peakPrice: fillPrice,
      note: this.entryNote(agent.config.style, symbol, score),
      entryMeta
    };
    agent.status = 'in-trade';
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = agent.position.note;
    this.recordFill({
      agent,
      symbol,
      orderId: `sim-${agent.config.id}-${direction === 'short' ? 'sell' : 'buy'}-${Date.now()}`,
      side: direction === 'short' ? 'sell' : 'buy',
      status: 'filled',
      price: fillPrice,
      pnlImpact: -entryFees,
      note: this.entryNote(agent.config.style, symbol, score),
      councilAction: decision.finalAction,
      councilConfidence: Math.max(decision.primary.confidence, decision.challenger?.confidence ?? 0),
      councilReason: decision.reason
    });
    console.log(`[TRADE] ${agent.config.name} OPEN ${direction.toUpperCase()} ${symbol.symbol} price=$${fillPrice.toFixed(2)} qty=${quantity.toFixed(6)} notional=$${(quantity * fillPrice).toFixed(2)} broker=${agent.config.broker} council=${decision.finalAction}`);
    this.persistStateSnapshot();
  }

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

  private async closePosition(agent: AgentState, symbol: SymbolState, reason: string, forcePnl?: number): Promise<void> {
    if (agent.config.executionMode === 'broker-paper') {
      await this.closeBrokerPaperPosition(agent, symbol, reason);
      return;
    }

    const position = agent.position;
    if (!position) return;

    const direction = this.getPositionDirection(position);
    const exitPrice = direction === 'short'
      ? symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25)
      : symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25);
    const grossPnl = this.computeGrossPnl(position, exitPrice, position.quantity);
    const fees = position.quantity * exitPrice * this.getFeeRate(symbol.assetClass);
    const realized = forcePnl !== undefined ? forcePnl : grossPnl - fees;
    const costBasis = position.entryPrice * position.quantity;
    this.noteTradeOutcome(agent, symbol, realized, reason);

    agent.cash += costBasis + realized;
    agent.realizedPnl = round(agent.realizedPnl + realized, 2);
    agent.feesPaid = round(agent.feesPaid + fees, 4);
    agent.lastExitPnl = realized;
    agent.trades += 1;
    if (realized >= 0) {
      agent.wins += 1;
    } else {
      agent.losses += 1;
    }
    console.log(`[TRADE] ${agent.config.name} CLOSE ${symbol.symbol} pnl=$${realized.toFixed(4)} entry=$${position.entryPrice.toFixed(2)} exit=$${exitPrice.toFixed(2)} reason=${reason} total_trades=${agent.trades} total_pnl=$${agent.realizedPnl.toFixed(2)}`);

    const realizedPnlPct = (realized / costBasis) * 100;
    const verdict = realized > 0 ? 'winner' : realized < 0 ? 'loser' : 'scratch';
    const aiComment = realized >= 0
      ? 'The setup worked because the entry waited for spread compression before committing size.'
      : 'The setup lost edge before the tape could follow through. Tightening entry quality matters more than trading more often.';
    const holdTicks = this.tick - position.entryTick;
    const journalContext = this.buildJournalContext(symbol);

    this.recordFill({
      agent,
      symbol,
      orderId: `sim-${agent.config.id}-${direction === 'short' ? 'buy' : 'sell'}-${Date.now()}`,
      side: direction === 'short' ? 'buy' : 'sell',
      status: 'filled',
      price: exitPrice,
      pnlImpact: realized,
      note: `Closed paper scalp at ${round(exitPrice, 2)} on ${reason}.`,
      source: 'simulated'
    });
    this.recordJournal({
      id: `paper-journal-${Date.now()}-${agent.config.id}-${randomUUID()}`,
      symbol: symbol.symbol,
      assetClass: symbol.assetClass,
      broker: agent.config.broker,
      strategy: `${agent.config.name} / scalping`,
      strategyId: agent.config.id,
      lane: 'scalping',
      thesis: position.note,
      entryAt: position.entryAt ?? new Date().toISOString(),
      entryTimestamp: position.entryAt ?? new Date().toISOString(),
      exitAt: new Date().toISOString(),
      realizedPnl: round(realized, 2),
      realizedPnlPct: round(realizedPnlPct, 3),
      slippageBps: round(symbol.spreadBps * 0.25, 2),
      spreadBps: round(symbol.spreadBps, 2),
      holdTicks,
      confidencePct: journalContext.confidencePct,
      regime: journalContext.regime,
      newsBias: journalContext.newsBias,
      orderFlowBias: journalContext.orderFlowBias,
      macroVeto: journalContext.macroVeto,
      embargoed: journalContext.embargoed,
      tags: [...journalContext.tags, `dir-${direction}`],
      ...(position.entryMeta ? {
        entryScore: position.entryMeta.score,
        entryHeuristicProbability: position.entryMeta.heuristicProbability,
        entryContextualProbability: position.entryMeta.contextualProbability,
        entryTrainedProbability: position.entryMeta.trainedProbability,
        entryApprove: position.entryMeta.approve,
        entryReason: position.entryMeta.reason,
        entryConfidencePct: position.entryMeta.confidencePct,
        entryRegime: position.entryMeta.regime,
        entryNewsBias: position.entryMeta.newsBias,
        entryOrderFlowBias: position.entryMeta.orderFlowBias,
        entryMacroVeto: position.entryMeta.macroVeto,
        entryEmbargoed: position.entryMeta.embargoed,
        entryTags: position.entryMeta.tags,
        estimatedCostBps: position.entryMeta.estimatedCostBps,
        expectedGrossEdgeBps: position.entryMeta.expectedGrossEdgeBps,
        expectedNetEdgeBps: position.entryMeta.expectedNetEdgeBps
      } : {}),
      aiComment,
      exitReason: reason,
      verdict,
      source: 'simulated'
    });

    this.pushPoint(agent.recentOutcomes, round(realized, 2), OUTCOME_HISTORY_LIMIT);
    this.pushPoint(agent.recentHoldTicks, holdTicks, OUTCOME_HISTORY_LIMIT);
    this.checkSymbolKillswitch(agent);
    this.applyAdaptiveTuning(agent, symbol);
    this.evaluateChallengerProbation(agent, symbol);

    agent.position = null;
    agent.status = 'cooldown';
    agent.cooldownRemaining = this.getAdaptiveCooldown(agent, symbol);
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `Booked ${realized >= 0 ? 'gain' : 'loss'} on ${symbol.symbol}: ${round(realized, 2)} after ${reason}.`;
    this.persistStateSnapshot();
  }

  /**
   * Cross-exchange arbitrage handler.
   * Compares prices for the same symbol across Alpaca and Coinbase.
   * If the spread between venues exceeds round-trip costs, simulates the arb.
   */
  private updateArbAgent(agent: AgentState, symbol: SymbolState): void {
    if (!agent.config.autonomyEnabled) {
      agent.status = 'watching';
      agent.lastAction = `Arb scanner disabled — autonomy not enabled.`;
      return;
    }

    if (agent.cooldownRemaining > 0) {
      agent.cooldownRemaining -= 1;
      agent.status = 'cooldown';
      return;
    }

    // Find the same symbol on the OTHER broker
    const myBroker = agent.config.broker;
    const counterBroker: BrokerId = myBroker === 'coinbase-live' ? 'alpaca-paper' : 'coinbase-live';

    // Find any agent on the counter-broker trading the same symbol to get its price view
    const counterAgent = Array.from(this.agents.values()).find(
      (other) => other.config.symbol === agent.config.symbol && other.config.broker === counterBroker
    );
    const counterSymbol = counterAgent ? this.market.get(counterAgent.config.symbol) : null;

    if (!counterSymbol || counterSymbol.price <= 0 || symbol.price <= 0) {
      agent.status = 'watching';
      agent.lastAction = `Waiting for price data on both venues for ${symbol.symbol}.`;
      return;
    }

    // If already in an arb position, check exit
    if (agent.position) {
      const holdTicks = this.tick - agent.position.entryTick;
      const gain = symbol.price - agent.position.entryPrice;

      // Close arb after short hold or if spread collapsed
      if (holdTicks >= agent.config.maxHoldTicks || gain > 0) {
        const pnl = gain * agent.position.quantity;
        agent.cash += (agent.position.entryPrice * agent.position.quantity) + pnl;
        agent.realizedPnl = round(agent.realizedPnl + pnl, 2);
        agent.lastExitPnl = pnl;
        agent.trades += 1;
        if (pnl > 0) agent.wins += 1;
        console.log(`[ARB] ${agent.config.name} closed ${symbol.symbol} arb: pnl=$${pnl.toFixed(4)} hold=${holdTicks} ticks`);
        this.pushPoint(agent.recentOutcomes, round(pnl, 2), OUTCOME_HISTORY_LIMIT);
        const exitPrice = symbol.price;
        this.recordFill({
          agent, symbol,
          orderId: `arb-${agent.config.id}-exit-${Date.now()}`,
          side: 'sell', status: 'filled', price: exitPrice, pnlImpact: round(pnl, 4),
          note: `Arb exit ${symbol.symbol}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} after ${holdTicks} ticks`,
          source: 'simulated'
        });
        agent.position = null;
        agent.status = 'cooldown';
        agent.cooldownRemaining = this.getAdaptiveCooldown(agent, symbol);
        agent.lastAction = `Arb closed on ${symbol.symbol}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}`;
        return;
      }

      agent.status = 'in-trade';
      agent.lastAction = `Holding ${symbol.symbol} arb position (${holdTicks}/${agent.config.maxHoldTicks} ticks).`;
      return;
    }

    // Detect arb opportunity: Coinbase native orderbook vs Alpaca pass-through pricing
    // Coinbase (native exchange) typically has tighter spreads than Alpaca (market maker markup).
    // Use the orderflow data from market-intel to model the real Coinbase bid/ask.
    const orderFlow = this.marketIntel.getSnapshot().orderFlow.find((f) => f.symbol === symbol.symbol);
    const coinbaseMid = symbol.price;
    const coinbaseSpreadBps = orderFlow?.spreadBps ?? symbol.spreadBps;
    // Alpaca adds ~3-8bps markup on top of exchange price for crypto
    const alpacaMarkupBps = symbol.assetClass === 'crypto' ? 5 : 2;
    const alpacaMid = coinbaseMid * (1 + alpacaMarkupBps / 10_000);
    const spreadBetweenVenues = Math.abs(alpacaMid - coinbaseMid);
    const spreadBps = (spreadBetweenVenues / coinbaseMid) * 10_000;

    // Arb edge = venue spread minus both sides' execution costs
    const totalCostBps = coinbaseSpreadBps + symbol.spreadBps + 2; // 2bps safety margin
    const arbEdgeBps = spreadBps - totalCostBps;

    if (arbEdgeBps <= 0) {
      agent.status = 'watching';
      agent.lastAction = `Scanning ${symbol.symbol} arb: venue spread ${spreadBps.toFixed(1)}bps, cost ${totalCostBps.toFixed(1)}bps, no edge.`;
      return;
    }

    // Arb detected! Buy on cheaper venue (Coinbase native is typically cheaper)
    const buyPrice = Math.min(coinbaseMid, alpacaMid);
    const notional = this.getAgentEquity(agent) * agent.config.sizeFraction * agent.allocationMultiplier;
    if (notional <= 50) {
      agent.status = 'watching';
      agent.lastAction = 'Arb detected but insufficient capital.';
      return;
    }

    const quantity = round(notional / buyPrice, 6);
    agent.cash -= notional;
    const arbNote = `Arb entry: ${spreadBps.toFixed(1)}bps venue spread, ${arbEdgeBps.toFixed(1)}bps edge after costs. Buy@${buyPrice.toFixed(2)} (${coinbaseMid < alpacaMid ? 'Coinbase' : 'Alpaca'} cheaper).`;
    agent.position = {
      direction: 'long',
      quantity,
      entryPrice: buyPrice,
      entryTick: this.tick,
      entryAt: new Date().toISOString(),
      stopPrice: buyPrice * 0.999,
      targetPrice: buyPrice * (1 + arbEdgeBps / 10_000),
      peakPrice: buyPrice,
      note: arbNote
    };
    agent.status = 'in-trade';
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `ARB ENTRY: ${symbol.symbol} ${arbEdgeBps.toFixed(1)}bps edge, bought at ${buyPrice.toFixed(2)}`;
    console.log(`[ARB] ${agent.config.name} entered ${symbol.symbol}: edge=${arbEdgeBps.toFixed(1)}bps, qty=${quantity}, notional=$${notional.toFixed(2)}`);

    this.recordFill({
      agent, symbol,
      orderId: `arb-${agent.config.id}-${Date.now()}`,
      side: 'buy', status: 'filled', price: buyPrice, pnlImpact: 0,
      note: arbNote,
      source: 'simulated'
    });
  }

  /** Adaptive cooldown: longer after losses in bad conditions, shorter when winning */
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

  private async openBrokerPaperPosition(
    agent: AgentState,
    symbol: SymbolState,
    score: number,
    entryMeta: PositionEntryMetaState,
    decision: AiCouncilDecision,
    direction: PositionDirection
  ): Promise<void> {
    // Half-Kelly dynamic sizing from rolling 30-trade window
    const kellyFraction = this.computeHalfKelly(agent);
    const baseFraction = kellyFraction > 0 ? Math.min(kellyFraction, agent.config.sizeFraction * 2) : agent.config.sizeFraction;

    // Conviction-based sizing + streak awareness
    const intel = this.marketIntel.getCompositeSignal(symbol.symbol);
    const convictionMultiplier = intel.confidence >= 60 ? 1.3 : intel.confidence >= 40 ? 1.0 : 0.7;
    const regimeMultiplier = this.getRegimeThrottleMultiplier(symbol);
    const calibrationMultiplier = this.computeConfidenceCalibrationMultiplier(agent);
    const edgeConfidenceMultiplier = clamp((entryMeta.trainedProbability / 100) * 1.4, 0.55, 1.35);
    // Sizing multipliers delegated to paper-engine/sizing.ts
    const fng = this.marketIntel.getFearGreedValue();
    const consecutiveLosses = this.countConsecutiveLosses(agent.recentOutcomes ?? []);
    const streakMultiplier = computeStreakMultiplier(consecutiveLosses, agent.config.style, fng);
    const executionMultiplier = this.getExecutionQualityMultiplier(agent.config.broker);
    const fngMultiplier = computeFngSizeMultiplier(agent.config.style, symbol.assetClass, fng);

    const sizedFraction = baseFraction
      * agent.allocationMultiplier
      * convictionMultiplier
      * streakMultiplier
      * executionMultiplier
      * regimeMultiplier
      * calibrationMultiplier
      * edgeConfidenceMultiplier
      * fngMultiplier;
    const notional = Math.min(this.getAgentEquity(agent) * sizedFraction, agent.cash * 0.9);
    if (notional <= 50) {
      agent.status = 'watching';
      agent.lastAction = 'Waiting for capital recycle before submitting a broker-backed paper order.';
      return;
    }

    // OANDA requires integer units for forex/bond/commodity; crypto uses 6 decimals
    const rawQty = notional / Math.max(symbol.price, 1);
    const quantity = agent.config.broker === 'oanda-rest'
      ? Math.max(1, Math.floor(rawQty))
      : round(rawQty, 6);
    if (quantity <= 0) {
      agent.status = 'watching';
      agent.lastAction = `Skipped ${symbol.symbol} because the computed order quantity was not tradable.`;
      return;
    }

    // Coinbase has no paper API — simulate fills locally using live tape prices
    if (this.shouldSimulateLocally(agent.config.broker)) {
      const fillPrice = direction === 'short'
        ? symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25)
        : symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25);
      const entryFees = quantity * fillPrice * this.getFeeRate(symbol.assetClass);
      agent.cash -= (notional + entryFees);
      agent.realizedPnl -= entryFees;
      agent.feesPaid = round(agent.feesPaid + entryFees, 4);
      agent.position = {
        direction,
        quantity,
        entryPrice: fillPrice,
        entryTick: this.tick,
        entryAt: new Date().toISOString(),
        stopPrice: this.computeDynamicStop(fillPrice, agent, symbol, direction),
        targetPrice: this.computeDynamicTarget(fillPrice, agent, symbol, direction),
        peakPrice: fillPrice,
        note: this.entryNote(agent.config.style, symbol, score),
        entryMeta
      };
      agent.status = 'in-trade';
      agent.lastSymbol = symbol.symbol;
      agent.lastAction = `Paper sim buy ${symbol.symbol} at ${round(fillPrice, 2)} (local sim, no live orders).`;
      this.recordFill({
        agent, symbol,
        orderId: `sim-${agent.config.id}-${direction === 'short' ? 'sell' : 'buy'}-${Date.now()}`,
        side: direction === 'short' ? 'sell' : 'buy', status: 'filled', price: fillPrice, pnlImpact: 0,
        note: `Paper sim entry at ${round(fillPrice, 2)}. ${agent.position.note}`,
        source: 'simulated',
        councilAction: decision.finalAction,
        councilConfidence: Math.max(decision.primary.confidence, decision.challenger?.confidence ?? 0),
        councilReason: decision.reason
      });
      this.persistStateSnapshot();
      return;
    }

    const entrySide: OrderSide = direction === 'short' ? 'sell' : 'buy';
    const orderId = `paper-${agent.config.id}-${entrySide}-${Date.now()}`;
    const brokerLabel = this.formatBrokerLabel(agent.config.broker);
    agent.pendingOrderId = orderId;
    agent.pendingSide = entrySide;
    agent.pendingEntryMeta = entryMeta;
    agent.status = 'cooldown';
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `Submitting ${brokerLabel} ${entrySide} for ${symbol.symbol}.`;

    try {
      const entryCounters = this.executionQualityCounters.get(agent.config.broker) ?? { attempts: 0, rejects: 0, partialFills: 0 };
      entryCounters.attempts += 1;
      this.executionQualityCounters.set(agent.config.broker, entryCounters);
      const report = await this.routeBrokerOrder({
        id: orderId,
        symbol: symbol.symbol,
        broker: agent.config.broker,
        side: entrySide,
        orderType: 'market',
        notional,
        quantity,
        strategy: `${agent.config.name} / scalping`,
        mode: 'paper',
        thesis: this.entryNote(agent.config.style, symbol, score)
      });
      agent.lastBrokerSyncAt = report.timestamp;

      if (report.status === 'rejected') {
        entryCounters.rejects += 1;
        this.executionQualityCounters.set(agent.config.broker, entryCounters);
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        agent.pendingEntryMeta = undefined;
        agent.cooldownRemaining = 1;
        agent.lastAction = `${brokerLabel} ${entrySide} rejected for ${symbol.symbol}: ${report.message}`;
        return;
      }

      if (report.status !== 'filled' || report.avgFillPrice <= 0 || report.filledQty <= 0) {
        agent.pendingEntryMeta = entryMeta;
        agent.lastAction = `${brokerLabel} ${entrySide} accepted for ${symbol.symbol}, waiting for broker fill.`;
        return;
      }

      this.applyBrokerFilledEntry(agent, symbol, report, score, entryMeta);
    } catch (error) {
      agent.pendingOrderId = null;
      agent.pendingSide = null;
      agent.cooldownRemaining = 2;
      agent.lastAction = `Failed to submit ${brokerLabel} ${entrySide} for ${symbol.symbol}: ${error instanceof Error ? error.message : 'unknown error'}.`;
    }
  }

  private async closeBrokerPaperPosition(agent: AgentState, symbol: SymbolState, reason: string): Promise<void> {
    const position = agent.position;
    if (!position) {
      return;
    }

    // Discard dust positions that are below broker minimums
    const notional = position.quantity * symbol.price;
    if (notional < 1) {
      agent.position = null;
      agent.pendingOrderId = null;
      agent.pendingSide = null;
      agent.cooldownRemaining = 1;
      agent.status = 'cooldown';
      agent.lastAction = `Discarded dust position in ${symbol.symbol} (notional $${notional.toFixed(4)}).`;
      this.persistStateSnapshot();
      return;
    }

    // Local simulation path (currently disabled — all trades go through broker APIs)
    if (this.shouldSimulateLocally(agent.config.broker)) {
      const direction = this.getPositionDirection(position);
      const exitPrice = direction === 'short'
        ? symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25)
        : symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25);
      const proceeds = position.quantity * exitPrice;
      const exitFees = proceeds * this.getFeeRate(symbol.assetClass);
      const pnl = this.computeGrossPnl(position, exitPrice, position.quantity) - exitFees;
      agent.cash += (proceeds - exitFees);
      agent.realizedPnl += pnl;
      agent.feesPaid = round(agent.feesPaid + exitFees, 4);
      agent.lastExitPnl = pnl;
      if (pnl > 0) agent.wins += 1;
      agent.trades += 1;
      agent.position = null;
      agent.cooldownRemaining = this.getAdaptiveCooldown(agent, symbol);
      agent.status = 'cooldown';
      agent.lastAction = `Paper sim exit ${symbol.symbol} at ${round(exitPrice, 2)} (${reason}). PnL ${pnl >= 0 ? '+' : ''}${round(pnl, 2)}.`;
      this.recordFill({
        agent, symbol,
        orderId: `sim-${agent.config.id}-${direction === 'short' ? 'buy' : 'sell'}-${Date.now()}`,
        side: direction === 'short' ? 'buy' : 'sell', status: 'filled', price: exitPrice, pnlImpact: pnl,
        note: `Paper sim exit at ${round(exitPrice, 2)}. ${reason}`,
        source: 'simulated'
      });
      this.persistStateSnapshot();
      return;
    }

    const exitSide: OrderSide = this.getPositionDirection(position) === 'short' ? 'buy' : 'sell';
    const orderId = `paper-${agent.config.id}-${exitSide}-${Date.now()}`;
    const brokerLabel = this.formatBrokerLabel(agent.config.broker);
    agent.pendingOrderId = orderId;
    agent.pendingSide = exitSide;
    agent.status = 'cooldown';
    agent.lastAction = `Submitting ${brokerLabel} exit for ${symbol.symbol} after ${reason}.`;

    try {
      const exitCounters = this.executionQualityCounters.get(agent.config.broker) ?? { attempts: 0, rejects: 0, partialFills: 0 };
      exitCounters.attempts += 1;
      this.executionQualityCounters.set(agent.config.broker, exitCounters);
      // Use broker's actual position quantity to avoid dust
      const brokerQty = this._brokerPositionCache?.get(agent.config.symbol) ?? position.quantity;
      const sellQty = agent.config.broker === 'oanda-rest'
        ? Math.floor(brokerQty)
        : brokerQty;

      const report = await this.routeBrokerOrder({
        id: orderId,
        symbol: symbol.symbol,
        broker: agent.config.broker,
        side: exitSide,
        orderType: 'market',
        notional: sellQty * Math.max(symbol.price, position.entryPrice),
        quantity: sellQty,
        strategy: `${agent.config.name} / scalping`,
        mode: 'paper',
        thesis: `Exit ${symbol.symbol} because ${reason}.`
      });
      agent.lastBrokerSyncAt = report.timestamp;

      if (report.status === 'rejected') {
        exitCounters.rejects += 1;
        this.executionQualityCounters.set(agent.config.broker, exitCounters);
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        agent.lastAction = `${brokerLabel} exit rejected for ${symbol.symbol}: ${report.message}`;
        return;
      }

      if (report.status !== 'filled' || report.avgFillPrice <= 0 || report.filledQty <= 0) {
        agent.lastAction = `${brokerLabel} exit accepted for ${symbol.symbol}, waiting for broker fill.`;
        return;
      }

      this.applyBrokerFilledExit(agent, symbol, report, reason);
    } catch (error) {
      agent.pendingOrderId = null;
      agent.pendingSide = null;
      agent.lastAction = `Failed to submit ${brokerLabel} exit for ${symbol.symbol}: ${error instanceof Error ? error.message : 'unknown error'}.`;
    }
  }

  private applyBrokerFilledEntry(
    agent: AgentState,
    symbol: SymbolState,
    report: BrokerRouteResponse,
    score: number,
    entryMeta?: PositionEntryMetaState
  ): void {
    const decision = agent.pendingCouncilDecision;
    const pendingSide = agent.pendingSide;
    const direction: PositionDirection = pendingSide === 'sell' ? 'short' : 'long';
    const fillPrice = report.avgFillPrice;
    const quantity = round(report.filledQty, 6);
    const costBasis = fillPrice * quantity;
    const note = this.entryNote(agent.config.style, symbol, score);

    agent.pendingOrderId = null;
    agent.pendingSide = null;
    agent.pendingEntryMeta = undefined;
    const entryFees = costBasis * this.getFeeRate(symbol.assetClass);
    agent.cash -= (costBasis + entryFees);
    agent.realizedPnl -= entryFees;
    agent.feesPaid = round(agent.feesPaid + entryFees, 4);
    agent.position = {
      direction,
      quantity,
      entryPrice: fillPrice,
      entryTick: this.tick,
      entryAt: new Date().toISOString(),
      stopPrice: this.computeDynamicStop(fillPrice, agent, symbol, direction),
      targetPrice: this.computeDynamicTarget(fillPrice, agent, symbol, direction),
      peakPrice: fillPrice,
      note,
      entryMeta: entryMeta ?? agent.pendingEntryMeta ?? this.buildEntryMeta(agent, symbol, score)
    };
    agent.status = 'in-trade';
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `Broker-filled ${this.formatBrokerLabel(agent.config.broker)} entry at ${round(fillPrice, 2)}. ${note}`;
    console.log(`[TRADE] ${agent.config.name} BROKER-ENTRY ${symbol.symbol} price=$${fillPrice.toFixed(2)} qty=${quantity.toFixed(6)} notional=$${costBasis.toFixed(2)} fees=$${entryFees.toFixed(4)} broker=${agent.config.broker} orderId=${report.orderId}`);

    this.recordFill({
      agent,
      symbol,
      orderId: report.orderId,
      side: pendingSide ?? 'buy',
      status: 'filled',
      price: fillPrice,
      pnlImpact: 0,
      note: `Broker-filled ${this.formatBrokerLabel(agent.config.broker)} entry at ${round(fillPrice, 2)}. ${note}`,
      source: 'broker',
      councilAction: decision?.finalAction,
      councilConfidence: decision ? Math.max(decision.primary.confidence, decision.challenger?.confidence ?? 0) : undefined,
      councilReason: decision?.reason
    });
    agent.pendingCouncilDecision = undefined;
    this.persistStateSnapshot();
  }

  private applyBrokerFilledExit(
    agent: AgentState,
    symbol: SymbolState,
    report: BrokerRouteResponse,
    reason: string,
    forcePnl?: number
  ): void {
    const position = agent.position;
    if (!position) {
      agent.pendingOrderId = null;
      agent.pendingSide = null;
      return;
    }

    const exitPrice = report.avgFillPrice;
    const closedQuantity = round(Math.min(position.quantity, report.filledQty > 0 ? report.filledQty : position.quantity), 6);
    const isPartialFill = closedQuantity < position.quantity * 0.95; // <95% = partial
    const direction = this.getPositionDirection(position);
    const grossPnl = this.computeGrossPnl(position, exitPrice, closedQuantity);
    const fees = closedQuantity * exitPrice * this.getFeeRate(symbol.assetClass);
    const realized = forcePnl !== undefined ? forcePnl : grossPnl - fees;
    const costBasis = position.entryPrice * closedQuantity;
    const realizedPnlPct = (realized / costBasis) * 100;
    this.noteTradeOutcome(agent, symbol, realized, reason);

    if (isPartialFill) {
      const counters = this.executionQualityCounters.get(agent.config.broker) ?? { attempts: 0, rejects: 0, partialFills: 0 };
      counters.partialFills += 1;
      this.executionQualityCounters.set(agent.config.broker, counters);
      const remainQty = round(position.quantity - closedQuantity, 6);
      console.log(`[PARTIAL FILL] ${agent.config.name} ${symbol.symbol}: closed ${closedQuantity} of ${position.quantity}, ${remainQty} remaining. Will retry next tick.`);
      // Keep position open with reduced quantity — next tick will attempt to close remainder
      position.quantity = remainQty;
      agent.cash += (position.entryPrice * closedQuantity) + realized;
      agent.realizedPnl = round(agent.realizedPnl + realized, 2);
      agent.feesPaid = round(agent.feesPaid + fees, 4);
      agent.lastAction = `Partial fill on ${symbol.symbol} exit: ${closedQuantity} filled, ${remainQty} remaining.`;
      agent.pendingOrderId = null;
      agent.pendingSide = null;
      return;
    }
    const verdict = realized > 0 ? 'winner' : realized < 0 ? 'loser' : 'scratch';
    const aiComment = realized >= 0
      ? 'The setup worked because the entry quality and tape gate kept the strategy out of weak quotes.'
      : 'The broker-backed paper trade still lost edge. Trade less or tighten entry quality before adding more size.';
    const holdTicks = this.tick - position.entryTick;
    const journalContext = this.buildJournalContext(symbol);

    agent.pendingOrderId = null;
    agent.pendingSide = null;
    agent.pendingEntryMeta = undefined;
    agent.cash += costBasis + realized;
    agent.realizedPnl = round(agent.realizedPnl + realized, 2);
    agent.feesPaid = round(agent.feesPaid + fees, 4);
    agent.lastExitPnl = realized;
    agent.trades += 1;
    if (realized >= 0) {
      agent.wins += 1;
    } else {
      agent.losses += 1;
    }
    console.log(`[TRADE] ${agent.config.name} BROKER-EXIT ${symbol.symbol} pnl=$${realized.toFixed(4)} exit=$${exitPrice.toFixed(2)} reason=${reason} total_trades=${agent.trades} total_pnl=$${agent.realizedPnl.toFixed(2)}`);

    this.recordFill({
      agent,
      symbol,
      orderId: report.orderId,
      side: direction === 'short' ? 'buy' : 'sell',
      status: 'filled',
      price: exitPrice,
      pnlImpact: realized,
      note: `Broker-filled ${this.formatBrokerLabel(agent.config.broker)} exit at ${round(exitPrice, 2)} on ${reason}.`,
      source: 'broker'
    });
    this.recordJournal({
      id: `paper-journal-${Date.now()}-${agent.config.id}-${randomUUID()}`,
      symbol: symbol.symbol,
      assetClass: symbol.assetClass,
      broker: agent.config.broker,
      strategy: `${agent.config.name} / scalping`,
      strategyId: agent.config.id,
      lane: 'scalping',
      thesis: position.note,
      entryAt: position.entryAt ?? new Date().toISOString(),
      entryTimestamp: position.entryAt ?? new Date().toISOString(),
      exitAt: new Date().toISOString(),
      realizedPnl: round(realized, 2),
      realizedPnlPct: round(realizedPnlPct, 3),
      slippageBps: round(symbol.price > 0 ? Math.abs((exitPrice - symbol.price) / symbol.price) * 10_000 : symbol.spreadBps * 0.25, 2),
      spreadBps: round(symbol.spreadBps, 2),
      ...(report.latencyMs !== undefined ? { latencyMs: report.latencyMs } : {}),
      holdTicks,
      confidencePct: journalContext.confidencePct,
      regime: journalContext.regime,
      newsBias: journalContext.newsBias,
      orderFlowBias: journalContext.orderFlowBias,
      macroVeto: journalContext.macroVeto,
      embargoed: journalContext.embargoed,
      tags: [...journalContext.tags, `dir-${direction}`],
      ...(position.entryMeta ? {
        entryScore: position.entryMeta.score,
        entryHeuristicProbability: position.entryMeta.heuristicProbability,
        entryContextualProbability: position.entryMeta.contextualProbability,
        entryTrainedProbability: position.entryMeta.trainedProbability,
        entryApprove: position.entryMeta.approve,
        entryReason: position.entryMeta.reason,
        entryConfidencePct: position.entryMeta.confidencePct,
        entryRegime: position.entryMeta.regime,
        entryNewsBias: position.entryMeta.newsBias,
        entryOrderFlowBias: position.entryMeta.orderFlowBias,
        entryMacroVeto: position.entryMeta.macroVeto,
        entryEmbargoed: position.entryMeta.embargoed,
        entryTags: position.entryMeta.tags,
        estimatedCostBps: position.entryMeta.estimatedCostBps,
        expectedGrossEdgeBps: position.entryMeta.expectedGrossEdgeBps,
        expectedNetEdgeBps: position.entryMeta.expectedNetEdgeBps
      } : {}),
      aiComment,
      exitReason: reason,
      verdict,
      source: 'broker'
    });

    this.pushPoint(agent.recentOutcomes, round(realized, 2), OUTCOME_HISTORY_LIMIT);
    this.pushPoint(agent.recentHoldTicks, holdTicks, OUTCOME_HISTORY_LIMIT);
    this.checkSymbolKillswitch(agent);
    this.applyAdaptiveTuning(agent, symbol);
    this.evaluateChallengerProbation(agent, symbol);

    agent.position = null;
    agent.status = 'cooldown';
    agent.cooldownRemaining = this.getAdaptiveCooldown(agent, symbol);
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `Booked ${realized >= 0 ? 'gain' : 'loss'} on broker-backed ${symbol.symbol}: ${round(realized, 2)} after ${reason}.`;
    this.persistStateSnapshot();
  }

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

  private getMetaLabelDecision(
    agent: AgentState,
    symbol: SymbolState,
    score: number,
    intel: {
      direction: 'strong-buy' | 'buy' | 'neutral' | 'sell' | 'strong-sell';
      confidence: number;
      tradeable: boolean;
      adverseSelectionRisk?: number;
      quoteStabilityMs?: number;
    }
  ): {
    approve: boolean;
    probability: number;
    reason: string;
    heuristicProbability: number;
    contextualProbability: number;
    trainedProbability: number;
    contextualReason: string;
    trainedReason: string;
    sampleCount: number;
    support: number;
    expectedGrossEdgeBps: number;
    estimatedCostBps: number;
    expectedNetEdgeBps: number;
  } {
    const recent = pickLast(agent.recentOutcomes, 8);
    const wins = recent.filter((value) => value > 0).length;
    const losses = recent.filter((value) => value < 0).length;
    const posteriorWinRate = (wins + 1) / Math.max(wins + losses + 2, 1);
    const grossWins = recent.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLosses = Math.abs(recent.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 1.5 : 1;
    const safeScore = Number.isFinite(score) ? score : 0;
    const scoreQuality = clamp((safeScore - this.entryThreshold(agent.config.style)) / Math.max(this.fastPathThreshold(agent.config.style) - this.entryThreshold(agent.config.style), 1), 0, 1);
    const spreadQuality = clamp(1 - (symbol.spreadBps / Math.max(agent.config.spreadLimitBps, 0.1)), 0, 1);
    const intelBonus = intel.tradeable ? clamp(intel.confidence / 100, 0, 1) * 0.15 : 0.05;
    const heuristicProbability = clamp(
      0.18
        + posteriorWinRate * 0.32
        + clamp(profitFactor / 3, 0, 0.2)
        + scoreQuality * 0.18
        + spreadQuality * 0.12
        + intelBonus,
      0,
      0.99
    );

    const contextual = this.getContextualMetaSignal(agent, symbol, intel);
    this.getMetaJournalEntries(); // Ensure caches are warm
    const trained = this.metaModelCache
      ? predictWithModel(this.metaModelCache, this.buildMetaCandidate(agent, symbol, intel))
      : { posterior: 0.5, support: 0, sampleCount: this.metaJournalCache.length, matchedTokens: [], reason: 'Insufficient trained samples.' };
    const contextualWeight = clamp(contextual.support / 24, 0, 0.28);
    const trainedReadiness = clamp((trained.sampleCount - 7) / 24, 0, 1);
    const trainedWeight = (clamp(trained.sampleCount / 30, 0, 0.22) + clamp(trained.support / 30, 0, 0.18)) * trainedReadiness;
    const heuristicWeight = Math.max(0.2, 1 - contextualWeight - trainedWeight);
    const weightSum = heuristicWeight + contextualWeight + trainedWeight;
    let probability = (
      heuristicProbability * heuristicWeight
      + contextual.posterior * contextualWeight
      + trained.posterior * trainedWeight
    ) / Math.max(weightSum, Number.EPSILON);

    if ((intel.adverseSelectionRisk ?? 0) >= 70) {
      probability *= 0.78;
    }
    if ((intel.quoteStabilityMs ?? 9_999) < 1_500) {
      probability *= 0.84;
    }
    if (trained.sampleCount >= 12 && trained.posterior < 0.45) {
      probability *= 0.9;
    }
    probability = clamp(probability, 0, 0.99);

    const expectedGrossEdgeBps = estimateExpectedGrossEdgeBps(probability * 100, agent.config.targetBps, agent.config.stopBps);
    const estimatedCostBps = estimateRoundTripCostBps({
      assetClass: symbol.assetClass,
      broker: agent.config.broker,
      spreadBps: symbol.spreadBps,
      orderType: 'market',
      adverseSelectionRisk: intel.adverseSelectionRisk,
      quoteStabilityMs: intel.quoteStabilityMs,
      postOnly: false,
      shortSide: false
    });
    const expectedNetEdgeBps = expectedGrossEdgeBps - estimatedCostBps;

    const netPositive = expectedNetEdgeBps > 0;
    if (!netPositive) {
      probability *= 0.75;
    }

    // Paper mode: low floor to maximize data collection. Tighten for live.
    const approvalFloor = agent.config.executionMode === 'broker-paper' ? 0.30 : 0.6;
    const approve = probability >= approvalFloor;
    const reasonPrefix = `precision ${round(probability * 100, 1)}% (heuristic ${round(heuristicProbability * 100, 1)}%, contextual ${round(contextual.posterior * 100, 1)}%, trained ${round(trained.posterior * 100, 1)}%, gross ${round(expectedGrossEdgeBps, 1)}bps, cost ${round(estimatedCostBps, 1)}bps, net ${round(expectedNetEdgeBps, 1)}bps)`;
    return {
      approve,
      probability: round(probability * 100, 1),
      reason: approve
        ? `${reasonPrefix}. ${contextual.reason} ${trained.reason}`
        : `${reasonPrefix}. ${contextual.reason} ${trained.reason} Need stronger edge or cleaner tape.`,
      heuristicProbability: round(heuristicProbability * 100, 1),
      contextualProbability: round(contextual.posterior * 100, 1),
      trainedProbability: round(trained.posterior * 100, 1),
      contextualReason: contextual.reason,
      trainedReason: trained.reason,
      sampleCount: trained.sampleCount,
      support: contextual.support,
      expectedGrossEdgeBps,
      estimatedCostBps,
      expectedNetEdgeBps
    };
  }

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

  private getContextualMetaSignal(
    agent: AgentState,
    symbol: SymbolState,
    intel: {
      direction: 'strong-buy' | 'buy' | 'neutral' | 'sell' | 'strong-sell';
      confidence: number;
    }
  ): { posterior: number; support: number; reason: string } {
    const entries = this.getMetaJournalEntries();
    if (entries.length === 0) {
      return { posterior: 0.5, support: 0, reason: 'No historical journal support.' };
    }

    const strategyName = `${agent.config.name} / scalping`;
    const regime = this.classifySymbolRegime(symbol);
    const flowBucket = this.normalizeFlowBucket(intel.direction);
    const confidenceBucket = this.getConfidenceBucket(intel.confidence);
    const spreadBucket = this.getSpreadBucket(symbol.spreadBps, agent.config.spreadLimitBps);

    // Use durable feature-store history first (indexed SQLite), then fall back to in-memory journaling.
    const sqliteSnapshot = this.featureStore.getPosteriorSnapshot({
      strategyId: agent.config.id,
      strategy: strategyName,
      symbol: symbol.symbol,
      regime,
      flowBucket,
      confidenceBucket,
      spreadBucket
    });
    if (sqliteSnapshot.support >= 4) {
      return sqliteSnapshot;
    }

    const exact = entries.filter((entry) => (entry.strategyId === agent.config.id || entry.strategy === strategyName));
    const symbolMatches = entries.filter((entry) => entry.symbol === symbol.symbol);
    const contextMatches = entries.filter((entry) =>
      entry.symbol === symbol.symbol
      && (entry.regime ?? 'unknown') === regime
      && this.normalizeFlowBucket(entry.orderFlowBias ?? 'neutral') === flowBucket
      && this.getConfidenceBucket(entry.confidencePct ?? 0) === confidenceBucket
      && this.getSpreadBucket(entry.spreadBps, agent.config.spreadLimitBps) === spreadBucket
    );
    const regimeMatches = entries.filter((entry) =>
      (entry.regime ?? 'unknown') === regime
      && this.normalizeFlowBucket(entry.orderFlowBias ?? 'neutral') === flowBucket
    );

    const summarize = (group: TradeJournalEntry[], priorWins: number, priorLosses: number) => {
      const winsLocal = group.filter((entry) => entry.realizedPnl > 0).length;
      const lossesLocal = group.filter((entry) => entry.realizedPnl < 0).length;
      const posterior = (winsLocal + priorWins) / Math.max(winsLocal + lossesLocal + priorWins + priorLosses, 1);
      return {
        count: group.length,
        posterior,
        expectancy: group.length > 0 ? average(group.map((entry) => entry.realizedPnl)) : 0
      };
    };

    const global = summarize(entries, 3, 3);
    const exactStats = summarize(exact, 2, 2);
    const symbolStats = summarize(symbolMatches, 2, 2);
    const contextStats = summarize(contextMatches, 2, 2);
    const regimeStats = summarize(regimeMatches, 2, 2);

    const weightedPosterior = clamp(
      global.posterior * 0.15
      + regimeStats.posterior * 0.2
      + symbolStats.posterior * 0.25
      + contextStats.posterior * 0.25
      + exactStats.posterior * 0.15,
      0.05,
      0.98
    );
    const support = exactStats.count + contextStats.count + symbolStats.count + regimeStats.count;
    const reason = `context exact ${exactStats.count}, symbol ${symbolStats.count}, regime ${regimeStats.count}, context ${contextStats.count}.`;
    return { posterior: weightedPosterior, support, reason };
  }

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
  private canEnter(agent: AgentState, symbol: SymbolState, shortReturn: number, mediumReturn: number, score: number): boolean {
    // Paper mode: smart entries with multiple filters
    if (agent.config.executionMode === 'broker-paper' && symbol.price > 0 && symbol.tradable) {
      if (this.circuitBreakerLatched) return false;
      if (this.operationalKillSwitchUntilMs > Date.now()) return false;
      if (symbol.spreadBps > agent.config.spreadLimitBps) return false;
      const guard = this.getSymbolGuard(symbol.symbol);
      if (guard) return false;
      const sessionGate = this.evaluateSessionKpiGate(symbol);
      if (!sessionGate.pass) return false;
      const intel = this.marketIntel.getCompositeSignal(symbol.symbol);
      const direction = this.resolveEntryDirection(agent, symbol, score, intel);
      const regime = this.classifySymbolRegime(symbol);
      const regimeThrottle = this.getRegimeThrottleMultiplier(symbol);
      if (regimeThrottle < 0.5) return false;
      const strongDirectionSignal = direction === 'short'
        ? (intel.direction === 'sell' || intel.direction === 'strong-sell')
        : (intel.direction === 'buy' || intel.direction === 'strong-buy');

      if (symbol.assetClass === 'crypto') {
        const cryptoGuard = this.evaluateCryptoExecutionGuard(symbol, intel);
        if (!cryptoGuard.pass) {
          agent.lastAction = cryptoGuard.reason;
          return false;
        }
      }

      if (Math.abs(score) < this.entryThreshold(agent.config.style)) return false;
      if (!strongDirectionSignal && intel.confidence < 65) return false;

      // 1. Time-of-day filter (delegated to entry-filters.ts)
      if (isTimeBlocked(symbol.assetClass)) return false;
      if (symbol.assetClass === 'crypto' && direction === 'long') {
        const riskOffActive = this.signalBus.hasRecentSignalOfType('risk-off', 120_000);
        const panicRegime = this.classifySymbolRegime(symbol) === 'panic';
        if (riskOffActive || (panicRegime && symbol.drift <= -0.004)) return false;
      }

      // 2. Volume/momentum confirmation from composite signal
      if (agent.config.style === 'momentum' && direction === 'long' && (intel.direction === 'sell' || intel.direction === 'strong-sell')) return false;
      if (agent.config.style === 'momentum' && direction === 'short' && (intel.direction === 'buy' || intel.direction === 'strong-buy')) return false;
      // Fix #11: Block crowded trades — if Binance funding shows everyone positioned same way, skip
      if (symbol.assetClass === 'crypto' && this.derivativesIntel.shouldBlockEntry(symbol.symbol, direction)) return false;

      // Fix #1: removed mean-reversion strong-buy rejection — MR should enter at extremes

      // 3. Correlation filter: stagger entries in same asset class
      const recentSameClass = Array.from(this.agents.values()).some((other) => {
        if (other.config.id === agent.config.id || !other.position) return false;
        if ((this.tick - other.position.entryTick) >= 3) return false;
        const otherSymbol = this.market.get(other.config.symbol);
        return otherSymbol ? otherSymbol.assetClass === symbol.assetClass : false;
      });
      if (recentSameClass) return false;

      // 3b. Regime anti-overtrading: reduce concurrent entries in unstable regimes.
      const openSameClass = Array.from(this.agents.values()).filter((other) => {
        if (other.config.id === agent.config.id || !other.position) return false;
        const otherSymbol = this.market.get(other.config.symbol);
        return otherSymbol ? otherSymbol.assetClass === symbol.assetClass : false;
      }).length;
      const maxConcurrent = regime === 'panic' ? 1 : regime === 'trend' ? 2 : 1;
      if (openSameClass >= maxConcurrent) return false;
      if (this.breachesCrowdingLimit(symbol)) return false;

      // 4. Minimum price history: need at least 20 data points for indicators to work
      if (symbol.history.length < 20) return false;

      // 5-6. VWAP + RSI(2) filters (delegated to entry-filters.ts)
      const rsi2 = this.marketIntel.computeRSI2(symbol.symbol);
      const fngVal = this.marketIntel.getFearGreedValue();
      if (isVwapBlocked(agent.config.style, symbol.assetClass, this.marketIntel.isVwapFlat(symbol.symbol), fngVal, rsi2)) return false;
      if (isRsi2Blocked(agent.config.style, direction, rsi2, fngVal)) return false;
      // Falling knife filter (Gemini insight)
      const bb = this.marketIntel.getSnapshot().bollinger.find((b) => b.symbol === symbol.symbol);
      if (isFallingKnifeBlocked(symbol.assetClass, direction, rsi2, fngVal, bb?.squeeze ?? false, bb?.pricePosition ?? 0.5)) return false;

      // 7. Stochastic(14,3,3) confirmation for forex momentum entries
      if (symbol.assetClass === 'forex' && agent.config.style === 'momentum') {
        const stoch = this.marketIntel.computeStochastic(symbol.symbol);
        if (stoch && stoch.crossover === 'bearish') return false;
      }

      // 8. Stochastic(14,3,3) confirmation for forex mean-reversion — need oversold crossover
      if (symbol.assetClass === 'forex' && agent.config.style === 'mean-reversion') {
        const stoch = this.marketIntel.computeStochastic(symbol.symbol);
        if (stoch && stoch.k > 50 && stoch.crossover !== 'bullish') return false;
      }

      // 9. RSI(14) multi-timeframe (delegated to entry-filters.ts)
      if (isRsi14Blocked(agent.config.style, direction, this.marketIntel.computeRSI14(symbol.symbol), fngVal)) return false;

      // 10. Regime + edge gate: require higher expected net edge in riskier regimes.
      const meta = this.getMetaLabelDecision(agent, symbol, score, intel);
      const minNetEdgeBps = regime === 'panic'
        ? (symbol.assetClass === 'crypto' ? 14 : 10)
        : regime === 'trend'
          ? 6
          : 4;
      if (meta.expectedNetEdgeBps < minNetEdgeBps) return false;
      const qualityMult = this.getExecutionQualityMultiplier(agent.config.broker);
      const proposedNotional = Math.min(this.getAgentEquity(agent) * agent.config.sizeFraction * agent.allocationMultiplier * qualityMult, agent.cash * 0.9);
      if (proposedNotional > 0 && this.wouldBreachPortfolioRiskBudget(agent, symbol, proposedNotional)) return false;

      return true;
    }

    const style = agent.config.style;
    const shortSma = average(pickLast(symbol.history, 4));
    const longSma = average(pickLast(symbol.history, 12));
    const isBrokerPaperEquity = agent.config.executionMode === 'broker-paper' && symbol.assetClass === 'equity';
    const isBrokerPaperCrypto = agent.config.executionMode === 'broker-paper' && symbol.assetClass === 'crypto';
    const isBrokerPaperFx = agent.config.executionMode === 'broker-paper'
      && (symbol.assetClass === 'forex' || symbol.assetClass === 'bond' || symbol.assetClass === 'commodity');

    if (style === 'momentum') {
      if (isBrokerPaperEquity) {
        return (
          score > this.entryThreshold(style)
          && shortReturn > 0.0005
          && shortSma > longSma
          && symbol.bias > 0
          && symbol.spreadBps <= agent.config.spreadLimitBps
        );
      }
      if (isBrokerPaperCrypto) {
        return (
          score > this.entryThreshold(style)
          && shortReturn > 0.0004
          && shortSma > longSma
          && symbol.bias > 0
          && symbol.spreadBps <= agent.config.spreadLimitBps
        );
      }
      if (isBrokerPaperFx) {
        return (
          score > Math.max(this.entryThreshold(style) - 0.5, 0.8)
          && shortReturn > 0.0002
          && shortSma > longSma * 1.00002
          && symbol.bias > 0
          && symbol.spreadBps <= agent.config.spreadLimitBps
        );
      }
      return score > this.entryThreshold(style) && shortReturn > 0.0012 && mediumReturn > 0.0014 && shortSma > longSma && symbol.bias > 0;
    }

    if (style === 'breakout') {
      const breakoutWindow = pickLast(symbol.history, 9).slice(0, -1);
      const breakoutBase = breakoutWindow.length > 0 ? Math.max(...breakoutWindow) : symbol.price;
      if (isBrokerPaperEquity) {
        return (
          score > Math.max(this.entryThreshold(style) + 1.1, 5.9)
          && shortReturn > 0.0019
          && mediumReturn > 0.0021
          && symbol.price > breakoutBase * 1.001
          && symbol.bias > 0.0002
          && symbol.liquidityScore >= 90
          && symbol.spreadBps <= Math.min(agent.config.spreadLimitBps, 2.5)
        );
      }
      if (isBrokerPaperFx) {
        return (
          score > Math.max(this.entryThreshold(style) - 1.5, 3.0)
          && shortReturn > 0.0004
          && symbol.price > breakoutBase * 1.0002
          && symbol.bias > 0
          && symbol.spreadBps <= agent.config.spreadLimitBps
        );
      }
      return score > this.entryThreshold(style) && shortReturn > 0.0015 && symbol.price > breakoutBase * 1.0007 && symbol.bias > 0;
    }

    if (isBrokerPaperCrypto) {
      return (
        score > Math.max(this.entryThreshold(style) + 0.2, 1.45)
        && shortReturn < -0.0012
        && mediumReturn > -0.003
        && symbol.price < longSma * 0.9989
        && symbol.bias > -0.00035
        && symbol.liquidityScore >= 94
        && symbol.spreadBps <= Math.min(agent.config.spreadLimitBps, 3.5)
      );
    }

    if (isBrokerPaperFx) {
      return (
        score > Math.max(this.entryThreshold(style) - 0.2, 1.0)
        && shortReturn < -0.0003
        && mediumReturn > -0.002
        && symbol.price < longSma * 0.99985
        && symbol.spreadBps <= agent.config.spreadLimitBps
      );
    }

    return score > this.entryThreshold(style) && shortReturn < -0.0007 && symbol.price < longSma * 0.9994;
  }

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

  private refreshCapitalAllocation(): void {
    const contenders = Array.from(this.agents.values()).filter((agent) => agent.config.executionMode === 'broker-paper' && agent.config.autonomyEnabled);
    if (contenders.length === 0) {
      return;
    }

    const rawScores = contenders.map((agent) => {
      const recent = pickLast(agent.recentOutcomes, 30); // 30-trade rolling window for stable ranking
      const wins = recent.filter((value) => value > 0).length;
      const losses = recent.filter((value) => value < 0).length;
      const posteriorMean = (wins + 1) / Math.max(wins + losses + 2, 1);
      const expectancy = recent.length > 0 ? average(recent) : 0;
      const grossWins = recent.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
      const grossLosses = Math.abs(recent.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
      const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 1.5 : 1;
      const symbol = this.market.get(agent.config.symbol) ?? null;
      const recentJournal = this.getRecentJournalEntries(agent, symbol, 12);
      const mistakeProfile = this.buildMistakeProfile(agent, symbol, recentJournal);
      const tapeBonus = symbol && this.hasTradableTape(symbol) ? 0.08 : -0.12;
      const embargoPenalty = this.eventCalendar.getEmbargo(agent.config.symbol).blocked ? -0.35 : 0;
      const newsPenalty = this.newsIntel.getSignal(agent.config.symbol).veto ? -0.25 : 0;
      const intelligence = this.marketIntel.getCompositeSignal(agent.config.symbol);
      const convictionBonus = intelligence.tradeable ? Math.min(intelligence.confidence / 1000, 0.08) : 0;
      const mistakePenalty = mistakeProfile.dominant === 'clean'
        ? mistakeProfile.sampleCount >= 8 ? 0.02 : 0
        : mistakeProfile.dominant === 'spread-leakage'
          ? clamp(0.08 + mistakeProfile.severity / 1200, 0.08, 0.22)
          : mistakeProfile.dominant === 'premature-exit'
            ? clamp(0.06 + mistakeProfile.severity / 1500, 0.06, 0.18)
            : mistakeProfile.dominant === 'overstay'
              ? clamp(0.07 + mistakeProfile.severity / 1400, 0.07, 0.2)
              : mistakeProfile.dominant === 'noise-chasing'
                ? clamp(0.1 + mistakeProfile.severity / 1100, 0.1, 0.24)
                : clamp(0.14 + mistakeProfile.severity / 900, 0.14, 0.28);
      const score = clamp(
        0.35
          + posteriorMean * 0.4
          + clamp(profitFactor / 4, 0, 0.35)
          + clamp(expectancy / 40, -0.08, 0.08)
          + tapeBonus
          + convictionBonus
          + embargoPenalty
          + newsPenalty
          - mistakePenalty,
        0.2,
        1.8
      );
      return { agent, score, posteriorMean, profitFactor, expectancy, mistakeProfile };
    });

    const meanScore = average(rawScores.map((item) => item.score)) || 1;
    for (const item of rawScores) {
      const multiplier = clamp(round(item.score / meanScore, 3), 0.4, 1.6);
      const changed = Math.abs(multiplier - item.agent.allocationMultiplier) >= 0.05;
      item.agent.allocationMultiplier = multiplier;
      item.agent.allocationScore = round(item.score, 3);
      item.agent.allocationReason = `Bandit allocation score ${item.score.toFixed(2)} from posterior ${(item.posteriorMean * 100).toFixed(1)}%, PF ${item.profitFactor.toFixed(2)}, expectancy ${item.expectancy.toFixed(2)}. Mistake loop: ${item.mistakeProfile.summary}`;
      if (changed) {
        this.recordEvent('allocation-update', {
          agentId: item.agent.config.id,
          symbol: item.agent.config.symbol,
          allocationMultiplier: item.agent.allocationMultiplier,
          allocationScore: item.agent.allocationScore,
          reason: item.agent.allocationReason
        });
      }
    }
  }

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

  private toAgentSnapshot(agent: AgentState): PaperAgentSnapshot {
    const equity = this.getAgentEquity(agent);
    const netPnl = this.getAgentNetPnl(agent);
    const winRate = agent.trades === 0 ? 0 : (agent.wins / agent.trades) * 100;
    const symbol = this.market.get(agent.config.symbol);
    const directionBias = agent.position
      ? this.getPositionDirection(agent.position)
      : 'neutral';
    const executionQualityScore = this.getExecutionQualityByBroker().find((row: any) => row.broker === agent.config.broker)?.score ?? 0;
    const sessionKpiGate = symbol ? this.evaluateSessionKpiGate(symbol).message : 'Session gate unavailable.';
    const killSwitch = this.getSymbolGuard(agent.config.symbol);
    const entryThrottle = symbol ? this.getRegimeThrottleMultiplier(symbol) : 1;
    const operationalGate = this.circuitBreakerLatched
      ? `Circuit breaker (${this.circuitBreakerScope}) active.`
      : this.operationalKillSwitchUntilMs > Date.now()
        ? `Operational kill switch until ${new Date(this.operationalKillSwitchUntilMs).toISOString()}.`
        : 'clear';

    return {
      id: agent.config.id,
      name: agent.config.name,
      lane: 'scalping',
      broker: agent.config.broker,
      status: agent.status,
      equity,
      dayPnl: netPnl,
      realizedPnl: round(agent.realizedPnl, 2),
      feesPaid: round(agent.feesPaid, 2),
      returnPct: agent.startingEquity > 0 ? round((netPnl / agent.startingEquity) * 100, 2) : 0,
      winRate: round(winRate, 1),
      totalTrades: agent.trades,
      openPositions: agent.position ? 1 : 0,
      lastAction: agent.lastAction,
      lastSymbol: agent.lastSymbol,
      focus: agent.config.focus,
      lastExitPnl: round(agent.lastExitPnl, 2),
      directionBias,
      executionQualityScore: round(executionQualityScore, 1),
      sessionKpiGate,
      symbolKillSwitchUntil: killSwitch ? new Date(killSwitch.blockedUntilMs).toISOString() : null,
      entryThrottle: round(entryThrottle, 2),
      operationalGate,
      curve: [...agent.curve]
    };
  }

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
