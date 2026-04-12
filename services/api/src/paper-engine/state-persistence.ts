/**
 * State Persistence
 *
 * Serialize/deserialize engine state to/from disk.
 * Handles state snapshots, ledger history, and agent config overrides.
 */

import fs from 'node:fs';
import type { AgentFillEvent, TradeJournalEntry } from '@hermes/contracts';
import type {
  AgentState, AgentConfig, SymbolState, PersistedPaperEngineState, PersistedAgentState,
  STATE_SNAPSHOT_PATH, AGENT_CONFIG_OVERRIDES_PATH, LEDGER_DIR
} from './types.js';
import { round } from '../paper-engine-utils.js';

export interface EngineStateForPersistence {
  tick: number;
  market: Map<string, SymbolState>;
  agents: Map<string, AgentState>;
  fills: AgentFillEvent[];
  journal: TradeJournalEntry[];
  deskCurve: number[];
  benchmarkCurve: number[];
}

/**
 * Serialize the engine state to a JSON file.
 */
export function persistState(
  state: EngineStateForPersistence,
  statePath: string,
  ledgerDir: string
): void {
  const persisted: PersistedPaperEngineState = {
    savedAt: new Date().toISOString(),
    tick: state.tick,
    market: Array.from(state.market.values()),
    agents: Array.from(state.agents.values()).map((agent) => ({
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
    fills: state.fills,
    journal: state.journal,
    deskCurve: state.deskCurve,
    benchmarkCurve: state.benchmarkCurve
  };

  try {
    fs.mkdirSync(ledgerDir, { recursive: true });
    const tmpPath = `${statePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(persisted), 'utf8');
    fs.renameSync(tmpPath, statePath);
  } catch (error) {
    console.error('[paper-engine] failed to persist state', error);
  }
}

/**
 * Load agent config overrides from disk.
 */
export function loadAgentConfigOverrides(overridesPath: string): Map<string, Partial<AgentConfig>> {
  const map = new Map<string, Partial<AgentConfig>>();
  try {
    if (!fs.existsSync(overridesPath)) return map;
    const raw = JSON.parse(fs.readFileSync(overridesPath, 'utf8')) as Record<string, Partial<AgentConfig>>;
    for (const [id, config] of Object.entries(raw)) {
      map.set(id, config);
    }
  } catch { /* best-effort */ }
  return map;
}

/**
 * Save agent config overrides to disk.
 */
export function persistAgentConfigOverrides(
  agents: Map<string, AgentState>,
  overridesPath: string,
  ledgerDir: string
): void {
  try {
    fs.mkdirSync(ledgerDir, { recursive: true });
    const overrides: Record<string, Partial<AgentConfig>> = {};
    for (const agent of agents.values()) {
      if (JSON.stringify(agent.config) !== JSON.stringify(agent.baselineConfig)) {
        overrides[agent.config.id] = agent.config;
      }
    }
    fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2), 'utf8');
  } catch (error) {
    console.error('[paper-engine] failed to persist config overrides', error);
  }
}
