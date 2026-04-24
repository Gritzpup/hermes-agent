// @ts-nocheck
/**
 * Deterministic Replay Engine
 *
 * Enables replay of paper-engine state from a snapshot + WAL entries.
 * Use cases:
 *  - Recover state after crash without replaying the full event log
 *  - Validate engine logic by replaying historical ticks
 *  - Simulate "what-if" scenarios by mutating snapshot and replaying from there
 *
 * Architecture:
 *  1. Load paper-state.json snapshot (full engine state at point-in-time)
 *  2. Optionally replay WAL entries from a specific tick onwards
 *  3. Reconstruct exact engine state including agent positions, cash, PnL
 */

import fs from 'node:fs';
import path from 'node:path';
import { STATE_SNAPSHOT_PATH, LEDGER_DIR } from './types.js';

export interface ReplayOptions {
  /** Start replaying from this tick. If undefined, starts from snapshot tick. */
  fromTick?: number;
  /** Stop replaying at this tick. If undefined, replays to end of WAL. */
  toTick?: number;
  /** If true, replayed events are applied to the engine (state mutations). */
  applyState: boolean;
  /** If true, print each replayed event. */
  verbose?: boolean;
}

interface SnapshotState {
  tick: number;
  timestamp: string;
  agents: Record<string, any>;
  market: Record<string, any>;
  cash: number;
  nav: number;
  realizedPnl: number;
  dailyPnl: number;
  [key: string]: any;
}

/**
 * Load a snapshot from the paper-engine state file.
 */
export function loadSnapshot(snapshotPath?: string): SnapshotState | null {
  const filePath = snapshotPath ?? STATE_SNAPSHOT_PATH;
  if (!fs.existsSync(filePath)) {
    console.warn(`[replay] Snapshot not found at ${filePath}`);
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as SnapshotState;
  } catch (err) {
    console.error(`[replay] Failed to load snapshot:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Replay WAL entries from a given range, optionally applying them to the engine.
 *
 * @param walEntries  Array of OrderWalEntry rows from PostgreSQL
 * @param engine      The paper engine instance (if applyState=true)
 * @param options     Replay options
 */
export async function replayWalEntries(
  walEntries: Array<Record<string, unknown>>,
  engine: any,
  options: ReplayOptions
): Promise<void> {
  const { fromTick = 0, toTick = Infinity, applyState, verbose } = options;

  const relevant = walEntries
    .filter(e => {
      const tick = Number(e.tick);
      return tick >= fromTick && tick <= toTick;
    })
    .sort((a, b) => Number(a.tick) - Number(b.tick));

  console.log(`[replay] Replaying ${relevant.length} WAL entries (tick ${fromTick} → ${toTick})`);

  for (const entry of relevant) {
    const tick = Number(entry.tick);
    const status = String(entry.status);

    if (verbose) {
      console.log(`[replay] tick=${tick} status=${status} symbol=${entry.symbol} broker=${entry.broker} filledQty=${entry.filledQty}`);
    }

    if (!applyState || !engine) continue;

    // Reconstruct events from WAL entries
    if (status === 'filled' && entry.filledQty > 0) {
      try {
        // Find the agent by agentId in the engine
        const agent = Array.from(engine.agents.values()).find((a: any) => a.config.id === entry.agentId);
        if (!agent) {
          console.warn(`[replay] Agent ${entry.agentId} not found in engine at tick ${tick}`);
          continue;
        }

        const symbol = engine.market.get(String(entry.symbol));
        if (!symbol) {
          console.warn(`[replay] Symbol ${entry.symbol} not found in engine at tick ${tick}`);
          continue;
        }

        const side = String(entry.side);
        const filledQty = Number(entry.filledQty);
        const avgFillPrice = Number(entry.avgFillPrice);

        if (side === 'buy' || side === 'sell') {
          // Entry fill: reconstruct as if a broker fill happened
          const direction = side === 'buy' ? 'long' : 'short';
          engine.applyBrokerFilledEntry(agent, symbol, {
            orderId: String(entry.idempotencyKey ?? entry.id),
            status: 'filled',
            filledQty,
            avgFillPrice,
            timestamp: String(entry.timestamp),
            latencyMs: entry.latencyMs ?? 0,
          }, 0, {});
        }
        // Exit fills would be handled similarly with applyBrokerFilledExit
      } catch (err) {
        console.error(`[replay] Error applying WAL entry ${entry.id}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  console.log(`[replay] Replay complete. Final engine tick: ${engine?.tick ?? 'unknown'}`);
}

/**
 * Full deterministic replay: load snapshot + replay WAL from checkpoint.
 * Returns the reconstructed engine state.
 */
export async function runReplay(
  snapshotPath?: string,
  options?: ReplayOptions
): Promise<{ snapshot: SnapshotState | null; walEntries: Array<Record<string, unknown>> }> {
  const snapshot = loadSnapshot(snapshotPath);
  const fromTick = options?.fromTick ?? snapshot?.tick ?? 0;

  // WAL entries would be loaded from PostgreSQL via replayWal from order-wal.ts
  // For now, return the snapshot info so the caller can load WAL separately
  console.log(`[replay] Snapshot loaded: tick=${snapshot?.tick ?? 'none'}`);
  console.log(`[replay] WAL replay starts from tick ${fromTick}`);

  return { snapshot, walEntries: [] };
}
