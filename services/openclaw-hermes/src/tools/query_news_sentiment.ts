/**
 * Tool: query_news_sentiment
 * Reads hermes:sentiment:{symbol} from Redis.
 * Phase 2 will populate these keys; this tool returns null when absent (no error).
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { ToolContext, ToolDef } from './index.js';

export interface NewsSentiment {
  symbol: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  score: number;        // -1 to 1
  sources: string[];
  headline?: string;
  ts: string;
}

export interface QueryNewsSentimentResult {
  symbol: string;
  sentiment: NewsSentiment | null;
  reason: string;
}

async function queryNewsSentiment(
  _ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<QueryNewsSentimentResult> {
  const symbol = String(args.symbol ?? '').toUpperCase().trim();

  if (!symbol) {
    throw new Error('query_news_sentiment: symbol is required');
  }

  const key = `hermes:sentiment:${symbol}`;
  try {
    const raw = await redis.get(key);
    if (!raw) {
      return { symbol, sentiment: null, reason: 'no data' };
    }
    const parsed = JSON.parse(raw) as NewsSentiment;
    return { symbol, sentiment: { ...parsed, symbol }, reason: 'found' };
  } catch (err) {
    logger.debug({ symbol, err: String(err) }, 'query_news_sentiment: failed to parse, treating as absent');
    return { symbol, sentiment: null, reason: 'parse error' };
  }
}

export const QUERY_NEWS_SENTIMENT_TOOL: ToolDef = {
  name: 'query_news_sentiment',
  description: 'Read news sentiment for a symbol from Redis hermes:sentiment:{symbol}. Returns null when data is absent (Phase 2 not yet populating).',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Symbol to query (e.g. BTC-USD)' },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  fn: queryNewsSentiment,
};
