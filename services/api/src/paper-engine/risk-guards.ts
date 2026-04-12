/**
 * Risk Guards Module
 *
 * Symbol-level killswitches and guard management.
 * Self-contained — owns its own state (symbol guard map + persistence).
 */

import fs from 'node:fs';
import type { SymbolGuardState } from './types.js';
import { SYMBOL_GUARD_PATH } from './types.js';

export class SymbolGuardManager {
  private guards = new Map<string, SymbolGuardState>();

  constructor() {
    this.restore();
  }

  /** Get active guard for a symbol, or null if not blocked. */
  get(symbol: string): SymbolGuardState | null {
    const state = this.guards.get(symbol);
    if (!state) return null;
    if (state.blockedUntilMs <= Date.now()) return null;
    return state;
  }

  /** Check if 3 consecutive losses should trigger a killswitch. */
  checkKillswitch(agentName: string, symbol: string, recentOutcomes: number[]): void {
    const outcomes = recentOutcomes.slice(-3);
    if (outcomes.length >= 3 && outcomes.every((o) => o < 0)) {
      const blockMs = 60 * 60 * 1000; // 1 hour
      this.guards.set(symbol, {
        symbol,
        consecutiveLosses: 3,
        blockedUntilMs: Date.now() + blockMs,
        blockReason: `Auto-killswitch: ${agentName} had 3 consecutive losses`,
        updatedAt: new Date().toISOString()
      });
      this.persist();
      console.log(`[KILLSWITCH] ${symbol} blocked for 60 min after 3 consecutive losses by ${agentName}`);
    }
  }

  /** Update a symbol guard via mutation function. */
  update(symbol: string, mutation: (state: SymbolGuardState) => SymbolGuardState): void {
    const current = this.guards.get(symbol) ?? {
      symbol,
      consecutiveLosses: 0,
      blockedUntilMs: 0,
      blockReason: '',
      updatedAt: new Date().toISOString()
    };
    const next = mutation(current);
    this.guards.set(symbol, { ...next, updatedAt: new Date().toISOString() });
    this.persist();
  }

  /** Acknowledge (clear) a circuit breaker. */
  acknowledge(symbol: string): boolean {
    if (!this.guards.has(symbol)) return false;
    this.guards.delete(symbol);
    this.persist();
    return true;
  }

  /** Get all active guards. */
  getAll(): SymbolGuardState[] {
    const now = Date.now();
    return Array.from(this.guards.values()).filter((g) => g.blockedUntilMs > now);
  }

  private restore(): void {
    try {
      if (!fs.existsSync(SYMBOL_GUARD_PATH)) return;
      const raw = fs.readFileSync(SYMBOL_GUARD_PATH, 'utf8');
      const parsed = JSON.parse(raw) as SymbolGuardState[];
      if (!Array.isArray(parsed)) return;
      this.guards.clear();
      for (const item of parsed) {
        if (!item?.symbol || !Number.isFinite(item.blockedUntilMs)) continue;
        this.guards.set(item.symbol, item);
      }
    } catch {
      // best-effort
    }
  }

  private persist(): void {
    try {
      fs.promises.writeFile(
        SYMBOL_GUARD_PATH,
        JSON.stringify(Array.from(this.guards.values()), null, 2),
        'utf8'
      ).catch(() => {});
    } catch {
      // best-effort
    }
  }
}
