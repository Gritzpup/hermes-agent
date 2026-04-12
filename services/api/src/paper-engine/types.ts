import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AiCouncilDecision,
  AgentFillEvent,
  AgentStatus,
  AssetClass,
  BrokerId,
  MarketSession,
  MarketSnapshot,
  OrderSide,
  OrderStatus,
  StrategyMode,
  TradeJournalEntry
} from '@hermes/contracts';

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

export type AgentStyle = 'momentum' | 'mean-reversion' | 'breakout' | 'arbitrage';
export type AgentExecutionMode = 'broker-paper' | 'watch-only';
export type PositionDirection = 'long' | 'short';
export type SessionBucket = 'asia' | 'europe' | 'us' | 'off';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SymbolState {
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

export interface PositionEntryMetaState {
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

export interface PerformanceSummary {
  sampleCount: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
}

export interface ScalpRouteState {
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

export interface PositionState {
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

export interface AgentConfig {
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

export interface AgentDeploymentState {
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

export interface AgentState {
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

export interface MistakeLearningProfile {
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

export interface PaperEngineStateSnapshot {
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

export interface PersistedAgentState {
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

export interface PersistedPaperEngineState {
  savedAt: string;
  tick: number;
  market: SymbolState[];
  agents: PersistedAgentState[];
  fills: AgentFillEvent[];
  journal: TradeJournalEntry[];
  deskCurve: number[];
  benchmarkCurve: number[];
}

export interface PersistedMarketDataState {
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

export interface BrokerRouteResponse {
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

export interface BrokerAccountPosition {
  broker: BrokerId;
  symbol: string;
  quantity: number;
  avgEntry: number;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

export interface BrokerAccountSnapshot {
  broker: BrokerId;
  status: string;
  asOf: string;
  account?: Record<string, unknown>;
  positions: BrokerAccountPosition[];
  fills?: unknown[];
  orders?: unknown[];
}

export interface BrokerAccountResponse {
  asOf: string;
  brokers: BrokerAccountSnapshot[];
}

export interface BrokerPaperAccountState {
  asOf: string;
  status: string;
  cash: number;
  equity: number;
  dayBaseline: number;
  buyingPower: number;
}

export interface SymbolGuardState {
  symbol: string;
  consecutiveLosses: number;
  blockedUntilMs: number;
  blockReason: string;
  updatedAt: string;
}

export interface ExecutionQualityCounters {
  attempts: number;
  rejects: number;
  partialFills: number;
}

export interface WeeklyReportState {
  asOf: string;
  path: string;
  summary: string;
}

export interface RegimeKpiRow {
  symbol: string;
  regime: string;
  trades: number;
  winRatePct: number;
  expectancy: number;
  profitFactor: number;
  throttleMultiplier: number;
}

export interface SloStatusState {
  dataFreshnessP95Ms: number;
  orderAckP95Ms: number;
  brokerErrorRatePct: number;
  breaches: string[];
}

export interface WalkForwardResult {
  agentId: string;
  symbol: string;
  passed: boolean;
  outSampleTrades: number;
  candidateExpectancy: number;
  championExpectancy: number;
  note: string;
  asOf: string;
}

export interface TradeForensicsRow {
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HISTORY_LIMIT = 48;
export const OUTCOME_HISTORY_LIMIT = 200; // Larger window for Half-Kelly and performance analysis
export const FILL_LIMIT = 50;
export const JOURNAL_LIMIT = 24;
export const TICK_MS = 3_000;
export const STARTING_EQUITY = Number(process.env.HERMES_STARTING_EQUITY ?? 100_000);
export const EQUITY_FEE_BPS = 0.5;
export const CRYPTO_FEE_BPS = 5.0;
export const PAPER_BROKER: BrokerId = 'alpaca-paper';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const LEDGER_DIR = process.env.PAPER_LEDGER_DIR ?? path.resolve(MODULE_DIR, '../../.runtime/paper-ledger');
export const MARKET_DATA_RUNTIME_PATH =
  process.env.MARKET_DATA_RUNTIME_PATH ?? path.resolve(MODULE_DIR, '../../../.runtime/market-data.json');
export const BROKER_ROUTER_URL = process.env.BROKER_ROUTER_URL ?? 'http://127.0.0.1:4303';
export const FILL_LEDGER_PATH = path.join(LEDGER_DIR, 'fills.jsonl');
export const JOURNAL_LEDGER_PATH = path.join(LEDGER_DIR, 'journal.jsonl');
export const STATE_SNAPSHOT_PATH = path.join(LEDGER_DIR, 'paper-state.json');
export const AGENT_CONFIG_OVERRIDES_PATH = path.join(LEDGER_DIR, 'agent-config-overrides.json');
export const EVENT_LOG_PATH = path.join(LEDGER_DIR, 'events.jsonl');
export const SYMBOL_GUARD_PATH = path.join(LEDGER_DIR, 'symbol-guards.json');
export const WEEKLY_REPORT_DIR = path.join(LEDGER_DIR, 'weekly-reports');
export const DAILY_CIRCUIT_BREAKER_DD_PCT = Number(process.env.DAILY_CIRCUIT_BREAKER_DD_PCT ?? 3.2);
export const WEEKLY_CIRCUIT_BREAKER_DD_PCT = Number(process.env.WEEKLY_CIRCUIT_BREAKER_DD_PCT ?? 6.5);
// Fix #8: Tightened crypto gating per Codex -- fewer marginal entries = higher win rate
export const CRYPTO_MAX_ENTRY_SPREAD_BPS = Number(process.env.CRYPTO_MAX_ENTRY_SPREAD_BPS ?? 2.2);
export const CRYPTO_MAX_EST_SLIPPAGE_BPS = Number(process.env.CRYPTO_MAX_EST_SLIPPAGE_BPS ?? 1.6);
export const CRYPTO_MIN_BOOK_DEPTH_NOTIONAL = Number(process.env.CRYPTO_MIN_BOOK_DEPTH_NOTIONAL ?? 120_000);
export const DATA_FRESHNESS_SLO_MS = Number(process.env.DATA_FRESHNESS_SLO_MS ?? 7_500);
export const ORDER_ACK_SLO_MS = Number(process.env.ORDER_ACK_SLO_MS ?? 2_500);
export const BROKER_ERROR_SLO_PCT = Number(process.env.BROKER_ERROR_SLO_PCT ?? 5.0);
export const BROKER_SYNC_MS = Number(process.env.PAPER_BROKER_SYNC_MS ?? 5_000);
export const REAL_PAPER_AUTOPILOT = (process.env.REAL_PAPER_AUTOPILOT ?? 'true').toLowerCase() === 'true';
export const COINBASE_LIVE_ROUTING_ENABLED = (process.env.COINBASE_LIVE_ROUTING_ENABLED ?? '0') === '1';
export const HERMES_BROKER_ORDER_PREFIX = 'paper-agent-';
