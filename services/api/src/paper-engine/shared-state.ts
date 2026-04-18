/**
 * Shared Engine State
 *
 * Centralized mutable state shared across all sub-engines.
 * This is the single source of truth — sub-engines read and write to this.
 */

import type { AgentFillEvent, TradeJournalEntry, BrokerId } from '@hermes/contracts';
import type {
  AgentState, SymbolState, ScalpRouteState, BrokerPaperAccountState,
  WeeklyReportState, RegimeKpiRow, SloStatusState, WalkForwardResult,
  TradeForensicsRow, ExecutionQualityCounters, SymbolGuardState,
  HISTORY_LIMIT, OUTCOME_HISTORY_LIMIT
} from './types.js';

export class SharedState {
  tick = 0;
  market = new Map<string, SymbolState>();
  agents = new Map<string, AgentState>();
  fills: AgentFillEvent[] = [];
  journal: TradeJournalEntry[] = [];
  deskCurve: number[] = [];
  benchmarkCurve: number[] = [];

  // Broker account snapshots
  brokerPaperAccount: BrokerPaperAccountState | null = null;
  brokerOandaAccount: BrokerPaperAccountState | null = null;
  brokerCoinbaseAccount: BrokerPaperAccountState | null = null;

  // Scalp route planning
  scalpRouteCandidates = new Map<string, ScalpRouteState>();
  selectedScalpOverallId: string | null = null;
  selectedScalpByAssetClass = new Map<string, string>();

  // Risk controls
  symbolGuards = new Map<string, SymbolGuardState>();
  // COO: Track engine startup time for circuit breaker warmup grace period
  startedAt = new Date().toISOString();

  circuitBreakerLatched = false;
  circuitBreakerScope: 'none' | 'daily' | 'weekly' = 'none';
  circuitBreakerReason = '';
  circuitBreakerArmedAt: string | null = null;
  circuitBreakerReviewed = false;
  operationalKillSwitchUntilMs = 0;

  // Performance tracking
  regimeKpis: RegimeKpiRow[] = [];
  latestSlo: SloStatusState = { dataFreshnessP95Ms: 0, orderAckP95Ms: 0, brokerErrorRatePct: 0, breaches: [] };
  walkForwardResults = new Map<string, WalkForwardResult>();
  forensicRows: TradeForensicsRow[] = [];
  executionQuality = new Map<BrokerId, ExecutionQualityCounters>();
  latestWeeklyReport: WeeklyReportState | null = null;

  // Market data sources
  marketDataSources: Array<{ venue: BrokerId; symbols: string[]; status: string; detail: string; updatedAt: string }> = [];

  // Replay / strategy state
  strategyReplayTick = 0;
  stepInFlight = false;

  // File write queue
  fileQueues = new Map<string, Promise<void>>();
}
