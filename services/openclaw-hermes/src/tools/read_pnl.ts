/**
 * Tool: read_pnl
 * Returns realized + unrealized PnL from Redis hermes:pnl:* keys.
 * If no keys are present, computes from positions + fills heuristically.
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { ToolContext, ToolDef } from './index.js';

export interface PnLBreakdown {
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  bySymbol: Record<string, { realized: number; unrealized: number; count: number }>;
  byStrategy: Record<string, { realized: number; unrealized: number; count: number }>;
}

export interface ReadPnlResult {
  pnl: PnLBreakdown;
  source: 'redis' | 'computed';
  ts: string;
}

async function readPnl(
  _ctx: ToolContext,
  _args: Record<string, unknown>,
): Promise<ReadPnlResult> {
  // Try Redis keys first
  try {
    const pnlKey = 'hermes:pnl:current';
    const raw = await redis.get(pnlKey);
    if (raw) {
      const parsed = JSON.parse(raw) as PnLBreakdown;
      return { pnl: parsed, source: 'redis', ts: new Date().toISOString() };
    }

    // Try per-symbol PnL keys
    const bySymbol: PnLBreakdown['bySymbol'] = {};
    const byStrategy: PnLBreakdown['byStrategy'] = {};
    let totalRealized = 0;
    let totalUnrealized = 0;

    const stream = redis.scanStream({ match: 'hermes:pnl:*', count: 100 });
    for await (const keys of stream) {
      for (const key of keys) {
        if (key === pnlKey) continue;
        try {
          const data = await redis.get(key);
          if (!data) continue;
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const sym = String(parsed.symbol ?? key.split(':').pop() ?? 'unknown');
          const realized = Number(parsed.realizedPnl ?? 0);
          const unrealized = Number(parsed.unrealizedPnl ?? 0);
          const count = Number(parsed.tradeCount ?? 1);

          if (!bySymbol[sym]) bySymbol[sym] = { realized: 0, unrealized: 0, count: 0 };
          bySymbol[sym]!.realized += realized;
          bySymbol[sym]!.unrealized += unrealized;
          bySymbol[sym]!.count += count;

          const strat = String(parsed.strategyId ?? 'unknown');
          if (!byStrategy[strat]) byStrategy[strat] = { realized: 0, unrealized: 0, count: 0 };
          byStrategy[strat]!.realized += realized;
          byStrategy[strat]!.unrealized += unrealized;
          byStrategy[strat]!.count += count;

          totalRealized += realized;
          totalUnrealized += unrealized;
        } catch { /* skip corrupt key */ }
      }
    }

    if (Object.keys(bySymbol).length > 0) {
      return {
        pnl: { realizedPnl: totalRealized, unrealizedPnl: totalUnrealized, totalPnl: totalRealized + totalUnrealized, bySymbol, byStrategy },
        source: 'redis',
        ts: new Date().toISOString(),
      };
    }
  } catch (err) {
    logger.debug({ err: String(err) }, 'read_pnl: Redis read failed, falling back to computed');
  }

  // Fallback: compute from positions
  let totalUnrealized = 0;
  const bySymbol: PnLBreakdown['bySymbol'] = {};
  const byStrategy: PnLBreakdown['byStrategy'] = {};

  try {
    const stream = redis.scanStream({ match: 'hermes:positions:*', count: 100 });
    for await (const keys of stream) {
      for (const key of keys) {
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          const pos = JSON.parse(raw) as Record<string, unknown>;
          const unrealized = Number(pos.unrealizedPnl ?? 0);
          totalUnrealized += unrealized;

          const sym = String(pos.symbol ?? key.replace('hermes:positions:', ''));
          if (!bySymbol[sym]) bySymbol[sym] = { realized: 0, unrealized: 0, count: 0 };
          bySymbol[sym]!.unrealized += unrealized;

          const strat = String(pos.strategyId ?? 'unknown');
          if (!byStrategy[strat]) byStrategy[strat] = { realized: 0, unrealized: 0, count: 0 };
          byStrategy[strat]!.unrealized += unrealized;
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'read_pnl: positions fallback failed');
  }

  return {
    pnl: {
      realizedPnl: 0,
      unrealizedPnl: totalUnrealized,
      totalPnl: totalUnrealized,
      bySymbol,
      byStrategy,
    },
    source: 'computed',
    ts: new Date().toISOString(),
  };
}

export const READ_PNL_TOOL: ToolDef = {
  name: 'read_pnl',
  description: 'Returns realized + unrealized PnL. Tries hermes:pnl:* keys in Redis first; falls back to computing from hermes:positions:* keys.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  fn: readPnl,
};
