/**
 * Tool: read_positions
 * Returns all open positions from Redis hermes:positions:*
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { ToolContext, ToolDef } from './index.js';

export interface Position {
  symbol: string;
  qty: number;
  side: 'long' | 'short';
  entryPx: number;
  unrealizedPnl: number;
  strategyId?: string;
  broker?: string;
  openedAt: string;
}

export interface ReadPositionsResult {
  positions: Position[];
  count: number;
  ts: string;
}

async function readPositions(
  _ctx: ToolContext,
  _args: Record<string, unknown>,
): Promise<ReadPositionsResult> {
  const positions: Position[] = [];

  try {
    // Scan for all hermes:positions:* keys
    const stream = redis.scanStream({
      match: 'hermes:positions:*',
      count: 100,
    });

    for await (const keys of stream) {
      for (const key of keys) {
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const symKey = key.replace('hermes:positions:', '');
          const pos: Position = {
            symbol: String(parsed.symbol ?? symKey),
            qty: Number(parsed.qty ?? 0),
            side: (parsed.side as 'long' | 'short') ?? 'long',
            entryPx: Number(parsed.entryPx ?? 0),
            unrealizedPnl: Number(parsed.unrealizedPnl ?? 0),
            openedAt: String(parsed.openedAt ?? new Date().toISOString()),
          };
          if (parsed.strategyId) (pos as { strategyId?: string }).strategyId = String(parsed.strategyId);
          if (parsed.broker) (pos as { broker?: string }).broker = String(parsed.broker);
          positions.push(pos);
        } catch (err) {
          logger.debug({ key, err: String(err) }, 'read_positions: failed to parse key');
        }
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'read_positions: scan failed, returning empty');
  }

  return {
    positions,
    count: positions.length,
    ts: new Date().toISOString(),
  };
}

export const READ_POSITIONS_TOOL: ToolDef = {
  name: 'read_positions',
  description: 'Read all open positions from Redis. Returns symbol, qty, side, entryPx, unrealizedPnl, strategyId, broker, openedAt for each position.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  fn: readPositions,
};
