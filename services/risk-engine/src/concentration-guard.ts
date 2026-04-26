/**
 * ConcentrationGuard — per-symbol notional concentration cap.
 *
 * share = abs(symbol_notional) / sum(abs(all_symbol_notionals))
 *
 * Thresholds (configurable via env):
 *   > CONCENTRATION_HALT_PCT    (default 50%) → halt symbol
 *   > CONCENTRATION_THROTTLE_PCT (default 35%) → throttle (block entries that would increase share)
 *   ≤ CONCENTRATION_THROTTLE_PCT             → allow
 *
 * Reads live exposure from Redis at hermes:positions:* keys via @hermes/infra redis client.
 */

import { redis } from '@hermes/infra';

export const CONCENTRATION_HALT_PCT = Number(process.env.CONCENTRATION_HALT_PCT ?? 50);
export const CONCENTRATION_THROTTLE_PCT = Number(process.env.CONCENTRATION_THROTTLE_PCT ?? 35);

export type ConcentrationAction = 'allow' | 'throttle' | 'halt';

export interface ConcentrationResult {
  /** action taken */
  action: ConcentrationAction;
  /** new share after proposed entry (0–100 %) */
  share: number;
  reason: string;
  /** current share before proposed entry */
  symbolShare: number;
  totalNotional: number;
}

export interface PositionEntry {
  symbol: string;
  notional: number;
}

/**
 * Fetch all hermes:positions:* keys from Redis and return entries as
 * { symbol, notional }[].  Keys not matching the expected schema are skipped.
 */
export async function fetchPositions(
  client: { keys(pattern: string): Promise<string[]>; mget(...keys: string[]): Promise<(string | null)[]> }
): Promise<PositionEntry[]> {
  const keys = await client.keys('hermes:positions:*');
  if (keys.length === 0) return [];

  const values = await client.mget(...keys);

  const entries: PositionEntry[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const raw = values[i]!;
    if (!key || !raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const notional = typeof parsed === 'number' ? parsed : (parsed?.notional ?? 0);
      if (typeof notional === 'number' && Number.isFinite(notional)) {
        const symbol = key.replace(/^hermes:positions:/, '');
        entries.push({ symbol, notional });
      }
    } catch {
      const notional = Number(raw);
      if (Number.isFinite(notional)) {
        const symbol = key.replace(/^hermes:positions:/, '');
        entries.push({ symbol, notional });
      }
    }
  }
  return entries;
}

export class ConcentrationGuard {
  /**
   * Evaluate whether placing a new order for `symbol` with `proposedNotional`
   * would breach concentration limits.
   *
   * Logic:
   *   halt    : newShare > HALT_PCT    (>50% of total after proposed entry)
   *   throttle: newShare > THROTTLE_PCT (>35% of total after proposed entry)
   *   allow  : newShare ≤ THROTTLE_PCT
   *
   * share = abs(symbol_notional) / sum(abs(all_symbol_notionals)) * 100
   */
  async evaluate(symbol: string, proposedNotional: number): Promise<ConcentrationResult> {
    const entries = await fetchPositions(redis);

    const totalNotional = entries.reduce((sum, e) => sum + Math.abs(e.notional), 0);

    // Current notional for this symbol (0 if not present in positions)
    const currentNotional =
      entries.find((e) => e.symbol === symbol)?.notional ?? 0;

    const symbolAbs = Math.abs(currentNotional);
    const proposedAbs = Math.abs(proposedNotional);
    const newTotal = totalNotional + proposedAbs;

    // Current share (before proposed entry) and new share (after)
    const symbolShare = totalNotional > 0 ? (symbolAbs / totalNotional) * 100 : 0;
    const newShare =
      newTotal > 0 ? ((symbolAbs + proposedAbs) / newTotal) * 100 : 0;

    // Halt: current share strictly > HALT_PCT
    // (don't halt first-time positions; those are caught by throttle if needed)
    if (symbolAbs > 0 && symbolShare > CONCENTRATION_HALT_PCT) {
      return {
        action: 'halt',
        share: round2(newShare),
        reason: `concentration-halt: ${symbol} at ${round2(symbolShare)}% current share (>${CONCENTRATION_HALT_PCT}%)`,
        symbolShare: round2(symbolShare),
        totalNotional: round2(totalNotional),
      };
    }

    // Throttle: new share strictly > THROTTLE_PCT
    if (newShare > CONCENTRATION_THROTTLE_PCT) {
      return {
        action: 'throttle',
        share: round2(newShare),
        reason: `concentration-throttle: ${symbol} would be at ${round2(newShare)}% (>${CONCENTRATION_THROTTLE_PCT}%)`,
        symbolShare: round2(symbolShare),
        totalNotional: round2(totalNotional),
      };
    }

    return {
      action: 'allow',
      share: round2(newShare),
      reason: `concentration-ok: ${symbol} at ${round2(symbolShare)}% + ${round2(proposedAbs)} → ${round2(newShare)}% (≤${CONCENTRATION_THROTTLE_PCT}%)`,
      symbolShare: round2(symbolShare),
      totalNotional: round2(totalNotional),
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
