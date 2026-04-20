// Register the 4 grid engines (btc/eth/sol/xrp) as watch-only agents in the
// paper-engine's agent Map. This unblocks /api/paper-desk, VenueMatrixSection,
// strategy-director, and every other consumer of `engine.agents.values()` from
// seeing grid activity — previously the grids wrote directly to journal.jsonl
// but never appeared as agents, so UI matrices + allocation decisions were
// missing ~90% of the firm's actual trading volume.
//
// Safety: executionMode='watch-only' + autonomyEnabled=false is the standard
// flag-pair that makes all trading-execution code-paths skip the agent. These
// synthetic agents will NOT enter/exit positions; the real grid engines do that
// via their own code. We only surface their journal-derived stats as agent data.

import { readJsonLines } from '../lib/persistence-helpers.js';
import { JOURNAL_LEDGER_PATH, STARTING_EQUITY } from './types.js';
import type { AgentState, AgentConfig, BrokerId, TradeJournalEntry } from './types.js';
import { round } from '../paper-engine-utils.js';

export interface GridSyntheticSpec {
  id: string;           // must match journal.strategyId, e.g. 'grid-xrp-usd'
  name: string;         // human label, e.g. 'XRP Grid (Coinbase)'
  symbol: string;       // 'XRP-USD'
  broker: BrokerId;     // 'coinbase-live'
}

function buildConfig(spec: GridSyntheticSpec): AgentConfig {
  return {
    id: spec.id,
    name: spec.name,
    symbol: spec.symbol,
    broker: spec.broker,
    style: 'breakout',                  // grids profit on range-bound price oscillation
    executionMode: 'watch-only',        // CRITICAL: prevents tick loop from trying to trade here
    autonomyEnabled: false,             // double-guard — also prevents autonomous entries
    focus: 'grid range-oscillation',
    targetBps: 15,                      // informational only (real grid has its own spacing)
    stopBps: 500,
    maxHoldTicks: 0,
    cooldownTicks: 0,
    sizeFraction: 0,                    // 0 sizing = any trade attempt is a noop
    spreadLimitBps: 200,
  };
}

function buildState(engine: any, spec: GridSyntheticSpec, journalRows: TradeJournalEntry[]): AgentState {
  const config = buildConfig(spec);
  const mine = journalRows.filter((e) => e.strategyId === spec.id);
  const wins = mine.filter((e) => e.realizedPnl > 0).length;
  const losses = mine.filter((e) => e.realizedPnl < 0).length;
  const realizedPnl = round(mine.reduce((s, e) => s + e.realizedPnl, 0), 2);
  const lastPnl = mine.length > 0 ? mine[mine.length - 1]!.realizedPnl : 0;
  const allocation = STARTING_EQUITY / 24;   // rough per-agent share, not used for grid sizing

  return {
    config,
    baselineConfig: config,
    evaluationWindow: 'live-market',
    startingEquity: allocation,
    cash: allocation,
    realizedPnl,
    feesPaid: 0,
    wins,
    losses,
    trades: mine.length,
    status: 'watching',
    cooldownRemaining: 0,
    position: null,
    pendingOrderId: null,
    pendingSide: null,
    lastBrokerSyncAt: null,
    lastAction: 'Grid engine active (synthetic registration).',
    lastSymbol: spec.symbol,
    lastExitPnl: round(lastPnl, 2),
    recentOutcomes: mine.slice(-30).map((e) => e.realizedPnl),
    recentHoldTicks: [],
    baselineExpectancy: 0,
    lastAdjustment: 'Managed by GridEngine — not by paper-engine tick.',
    improvementBias: 'hold-steady',
    allocationMultiplier: 1,
    allocationScore: 1,
    allocationReason: 'Grid engine — concurrent strategy, not tuned by lane learning.',
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
      lastDecision: 'Synthetic grid agent; no deployment decisions apply.',
    },
    curve: [allocation],
  };
}

/**
 * Call once after paperEngine is constructed and grids are instantiated. Idempotent —
 * re-registration refreshes the journal-derived counters.
 */
export function registerSyntheticGridAgents(engine: any, specs: GridSyntheticSpec[]): void {
  const journalRows = engine.journal && engine.journal.length > 0
    ? (engine.journal as TradeJournalEntry[])
    : readJsonLines<TradeJournalEntry>(JOURNAL_LEDGER_PATH);

  for (const spec of specs) {
    const state = buildState(engine, spec, journalRows);
    engine.agents.set(spec.id, state);
    console.log(`[grid-synthetic] registered ${spec.id}: ${state.trades} trades, $${state.realizedPnl} pnl`);
  }
}
