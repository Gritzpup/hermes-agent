/**
 * Tool: query_fundamentals
 * Reads hermes:fundamentals:{symbol} from Redis.
 * Returns null when absent.
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { ToolContext, ToolDef } from './index.js';

export interface Fundamentals {
  symbol: string;
  marketCap?: number;
  volume24h?: number;
  peRatio?: number;
  priceToBook?: number;
  dividendYield?: number;
  beta?: number;
  eps?: number;
  revenue?: number;
  netIncome?: number;
  [key: string]: unknown;
}

export interface QueryFundamentalsResult {
  symbol: string;
  fundamentals: Fundamentals | null;
  reason: string;
}

async function queryFundamentals(
  _ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<QueryFundamentalsResult> {
  const symbol = String(args.symbol ?? '').toUpperCase().trim();

  if (!symbol) {
    throw new Error('query_fundamentals: symbol is required');
  }

  const key = `hermes:fundamentals:${symbol}`;
  try {
    const raw = await redis.get(key);
    if (!raw) {
      return { symbol, fundamentals: null, reason: 'no data' };
    }
    const parsed = JSON.parse(raw) as Fundamentals;
    return { symbol, fundamentals: { ...parsed, symbol }, reason: 'found' };
  } catch (err) {
    logger.debug({ symbol, err: String(err) }, 'query_fundamentals: failed to parse, treating as absent');
    return { symbol, fundamentals: null, reason: 'parse error' };
  }
}

export const QUERY_FUNDAMENTALS_TOOL: ToolDef = {
  name: 'query_fundamentals',
  description: 'Read fundamental data for a symbol from Redis hermes:fundamentals:{symbol}. Returns null when absent.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Symbol to query (e.g. BTC-USD)' },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  fn: queryFundamentals,
};
