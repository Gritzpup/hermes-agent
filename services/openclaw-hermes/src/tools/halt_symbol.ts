/**
 * Tool: halt_symbol
 * Publishes a halt signal to TOPICS.RISK_SIGNAL via @hermes/infra Redis pub/sub.
 * The risk-engine subscribes to RISK_SIGNAL and enacts per-symbol halts.
 */

import { redis } from '@hermes/infra';
import { TOPICS } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { ToolContext, ToolDef } from './index.js';

export interface HaltSymbolArgs {
  symbol: string;
  reason: string;
  severity?: 'warn' | 'critical';
}

export interface HaltSymbolResult {
  ok: boolean;
  symbol: string;
  reason: string;
  topic: string;
  publishedAt: string;
}

async function haltSymbol(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<HaltSymbolResult> {
  const symbol = String(args.symbol ?? '').toUpperCase().trim();
  const reason = String(args.reason ?? 'COO directive');
  const severity: 'warn' | 'critical' = args.severity === 'critical' ? 'critical' : 'warn';

  if (!symbol) {
    throw new Error('halt_symbol: symbol is required');
  }

  const payload = {
    type: 'halt-symbol',
    symbol,
    reason,
    severity,
    operator: 'coo-pipeline',
    tickId: ctx.tickId,
    ts: new Date().toISOString(),
  };

  await redis.publish(TOPICS.RISK_SIGNAL, JSON.stringify(payload));
  logger.warn({ symbol, reason, severity, tickId: ctx.tickId }, 'halt_symbol: published to RISK_SIGNAL');

  return {
    ok: true,
    symbol,
    reason,
    topic: TOPICS.RISK_SIGNAL,
    publishedAt: new Date().toISOString(),
  };
}

export const HALT_SYMBOL_TOOL: ToolDef = {
  name: 'halt_symbol',
  description: 'Publish a per-symbol halt signal to the RISK_SIGNAL topic. Risk-engine subscribes and enforces the halt.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Symbol to halt trading on (e.g. BTC-USD)' },
      reason: { type: 'string', description: 'Reason for the halt' },
      severity: { type: 'string', enum: ['warn', 'critical'], description: 'Severity level (default warn)', default: 'warn' },
    },
    required: ['symbol', 'reason'],
    additionalProperties: false,
  },
  fn: haltSymbol,
};
