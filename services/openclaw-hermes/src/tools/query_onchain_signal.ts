/**
 * Tool: query_onchain_signal
 * Reads hermes:onchain:{symbol} from Redis.
 * Phase 2 will populate these keys; this tool returns null when absent (no error).
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { ToolContext, ToolDef } from './index.js';

export interface OnchainSignal {
  symbol: string;
  whaleActivity: 'high' | 'medium' | 'low';
  netFlow: number;          // positive = net inflow to exchanges (bearish), negative = outflow (bullish)
  largeTxCount24h: number;
  exchangeBalancePct: number; // % of supply on exchanges
  momentum: 'accumulating' | 'distributing' | 'neutral';
  ts: string;
}

export interface QueryOnchainSignalResult {
  symbol: string;
  signal: OnchainSignal | null;
  reason: string;
}

async function queryOnchainSignal(
  _ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<QueryOnchainSignalResult> {
  const symbol = String(args.symbol ?? '').toUpperCase().trim();

  if (!symbol) {
    throw new Error('query_onchain_signal: symbol is required');
  }

  const key = `hermes:onchain:${symbol}`;
  try {
    const raw = await redis.get(key);
    if (!raw) {
      return { symbol, signal: null, reason: 'no data' };
    }
    const parsed = JSON.parse(raw) as OnchainSignal;
    return { symbol, signal: { ...parsed, symbol }, reason: 'found' };
  } catch (err) {
    logger.debug({ symbol, err: String(err) }, 'query_onchain_signal: failed to parse, treating as absent');
    return { symbol, signal: null, reason: 'parse error' };
  }
}

export const QUERY_ONCHAIN_SIGNAL_TOOL: ToolDef = {
  name: 'query_onchain_signal',
  description: 'Read on-chain signal for a symbol from Redis hermes:onchain:{symbol}. Returns null when data is absent (Phase 2 not yet populating).',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Symbol to query (e.g. BTC-USD)' },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  fn: queryOnchainSignal,
};
