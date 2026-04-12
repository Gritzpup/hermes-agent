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

type AgentStyle = 'momentum' | 'mean-reversion' | 'breakout' | 'arbitrage';
type AgentExecutionMode = 'broker-paper' | 'watch-only';
type PositionDirection = 'long' | 'short';
type SessionBucket = 'asia' | 'europe' | 'us' | 'off';

interface SymbolState {
  symbol: string;
  broker: BrokerId;
  assetClass: AssetClass;
  marketStatus: 'live' | 'delayed' | 'stale';
  sourceMode: 'broker' | 'service' | 'simulated' | 'mock';
  session: MarketSession;
  tradable: boolean;
  qualityFlags: string[];
  updatedAt: string;
  price: number;
  openPrice: number;
  volume: number;
  liquidityScore: number;
  spreadBps: number;
  baseSpreadBps: number;
  drift: number;
  volatility: number;
  meanAnchor: number;
  bias: number;
  history: number[];
  returns: number[];
}

interface PositionEntryMetaState {
  score: number;
  heuristicProbability: number;
  contextualProbability: number;
  trainedProbability: number;
  approve: boolean;
  reason: string;
  confidencePct: number;
  regime: string;
  newsBias: string;
  orderFlowBias: string;
  macroVeto: boolean;
  embargoed: boolean;
  tags: string[];
  expectedGrossEdgeBps: number;
  estimatedCostBps: number;
  expectedNetEdgeBps: number;
}

interface PerformanceSummary {
  sampleCount: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
}

interface ScalpRouteState {
  id: string;
  strategyId: string;
  strategy: string;
  lane: StrategyMode;
  symbols: string[];
  assetClass: AssetClass;
  venue: BrokerId;
  direction: 'buy' | 'sell' | 'neutral';
  expectedGrossEdgeBps: number;
  estimatedCostBps: number;
  expectedNetEdgeBps: number;
  confidencePct: number;
  support: number;
  sampleCount: number;
  recentWinRate: number;
  profitFactor: number;
  expectancy: number;
  regime: string;
  newsBias: string;
  orderFlowBias: string;
  macroVeto: boolean;
  embargoed: boolean;
  enabled: boolean;
  selected: boolean;
  allocationMultiplier: number;
  reason: string;
  selectedReason: string;
  routeRank: number;
  updatedAt: string;
}

interface PositionState {
  direction: PositionDirection;
  quantity: number;
  entryPrice: number;
  entryTick: number;
  entryAt?: string;
  stopPrice: number;
  targetPrice: number;
  peakPrice: number;
  note: string;
  entryMeta?: PositionEntryMetaState | undefined;
}

interface AgentConfig {
  id: string;
  name: string;
  symbol: string;
  broker: BrokerId;
  style: AgentStyle;
  executionMode: AgentExecutionMode;
  autonomyEnabled: boolean;
  focus: string;
  targetBps: number;
  stopBps: number;
  maxHoldTicks: number;
  cooldownTicks: number;
  sizeFraction: number;
  spreadLimitBps: number;
}

interface AgentDeploymentState {
  mode: 'stable' | 'challenger-probation';
  championConfig: AgentConfig | null;
  challengerConfig: AgentConfig | null;
  startedAt: string | null;
  startingTrades: number;
  startingRealizedPnl: number;
  startingOutcomeCount: number;
  probationTradesRequired: number;
  rollbackLossLimit: number;
  lastDecision: string;
}

interface AgentState {
  config: AgentConfig;
  baselineConfig: AgentConfig;
  evaluationWindow: 'legacy' | 'live-market';
  startingEquity: number;
  cash: number;
  realizedPnl: number;
  feesPaid: number;
  wins: number;
  losses: number;
  trades: number;
  status: AgentStatus;
  cooldownRemaining: number;
  position: PositionState | null;
  pendingOrderId: string | null;
  pendingSide: OrderSide | null;
  pendingEntryMeta?: PositionEntryMetaState | undefined;
  pendingCouncilDecision?: AiCouncilDecision | undefined;
  lastBrokerSyncAt: string | null;
  lastAction: string;
  lastSymbol: string;
  lastExitPnl: number;
  recentOutcomes: number[];
  recentHoldTicks: number[];
  lastAdjustment: string;
  improvementBias: 'tighten-risk' | 'press-edge' | 'hold-steady';
  allocationMultiplier: number;
  allocationScore: number;
  allocationReason: string;
  deployment: AgentDeploymentState;
  curve: number[];
}

interface MistakeLearningProfile {
  sampleCount: number;
  winnerCount: number;
  loserCount: number;
  dominant: 'clean' | 'spread-leakage' | 'premature-exit' | 'overstay' | 'noise-chasing' | 'veto-drift';
  severity: number;
  summary: string;
  avgWinnerHoldTicks: number;
  avgLoserHoldTicks: number;
  avgWinnerSpreadBps: number;
  avgLoserSpreadBps: number;
  avgWinnerConfidencePct: number;
  avgLoserConfidencePct: number;
}

interface PaperEngineStateSnapshot {
  version: 1;
  savedAt: string;
  tick: number;
  market: SymbolState[];
  agents: AgentState[];
  fills: AgentFillEvent[];
  journal: TradeJournalEntry[];
  deskCurve: number[];
  benchmarkCurve: number[];
}

interface PersistedAgentState {
  id: string;
  config: AgentConfig;
  baselineConfig: AgentConfig;
  evaluationWindow: 'legacy' | 'live-market';
  startingEquity: number;
  cash: number;
  realizedPnl: number;
  feesPaid?: number;
  wins: number;
  losses: number;
  trades: number;
  status: AgentStatus;
  cooldownRemaining: number;
  position: PositionState | null;
  pendingOrderId?: string | null;
  pendingSide?: OrderSide | null;
  pendingEntryMeta?: PositionEntryMetaState | undefined;
  lastBrokerSyncAt?: string | null;
  lastAction: string;
  lastSymbol: string;
  lastExitPnl: number;
  recentOutcomes: number[];
  recentHoldTicks: number[];
  lastAdjustment: string;
  improvementBias: 'tighten-risk' | 'press-edge' | 'hold-steady';
  allocationMultiplier?: number;
  allocationScore?: number;
  allocationReason?: string;
  deployment?: AgentDeploymentState;
  curve: number[];
}

interface PersistedPaperEngineState {
  savedAt: string;
  tick: number;
  market: SymbolState[];
  agents: PersistedAgentState[];
  fills: AgentFillEvent[];
  journal: TradeJournalEntry[];
  deskCurve: number[];
  benchmarkCurve: number[];
}

interface PersistedMarketDataState {
  asOf: string;
  snapshots: MarketSnapshot[];
  sources: Array<{
    venue: BrokerId;
    symbols: string[];
    status: 'live' | 'degraded' | 'stale' | 'disconnected';
    detail: string;
    updatedAt: string;
  }>;
}

interface BrokerRouteResponse {
  orderId: string;
  broker: BrokerId;
  symbol: string;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  latencyMs?: number;
  message: string;
  timestamp: string;
  source?: 'broker' | 'simulated' | 'mock';
}

interface BrokerAccountPosition {
  broker: BrokerId;
  symbol: string;
  quantity: number;
  avgEntry: number;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

interface BrokerAccountSnapshot {
  broker: BrokerId;
  status: string;
  asOf: string;
  account?: Record<string, unknown>;
  positions: BrokerAccountPosition[];
  fills?: unknown[];
  orders?: unknown[];
}

interface BrokerAccountResponse {
  asOf: string;
  brokers: BrokerAccountSnapshot[];
}

interface BrokerPaperAccountState {
  asOf: string;
  status: string;
  cash: number;
  equity: number;
  dayBaseline: number;
  buyingPower: number;
}

interface SymbolGuardState {
  symbol: string;
  consecutiveLosses: number;
  blockedUntilMs: number;
  blockReason: string;
  updatedAt: string;
}

interface ExecutionQualityCounters {
  attempts: number;
  rejects: number;
  partialFills: number;
}

interface WeeklyReportState {
  asOf: string;
  path: string;
  summary: string;
}

interface RegimeKpiRow {
  symbol: string;
  regime: string;
  trades: number;
  winRatePct: number;
  expectancy: number;
  profitFactor: number;
  throttleMultiplier: number;
}

interface SloStatusState {
  dataFreshnessP95Ms: number;
  orderAckP95Ms: number;
  brokerErrorRatePct: number;
  breaches: string[];
}

interface WalkForwardResult {
  agentId: string;
  symbol: string;
  passed: boolean;
  outSampleTrades: number;
  candidateExpectancy: number;
  championExpectancy: number;
  note: string;
  asOf: string;
}

interface TradeForensicsRow {
  id: string;
  symbol: string;
  strategyId?: string;
  exitAt: string;
  realizedPnl: number;
  realizedPnlPct: number;
  verdict: 'winner' | 'loser' | 'scratch';
  attribution: {
    entryTimingBps: number;
    spreadCostBps: number;
    slippageCostBps: number;
    exitTimingBps: number;
    modelErrorBps: number;
  };
  timeline: Array<Record<string, unknown>>;
}

const HISTORY_LIMIT = 48;
const OUTCOME_HISTORY_LIMIT = 200; // Larger window for Half-Kelly and performance analysis
const FILL_LIMIT = 50;
const JOURNAL_LIMIT = 24;
const TICK_MS = 3_000;
const STARTING_EQUITY = Number(process.env.HERMES_STARTING_EQUITY ?? 100_000);
const EQUITY_FEE_BPS = 0.5;
const CRYPTO_FEE_BPS = 5.0;
const PAPER_BROKER: BrokerId = 'alpaca-paper';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_DIR = process.env.PAPER_LEDGER_DIR ?? path.resolve(MODULE_DIR, '../.runtime/paper-ledger');
const MARKET_DATA_RUNTIME_PATH =
  process.env.MARKET_DATA_RUNTIME_PATH ?? path.resolve(MODULE_DIR, '../../.runtime/market-data.json');
const BROKER_ROUTER_URL = process.env.BROKER_ROUTER_URL ?? 'http://127.0.0.1:4303';
const FILL_LEDGER_PATH = path.join(LEDGER_DIR, 'fills.jsonl');
const JOURNAL_LEDGER_PATH = path.join(LEDGER_DIR, 'journal.jsonl');
const STATE_SNAPSHOT_PATH = path.join(LEDGER_DIR, 'paper-state.json');
const AGENT_CONFIG_OVERRIDES_PATH = path.join(LEDGER_DIR, 'agent-config-overrides.json');
const EVENT_LOG_PATH = path.join(LEDGER_DIR, 'events.jsonl');
const SYMBOL_GUARD_PATH = path.join(LEDGER_DIR, 'symbol-guards.json');
const WEEKLY_REPORT_DIR = path.join(LEDGER_DIR, 'weekly-reports');
const DAILY_CIRCUIT_BREAKER_DD_PCT = Number(process.env.DAILY_CIRCUIT_BREAKER_DD_PCT ?? 3.2);
const WEEKLY_CIRCUIT_BREAKER_DD_PCT = Number(process.env.WEEKLY_CIRCUIT_BREAKER_DD_PCT ?? 6.5);
// Fix #8: Tightened crypto gating per Codex — fewer marginal entries = higher win rate
const CRYPTO_MAX_ENTRY_SPREAD_BPS = Number(process.env.CRYPTO_MAX_ENTRY_SPREAD_BPS ?? 2.2);
const CRYPTO_MAX_EST_SLIPPAGE_BPS = Number(process.env.CRYPTO_MAX_EST_SLIPPAGE_BPS ?? 1.6);
const CRYPTO_MIN_BOOK_DEPTH_NOTIONAL = Number(process.env.CRYPTO_MIN_BOOK_DEPTH_NOTIONAL ?? 120_000);
const DATA_FRESHNESS_SLO_MS = Number(process.env.DATA_FRESHNESS_SLO_MS ?? 7_500);
const ORDER_ACK_SLO_MS = Number(process.env.ORDER_ACK_SLO_MS ?? 2_500);
const BROKER_ERROR_SLO_PCT = Number(process.env.BROKER_ERROR_SLO_PCT ?? 5.0);
const BROKER_SYNC_MS = Number(process.env.PAPER_BROKER_SYNC_MS ?? 5_000);
const REAL_PAPER_AUTOPILOT = (process.env.REAL_PAPER_AUTOPILOT ?? 'true').toLowerCase() === 'true';
const COINBASE_LIVE_ROUTING_ENABLED = (process.env.COINBASE_LIVE_ROUTING_ENABLED ?? '0') === '1';
const HERMES_BROKER_ORDER_PREFIX = 'paper-agent-';

class PaperScalpingEngine {
  private getFeeRate(assetClass: AssetClass): number {
    // Real per-side fee rate for cost-aware stops/targets
    if (assetClass === 'crypto') return 0.004; // ~40bps taker per side (Coinbase/Alpaca)
    if (assetClass === 'forex') return 0; // OANDA spread-only
    return 0.0001; // ~1bps per side for stocks
  }

  private roundTripFeeBps(assetClass: AssetClass): number {
    return this.getFeeRate(assetClass) * 10_000 * 2;
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

  private resolveEntryDirection(
    agent: AgentState,
    symbol: SymbolState,
    score: number,
    intel?: {
      direction: 'strong-buy' | 'buy' | 'neutral' | 'sell' | 'strong-sell';
      confidence: number;
    }
  ): PositionDirection {
    const signal = intel ?? this.marketIntel.getCompositeSignal(symbol.symbol);
    const bearishFlow = signal.direction === 'sell' || signal.direction === 'strong-sell';
    const bullishFlow = signal.direction === 'buy' || signal.direction === 'strong-buy';
    const riskOff = this.signalBus.hasRecentSignalOfType('risk-off', 120_000);
    const panicRegime = this.classifySymbolRegime(symbol) === 'panic';
    const fng = this.marketIntel.getFearGreedValue();
    const bearishMarket = fng !== null && fng < 35;
    const extremeFear = fng !== null && fng <= 20;
    const rsi2 = this.marketIntel.computeRSI2(symbol.symbol);

    // Gemini insight: disable ALL short entries in extreme fear crypto — short squeezes kill shorts
    if (extremeFear && symbol.assetClass === 'crypto') {
      return 'long';
    }

    // Mean-reversion: short when overbought in bearish market, long when oversold
    if (agent.config.style === 'mean-reversion') {
      if (rsi2 !== null && rsi2 > 80 && (bearishFlow || bearishMarket)) return 'short';
      if ((riskOff !== null || panicRegime) && score <= -0.8 && bearishFlow) return 'short';
      return 'long';
    }

    // Momentum: follow the trend direction (but not short in extreme fear)
    if (bearishFlow && (score <= -0.4 || bearishMarket || symbol.drift <= -0.0015)) {
      return 'short';
    }

    if (bullishFlow && (score >= 0.4 || symbol.drift >= 0.0015)) {
      return 'long';
    }

    // Tie-break: use Fear & Greed for crypto, score for others
    if (symbol.assetClass === 'crypto' && bearishMarket) return 'short';
    return score < 0 ? 'short' : 'long';
  }

  private computeGrossPnl(position: PositionState, exitPrice: number, quantity: number): number {
    return this.getPositionDirection(position) === 'short'
      ? (position.entryPrice - exitPrice) * quantity
      : (exitPrice - position.entryPrice) * quantity;
  }

  private getSessionBucket(isoTs = new Date().toISOString()): SessionBucket {
    const date = new Date(isoTs);
    const hour = date.getUTCHours();
    if (hour >= 0 && hour <= 6) return 'asia';
    if (hour >= 7 && hour <= 12) return 'europe';
    if (hour >= 13 && hour <= 20) return 'us';
    return 'off';
  }

  private getVolatilityBucket(symbol: SymbolState): 'low' | 'medium' | 'high' {
    if (symbol.volatility >= 0.02) return 'high';
    if (symbol.volatility >= 0.008) return 'medium';
    return 'low';
  }

  private getSymbolCluster(symbol: SymbolState): 'crypto' | 'equity' | 'forex' | 'bond' | 'commodity' {
    if (symbol.assetClass === 'commodity' || symbol.assetClass === 'commodity-proxy') return 'commodity';
    if (symbol.assetClass === 'crypto') return 'crypto';
    if (symbol.assetClass === 'equity') return 'equity';
    if (symbol.assetClass === 'bond') return 'bond';
    return 'forex';
  }

  private getClusterLimitPct(cluster: ReturnType<PaperScalpingEngine['getSymbolCluster']>): number {
    if (cluster === 'crypto') return 45;
    if (cluster === 'equity') return 35;
    if (cluster === 'forex') return 40;
    if (cluster === 'bond') return 30;
    return 25;
  }

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

  private noteTradeOutcome(agent: AgentState, symbol: SymbolState, realized: number, reason: string): void {
    const spreadShock = symbol.spreadBps > Math.max(agent.config.spreadLimitBps * 1.8, symbol.baseSpreadBps * 2.2);
    this.updateSymbolGuard(symbol.symbol, (state) => {
      if (realized > 0) {
        return {
          ...state,
          consecutiveLosses: 0,
          blockedUntilMs: state.blockedUntilMs > Date.now() ? state.blockedUntilMs : 0,
          blockReason: state.blockedUntilMs > Date.now() ? state.blockReason : ''
        };
      }

      const consecutiveLosses = state.consecutiveLosses + 1;
      let blockedUntilMs = state.blockedUntilMs;
      let blockReason = state.blockReason;

      if (spreadShock) {
        blockedUntilMs = Math.max(blockedUntilMs, Date.now() + 30 * 60_000);
        blockReason = `Spread shock guard: ${symbol.spreadBps.toFixed(2)}bps on ${symbol.symbol}.`;
      }

      if (consecutiveLosses >= 3) {
        blockedUntilMs = Math.max(blockedUntilMs, Date.now() + 2 * 60 * 60_000);
        blockReason = `Loss streak guard: ${consecutiveLosses} consecutive losses on ${symbol.symbol} (${reason}).`;
      }

      return { ...state, consecutiveLosses, blockedUntilMs, blockReason };
    });
  }

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

  private getExecutionQualityByBroker(): Array<{
    broker: BrokerId;
    score: number;
    avgSlippageBps: number;
    avgLatencyMs: number;
    partialFillRatePct: number;
    rejectRatePct: number;
    sampleCount: number;
  }> {
    const journal = this.getMetaJournalEntries().slice(-200);
    const brokers: BrokerId[] = ['alpaca-paper', 'oanda-rest', 'coinbase-live'];
    return brokers.map((broker) => {
      const rows = journal.filter((entry) => entry.broker === broker);
      const sampleCount = rows.length;
      const avgSlippageBps = sampleCount > 0
        ? average(rows.map((entry) => Math.abs(entry.slippageBps)))
        : 0;
      const avgLatencyMs = sampleCount > 0
        ? average(rows.map((entry) => Number.isFinite(entry.latencyMs) ? (entry.latencyMs as number) : 0))
        : 0;
      const counters = this.executionQualityCounters.get(broker) ?? { attempts: 0, rejects: 0, partialFills: 0 };
      const rejectRatePct = counters.attempts > 0 ? (counters.rejects / counters.attempts) * 100 : 0;
      const partialFillRatePct = counters.attempts > 0 ? (counters.partialFills / counters.attempts) * 100 : 0;
      const score = clamp(
        100
          - avgSlippageBps * 2.2
          - avgLatencyMs / 120
          - rejectRatePct * 1.4
          - partialFillRatePct * 0.9,
        5,
        100
      );
      return {
        broker,
        score: round(score, 1),
        avgSlippageBps: round(avgSlippageBps, 2),
        avgLatencyMs: round(avgLatencyMs, 1),
        partialFillRatePct: round(partialFillRatePct, 2),
        rejectRatePct: round(rejectRatePct, 2),
        sampleCount
      };
    });
  }

  private getExecutionQualityMultiplier(broker: BrokerId): number {
    const row = this.getExecutionQualityByBroker().find((entry) => entry.broker === broker);
    if (!row) return 1;
    return clamp(row.score / 100, 0.45, 1.1);
  }

  private getPortfolioRiskSnapshot(): {
    totalOpenNotional: number;
    budgetPct: number;
    openRiskPct: number;
    byCluster: Array<{ cluster: string; openNotional: number; pct: number; limitPct: number }>;
  } {
    const deskEquity = Math.max(this.getDeskEquity(), 1);
    const byCluster = new Map<string, number>();
    let totalOpenNotional = 0;
    for (const agent of this.agents.values()) {
      if (!agent.position) continue;
      const symbol = this.market.get(agent.config.symbol);
      if (!symbol) continue;
      const notional = agent.position.entryPrice * agent.position.quantity;
      totalOpenNotional += notional;
      const cluster = this.getSymbolCluster(symbol);
      byCluster.set(cluster, (byCluster.get(cluster) ?? 0) + notional);
    }
    const byClusterRows = Array.from(byCluster.entries()).map(([cluster, openNotional]) => ({
      cluster,
      openNotional: round(openNotional, 2),
      pct: round((openNotional / deskEquity) * 100, 2),
      limitPct: this.getClusterLimitPct(cluster as ReturnType<PaperScalpingEngine['getSymbolCluster']>)
    }));
    const openRiskPct = (totalOpenNotional / deskEquity) * 100;
    return {
      totalOpenNotional: round(totalOpenNotional, 2),
      budgetPct: 85,
      openRiskPct: round(openRiskPct, 2),
      byCluster: byClusterRows
    };
  }

  private wouldBreachPortfolioRiskBudget(agent: AgentState, symbol: SymbolState, proposedNotional: number): boolean {
    const risk = this.getPortfolioRiskSnapshot();
    const deskEquity = Math.max(this.getDeskEquity(), 1);
    if (((risk.totalOpenNotional + proposedNotional) / deskEquity) * 100 > risk.budgetPct) return true;
    const cluster = this.getSymbolCluster(symbol);
    const clusterRow = risk.byCluster.find((row) => row.cluster === cluster);
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
        ...risk.byCluster.map((row) => `- ${row.cluster}: ${row.pct}% (limit ${row.limitPct}%)`),
        ''
      ].join('\n');
      fs.writeFileSync(reportPath, body, 'utf8');
      this.latestWeeklyReport = { asOf: new Date().toISOString(), path: reportPath, summary };
      this.recordEvent('weekly-report', this.latestWeeklyReport as unknown as Record<string, unknown>);
    } catch (error) {
      console.error('[paper-engine] failed to write weekly report', error);
    }
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
    return sorted[idx] ?? 0;
  }

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

  private buildRegimeKpis(): RegimeKpiRow[] {
    const rows = this.getMetaJournalEntries().slice(-500);
    const grouped = new Map<string, TradeJournalEntry[]>();
    for (const entry of rows) {
      const regime = (entry.regime ?? 'unknown').trim() || 'unknown';
      const key = `${entry.symbol}::${regime}`;
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    const result: RegimeKpiRow[] = [];
    for (const [key, entries] of grouped.entries()) {
      const [symbolRaw, regimeRaw] = key.split('::');
      const symbol = symbolRaw ?? 'UNKNOWN';
      const regime = regimeRaw ?? 'unknown';
      const trades = entries.length;
      const winners = entries.filter((entry) => entry.realizedPnl > 0);
      const losers = entries.filter((entry) => entry.realizedPnl < 0);
      const grossWins = winners.reduce((sum, entry) => sum + entry.realizedPnl, 0);
      const grossLosses = Math.abs(losers.reduce((sum, entry) => sum + entry.realizedPnl, 0));
      const winRatePct = trades > 0 ? (winners.length / trades) * 100 : 0;
      const expectancy = trades > 0 ? average(entries.map((entry) => entry.realizedPnl)) : 0;
      const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
      const throttleMultiplier = trades < 6
        ? 1
        : profitFactor < 0.9 || winRatePct < 42
          ? 0.45
          : profitFactor < 1.05
            ? 0.72
            : 1.05;
      result.push({
        symbol,
        regime,
        trades,
        winRatePct: round(winRatePct, 1),
        expectancy: round(expectancy, 2),
        profitFactor: round(profitFactor, 2),
        throttleMultiplier: round(throttleMultiplier, 2)
      });
    }
    return result.sort((left, right) => right.trades - left.trades).slice(0, 80);
  }

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

  private evaluateWalkForwardPromotion(agent: AgentState, candidate: AgentConfig, champion: AgentConfig): WalkForwardResult {
    const entries = this.getMetaJournalEntries()
      .filter((entry) => entry.strategyId === agent.config.id && entry.symbol === candidate.symbol)
      .slice(-80);
    const split = Math.max(6, Math.floor(entries.length * 0.65));
    const outSample = entries.slice(split);
    const simExpectancy = (config: AgentConfig, rows: TradeJournalEntry[]): number => {
      const selected = rows.filter((entry) => entry.spreadBps <= config.spreadLimitBps);
      if (selected.length === 0) return -999;
      return average(selected.map((entry) => entry.realizedPnl));
    };
    const candidateExpectancy = outSample.length > 0 ? simExpectancy(candidate, outSample) : -999;
    const championExpectancy = outSample.length > 0 ? simExpectancy(champion, outSample) : -999;
    const passed = outSample.length >= 6 && candidateExpectancy >= championExpectancy - 0.2;
    const note = outSample.length < 6
      ? `Insufficient out-of-sample trades (${outSample.length}/6).`
      : passed
        ? `Walk-forward pass: candidate expectancy ${candidateExpectancy.toFixed(2)} >= champion ${championExpectancy.toFixed(2)}.`
        : `Walk-forward fail: candidate expectancy ${candidateExpectancy.toFixed(2)} < champion ${championExpectancy.toFixed(2)}.`;
    return {
      agentId: agent.config.id,
      symbol: candidate.symbol,
      passed,
      outSampleTrades: outSample.length,
      candidateExpectancy: round(candidateExpectancy, 2),
      championExpectancy: round(championExpectancy, 2),
      note,
      asOf: new Date().toISOString()
    };
  }

  private buildForensics(entry: TradeJournalEntry): TradeForensicsRow {
    const score = entry.entryScore ?? 0;
    const modelProb = clamp(((entry.entryTrainedProbability ?? entry.entryContextualProbability ?? entry.entryHeuristicProbability ?? entry.entryConfidencePct ?? 50) / 100), 0.01, 0.99);
    const entryTimingBps = round(Math.max(0, 40 - Math.abs(score) * 15), 2);
    const spreadCostBps = round(Math.max(0, entry.spreadBps * 0.6), 2);
    const slippageCostBps = round(Math.max(0, Math.abs(entry.slippageBps)), 2);
    const exitTimingBps = round(
      entry.holdTicks && entry.holdTicks > 0
        ? Math.max(0, (entry.holdTicks > 10 ? (entry.holdTicks - 10) * 0.8 : 0))
        : 0,
      2
    );
    const modelErrorBps = round((1 - modelProb) * 45, 2);
    const timeline = this.getRecentEvents(600)
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .filter((row) => {
        const timestamp = typeof row.timestamp === 'string' ? row.timestamp : '';
        if (!timestamp) return false;
        const ts = Date.parse(timestamp);
        if (!Number.isFinite(ts)) return false;
        const entryTs = Date.parse(entry.entryAt);
        const exitTs = Date.parse(entry.exitAt);
        return ts >= entryTs - 60_000 && ts <= exitTs + 60_000;
      })
      .slice(-24);

    return {
      id: entry.id,
      symbol: entry.symbol,
      ...(entry.strategyId ? { strategyId: entry.strategyId } : {}),
      exitAt: entry.exitAt,
      realizedPnl: round(entry.realizedPnl, 2),
      realizedPnlPct: round(entry.realizedPnlPct, 3),
      verdict: entry.verdict,
      attribution: {
        entryTimingBps,
        spreadCostBps,
        slippageCostBps,
        exitTimingBps,
        modelErrorBps
      },
      timeline
    };
  }

  private getAgentBroker(agent: AgentState): BrokerId {
    return agent.config.broker;
  }

  private formatBrokerLabel(broker: BrokerId): string {
    switch (broker) {
      case 'coinbase-live':
        return 'Coinbase live';
      case 'oanda-rest':
        return 'OANDA practice';
      case 'alpaca-paper':
      default:
        return 'Alpaca paper';
    }
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

  private async seedFromBrokerHistory(): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(`${BROKER_ROUTER_URL}/account`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return;

      const payload = await response.json() as BrokerAccountResponse;
      const brokers = Array.isArray(payload.brokers) ? payload.brokers : [];

      for (const broker of brokers) {
        // === ALPACA: match buy/sell order pairs to count round-trip trades ===
        if (broker.broker === 'alpaca-paper') {
          // Skip if Alpaca agents already have trades (already seeded or trading)
          const alpacaAgents = Array.from(this.agents.values()).filter((a) => a.config.broker === 'alpaca-paper');
          const alpacaTrades = alpacaAgents.reduce((s, a) => s + a.trades, 0);
          if (alpacaTrades > 0) continue;

          const orders = Array.isArray(broker.orders) ? broker.orders as Record<string, unknown>[] : [];
          const fills = orders.filter((o) =>
            o.status === 'filled' && typeof o.filled_avg_price === 'string'
          );
          const openBuys = new Map<string, { price: number; qty: number }>();
          for (const order of fills) {
            const sym = String(order.symbol ?? '').replace('/', '-');
            const price = parseFloat(String(order.filled_avg_price ?? '0'));
            const qty = parseFloat(String(order.filled_qty ?? '0'));
            const agent = alpacaAgents.find((a) => a.config.symbol === sym);
            if (!agent) continue;

            if (order.side === 'buy') {
              openBuys.set(sym, { price, qty });
            } else if (order.side === 'sell' && openBuys.has(sym)) {
              const buy = openBuys.get(sym)!;
              const pnl = (price - buy.price) * Math.min(qty, buy.qty);
              agent.trades += 1;
              agent.realizedPnl = round(agent.realizedPnl + pnl, 4);
              if (pnl >= 0) agent.wins += 1;
              else agent.losses += 1;
              openBuys.delete(sym);
            }
          }
        }

        // === OANDA: use account-level PL since fills only show open trades ===
        if (broker.broker === 'oanda-rest') {
          const oandaAgents = Array.from(this.agents.values()).filter((a) => a.config.broker === 'oanda-rest');
          const oandaTrades = oandaAgents.reduce((s, a) => s + a.trades, 0);
          if (oandaTrades > 0) continue;

          const acct = broker.account as Record<string, unknown> ?? {};
          const oandaPl = parseFloat(String(acct.pl ?? '0'));
          const oandaFills = Array.isArray(broker.fills) ? broker.fills as Record<string, unknown>[] : [];
          // Count unique instruments that have been traded (open trades = evidence of activity)
          const tradedInstruments = new Set(oandaFills.map((f) => String((f as Record<string, unknown>).instrument ?? '')).filter(Boolean));

          if (oandaPl !== 0 && tradedInstruments.size > 0) {
            // Distribute realized PL proportionally across traded instruments
            const perInstrument = oandaPl / tradedInstruments.size;
            for (const instrument of tradedInstruments) {
              const agent = oandaAgents.find((a) => a.config.symbol === instrument);
              if (!agent) continue;
              // Count how many fills this instrument has as a proxy for trade count
              const instrumentFills = oandaFills.filter((f) => (f as Record<string, unknown>).instrument === instrument);
              agent.trades = instrumentFills.length;
              agent.realizedPnl = round(perInstrument, 4);
              if (perInstrument >= 0) agent.wins = Math.max(1, Math.round(instrumentFills.length * 0.6));
              else agent.losses = instrumentFills.length;
            }
          }
        }
      }

      // === COINBASE PAPER: seed from local fills ledger (simulated trades) ===
      const cbAgents = Array.from(this.agents.values()).filter((a) => a.config.broker === 'coinbase-live');
      const cbTrades = cbAgents.reduce((s, a) => s + a.trades, 0);
      if (cbTrades === 0) {
        try {
          const fillLines = readJsonLines<{ agentId: string; side: string; pnlImpact: number; status: string; source: string }>(FILL_LEDGER_PATH);
          const cbFills = fillLines.filter((f) => f.source === 'simulated' && f.status === 'filled' && cbAgents.some((a) => a.config.id === f.agentId));
          for (const fill of cbFills) {
            const agent = cbAgents.find((a) => a.config.id === fill.agentId);
            if (!agent) continue;
            if (fill.side === 'sell' || (fill.side === 'buy' && fill.pnlImpact !== 0)) {
              // Exit fill
              if (fill.pnlImpact !== 0) {
                agent.trades += 1;
                agent.realizedPnl = round(agent.realizedPnl + fill.pnlImpact, 4);
                if (fill.pnlImpact > 0) agent.wins += 1;
                else agent.losses += 1;
              }
            }
          }
        } catch {
          // fills.jsonl may not exist yet
        }
      }

      const totalSeeded = Array.from(this.agents.values()).reduce((s, a) => s + a.trades, 0);
      const totalPnl = Array.from(this.agents.values()).reduce((s, a) => s + a.realizedPnl, 0);
      if (totalSeeded > 0) {
        console.log(`[paper-engine] seeded ${totalSeeded} trades from broker history (PnL: $${totalPnl.toFixed(2)})`);
        this.persistStateSnapshot();
      }
    } catch (error) {
      console.error('[paper-engine] failed to seed from broker history:', error instanceof Error ? error.message : error);
    }
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
      ? this.forensicRows.filter((row) => row.symbol === symbol)
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

  private buildStrategyTelemetry(): PaperStrategyTelemetry[] {
    return Array.from(this.agents.values()).map((agent) => {
      const outcomes = pickLast(agent.recentOutcomes, 12);
      const holds = pickLast(agent.recentHoldTicks, 8);
      const wins = outcomes.filter((value) => value > 0);
      const losses = outcomes.filter((value) => value < 0);
      const grossWins = wins.reduce((sum, value) => sum + value, 0);
      const grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const avgWinner = wins.length > 0 ? grossWins / wins.length : 0;
      const avgLoser = losses.length > 0 ? grossLosses / losses.length : 0;
      const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
      const winRate = outcomes.length > 0 ? (wins.length / outcomes.length) * 100 : agent.trades > 0 ? (agent.wins / agent.trades) * 100 : 0;
      const expectancy = outcomes.length > 0 ? average(outcomes) : 0;
      const recentWindow = outcomes.slice(-4);
      const priorWindow = outcomes.slice(0, Math.max(0, outcomes.length - recentWindow.length));
      const recentWinRate = recentWindow.length > 0 ? (recentWindow.filter((value) => value > 0).length / recentWindow.length) * 100 : 0;
      const priorWinRate = priorWindow.length > 0 ? (priorWindow.filter((value) => value > 0).length / priorWindow.length) * 100 : recentWinRate;
      const performanceDeltaPct = round(recentWinRate - priorWinRate, 1);
      const performanceTrend: 'improving' | 'worsening' | 'stable' = performanceDeltaPct > 2 ? 'improving' : performanceDeltaPct < -2 ? 'worsening' : 'stable';
      const lastAdjustmentImproved = recentWindow.length > 0 ? recentWinRate >= priorWinRate : true;
      const symbol = this.market.get(agent.config.symbol) ?? null;
      const recentJournal = this.getRecentJournalEntries(agent, symbol, 16);
      const recentMistakeProfile = this.buildMistakeProfile(agent, symbol, recentJournal.slice(-8));
      const priorMistakeProfile = this.buildMistakeProfile(agent, symbol, recentJournal.slice(0, Math.max(0, recentJournal.length - 8)));
      const mistakeDelta = round(recentMistakeProfile.severity - priorMistakeProfile.severity, 1);
      const mistakeTrend: 'improving' | 'worsening' | 'stable' = mistakeDelta < -5 ? 'improving' : mistakeDelta > 5 ? 'worsening' : 'stable';

      return {
        agentId: agent.config.id,
        agentName: agent.config.name,
        symbol: agent.config.symbol,
        style: agent.config.style,
        expectancy: round(expectancy, 2),
        profitFactor: round(profitFactor, 2),
        avgWinner: round(avgWinner, 2),
        avgLoser: round(avgLoser, 2),
        avgHoldTicks: round(average(holds), 2),
        winRate: round(winRate, 1),
        targetBps: round(agent.config.targetBps, 2),
        stopBps: round(agent.config.stopBps, 2),
        maxHoldTicks: agent.config.maxHoldTicks,
        spreadLimitBps: round(agent.config.spreadLimitBps, 2),
        sizeFractionPct: round(agent.config.sizeFraction * 100, 2),
        lastAdjustment: agent.lastAdjustment,
        improvementBias: agent.improvementBias,
        mistakeSummary: recentMistakeProfile.summary,
        mistakeScore: recentMistakeProfile.severity,
        mistakeTrend,
        mistakeDelta,
        performanceTrend,
        performanceDeltaPct,
        lastAdjustmentImproved,
        allocationMultiplier: round(agent.allocationMultiplier, 2),
        allocationScore: round(agent.allocationScore, 2),
        allocationReason: agent.allocationReason
      };
    });
  }

  private buildMarketTape(): PaperTapeSnapshot[] {
    const visibleFills = this.getVisibleFills();
    // Use agent's configured broker for routing, not market data source
    const agentBrokerMap = new Map(Array.from(this.agents.values()).map((a) => [a.config.symbol, a.config.broker]));
    return Array.from(this.market.values()).map((symbol) => ({
      symbol: symbol.symbol,
      broker: agentBrokerMap.get(symbol.symbol) ?? symbol.broker,
      assetClass: symbol.assetClass,
      status: symbol.marketStatus,
      source: symbol.sourceMode,
      updatedAt: symbol.updatedAt,
      session: symbol.session,
      tradable: symbol.tradable,
      qualityFlags: [...symbol.qualityFlags],
      lastPrice: round(symbol.price, 2),
      changePct: round(symbol.openPrice > 0 ? ((symbol.price - symbol.openPrice) / symbol.openPrice) * 100 : 0, 2),
      spreadBps: round(symbol.spreadBps, 2),
      liquidityScore: round(symbol.liquidityScore, 0),
      candles: this.toCandles(symbol.history),
      markers: visibleFills
        .filter((fill) => fill.symbol === symbol.symbol)
        .slice(0, 6)
        .map((fill) => ({
          id: fill.id,
          symbol: fill.symbol,
          side: fill.side,
          status: fill.status,
          price: fill.price,
          agentName: fill.agentName,
          timestamp: fill.timestamp
        }))
    }));
  }

  private analyzeSignals(): void {
    const now = new Date().toISOString();
    for (const symbol of this.market.values()) {
      if (symbol.baseSpreadBps > 0 && symbol.spreadBps > symbol.baseSpreadBps * 1.5) {
        this.signalBus.emit({
          type: 'spread-expansion',
          symbol: symbol.symbol,
          severity: symbol.spreadBps > symbol.baseSpreadBps * 2.5 ? 'critical' : 'warning',
          message: `${symbol.symbol} spread ${symbol.spreadBps.toFixed(1)} bps exceeds baseline ${symbol.baseSpreadBps.toFixed(1)} bps.`,
          timestamp: now
        });
      }
    }

    const btc = this.market.get('BTC-USD');
    const eth = this.market.get('ETH-USD');
    if (btc && eth && btc.openPrice > 0 && eth.openPrice > 0) {
      const btcChange = (btc.price - btc.openPrice) / btc.openPrice;
      const ethChange = (eth.price - eth.openPrice) / eth.openPrice;
      if ((btcChange > 0.005 && ethChange < -0.005) || (btcChange < -0.005 && ethChange > 0.005)) {
        this.signalBus.emit({
          type: 'correlation-break',
          symbol: 'BTC-USD/ETH-USD',
          severity: 'warning',
          message: `BTC ${(btcChange * 100).toFixed(2)}% vs ETH ${(ethChange * 100).toFixed(2)}% divergence.`,
          timestamp: now
        });
      }
    }

    const symbols = Array.from(this.market.values()).filter((s) => s.price > 0 && s.openPrice > 0);
    const negative = symbols.filter((s) => s.price < s.openPrice).length;
    if (symbols.length >= 3 && negative / symbols.length > 0.75) {
      this.signalBus.emit({
        type: 'risk-off',
        symbol: 'DESK',
        severity: negative / symbols.length > 0.8 ? 'critical' : 'warning',
        message: `${negative}/${symbols.length} symbols negative. Risk-off conditions detected.`,
        timestamp: now
      });
    }
  }

  private getDataSources(): DataSourceStatus[] {
    const tradableSymbols = Array.from(this.market.values())
      .filter((symbol) => this.hasTradableTape(symbol))
      .map((symbol) => symbol.symbol);
    const blockedSymbols = Array.from(this.market.values())
      .filter((symbol) => !this.hasTradableTape(symbol))
      .map((symbol) => `${symbol.symbol} (${this.describeTapeFlags(symbol)})`);
    const brokerPaperPilots = Array.from(this.agents.values())
      .filter((agent) => agent.config.executionMode === 'broker-paper' && agent.config.autonomyEnabled)
      .map((agent) => agent.config.symbol);
    const watchOnlyLanes = Array.from(this.agents.values())
      .filter((agent) => agent.config.executionMode === 'watch-only' || !agent.config.autonomyEnabled)
      .map((agent) => agent.config.symbol);

    return [
      {
        id: 'market-data',
        label: 'market data',
        mode: tradableSymbols.length > 0 ? 'live' : 'service',
        detail: tradableSymbols.length > 0
          ? `Tradable broker-fed tape currently drives ${tradableSymbols.join(', ')}. ${blockedSymbols.length > 0 ? `Autonomous entries are blocked for ${blockedSymbols.join(', ')}.` : 'All tracked paper symbols currently meet session and quote-quality gates.'}`
          : 'No symbols currently meet the session and quote-quality gates for autonomous trading.'
      },
      {
        id: 'paper-engine',
        label: 'paper execution',
        mode: brokerPaperPilots.length > 0 ? 'live' : 'service',
        detail: brokerPaperPilots.length > 0
          ? `Broker-backed Alpaca paper routing is armed for ${brokerPaperPilots.join(', ')} and only Hermes-owned broker-filled exits count toward firm win rates. ${watchOnlyLanes.length > 0 ? `Watch-only lanes: ${watchOnlyLanes.join(', ')}.` : ''}`.trim()
          : 'No broker-backed paper lanes are armed yet.'
      },
      {
        id: 'ai-council',
        label: 'ai council',
        mode: 'service',
        detail: 'Claude is primary. Codex only challenges low-confidence or borderline setups.'
      }
    ];
  }

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

  private syncBrokerPositionIntoAgent(
    agent: AgentState,
    symbol: SymbolState,
    brokerPosition: BrokerAccountPosition
  ): void {
    const quantity = round(brokerPosition.quantity, 6);
    const entryPrice = round(brokerPosition.avgEntry || symbol.price, 2);
    const direction: PositionDirection = agent.position?.direction
      ?? (agent.pendingSide === 'sell' ? 'short' : 'long');

    if (!agent.position) {
      const note = `Restored broker-backed ${this.formatBrokerLabel(agent.config.broker)} position from ${agent.config.symbol} sync.`;
      agent.cash = round(Math.max(0, agent.startingEquity + agent.realizedPnl - entryPrice * quantity), 2);
      agent.position = {
        direction,
        quantity,
        entryPrice,
        entryTick: this.tick,
        entryAt: new Date().toISOString(),
        stopPrice: this.computeDynamicStop(entryPrice, agent, symbol, direction),
        targetPrice: this.computeDynamicTarget(entryPrice, agent, symbol, direction),
        peakPrice: brokerPosition.markPrice || entryPrice,
        note,
        entryMeta: agent.pendingEntryMeta ?? undefined
      };
      agent.status = 'in-trade';
      agent.lastSymbol = symbol.symbol;
      agent.lastAction = agent.pendingOrderId && agent.pendingSide === 'buy'
        ? `Broker confirmed Alpaca paper entry in ${symbol.symbol} at ${entryPrice}.`
        : note;
    } else {
      const liveDirection = this.getPositionDirection(agent.position);
      agent.position.direction = liveDirection;
      agent.position.quantity = quantity;
      agent.position.entryPrice = entryPrice;
      agent.position.entryAt = agent.position.entryAt ?? new Date().toISOString();
      agent.position.stopPrice = this.computeDynamicStop(entryPrice, agent, symbol, liveDirection);
      agent.position.targetPrice = this.computeDynamicTarget(entryPrice, agent, symbol, liveDirection);
      const mark = brokerPosition.markPrice || symbol.price;
      agent.position.peakPrice = liveDirection === 'short'
        ? Math.min(agent.position.peakPrice, mark)
        : Math.max(agent.position.peakPrice, mark);
      agent.position.entryMeta = agent.position.entryMeta ?? agent.pendingEntryMeta ?? undefined;
      agent.status = 'in-trade';
    }

    agent.pendingOrderId = null;
    agent.pendingSide = null;
    agent.pendingEntryMeta = undefined;
  }

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
    const startedAtMs = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(`${BROKER_ROUTER_URL}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const result = await response.json() as BrokerRouteResponse & { message?: string };
      if (result.latencyMs === undefined || !Number.isFinite(result.latencyMs)) {
        result.latencyMs = Date.now() - startedAtMs;
      }
      if (!response.ok && result.status !== 'rejected') {
        this.recordEvent('route-error', {
          symbol: payload.symbol,
          broker: payload.broker,
          side: payload.side,
          latencyMs: result.latencyMs,
          message: result.message ?? 'broker route failed'
        });
        throw new Error(result.message ?? 'broker route failed');
      }
      if (result.status === 'rejected') {
        this.recordEvent('route-reject', {
          symbol: payload.symbol,
          broker: payload.broker,
          side: payload.side,
          latencyMs: result.latencyMs,
          message: result.message ?? 'rejected'
        });
      }
      return result;
    } catch (error) {
      this.operationalKillSwitchUntilMs = Math.max(this.operationalKillSwitchUntilMs, Date.now() + 10 * 60_000);
      throw error;
    }
  }

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

  private loadMarketDataState(): PersistedMarketDataState | null {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!fs.existsSync(MARKET_DATA_RUNTIME_PATH)) {
          return null;
        }
        const raw = fs.readFileSync(MARKET_DATA_RUNTIME_PATH, 'utf8');
        const parsed = JSON.parse(raw) as PersistedMarketDataState;
        if (!Array.isArray(parsed.snapshots)) {
          return null;
        }
        return {
          asOf: typeof parsed.asOf === 'string' ? parsed.asOf : new Date().toISOString(),
          snapshots: parsed.snapshots.filter(
            (snapshot) => snapshot.source !== 'mock' && snapshot.source !== 'simulated'
          ),
          sources: Array.isArray(parsed.sources) ? parsed.sources : []
        };
      } catch {
        // File may be mid-write — retry after a brief pause
        if (attempt < 2) {
          const start = Date.now();
          while (Date.now() - start < 100) { /* busy wait 100ms */ }
        }
      }
    }
    return null;
  }

  private applyMarketSnapshot(symbol: SymbolState, snapshot: MarketSnapshot, recordHistory: boolean): void {
    // Don't overwrite good data with a zero-price snapshot from another broker
    if (snapshot.lastPrice <= 0 && symbol.price > 0 && symbol.tradable) return;

    const previousPrice = symbol.price;
    const nextPrice = snapshot.lastPrice > 0 ? snapshot.lastPrice : previousPrice;
    const previousSourceMode = symbol.sourceMode;
    const openPrice = snapshot.changePct !== 0
      ? nextPrice / (1 + snapshot.changePct / 100)
      : symbol.openPrice > 0
        ? symbol.openPrice
        : nextPrice;
    const nextReturn = previousPrice > 0 ? (nextPrice - previousPrice) / previousPrice : 0;
    const session = snapshot.session ?? (snapshot.assetClass === 'equity' ? 'unknown' : 'regular');
    const qualityFlags = Array.isArray(snapshot.qualityFlags) ? [...snapshot.qualityFlags] : [];
    const tradable = snapshot.tradable ?? (
      snapshot.status === 'live'
      && snapshot.source !== 'mock'
      && snapshot.source !== 'simulated'
      && nextPrice > 0
      && session === 'regular'
      && qualityFlags.length === 0
    );

    symbol.broker = snapshot.broker;
    symbol.assetClass = snapshot.assetClass;
    symbol.marketStatus = snapshot.status;
    symbol.sourceMode = snapshot.source ?? 'service';
    symbol.session = session;
    symbol.tradable = tradable;
    symbol.qualityFlags = qualityFlags;
    symbol.updatedAt = snapshot.updatedAt ?? new Date().toISOString();
    symbol.price = round(nextPrice, 2);
    symbol.openPrice = round(openPrice, 2);
    symbol.volume = snapshot.volume;
    symbol.spreadBps = snapshot.spreadBps;
    symbol.baseSpreadBps = snapshot.spreadBps || symbol.baseSpreadBps;
    symbol.liquidityScore = snapshot.liquidityScore;
    symbol.meanAnchor = symbol.meanAnchor * 0.9 + symbol.price * 0.1;
    symbol.bias = clamp((symbol.bias * 0.7) + nextReturn * 0.3, -0.0015, 0.0015);

    const switchedToRuntimeTape =
      (previousSourceMode === 'simulated' || previousSourceMode === 'mock')
      && snapshot.source !== 'simulated'
      && snapshot.source !== 'mock';
    const historyDiverged = previousPrice > 0 && Math.abs((nextPrice - previousPrice) / previousPrice) > 0.2;

    if (switchedToRuntimeTape || historyDiverged) {
      symbol.history = Array.from({ length: 24 }, () => round(symbol.price, 2));
      symbol.returns = Array.from({ length: 24 }, () => 0);
    }

    if (recordHistory) {
      this.pushPoint(symbol.history, symbol.price);
      this.pushPoint(symbol.returns, nextReturn);
    }

    this.applySpreadShockGuard(symbol);
    this.queueEventDrivenExit(symbol, 'quote');
  }

  private hasTradableTape(symbol: SymbolState | undefined): boolean {
    if (!symbol) return false;
    return (
      symbol.marketStatus === 'live'
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

  private getTapeQualityBlock(symbol: SymbolState): string | null {
    if (symbol.marketStatus !== 'live') {
      return `${symbol.symbol} is blocked because the tape is ${symbol.marketStatus}.`;
    }

    if (symbol.sourceMode === 'mock' || symbol.sourceMode === 'simulated') {
      return `${symbol.symbol} is blocked because the tape source is ${symbol.sourceMode}, not broker-fed live data.`;
    }

    if (symbol.assetClass === 'equity' && symbol.session !== 'regular') {
      return `${symbol.symbol} is on ${symbol.session} session tape. Autonomous equity entries wait for the regular market session.`;
    }

    if (symbol.qualityFlags.includes('wide-spread')) {
      return `${symbol.symbol} spread ${symbol.spreadBps.toFixed(2)} bps is outside the tape-quality gate.`;
    }

    if (symbol.qualityFlags.includes('low-liquidity')) {
      return `${symbol.symbol} liquidity score ${symbol.liquidityScore.toFixed(0)} is below the tape-quality gate.`;
    }

    if (symbol.qualityFlags.includes('incomplete-quote') || symbol.qualityFlags.includes('missing-last-price')) {
      return `${symbol.symbol} quote is incomplete, so autonomous entries stay blocked.`;
    }

    if (!symbol.tradable) {
      return `${symbol.symbol} is not tradable on the current tape (${this.describeTapeFlags(symbol)}).`;
    }

    return null;
  }

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

  private seedMarket(): void {
    const updatedAt = new Date().toISOString();
    const configs = buildAgentConfigs(REAL_PAPER_AUTOPILOT);
    const seenSymbols = new Set<string>();

    const defaultSpreadBps: Record<string, number> = {
      'BTC-USD': 2.8, 'ETH-USD': 3.6, 'SOL-USD': 1.2, 'XRP-USD': 0.8, 'PAXG-USD': 4.0,
      'EUR_USD': 1.2, 'GBP_USD': 1.5, 'USD_JPY': 1.3, 'AUD_USD': 1.4,
      'SPX500_USD': 1.5, 'NAS100_USD': 2.0, 'US30_USD': 2.5,
      'USB02Y_USD': 1.0, 'USB05Y_USD': 1.0, 'USB10Y_USD': 1.1, 'USB30Y_USD': 1.2,
      'XAU_USD': 2.5, 'BCO_USD': 3.0, 'WTICO_USD': 2.8
    };

    for (const config of configs) {
      if (seenSymbols.has(config.symbol)) continue;
      seenSymbols.add(config.symbol);

      this.market.set(config.symbol, {
        symbol: config.symbol,
        broker: config.broker ?? 'oanda-rest',
        assetClass: config.assetClass ?? 'equity',
        marketStatus: 'stale',
        sourceMode: 'service',
        session: config.assetClass === 'crypto' ? 'regular' : 'unknown',
        tradable: false,
        qualityFlags: ['awaiting-market-data'],
        updatedAt,
        price: 0,
        openPrice: 0,
        volume: 0,
        liquidityScore: 0,
        spreadBps: 0,
        baseSpreadBps: defaultSpreadBps[config.symbol] ?? 2.0,
        drift: 0.00008,
        volatility: 0.001,
        meanAnchor: 0,
        bias: 0,
        history: Array.from({ length: 24 }, () => 0),
        returns: Array.from({ length: 24 }, () => 0)
      });
    }
  }

  private seedAgents(): void {
    const overrides = this.loadAgentConfigOverrides();
    const configs = buildAgentConfigs(REAL_PAPER_AUTOPILOT);

    const allocation = STARTING_EQUITY / configs.length;

    for (const config of configs) {
      const mergedConfig = withAgentConfigDefaults({
        ...config,
        ...(overrides[config.id] ?? {})
      });
      this.agents.set(config.id, {
        config: { ...mergedConfig },
        baselineConfig: { ...config },
        evaluationWindow: 'legacy',
        startingEquity: allocation,
        cash: allocation,
        realizedPnl: 0,
        feesPaid: 0,
        wins: 0,
        losses: 0,
        trades: 0,
        status: 'watching',
        cooldownRemaining: 0,
        position: null,
        pendingOrderId: null,
        pendingSide: null,
        lastBrokerSyncAt: null,
        lastAction: 'Booting paper scalper.',
        lastSymbol: config.symbol,
        lastExitPnl: 0,
        recentOutcomes: [],
        recentHoldTicks: [],
        lastAdjustment: 'Collecting baseline paper samples before tuning.',
        improvementBias: 'hold-steady',
        allocationMultiplier: 1,
        allocationScore: 1,
        allocationReason: 'Neutral initial allocation before live outcomes.',
        deployment: {
          mode: 'stable',
          championConfig: null,
          challengerConfig: null,
          startedAt: null,
          startingTrades: 0,
          startingRealizedPnl: 0,
          startingOutcomeCount: 0,
          probationTradesRequired: 6,
          rollbackLossLimit: 2,
          lastDecision: 'Baseline config active.'
        },
        curve: [allocation]
      });
    }
  }

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

  private getRouteBlock(agent: AgentState, symbol: SymbolState): string | null {
    // Paper mode: never block trades on route concentration — we need data
    if (agent.config.executionMode === 'broker-paper') {
      return null;
    }
    if (!agent.config.autonomyEnabled) {
      return null;
    }
    if (agent.config.broker === 'coinbase-live' && !this.shouldSimulateLocally(agent.config.broker) && !COINBASE_LIVE_ROUTING_ENABLED) {
      return `Coinbase live routing is disabled for paper-mode crypto lanes. ${symbol.symbol} stays watch-only until live routing is explicitly approved.`;
    }
    const route = this.scalpRouteCandidates.get(agent.config.id);
    if (!route) {
      return null;
    }
    // Allow new agents (< 5 trades) to trade even without proven edge — they need data
    if (route.expectedNetEdgeBps <= 0 && agent.trades >= 5) {
      return `No positive-net ${symbol.assetClass} scalp route for ${route.symbols[0] ?? symbol.symbol} after estimated fees and slippage.`;
    }
    // During bootstrap, skip route concentration only after net edge is positive.
    if (agent.trades < 5) {
      return null;
    }
    if (!route.selected) {
      const leaderId = this.selectedScalpByAssetClass.get(symbol.assetClass);
      const leader = leaderId ? this.scalpRouteCandidates.get(leaderId) : null;
      const routeSymbol = route.symbols[0] ?? symbol.symbol;
      const leaderSymbol = leader?.symbols[0] ?? routeSymbol;
      if (leader && leader.strategyId !== route.strategyId) {
        return `Routing to ${leaderSymbol} for ${symbol.assetClass} scalps: ${leader.expectedNetEdgeBps.toFixed(2)}bps net edge after ${leader.estimatedCostBps.toFixed(2)}bps estimated costs beats ${routeSymbol} at ${route.expectedNetEdgeBps.toFixed(2)}bps.`;
      }
      return `No positive-net ${symbol.assetClass} scalp route for ${routeSymbol} after estimated fees and slippage.`;
    }
    return null;
  }

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

    const catastrophicPct = agent.config.style === 'momentum' ? 0.98
      : agent.config.style === 'breakout' ? 0.985
      : 0.99;
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

  private maybeTrailBrokerStop(agent: AgentState, symbol: SymbolState): void {
    const position = agent.position;
    if (!position) return;

    const direction = this.getPositionDirection(position);
    const targetDelta = direction === 'short'
      ? position.entryPrice - position.targetPrice
      : position.targetPrice - position.entryPrice;
    if (targetDelta <= 0) return;

    const progress = direction === 'short'
      ? position.entryPrice - symbol.price
      : symbol.price - position.entryPrice;
    const progressPct = progress / targetDelta;

    // Gemini insight: in extreme fear crypto, bounces are violent but short — trail tighter
    const fng = this.marketIntel.getFearGreedValue();
    const extremeFearCrypto = fng !== null && fng <= 25 && symbol.assetClass === 'crypto';
    const beActivation = extremeFearCrypto ? 0.25 : 0.4;
    const trailActivation = extremeFearCrypto ? 0.35 : 0.7;
    const trailRatio = extremeFearCrypto ? 0.75 : 0.5;

    // Move stop to breakeven + costs
    if (progressPct >= beActivation) {
      const costProtectedStop = direction === 'short'
        ? position.entryPrice * (1 - (this.estimatedBrokerRoundTripCostBps(symbol) * 0.6) / 10_000)
        : position.entryPrice * (1 + (this.estimatedBrokerRoundTripCostBps(symbol) * 0.6) / 10_000);
      position.stopPrice = direction === 'short'
        ? Math.min(position.stopPrice, costProtectedStop)
        : Math.max(position.stopPrice, costProtectedStop);
    }

    // Trail at ratio of gains
    if (progressPct >= trailActivation) {
      const trailingStop = direction === 'short'
        ? position.entryPrice - progress * trailRatio
        : position.entryPrice + progress * trailRatio;
      position.stopPrice = direction === 'short'
        ? Math.min(position.stopPrice, trailingStop)
        : Math.max(position.stopPrice, trailingStop);
    }
  }

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

  private buildJournalContext(symbol: SymbolState): {
    regime: string;
    newsBias: string;
    orderFlowBias: string;
    macroVeto: boolean;
    embargoed: boolean;
    confidencePct: number;
    tags: string[];
  } {
    const intel = this.marketIntel.getCompositeSignal(symbol.symbol);
    const news = this.newsIntel.getSignal(symbol.symbol);
    const macro = this.newsIntel.getMacroSignal();
    const embargo = this.eventCalendar.getEmbargo(symbol.symbol);
    const sessionBucket = this.getSessionBucket();
    const volBucket = this.getVolatilityBucket(symbol);
    const tags = [
      news.veto ? 'symbol-news-veto' : '',
      macro.veto ? 'macro-veto' : '',
      embargo.blocked ? `embargo-${embargo.kind}` : '',
      intel.tradeable ? 'intel-tradeable' : 'intel-weak',
      `regime-${this.classifySymbolRegime(symbol)}`,
      `session-${sessionBucket}`,
      `vol-${volBucket}`
    ].filter((tag): tag is string => tag.length > 0);

    return {
      regime: this.classifySymbolRegime(symbol),
      newsBias: news.direction,
      orderFlowBias: intel.direction,
      macroVeto: macro.veto,
      embargoed: embargo.blocked,
      confidencePct: intel.confidence,
      tags
    };
  }

  private buildMetaCandidate(
    agent: AgentState,
    symbol: SymbolState,
    intel: {
      direction: 'strong-buy' | 'buy' | 'neutral' | 'sell' | 'strong-sell';
      confidence: number;
      adverseSelectionRisk?: number;
      quoteStabilityMs?: number;
    }
  ): MetaLabelCandidate {
    const context = this.buildJournalContext(symbol);
    const openMeta = agent.position?.entryMeta;
    const probability = openMeta?.trainedProbability ?? openMeta?.contextualProbability ?? openMeta?.heuristicProbability ?? intel.confidence;
    const expectedGrossEdgeBps = estimateExpectedGrossEdgeBps(probability, agent.config.targetBps, agent.config.stopBps);
    const estimatedCostBps = estimateRoundTripCostBps({
      assetClass: symbol.assetClass,
      broker: agent.config.broker,
      spreadBps: symbol.spreadBps,
      orderType: agent.config.executionMode === 'broker-paper' ? 'market' : 'market',
      adverseSelectionRisk: intel.adverseSelectionRisk,
      quoteStabilityMs: intel.quoteStabilityMs,
      postOnly: false,
      shortSide: false
    });
    const expectedNetEdgeBps = expectedGrossEdgeBps - estimatedCostBps;
    return {
      strategyId: agent.config.id,
      strategy: `${agent.config.name} / scalping`,
      style: agent.config.style,
      symbol: symbol.symbol,
      regime: context.regime,
      orderFlowBias: intel.direction,
      newsBias: context.newsBias,
      confidencePct: intel.confidence,
      spreadBps: symbol.spreadBps,
      macroVeto: context.macroVeto,
      embargoed: context.embargoed,
      tags: [...context.tags, `style-${agent.config.style}`, `mode-${agent.config.executionMode}`],
      source: agent.config.executionMode === 'broker-paper' ? 'broker' : 'simulated',
      assetClass: symbol.assetClass,
      expectedGrossEdgeBps,
      estimatedCostBps,
      expectedNetEdgeBps,
      ...(openMeta ? {
        entryScore: openMeta.score,
        entryHeuristicProbability: openMeta.heuristicProbability,
        entryContextualProbability: openMeta.contextualProbability,
        entryTrainedProbability: openMeta.trainedProbability,
        entryApprove: openMeta.approve,
        entryReason: openMeta.reason,
        entryConfidencePct: openMeta.confidencePct,
        entryRegime: openMeta.regime,
        entryNewsBias: openMeta.newsBias,
        entryOrderFlowBias: openMeta.orderFlowBias,
        entryMacroVeto: openMeta.macroVeto,
        entryEmbargoed: openMeta.embargoed,
        entryTags: openMeta.tags
      } : {})
    };
  }

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
    const base = agent.config.cooldownTicks;
    const lastPnl = agent.lastExitPnl;
    const fng = this.marketIntel.getFearGreedValue();
    const consecutiveLosses = this.countConsecutiveLosses(agent.recentOutcomes ?? []);

    let multiplier = 1.0;
    // After a loss, cool down longer
    if (lastPnl < 0) {
      multiplier = 1.3;
      if (consecutiveLosses >= 2) multiplier = 1.6;
      if (consecutiveLosses >= 3) multiplier = 2.0;
    } else if (lastPnl > 0) {
      // After a win, cool down slightly shorter
      multiplier = 0.8;
    }

    // Bearish/fearful market = longer cooldown for momentum, shorter for mean-reversion
    if (fng !== null && fng < 30 && agent.config.style === 'momentum') {
      multiplier *= 1.4;
    }

    return Math.max(2, Math.round(base * multiplier));
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
    // Cold streak protection: reduce size after consecutive losses
    // Gemini insight: disable for mean-reversion in extreme fear — they NEED to probe multiple times
    const recentOutcomes = agent.recentOutcomes ?? [];
    const consecutiveLosses = this.countConsecutiveLosses(recentOutcomes);
    const streakFng = this.marketIntel.getFearGreedValue();
    const disableStreakPenalty = agent.config.style === 'mean-reversion' && streakFng !== null && streakFng <= 20;
    const streakMultiplier = disableStreakPenalty ? 1.0 : (consecutiveLosses >= 3 ? 0.5 : consecutiveLosses >= 2 ? 0.75 : 1.0);
    const executionMultiplier = this.getExecutionQualityMultiplier(agent.config.broker);
    // Fear & Greed regime sizing: bearish = shrink momentum, boost mean-reversion
    const fng = this.marketIntel.getFearGreedValue();
    let fngMultiplier = 1.0;
    if (fng !== null && symbol.assetClass === 'crypto') {
      if (fng < 25) {
        // Extreme fear: momentum agents shrink, mean-reversion agents grow
        fngMultiplier = agent.config.style === 'momentum' ? 0.5 : agent.config.style === 'mean-reversion' ? 1.4 : 0.7;
      } else if (fng < 40) {
        fngMultiplier = agent.config.style === 'momentum' ? 0.7 : agent.config.style === 'mean-reversion' ? 1.2 : 0.9;
      } else if (fng > 75) {
        // Extreme greed: momentum agents grow, mean-reversion agents shrink
        fngMultiplier = agent.config.style === 'momentum' ? 1.3 : agent.config.style === 'mean-reversion' ? 0.7 : 1.0;
      }
    }

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

  private entryNote(style: AgentStyle, symbol: SymbolState, score: number): string {
    if (style === 'momentum') {
      return `Bought ${symbol.symbol} momentum squeeze after positive tape acceleration. Score ${score.toFixed(2)}.`;
    }
    if (style === 'breakout') {
      return `Bought ${symbol.symbol} on breakout through short-term range high. Score ${score.toFixed(2)}.`;
    }
    return `Bought ${symbol.symbol} on short-term overreaction into mean-reversion zone. Score ${score.toFixed(2)}.`;
  }

  private getEntryScore(style: AgentStyle, shortReturn: number, mediumReturn: number, symbol: SymbolState): number {
    if (symbol.price <= 0 || symbol.history.length < 2) return 0;
    const spreadPenalty = symbol.spreadBps * 0.03;
    const avg = average(pickLast(symbol.history, 12));
    const deviation = avg > 0 ? (symbol.price - avg) / symbol.price : 0;

    // RSI(2) bonus: extreme readings boost score significantly
    const rsi2 = this.marketIntel.computeRSI2(symbol.symbol);
    let rsi2Bonus = 0;
    if (rsi2 !== null) {
      if (style === 'mean-reversion') {
        // Oversold = high score for mean-reversion
        if (rsi2 < 10) rsi2Bonus = 3.0;
        else if (rsi2 < 25) rsi2Bonus = 1.5;
        else if (rsi2 > 75) rsi2Bonus = -1.0; // wrong side for mean-reversion
      } else {
        // For momentum/breakout, overbought momentum confirmation
        if (rsi2 > 65 && rsi2 < 85) rsi2Bonus = 0.8; // strong momentum, not yet exhausted
        else if (rsi2 < 15) rsi2Bonus = -1.5; // too oversold, don't chase long
      }
    }

    // Stochastic bonus: crossovers in extreme zones
    const stoch = this.marketIntel.computeStochastic(symbol.symbol);
    let stochBonus = 0;
    if (stoch) {
      if (style === 'mean-reversion' && stoch.crossover === 'bullish' && stoch.k < 30) stochBonus = 1.5;
      else if (style === 'momentum' && stoch.crossover === 'bullish' && stoch.k > 50) stochBonus = 1.0;
      else if (stoch.crossover === 'bearish' && stoch.k > 70) stochBonus = -1.0;
    }

    // Insider signal bonus: high-conviction insider buying boosts score significantly
    const insiderSignal = this.insiderRadar.getSignal(symbol.symbol);
    let insiderBonus = 0;
    if (insiderSignal && insiderSignal.convictionScore >= 0.5) {
      if (insiderSignal.direction === 'bullish') {
        insiderBonus = insiderSignal.isCluster ? 4.0 : 2.0;
        insiderBonus *= insiderSignal.convictionScore; // scale with conviction
      } else if (insiderSignal.direction === 'bearish' && insiderSignal.convictionScore >= 0.7) {
        insiderBonus = -3.0 * insiderSignal.convictionScore;
      }
    }

    const indicatorBonus = rsi2Bonus + stochBonus + insiderBonus;

    if (style === 'momentum') {
      return shortReturn * 1400 + mediumReturn * 600 + symbol.bias * 1200 - spreadPenalty + indicatorBonus;
    }
    if (style === 'breakout') {
      const breakoutWindow = pickLast(symbol.history, 9).slice(0, -1);
      const breakoutBase = breakoutWindow.length > 0 ? Math.max(...breakoutWindow) : symbol.price;
      const breakout = symbol.price / breakoutBase - 1;
      return breakout * 2200 + shortReturn * 900 + symbol.bias * 900 - spreadPenalty + indicatorBonus;
    }
    return (-deviation * 1800) + (-shortReturn * 500) + (mediumReturn * 240) - spreadPenalty + indicatorBonus;
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
    if (symbol.assetClass === 'crypto') {
      return Math.max(26, symbol.spreadBps * 2 + 8);
    }

    return Math.max(4, symbol.spreadBps * 1.75 + 1.5);
  }

  private fastPathThreshold(style: AgentStyle): number {
    return this.entryThreshold(style) + (style === 'breakout' ? 0.9 : 0.6);
  }

  private brokerRulesFastPathThreshold(agent: AgentState, _symbol: SymbolState): number {
    return this.fastPathThreshold(agent.config.style) + 0.2;
  }

  private canUseBrokerRulesFastPath(
    agent: AgentState,
    symbol: SymbolState,
    score: number,
    aiDecision: AiCouncilDecision | null
  ): boolean {
    if (agent.config.executionMode !== 'broker-paper') {
      return false;
    }

    if (score < this.brokerRulesFastPathThreshold(agent, symbol)) {
      return false;
    }

    if (!aiDecision) {
      return true;
    }

    if (aiDecision.status === 'queued' || aiDecision.status === 'evaluating') {
      return true;
    }

    if (aiDecision.status === 'complete' && aiDecision.finalAction === 'approve') {
      return true;
    }

    if (aiDecision.status === 'complete' && aiDecision.finalAction === 'reject') {
      return false;
    }

    return aiDecision.primary.provider === 'rules';
  }

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

      // 1. Time-of-day filter: only scalp during peak volatility hours
      const hour = new Date().getUTCHours();
      if (symbol.assetClass === 'crypto') {
        // Crypto peak: US market hours overlap (14-21 UTC) and Asia open (00-03 UTC)
        // Crypto trades 24/7 — only skip the lowest-volume dead zone (4-6 UTC = midnight US east coast)
        const cryptoActive = hour < 4 || hour >= 6;
        if (!cryptoActive) return false;

        // Bearish-protection: block crypto longs during risk-off tape, but allow shorts.
        const riskOffActive = this.signalBus.hasRecentSignalOfType('risk-off', 120_000);
        const negativeDrift = symbol.drift <= -0.004;
        const panicRegime = this.classifySymbolRegime(symbol) === 'panic';
        if (direction === 'long' && (riskOffActive || (panicRegime && negativeDrift))) return false;
      } else if (symbol.assetClass === 'forex') {
        // Forex peak: London (07-16 UTC) and NY overlap (13-17 UTC)
        const forexActive = hour >= 7 && hour <= 17;
        if (!forexActive) return false;
      }
      // Indices/bonds/commodities: trade whenever OANDA serves them

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

      // 5. VWAP flat threshold: if VWAP slope is near zero, market is chopping — skip momentum/breakout
      //    Gemini insight: bypass for crypto capitulations — RSI(2) < 10 in extreme fear = buy the wick
      const vwapRsi2 = this.marketIntel.computeRSI2(symbol.symbol);
      const vwapFng = this.marketIntel.getFearGreedValue();
      const cryptoCapitulation = symbol.assetClass === 'crypto' && vwapFng !== null && vwapFng <= 20 && vwapRsi2 !== null && vwapRsi2 < 10;
      if (agent.config.style !== 'mean-reversion' && this.marketIntel.isVwapFlat(symbol.symbol) && !cryptoCapitulation) {
        return false;
      }

      // 6. RSI(2) filter: for mean-reversion, require RSI(2) < 40 (oversold)
      //    For momentum, reject if RSI(2) > 85 (already extended)
      const rsi2 = this.marketIntel.computeRSI2(symbol.symbol);
      if (rsi2 !== null) {
        // In extreme fear, relax RSI(2) filter for mean-reversion — they need to probe dips
        const rsi2Fng = this.marketIntel.getFearGreedValue();
        const rsi2Limit = (rsi2Fng !== null && rsi2Fng <= 20) ? 55 : 40;
        if (agent.config.style === 'mean-reversion' && direction === 'long' && rsi2 > rsi2Limit) return false;
        if (agent.config.style === 'mean-reversion' && direction === 'short' && rsi2 < 60) return false;
        if (agent.config.style === 'momentum' && direction === 'long' && rsi2 > 85) return false;
        if (agent.config.style === 'momentum' && direction === 'short' && rsi2 < 18) return false;

        // Gemini insight: in extreme fear crypto, RSI(2) < 10 longs MUST have volatility confirmation
        // (Bollinger squeeze expansion or Bollinger position < 0.05) to avoid catching falling knives
        const entryFng = this.marketIntel.getFearGreedValue();
        if (symbol.assetClass === 'crypto' && entryFng !== null && entryFng < 25 && direction === 'long' && rsi2 < 10) {
          const bb = this.marketIntel.getSnapshot().bollinger.find((b) => b.symbol === symbol.symbol);
          if (bb && !bb.squeeze && bb.pricePosition > 0.05) {
            return false; // RSI(2) oversold but no panic wick / no squeeze — falling knife
          }
        }
      }

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

      // 9. Multi-timeframe RSI(14) confirmation — don't enter against the larger trend
      const rsi14 = this.marketIntel.computeRSI14(symbol.symbol);
      if (rsi14 !== null) {
        // Momentum long needs RSI(14) > 45 (not in a downtrend on the higher timeframe)
        if (agent.config.style === 'momentum' && direction === 'long' && rsi14 < 45) return false;
        // Mean-reversion long needs RSI(14) < 60 (not overbought on higher TF — room to bounce)
        // In extreme fear, relax RSI(14) for mean-reversion — allow entries in deeper downtrends
        const rsi14Fng = this.marketIntel.getFearGreedValue();
        const rsi14Limit = (rsi14Fng !== null && rsi14Fng <= 20) ? 70 : 60;
        if (agent.config.style === 'mean-reversion' && direction === 'long' && rsi14 > rsi14Limit) return false;
        // Short entries: momentum short needs RSI(14) < 55, mean-reversion short needs RSI(14) > 40
        if (agent.config.style === 'momentum' && direction === 'short' && rsi14 > 55) return false;
        if (agent.config.style === 'mean-reversion' && direction === 'short' && rsi14 < 40) return false;
      }

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

  private getManagerBlock(agent: AgentState, symbol: SymbolState): string | null {
    const outcomes = pickLast(agent.recentOutcomes, 8);
    if (outcomes.length < 6) return null;

    const wins = outcomes.filter((value) => value > 0);
    const losses = outcomes.filter((value) => value < 0);
    const grossWins = wins.reduce((sum, value) => sum + value, 0);
    const grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
    const expectancy = average(outcomes);
    const recentWinRate = wins.length / outcomes.length;
    const consecutiveLosses = this.countConsecutiveLosses(outcomes);

    const brokerPaperLane = agent.config.executionMode === 'broker-paper';
    const profitFactorFloor = brokerPaperLane ? 1.05 : 0.95;
    const winRateFloor = brokerPaperLane ? 0.5 : 0.45;
    const lossStreakLimit = brokerPaperLane ? 2 : 3;
    const expectancyFloor = brokerPaperLane ? -0.5 : -2;

    if ((profitFactor < profitFactorFloor && recentWinRate < winRateFloor) || consecutiveLosses >= lossStreakLimit || expectancy <= expectancyFloor) {
      return `Manager block on ${symbol.symbol}: recent PF ${profitFactor.toFixed(2)}, win ${(recentWinRate * 100).toFixed(1)}%, ${consecutiveLosses} straight losses.`;
    }

    return null;
  }

  private summarizePerformance(entries: TradeJournalEntry[]): PerformanceSummary {
    const filtered = entries.filter((entry) => entry.realizedPnl !== 0);
    const wins = filtered.filter((entry) => entry.realizedPnl > 0);
    const losses = filtered.filter((entry) => entry.realizedPnl < 0);
    const grossWins = wins.reduce((sum, entry) => sum + entry.realizedPnl, 0);
    const grossLosses = Math.abs(losses.reduce((sum, entry) => sum + entry.realizedPnl, 0));
    return {
      sampleCount: filtered.length,
      wins: wins.length,
      losses: losses.length,
      winRate: filtered.length > 0 ? wins.length / filtered.length : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0,
      expectancy: filtered.length > 0 ? average(filtered.map((entry) => entry.realizedPnl)) : 0
    };
  }

  private getPrecisionBlock(agent: AgentState, symbol: SymbolState): string | null {
    // Paper mode: never block — collect data
    return null;
    if (agent.config.executionMode !== 'broker-paper') {
      return null;
    }

    const entries = this.getMetaJournalEntries();
    const symbolEntries = entries
      .filter((entry) => entry.symbol === symbol.symbol && entry.realizedPnl !== 0)
      .sort((left, right) => Date.parse(left.exitAt) - Date.parse(right.exitAt));
    const assetEntries = entries
      .filter((entry) => (entry.assetClass ?? inferAssetClassFromSymbol(entry.symbol)) === symbol.assetClass && entry.realizedPnl !== 0)
      .sort((left, right) => Date.parse(left.exitAt) - Date.parse(right.exitAt));

    const symbolPerf = this.summarizePerformance(symbolEntries.slice(-12));
    const assetPerf = this.summarizePerformance(assetEntries.slice(-20));
    const symbolGate = evaluateKpiGate({
      scope: 'symbol',
      sampleCount: symbolPerf.sampleCount,
      winRatePct: symbolPerf.winRate * 100,
      profitFactor: symbolPerf.profitFactor,
      expectancy: symbolPerf.expectancy,
      netEdgeBps: undefined,
      confidencePct: undefined,
      drawdownPct: undefined
    });
    const assetGate = evaluateKpiGate({
      scope: 'asset',
      sampleCount: assetPerf.sampleCount,
      winRatePct: assetPerf.winRate * 100,
      profitFactor: assetPerf.profitFactor,
      expectancy: assetPerf.expectancy,
      netEdgeBps: undefined,
      confidencePct: undefined,
      drawdownPct: undefined
    });

    if (symbolPerf.sampleCount >= symbolGate.thresholds.minSampleCount && !symbolGate.passed) {
      return `Precision block on ${symbol.symbol}: ${symbolGate.summary}`;
    }

    if (assetPerf.sampleCount >= assetGate.thresholds.minSampleCount && !assetGate.passed) {
      return `Asset-class block on ${symbol.assetClass}: ${assetGate.summary}`;
    }

    return null;
  }

  private toLiveReadiness(agent: AgentState): AgentLiveReadiness {
    const symbol = this.market.get(agent.config.symbol);
    const outcomes = pickLast(agent.recentOutcomes, 12);
    const wins = outcomes.filter((value) => value > 0);
    const losses = outcomes.filter((value) => value < 0);
    const grossWins = wins.reduce((sum, value) => sum + value, 0);
    const grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
    const expectancy = outcomes.length > 0 ? average(outcomes) : 0;
    const winRate = agent.trades > 0 ? (agent.wins / agent.trades) * 100 : 0;
    const confidencePct = clamp((agent.allocationScore / 1.8) * 100, 0, 100);
    const kpiGate = evaluateKpiGate({
      scope: 'agent',
      sampleCount: agent.trades,
      winRatePct: winRate,
      profitFactor,
      expectancy,
      netEdgeBps: undefined,
      confidencePct,
      drawdownPct: undefined
    });
    const cryptoSymbol = agent.config.symbol.endsWith('-USD');
    const gates: ReadinessGate[] = [
      {
        name: 'asset venue fit',
        passed: cryptoSymbol,
        actual: agent.config.symbol,
        required: 'Coinbase live rollout should start with crypto symbols only',
        severity: cryptoSymbol ? 'info' : 'blocker'
      },
      {
        name: 'broker-backed paper path',
        passed: agent.config.executionMode === 'broker-paper',
        actual: agent.config.executionMode,
        required: 'strategy must prove itself on a broker-backed paper route before live promotion',
        severity: 'blocker'
      },
      {
        name: 'sample size',
        passed: agent.trades >= 20,
        actual: `${agent.trades} trades`,
        required: 'at least 20 completed paper trades',
        severity: 'blocker'
      },
      {
        name: 'paper profitability',
        passed: agent.realizedPnl > 0 && profitFactor >= 1.25 && expectancy > 0,
        actual: `PnL ${round(agent.realizedPnl, 2)}, PF ${profitFactor.toFixed(2)}, expectancy ${expectancy.toFixed(2)}`,
        required: 'positive PnL, PF >= 1.25, expectancy > 0',
        severity: 'blocker'
      },
      {
        name: 'kpi ratio',
        passed: kpiGate.passed,
        actual: `${kpiGate.ratioPct.toFixed(1)}% (${kpiGate.grade})`,
        required: `>= ${kpiGate.thresholds.minRatioPct.toFixed(1)}% and no KPI blockers`,
        severity: 'blocker'
      },
      {
        name: 'win rate',
        passed: winRate >= 52,
        actual: `${winRate.toFixed(1)}%`,
        required: 'at least 52% paper win rate',
        severity: 'warning'
      },
      {
        name: 'spread discipline',
        passed: (symbol?.spreadBps ?? Infinity) <= Math.min(agent.config.spreadLimitBps, 5),
        actual: `${(symbol?.spreadBps ?? 999).toFixed(2)} bps`,
        required: '<= 5.00 bps on current tape',
        severity: 'warning'
      },
      {
        name: 'market data provenance',
        passed: this.hasTradableTape(symbol),
        actual: symbol ? `${symbol.marketStatus}/${symbol.sourceMode}/${symbol.session}/${symbol.tradable ? 'tradable' : this.describeTapeFlags(symbol)}` : 'missing',
        required: 'live regular-session tradable market snapshots for autonomous deployment',
        severity: 'blocker'
      },
      {
        name: 'size discipline',
        passed: agent.config.sizeFraction <= 0.12,
        actual: `${(agent.config.sizeFraction * 100).toFixed(2)}%`,
        required: '<= 12.00% of agent capital for first live deployment',
        severity: 'warning'
      }
    ];
    const eligible = gates.every((gate) => gate.passed || gate.severity === 'info');

    return {
      agentId: agent.config.id,
      agentName: agent.config.name,
      symbol: agent.config.symbol,
      eligible,
      mode: eligible ? 'candidate' : gates.some((gate) => gate.severity === 'blocker' && !gate.passed) ? 'blocked' : 'paper-only',
      realizedPnl: round(agent.realizedPnl, 2),
      trades: agent.trades,
      winRate: round(winRate, 1),
      profitFactor: round(profitFactor, 2),
      expectancy: round(expectancy, 2),
      kpiRatio: kpiGate.ratioPct,
      lastAdjustment: agent.lastAdjustment,
      gates
    };
  }

  private applyAdaptiveTuning(agent: AgentState, symbol: SymbolState): void {
    const outcomes = pickLast(agent.recentOutcomes, 8);
    const minOutcomes = agent.config.executionMode === 'broker-paper' ? 2 : 3;
    if (outcomes.length < minOutcomes) {
      agent.lastAdjustment = `Collecting more broker-backed paper exits before tuning thresholds move (${outcomes.length}/${minOutcomes}).`;
      agent.improvementBias = 'hold-steady';
      return;
    }

    const holds = pickLast(agent.recentHoldTicks, 8);
    const wins = outcomes.filter((value) => value > 0);
    const losses = outcomes.filter((value) => value < 0);
    const grossWins = wins.reduce((sum, value) => sum + value, 0);
    const grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
    const winRate = wins.length / outcomes.length;
    const confidenceLower = this.wilsonBound(wins.length, outcomes.length, 1.0, 'lower');
    const confidenceUpper = this.wilsonBound(wins.length, outcomes.length, 1.0, 'upper');
    const confidenceSpan = confidenceUpper - confidenceLower;
    const avgHold = average(holds);
    const brokerPaperCrypto = agent.config.executionMode === 'broker-paper' && symbol.assetClass === 'crypto';
    const frictionFloorBps = brokerPaperCrypto ? this.estimatedBrokerRoundTripCostBps(symbol) + 12 : 0;
    const recentJournal = this.getRecentJournalEntries(agent, symbol, 12);
    const mistakeProfile = this.buildMistakeProfile(agent, symbol, recentJournal);

    // Confidence gate: don't churn parameters when the win-rate estimate is still statistically wide.
    if (outcomes.length < 6 || confidenceSpan > 0.45) {
      agent.lastAdjustment = `Holding tuning on ${symbol.symbol}: confidence is still wide (${(confidenceLower * 100).toFixed(1)}-${(confidenceUpper * 100).toFixed(1)}%) across ${outcomes.length} exits.`;
      agent.improvementBias = 'hold-steady';
      return;
    }

    let baseBias: AgentState['improvementBias'] = 'hold-steady';
    let baseNote = `Holding steady on ${symbol.symbol}. PF ${profitFactor.toFixed(2)}, win ${(winRate * 100).toFixed(1)}%, avg hold ${avgHold.toFixed(1)} ticks.`;

    if (profitFactor < 0.95 || confidenceUpper < 0.48) {
      agent.config.sizeFraction = clamp(round(agent.config.sizeFraction * 0.96, 4), 0.06, agent.baselineConfig.sizeFraction);
      agent.config.maxHoldTicks = Math.max(brokerPaperCrypto ? 12 : 4, agent.config.maxHoldTicks - 1);
      agent.config.spreadLimitBps = clamp(round(agent.config.spreadLimitBps - 0.25, 2), 2, agent.baselineConfig.spreadLimitBps);
      agent.config.stopBps = clamp(round(agent.config.stopBps - 0.5, 2), brokerPaperCrypto ? 14 : 8, agent.baselineConfig.stopBps + 3);
      if (brokerPaperCrypto) {
        agent.config.targetBps = Math.max(agent.config.targetBps, round(frictionFloorBps, 2));
      }
      baseNote = `Tightened risk after ${outcomes.length} exits on ${symbol.symbol}. PF ${profitFactor.toFixed(2)}, win ${(winRate * 100).toFixed(1)}%.`;
      baseBias = 'tighten-risk';
    } else if (profitFactor > 1.35 && confidenceLower > 0.52) {
      agent.config.targetBps = clamp(round(agent.config.targetBps + 0.5, 2), agent.baselineConfig.targetBps - 1, agent.baselineConfig.targetBps + 8);
      agent.config.sizeFraction = clamp(round(agent.config.sizeFraction + 0.01, 4), 0.06, agent.baselineConfig.sizeFraction + 0.06);
      if (avgHold < Math.max(3, agent.config.maxHoldTicks - 1)) {
        agent.config.maxHoldTicks = Math.min(agent.config.maxHoldTicks + 1, agent.baselineConfig.maxHoldTicks + 2);
      }
      if (brokerPaperCrypto) {
        agent.config.targetBps = Math.max(agent.config.targetBps, round(frictionFloorBps, 2));
      }
      baseNote = `Pressed edge after ${outcomes.length} exits on ${symbol.symbol}. PF ${profitFactor.toFixed(2)}, win ${(winRate * 100).toFixed(1)}%.`;
      baseBias = 'press-edge';
    } else {
      agent.config.targetBps = nudge(agent.config.targetBps, agent.baselineConfig.targetBps, 0.25);
      agent.config.stopBps = nudge(agent.config.stopBps, agent.baselineConfig.stopBps, 0.25);
      agent.config.spreadLimitBps = nudge(agent.config.spreadLimitBps, agent.baselineConfig.spreadLimitBps, 0.1);
      agent.config.sizeFraction = nudge(agent.config.sizeFraction, agent.baselineConfig.sizeFraction, 0.005);
      if (brokerPaperCrypto) {
        agent.config.targetBps = Math.max(agent.config.targetBps, round(frictionFloorBps, 2));
        agent.config.maxHoldTicks = Math.max(agent.config.maxHoldTicks, 12);
      }
    }

    const mistakeRefinement = this.applyMistakeDrivenRefinement(agent, symbol, mistakeProfile, brokerPaperCrypto, frictionFloorBps);
    const finalBias: AgentState['improvementBias'] = mistakeRefinement.bias === 'tighten-risk'
      ? 'tighten-risk'
      : mistakeRefinement.bias === 'press-edge' && baseBias === 'hold-steady'
        ? 'press-edge'
        : baseBias;
    const mistakeSuffix = mistakeProfile.dominant === 'clean'
      ? `Mistake loop: no dominant pattern across ${mistakeProfile.sampleCount} recent exits.`
      : `Mistake loop: ${mistakeRefinement.note}`;

    agent.lastAdjustment = `${baseNote} ${mistakeSuffix}`.trim();
    agent.improvementBias = finalBias;
  }

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

  private buildMistakeProfile(agent: AgentState, symbol: SymbolState | null, entries: TradeJournalEntry[]): MistakeLearningProfile {
    const sampleCount = entries.length;
    const winnerEntries = entries.filter((entry) => entry.realizedPnl > 0);
    const loserEntries = entries.filter((entry) => entry.realizedPnl < 0);

    if (sampleCount < 4 || (winnerEntries.length === 0 && loserEntries.length === 0)) {
      return {
        sampleCount,
        winnerCount: winnerEntries.length,
        loserCount: loserEntries.length,
        dominant: 'clean',
        severity: 0,
        summary: sampleCount < 4
          ? `Only ${sampleCount} recent exits so far; keep learning before changing the tape rules.`
          : 'No dominant mistake cluster in the recent exits.',
        avgWinnerHoldTicks: 0,
        avgLoserHoldTicks: 0,
        avgWinnerSpreadBps: 0,
        avgLoserSpreadBps: 0,
        avgWinnerConfidencePct: 0,
        avgLoserConfidencePct: 0
      };
    }

    const avgWinnerHoldTicks = winnerEntries.length > 0 ? average(winnerEntries.map((entry) => entry.holdTicks ?? 0)) : 0;
    const avgLoserHoldTicks = loserEntries.length > 0 ? average(loserEntries.map((entry) => entry.holdTicks ?? 0)) : 0;
    const avgWinnerSpreadBps = winnerEntries.length > 0 ? average(winnerEntries.map((entry) => entry.spreadBps ?? symbol?.spreadBps ?? agent.config.spreadLimitBps)) : 0;
    const avgLoserSpreadBps = loserEntries.length > 0 ? average(loserEntries.map((entry) => entry.spreadBps ?? symbol?.spreadBps ?? agent.config.spreadLimitBps)) : 0;
    const avgWinnerConfidencePct = winnerEntries.length > 0
      ? average(winnerEntries.map((entry) => entry.confidencePct ?? entry.entryConfidencePct ?? 0))
      : 0;
    const avgLoserConfidencePct = loserEntries.length > 0
      ? average(loserEntries.map((entry) => entry.confidencePct ?? entry.entryConfidencePct ?? 0))
      : 0;
    const avgWinnerNetEdgeBps = winnerEntries.length > 0
      ? average(winnerEntries.map((entry) => entry.expectedNetEdgeBps ?? ((entry.expectedGrossEdgeBps ?? 0) - (entry.estimatedCostBps ?? entry.spreadBps))))
      : 0;
    const avgLoserNetEdgeBps = loserEntries.length > 0
      ? average(loserEntries.map((entry) => entry.expectedNetEdgeBps ?? ((entry.expectedGrossEdgeBps ?? 0) - (entry.estimatedCostBps ?? entry.spreadBps))))
      : 0;

    const quickLosses = loserEntries.filter((entry) => (entry.holdTicks ?? 0) <= 3).length;
    const lateLosses = loserEntries.filter((entry) => (entry.holdTicks ?? 0) >= Math.max(agent.config.maxHoldTicks - 1, 4)).length;
    const stopOrFadeLosses = loserEntries.filter((entry) => /stop|fade|timeout/i.test(entry.exitReason)).length;
    const vetoLosses = loserEntries.filter((entry) => entry.macroVeto || entry.embargoed || entry.entryMacroVeto || entry.entryEmbargoed).length;
    const spreadPressure = avgLoserSpreadBps - avgWinnerSpreadBps;

    let dominant: MistakeLearningProfile['dominant'] = 'clean';
    if (vetoLosses >= Math.max(2, Math.ceil(loserEntries.length * 0.5))) {
      dominant = 'veto-drift';
    } else if (spreadPressure >= 0.75 || avgLoserSpreadBps > Math.max(symbol?.spreadBps ?? agent.config.spreadLimitBps, agent.config.spreadLimitBps * 0.9)) {
      dominant = 'spread-leakage';
    } else if (quickLosses >= Math.max(2, Math.ceil(loserEntries.length * 0.5)) && stopOrFadeLosses >= Math.max(1, Math.ceil(loserEntries.length / 3))) {
      dominant = 'premature-exit';
    } else if (lateLosses >= Math.max(2, Math.ceil(loserEntries.length * 0.5)) && stopOrFadeLosses >= Math.max(1, Math.ceil(loserEntries.length / 3))) {
      dominant = 'overstay';
    } else if ((avgLoserConfidencePct + 5) < avgWinnerConfidencePct || avgLoserNetEdgeBps < avgWinnerNetEdgeBps) {
      dominant = 'noise-chasing';
    }

    const severity = round(Math.min(100, Math.max(10, (loserEntries.length / Math.max(sampleCount, 1)) * 100)), 1);
    const summary = dominant === 'clean'
      ? `No dominant mistake cluster in ${sampleCount} recent exits.`
      : dominant === 'spread-leakage'
        ? `Spread leakage: losers averaged ${avgLoserSpreadBps.toFixed(2)}bps vs winners ${avgWinnerSpreadBps.toFixed(2)}bps.`
        : dominant === 'premature-exit'
          ? `Premature exits: ${quickLosses}/${loserEntries.length} losers stopped out within 3 ticks.`
          : dominant === 'overstay'
            ? `Overstays: losers held ${avgLoserHoldTicks.toFixed(1)} ticks against a max of ${agent.config.maxHoldTicks}.`
            : dominant === 'noise-chasing'
              ? `Noise chasing: loser confidence ${avgLoserConfidencePct.toFixed(1)}% vs winner confidence ${avgWinnerConfidencePct.toFixed(1)}%.`
              : `Veto drift: ${vetoLosses}/${loserEntries.length} recent losses ignored macro/news/embargo cues.`;

    return {
      sampleCount,
      winnerCount: winnerEntries.length,
      loserCount: loserEntries.length,
      dominant,
      severity,
      summary,
      avgWinnerHoldTicks,
      avgLoserHoldTicks,
      avgWinnerSpreadBps,
      avgLoserSpreadBps,
      avgWinnerConfidencePct,
      avgLoserConfidencePct
    };
  }

  private applyMistakeDrivenRefinement(
    agent: AgentState,
    symbol: SymbolState,
    profile: MistakeLearningProfile,
    brokerPaperCrypto: boolean,
    frictionFloorBps: number
  ): { note: string; bias: AgentState['improvementBias'] } {
    if (profile.dominant === 'clean') {
      return { note: profile.summary, bias: 'hold-steady' };
    }

    switch (profile.dominant) {
      case 'spread-leakage': {
        agent.config.sizeFraction = clamp(round(agent.config.sizeFraction * 0.94, 4), 0.06, agent.baselineConfig.sizeFraction);
        agent.config.spreadLimitBps = clamp(round(agent.config.spreadLimitBps - 0.25, 2), 2, agent.baselineConfig.spreadLimitBps);
        if (brokerPaperCrypto) {
          agent.config.targetBps = Math.max(agent.config.targetBps, round(frictionFloorBps, 2));
        }
        return {
          note: `${symbol.symbol}: ${profile.summary} Reduced size and spread tolerance.`,
          bias: 'tighten-risk'
        };
      }
      case 'premature-exit': {
        agent.config.stopBps = clamp(round(agent.config.stopBps + 0.5, 2), brokerPaperCrypto ? 14 : 8, agent.baselineConfig.stopBps + 4);
        agent.config.maxHoldTicks = Math.min(agent.config.maxHoldTicks + 1, agent.baselineConfig.maxHoldTicks + 2);
        agent.config.sizeFraction = clamp(round(agent.config.sizeFraction * 0.98, 4), 0.06, agent.baselineConfig.sizeFraction);
        return {
          note: `${symbol.symbol}: ${profile.summary} Gave trades a little more room and trimmed size.`,
          bias: 'hold-steady'
        };
      }
      case 'overstay': {
        agent.config.maxHoldTicks = Math.max(agent.config.maxHoldTicks - 1, 4);
        agent.config.targetBps = clamp(round(agent.config.targetBps - 0.5, 2), brokerPaperCrypto ? Math.max(8, round(frictionFloorBps, 2)) : 8, agent.baselineConfig.targetBps + 8);
        return {
          note: `${symbol.symbol}: ${profile.summary} Shortened hold window and lowered target.`,
          bias: 'tighten-risk'
        };
      }
      case 'noise-chasing': {
        agent.config.sizeFraction = clamp(round(agent.config.sizeFraction * 0.94, 4), 0.06, agent.baselineConfig.sizeFraction);
        agent.config.spreadLimitBps = clamp(round(agent.config.spreadLimitBps - 0.1, 2), 2, agent.baselineConfig.spreadLimitBps);
        if (brokerPaperCrypto) {
          agent.config.targetBps = Math.max(agent.config.targetBps, round(frictionFloorBps, 2));
        }
        return {
          note: `${symbol.symbol}: ${profile.summary} Lowered size and demanded cleaner tape conditions.`,
          bias: 'tighten-risk'
        };
      }
      case 'veto-drift': {
        agent.config.sizeFraction = clamp(round(agent.config.sizeFraction * 0.9, 4), 0.06, agent.baselineConfig.sizeFraction);
        agent.config.stopBps = clamp(round(agent.config.stopBps - 0.25, 2), brokerPaperCrypto ? 14 : 8, agent.baselineConfig.stopBps + 3);
        if (brokerPaperCrypto) {
          agent.config.targetBps = Math.max(agent.config.targetBps, round(frictionFloorBps, 2));
        }
        return {
          note: `${symbol.symbol}: ${profile.summary} Cut size after repeated veto drift.`,
          bias: 'tighten-risk'
        };
      }
      default:
        return { note: profile.summary, bias: 'hold-steady' };
    }
  }

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

  private evaluateChallengerProbation(agent: AgentState, symbol: SymbolState): void {
    if (agent.deployment.mode !== 'challenger-probation') {
      return;
    }

    const probationTrades = agent.trades - agent.deployment.startingTrades;
    const probationPnl = round(agent.realizedPnl - agent.deployment.startingRealizedPnl, 2);
    const probationOutcomes = agent.recentOutcomes.slice(agent.deployment.startingOutcomeCount);
    const wins = probationOutcomes.filter((value) => value > 0);
    const losses = probationOutcomes.filter((value) => value < 0);
    const grossWins = wins.reduce((sum, value) => sum + value, 0);
    const grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
    const winRate = probationOutcomes.length > 0 ? wins.length / probationOutcomes.length : 0;
    const consecutiveLosses = this.countConsecutiveLosses(probationOutcomes);

    if (probationTrades >= 3 && (probationPnl < -2 || consecutiveLosses >= agent.deployment.rollbackLossLimit || (probationTrades >= 4 && profitFactor < 0.9 && winRate < 0.4))) {
      const champion = agent.deployment.championConfig;
      if (champion) {
        agent.config = { ...champion };
        agent.deployment = {
          mode: 'stable',
          championConfig: null,
          challengerConfig: null,
          startedAt: null,
          startingTrades: agent.trades,
          startingRealizedPnl: agent.realizedPnl,
          startingOutcomeCount: agent.recentOutcomes.length,
          probationTradesRequired: 6,
          rollbackLossLimit: 2,
          lastDecision: `Rolled back challenger after ${probationTrades} probation trades on ${symbol.symbol}.`
        };
        agent.lastAdjustment = `Rolled back challenger config on ${symbol.symbol}. Probation PnL ${probationPnl}, PF ${profitFactor.toFixed(2)}.`;
        agent.lastAction = `Challenger rolled back on ${symbol.symbol}; champion restored after weak probation.`;
        this.recordEvent('config-rollback', {
          agentId: agent.config.id,
          symbol: symbol.symbol,
          probationTrades,
          probationPnl,
          profitFactor: round(profitFactor, 2),
          winRate: round(winRate * 100, 1)
        });
        this.persistAgentConfigOverrides();
      }
      return;
    }

    if (probationTrades >= agent.deployment.probationTradesRequired && probationPnl >= 0 && (profitFactor >= 1.0 || winRate >= 0.5)) {
      agent.baselineConfig = { ...agent.config };
      agent.deployment = {
        mode: 'stable',
        championConfig: null,
        challengerConfig: null,
        startedAt: null,
        startingTrades: agent.trades,
        startingRealizedPnl: agent.realizedPnl,
        startingOutcomeCount: agent.recentOutcomes.length,
        probationTradesRequired: 6,
        rollbackLossLimit: 2,
        lastDecision: `Accepted challenger after ${probationTrades} probation trades on ${symbol.symbol}.`
      };
      agent.lastAdjustment = `Accepted challenger config on ${symbol.symbol}. Probation PnL ${probationPnl}, PF ${profitFactor.toFixed(2)}.`;
      this.recordEvent('config-accept', {
        agentId: agent.config.id,
        symbol: symbol.symbol,
        probationTrades,
        probationPnl,
        profitFactor: round(profitFactor, 2),
        winRate: round(winRate * 100, 1)
      });
      this.persistAgentConfigOverrides();
    }
  }

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
    // Sum real broker account balances (Alpaca paper + OANDA practice)
    const alpacaEquity = this.brokerPaperAccount?.equity ?? 0;
    const oandaEquity = this.brokerOandaAccount?.equity ?? 0;
    const coinbaseEquity = this.brokerCoinbaseAccount?.equity ?? 0;
    const brokerTotal = alpacaEquity + oandaEquity + coinbaseEquity;
    if (brokerTotal > 0) {
      return round(brokerTotal, 2);
    }
    return round(this.getDeskAgentStates().reduce((sum, agent) => sum + this.getAgentEquity(agent), 0), 2);
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
    if (brokerTotal > STARTING_EQUITY) {
      return round(brokerTotal, 2);
    }
    return round(this.getDeskAgentStates().reduce((sum, agent) => sum + agent.startingEquity, 0), 2);
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

  private sanitizeBrokerPaperRuntimeState(): void {
    const sanitizedJournal = this.journal.filter(
      (entry) => this.isOwnedBrokerJournal(entry) && !this.isRestoredExternalBrokerJournal(entry)
    );
    const sanitizedFills = this.fills.filter(
      (fill) =>
        this.isOwnedBrokerFill(fill)
        && this.hasMatchingOwnedBrokerEntryFill(fill, this.fills)
        && !this.isRestoredExternalBrokerExitFill(fill, this.journal)
    );
    const fillsChanged = sanitizedFills.length !== this.fills.length;
    const journalChanged = sanitizedJournal.length !== this.journal.length;

    this.fills.splice(0, this.fills.length, ...sanitizedFills);
    this.journal.splice(0, this.journal.length, ...sanitizedJournal);

    const outcomesByAgent = new Map<string, number[]>();

    for (const agent of this.agents.values()) {
      if (agent.config.executionMode !== 'broker-paper') {
        continue;
      }

      agent.realizedPnl = 0;
      agent.feesPaid = 0;
      agent.wins = 0;
      agent.losses = 0;
      agent.trades = 0;
      agent.lastExitPnl = 0;
      agent.recentOutcomes = [];
      agent.recentHoldTicks = [];
      agent.position = null;
      agent.pendingOrderId = null;
      agent.pendingSide = null;
      agent.cash = round(agent.startingEquity, 2);
      agent.status = 'watching';
    }

    for (const fill of sanitizedFills) {
      if (fill.side !== 'sell') {
        continue;
      }

      const agent = this.agents.get(fill.agentId);
      if (!agent || agent.config.executionMode !== 'broker-paper') {
        continue;
      }

      agent.realizedPnl = round(agent.realizedPnl + fill.pnlImpact, 2);
      agent.trades += 1;
      if (fill.pnlImpact >= 0) {
        agent.wins += 1;
      } else {
        agent.losses += 1;
      }
      agent.lastExitPnl = fill.pnlImpact;
      agent.lastSymbol = fill.symbol;

      const outcomes = outcomesByAgent.get(fill.agentId) ?? [];
      outcomes.push(fill.pnlImpact);
      outcomesByAgent.set(fill.agentId, outcomes);
    }

    for (const agent of this.agents.values()) {
      if (agent.config.executionMode !== 'broker-paper') {
        continue;
      }

      if ((outcomesByAgent.get(agent.config.id) ?? []).length === 0) {
        const defaultConfig = getDefaultAgentConfig(agent.config.id, REAL_PAPER_AUTOPILOT);
        if (defaultConfig) {
          agent.baselineConfig = { ...defaultConfig };
          agent.config = { ...defaultConfig };
        }
      }

      agent.recentOutcomes = pickLast(outcomesByAgent.get(agent.config.id) ?? [], 8);
      agent.cash = round(agent.startingEquity + agent.realizedPnl, 2);
      if (agent.trades === 0) {
        agent.lastAction = `Ready to trade ${agent.config.symbol}. Waiting for signal.`;
        agent.improvementBias = 'hold-steady';
      } else {
        const symbol = this.market.get(agent.config.symbol);
        if (symbol) {
          this.applyAdaptiveTuning(agent, symbol);
        }
      }
      agent.curve = Array.from({ length: Math.max(this.deskCurve.length, 1) }, () => this.getAgentEquity(agent));
    }

    if (fillsChanged && sanitizedFills.length > 0) {
      this.rewriteLedger(FILL_LEDGER_PATH, [...sanitizedFills].reverse());
    }
    if (journalChanged) {
      this.rewriteLedger(JOURNAL_LEDGER_PATH, [...sanitizedJournal].reverse());
    }
  }

  private getVisibleFills(): AgentFillEvent[] {
    const deskAgentIds = new Set(this.getDeskAgentStates().map((agent) => agent.config.id));
    return this.fills.filter((fill) => deskAgentIds.has(fill.agentId));
  }

  private toBrokerPaperAccountState(snapshot: BrokerAccountSnapshot): BrokerPaperAccountState {
    const account = asRecord(snapshot.account);

    if (snapshot.broker === 'coinbase-live') {
      const accounts = normalizeArray(account.accounts);
      const cash = round(accounts.reduce<number>((sum, item) => {
        const record = asRecord(item);
        const currency = textField(record, ['currency']) ?? '';
        if (currency !== 'USD' && currency !== 'USDC') {
          return sum;
        }
        return sum + (numberField(record, ['available_balance.value', 'available_balance', 'balance.value', 'balance', 'value']) ?? 0);
      }, 0), 2);
      const markValue = round(snapshot.positions.reduce((sum, position) => sum + position.markPrice * position.quantity, 0), 2);
      const equity = round(cash + markValue, 2);

      return {
        asOf: snapshot.asOf,
        status: snapshot.status,
        cash,
        equity,
        dayBaseline: equity,
        buyingPower: cash
      };
    }

    const cash = numberField(account, ['cash', 'portfolio_cash', 'balance']) ?? 0;
    const equity = numberField(account, ['equity', 'portfolio_value', 'NAV', 'last_equity', 'value']) ?? cash;
    const dayBaseline = numberField(account, ['last_equity', 'portfolio_value', 'NAV', 'equity', 'cash']) ?? equity;
    const buyingPower = numberField(account, ['buying_power', 'buyingPower', 'daytrading_buying_power', 'cash']) ?? cash;

    return {
      asOf: snapshot.asOf,
      status: snapshot.status,
      cash: round(cash, 2),
      equity: round(equity, 2),
      dayBaseline: round(dayBaseline, 2),
      buyingPower: round(buyingPower, 2)
    };
  }

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
    const executionQualityScore = this.getExecutionQualityByBroker().find((row) => row.broker === agent.config.broker)?.score ?? 0;
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

  private recordFill(params: {
    agent: AgentState;
    symbol: SymbolState;
    orderId?: string;
    side: OrderSide;
    status: OrderStatus;
    price: number;
    pnlImpact: number;
    note: string;
    source?: 'simulated' | 'broker';
    councilAction?: string | undefined;
    councilConfidence?: number | undefined;
    councilReason?: string | undefined;
  }): void {
    const fill = {
      id: `paper-fill-${Date.now()}-${params.agent.config.id}-${params.side}-${randomUUID()}`,
      agentId: params.agent.config.id,
      agentName: params.agent.config.name,
      symbol: params.symbol.symbol,
      side: params.side,
      status: params.status,
      price: round(params.price, 2),
      pnlImpact: round(params.pnlImpact, 2),
      note: params.note,
      source: params.source ?? 'simulated',
      councilAction: params.councilAction,
      councilConfidence: params.councilConfidence,
      councilReason: params.councilReason,
      ...(params.orderId ? { orderId: params.orderId } : {}),
      timestamp: new Date().toISOString()
    };
    this.fills.unshift(fill);
    this.fills.splice(FILL_LIMIT);
    this.appendLedger(FILL_LEDGER_PATH, fill);
    this.recordEvent('fill', fill as unknown as Record<string, unknown>);
  }

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

  private restoreStateSnapshot(): boolean {
    if (!fs.existsSync(STATE_SNAPSHOT_PATH)) {
      return false;
    }

    try {
      const raw = fs.readFileSync(STATE_SNAPSHOT_PATH, 'utf8');
      const state = JSON.parse(raw) as PersistedPaperEngineState;
      if (!Array.isArray(state.market) || state.market.length === 0 || !Array.isArray(state.agents) || state.agents.length === 0) {
        return false;
      }

      const currentConfigs = buildAgentConfigs(REAL_PAPER_AUTOPILOT);
      const configById = new Map(currentConfigs.map((config) => [config.id, config]));
      const configBySymbol = new Map(currentConfigs.map((config) => [config.symbol, config]));
      const savedAgentIds = [...new Set(state.agents.map((agent) => agent.id))].sort();
      const currentAgentIds = currentConfigs.map((config) => config.id).sort();
      const savedSymbols = [...new Set(state.market.map((entry) => entry.symbol))].sort();
      const currentSymbols = [...new Set(currentConfigs.map((config) => config.symbol))].sort();
      if (savedAgentIds.join('|') !== currentAgentIds.join('|') || savedSymbols.join('|') !== currentSymbols.join('|')) {
        console.warn('[paper-engine] state snapshot universe mismatch; reseeding from current agent config');
        return false;
      }

      this.tick = state.tick;

      this.market.clear();
      for (const symbol of state.market) {
        const currentConfig = configBySymbol.get(symbol.symbol);
        this.market.set(symbol.symbol, {
          ...symbol,
          broker: currentConfig?.broker ?? symbol.broker,
          assetClass: currentConfig?.assetClass ?? symbol.assetClass,
          marketStatus: symbol.marketStatus ?? 'stale',
          sourceMode: symbol.sourceMode ?? 'service',
          session: symbol.session ?? (symbol.assetClass === 'equity' ? 'unknown' : 'regular'),
          tradable: symbol.tradable ?? false,
          qualityFlags: Array.isArray(symbol.qualityFlags) ? symbol.qualityFlags : ['awaiting-market-data'],
          updatedAt: symbol.updatedAt ?? state.savedAt
        });
      }

      this.agents.clear();
      for (const savedAgent of state.agents) {
        const currentConfig = configById.get(savedAgent.id);
        const config = withAgentConfigDefaults({
          ...savedAgent.config,
          broker: currentConfig?.broker ?? savedAgent.config.broker,
          symbol: currentConfig?.symbol ?? savedAgent.config.symbol,
          executionMode: currentConfig?.executionMode ?? savedAgent.config.executionMode,
          autonomyEnabled: currentConfig?.autonomyEnabled ?? savedAgent.config.autonomyEnabled,
          focus: currentConfig?.focus ?? savedAgent.config.focus,
        });
        const baselineConfig = withAgentConfigDefaults({
          ...savedAgent.baselineConfig,
          broker: currentConfig?.broker ?? savedAgent.baselineConfig.broker,
          symbol: currentConfig?.symbol ?? savedAgent.baselineConfig.symbol,
          executionMode: currentConfig?.executionMode ?? savedAgent.baselineConfig.executionMode,
          autonomyEnabled: currentConfig?.autonomyEnabled ?? savedAgent.baselineConfig.autonomyEnabled,
          focus: currentConfig?.focus ?? savedAgent.baselineConfig.focus,
        });
        this.agents.set(savedAgent.id, {
          config,
          baselineConfig,
          evaluationWindow: savedAgent.evaluationWindow ?? 'legacy',
          startingEquity: savedAgent.startingEquity,
          cash: savedAgent.cash,
          realizedPnl: savedAgent.realizedPnl,
          feesPaid: savedAgent.feesPaid ?? 0,
          wins: savedAgent.wins,
          losses: savedAgent.losses,
          trades: savedAgent.trades,
          status: savedAgent.status,
          cooldownRemaining: savedAgent.cooldownRemaining,
          position: savedAgent.position
            ? {
                ...savedAgent.position,
                direction: savedAgent.position.direction ?? 'long',
                entryAt: savedAgent.position.entryAt ?? state.savedAt
              }
            : null,
          pendingOrderId: savedAgent.pendingOrderId ?? null,
          pendingSide: savedAgent.pendingSide ?? null,
          pendingEntryMeta: savedAgent.pendingEntryMeta ?? undefined,
          lastBrokerSyncAt: savedAgent.lastBrokerSyncAt ?? null,
          lastAction: savedAgent.lastAction,
          lastSymbol: savedAgent.lastSymbol,
          lastExitPnl: savedAgent.lastExitPnl,
          recentOutcomes: savedAgent.recentOutcomes,
          recentHoldTicks: savedAgent.recentHoldTicks,
          lastAdjustment: savedAgent.lastAdjustment,
          improvementBias: savedAgent.improvementBias,
          allocationMultiplier: savedAgent.allocationMultiplier ?? 1,
          allocationScore: savedAgent.allocationScore ?? 1,
          allocationReason: savedAgent.allocationReason ?? 'Restored neutral allocation.',
          deployment: savedAgent.deployment ?? {
            mode: 'stable',
            championConfig: null,
            challengerConfig: null,
            startedAt: null,
            startingTrades: 0,
            startingRealizedPnl: savedAgent.realizedPnl,
            startingOutcomeCount: savedAgent.recentOutcomes.length,
            probationTradesRequired: 6,
            rollbackLossLimit: 2,
            lastDecision: 'Restored persisted configuration.'
          },
          curve: savedAgent.curve
        });
      }

      this.fills.splice(0, this.fills.length, ...state.fills.slice(0, FILL_LIMIT));
      this.journal.splice(0, this.journal.length, ...state.journal.slice(0, JOURNAL_LIMIT));
      this.deskCurve.splice(0, this.deskCurve.length, ...pickLast(state.deskCurve, HISTORY_LIMIT));
      this.benchmarkCurve.splice(0, this.benchmarkCurve.length, ...pickLast(state.benchmarkCurve, HISTORY_LIMIT));
      return true;
    } catch (error) {
      console.error('[paper-engine] failed to restore state snapshot', error);
      return false;
    }
  }

  private restoreLedgerHistory(): boolean {
    const fills = readJsonLines<AgentFillEvent>(FILL_LEDGER_PATH);
    const journal = readJsonLines<TradeJournalEntry>(JOURNAL_LEDGER_PATH);
    this.fills.splice(0, this.fills.length, ...fills.slice(-FILL_LIMIT).reverse());
    this.journal.splice(0, this.journal.length, ...journal.slice(-JOURNAL_LIMIT).reverse());

    const outcomesByAgent = new Map<string, number[]>();
    const hadLedger = fills.length > 0 || journal.length > 0;

    for (const agent of this.agents.values()) {
      const defaultConfig = getDefaultAgentConfig(agent.config.id, REAL_PAPER_AUTOPILOT);
      if (defaultConfig) {
        agent.baselineConfig = { ...defaultConfig };
        agent.config = { ...defaultConfig };
      }
      agent.realizedPnl = 0;
      agent.feesPaid = 0;
      agent.wins = 0;
      agent.losses = 0;
      agent.trades = 0;
      agent.lastExitPnl = 0;
      agent.recentOutcomes = [];
      agent.recentHoldTicks = [];
      if (!agent.position) {
        agent.cash = round(agent.startingEquity, 2);
      }
    }

    for (const fill of fills) {
      if (fill.side !== 'sell') {
        continue;
      }
      const agent = this.agents.get(fill.agentId);
      if (!agent || fill.source !== 'broker' || agent.config.executionMode !== 'broker-paper') {
        continue;
      }

      agent.realizedPnl = round(agent.realizedPnl + fill.pnlImpact, 2);
      agent.trades += 1;
      if (fill.pnlImpact >= 0) {
        agent.wins += 1;
      } else {
        agent.losses += 1;
      }
      agent.lastExitPnl = fill.pnlImpact;
      agent.lastSymbol = fill.symbol;

      const outcomes = outcomesByAgent.get(fill.agentId) ?? [];
      outcomes.push(fill.pnlImpact);
      outcomesByAgent.set(fill.agentId, outcomes);
    }

    for (const agent of this.agents.values()) {
      agent.recentOutcomes = pickLast(outcomesByAgent.get(agent.config.id) ?? [], 8);
      if (!agent.position) {
        agent.cash = round(agent.startingEquity + agent.realizedPnl, 2);
      }
      if (agent.config.executionMode === 'broker-paper' && agent.trades === 0 && !agent.position && !agent.pendingOrderId) {
        agent.lastAction = 'Awaiting the first broker-backed Alpaca paper fill in the live evaluation window.';
      }
      if (agent.recentOutcomes.length === 0) {
        agent.lastAdjustment = agent.config.executionMode === 'broker-paper'
          ? 'No broker-backed paper exits yet. Strategy is holding baseline settings.'
          : 'No broker-backed paper venue is attached to this lane yet. Baseline settings are preserved.';
        agent.improvementBias = 'hold-steady';
      }
      agent.curve = Array.from({ length: Math.max(this.deskCurve.length, 1) }, () => this.getAgentEquity(agent));
      const symbol = this.market.get(agent.config.symbol);
      if (symbol && agent.recentOutcomes.length > 0) {
        this.applyAdaptiveTuning(agent, symbol);
      }
    }

    return hadLedger;
  }

  private loadAgentConfigOverrides(): Record<string, Partial<AgentConfig>> {
    try {
      if (!fs.existsSync(AGENT_CONFIG_OVERRIDES_PATH)) return {};
      const raw = fs.readFileSync(AGENT_CONFIG_OVERRIDES_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, Partial<AgentConfig>>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private persistAgentConfigOverrides(): void {
    try {
      const overrides = Array.from(this.agents.values()).reduce<Record<string, Partial<AgentConfig>>>((acc, agent) => {
        acc[agent.config.id] = {
          style: agent.config.style,
          targetBps: agent.config.targetBps,
          stopBps: agent.config.stopBps,
          maxHoldTicks: agent.config.maxHoldTicks,
          cooldownTicks: agent.config.cooldownTicks,
          sizeFraction: agent.config.sizeFraction,
          spreadLimitBps: agent.config.spreadLimitBps
        };
        return acc;
      }, {});
      fs.writeFileSync(AGENT_CONFIG_OVERRIDES_PATH, JSON.stringify(overrides, null, 2), 'utf8');
    } catch (error) {
      console.error('[paper-engine] failed to persist config overrides', error);
    }
  }

  private persistStateSnapshot(): void {
    const state: PersistedPaperEngineState = {
      savedAt: new Date().toISOString(),
      tick: this.tick,
      market: Array.from(this.market.values()),
      agents: Array.from(this.agents.values()).map((agent) => ({
        id: agent.config.id,
        config: agent.config,
        baselineConfig: agent.baselineConfig,
        evaluationWindow: agent.evaluationWindow,
        startingEquity: agent.startingEquity,
        cash: agent.cash,
        realizedPnl: agent.realizedPnl,
        feesPaid: agent.feesPaid,
        wins: agent.wins,
        losses: agent.losses,
        trades: agent.trades,
        status: agent.status,
        cooldownRemaining: agent.cooldownRemaining,
        position: agent.position,
        pendingOrderId: agent.pendingOrderId,
        pendingSide: agent.pendingSide,
        pendingEntryMeta: agent.pendingEntryMeta,
        lastBrokerSyncAt: agent.lastBrokerSyncAt,
        lastAction: agent.lastAction,
        lastSymbol: agent.lastSymbol,
        lastExitPnl: agent.lastExitPnl,
        recentOutcomes: agent.recentOutcomes,
        recentHoldTicks: agent.recentHoldTicks,
        lastAdjustment: agent.lastAdjustment,
        improvementBias: agent.improvementBias,
        allocationMultiplier: agent.allocationMultiplier,
        allocationScore: agent.allocationScore,
        allocationReason: agent.allocationReason,
        deployment: agent.deployment,
        curve: agent.curve
      })),
      fills: [...this.fills],
      journal: [...this.journal],
      deskCurve: [...this.deskCurve],
      benchmarkCurve: [...this.benchmarkCurve]
    };

    try {
      const tempPath = `${STATE_SNAPSHOT_PATH}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(state), 'utf8');
      fs.renameSync(tempPath, STATE_SNAPSHOT_PATH);
    } catch (error) {
      console.error('[paper-engine] failed to persist state snapshot', error);
    }
  }

  private recordTickEvent(): void {
    const macro = this.newsIntel.getMacroSignal();
    const embargoes = this.eventCalendar.getSnapshot().activeEmbargoes;
    const payload = {
      tick: this.tick,
      prices: Array.from(this.market.values()).reduce<Record<string, { price: number; spreadBps: number; status: string; regime: string }>>((acc, symbol) => {
        acc[symbol.symbol] = {
          price: round(symbol.price, 4),
          spreadBps: round(symbol.spreadBps, 2),
          status: symbol.marketStatus,
          regime: this.classifySymbolRegime(symbol)
        };
        return acc;
      }, {}),
      activeAgents: Array.from(this.agents.values()).filter((agent) => agent.status === 'in-trade').map((agent) => agent.config.id),
      signals: this.signalBus.getRecent(12),
      macro: {
        direction: macro.direction,
        confidence: macro.confidence,
        veto: macro.veto,
        reasons: macro.reasons.slice(0, 3)
      },
      embargoes,
      agents: Array.from(this.agents.values()).map((agent) => {
        const symbol = this.market.get(agent.config.symbol);
        const intel = this.marketIntel.getCompositeSignal(agent.config.symbol);
        const news = this.newsIntel.getSignal(agent.config.symbol);
        const shortReturn = symbol ? this.relativeMove(symbol.history, 4) : 0;
        const mediumReturn = symbol ? this.relativeMove(symbol.history, 8) : 0;
        const score = symbol ? this.getEntryScore(agent.config.style, shortReturn, mediumReturn, symbol) : 0;
        const safeScore = Number.isFinite(score) ? score : 0;
        const meta = symbol ? this.getMetaLabelDecision(agent, symbol, safeScore, intel) : {
          approve: false,
          probability: 0,
          reason: 'Missing market state.',
          heuristicProbability: 0,
          contextualProbability: 0,
          trainedProbability: 0,
          contextualReason: 'Missing market state.',
          trainedReason: 'Missing market state.',
          sampleCount: 0,
          support: 0,
          expectedGrossEdgeBps: 0,
          estimatedCostBps: 0,
          expectedNetEdgeBps: 0
        };
        return {
          agentId: agent.config.id,
          symbol: agent.config.symbol,
          status: agent.status,
          style: agent.config.style,
          executionMode: agent.config.executionMode,
          allocationMultiplier: round(agent.allocationMultiplier, 3),
          deploymentMode: agent.deployment.mode,
          lastAction: agent.lastAction,
          cooldownRemaining: agent.cooldownRemaining,
          realizedPnl: round(agent.realizedPnl, 2),
          trades: agent.trades,
          position: agent.position
            ? {
                entryPrice: round(agent.position.entryPrice, 4),
                quantity: round(agent.position.quantity, 6),
                entryTick: agent.position.entryTick,
                stopPrice: round(agent.position.stopPrice, 4),
                targetPrice: round(agent.position.targetPrice, 4)
              }
            : null,
          config: {
            targetBps: agent.config.targetBps,
            stopBps: agent.config.stopBps,
            maxHoldTicks: agent.config.maxHoldTicks,
            cooldownTicks: agent.config.cooldownTicks,
            sizeFraction: agent.config.sizeFraction,
            spreadLimitBps: agent.config.spreadLimitBps
          },
          marketIntel: {
            direction: intel.direction,
            confidence: intel.confidence,
            adverseSelectionRisk: intel.adverseSelectionRisk,
            quoteStabilityMs: intel.quoteStabilityMs
          },
          metaLabel: {
            score: round(safeScore, 2),
            approve: meta.approve,
            probability: meta.probability,
            heuristicProbability: meta.heuristicProbability,
            contextualProbability: meta.contextualProbability,
            trainedProbability: meta.trainedProbability,
            sampleCount: meta.sampleCount,
            support: meta.support,
            expectedGrossEdgeBps: round(meta.expectedGrossEdgeBps, 2),
            estimatedCostBps: round(meta.estimatedCostBps, 2),
            expectedNetEdgeBps: round(meta.expectedNetEdgeBps, 2),
            reason: meta.reason
          },
          news: {
            direction: news.direction,
            confidence: news.confidence,
            veto: news.veto
          },
          spreadBps: round(symbol?.spreadBps ?? 0, 2),
          regime: symbol ? this.classifySymbolRegime(symbol) : 'unknown'
        };
      })
    };
    this.recordEvent('tick', payload);
  }

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
  private computeHalfKelly(agent: AgentState): number {
    const outcomes = (agent.recentOutcomes ?? []).slice(-30);
    if (outcomes.length < 10) return 0; // not enough data, caller uses config default

    const wins = outcomes.filter((o) => o > 0);
    const losses = outcomes.filter((o) => o < 0);
    if (wins.length === 0 || losses.length === 0) return 0;

    const winRate = wins.length / outcomes.length;
    const lossRate = 1 - winRate;
    const avgWin = wins.reduce((s, v) => s + v, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length);
    if (avgLoss === 0) return 0;

    const R = avgWin / avgLoss; // reward-to-risk ratio
    const kelly = (winRate * R - lossRate) / R;

    // Half-Kelly for safety, clamped to sane bounds
    const halfKelly = kelly / 2;
    return Math.max(0.01, Math.min(0.15, halfKelly));
  }

  private countConsecutiveLosses(outcomes: number[]): number {
    let count = 0;
    for (let index = outcomes.length - 1; index >= 0; index -= 1) {
      const outcome = outcomes[index];
      if ((outcome ?? 0) < 0) {
        count += 1;
      } else {
        break;
      }
    }
    return count;
  }

  private relativeMove(history: number[], lookback: number): number {
    const end = history.at(-1);
    const start = history.at(Math.max(history.length - lookback, 0));
    if (!end || !start) return 0;
    return (end - start) / start;
  }
  private pushPoint(target: number[], value: number, limit = HISTORY_LIMIT): void {
    target.push(round(value, 2));
    if (target.length > limit) {
      target.shift();
    }
  }
}

function dedupeById<T extends { id: string }>(entries: T[]): T[] {
  const byId = new Map<string, T>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }
  return Array.from(byId.values()).sort((left, right) => {
    const leftTime = 'exitAt' in left && typeof left.exitAt === 'string' ? Date.parse(left.exitAt) : 0;
    const rightTime = 'exitAt' in right && typeof right.exitAt === 'string' ? Date.parse(right.exitAt) : 0;
    return rightTime - leftTime;
  });
}

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
