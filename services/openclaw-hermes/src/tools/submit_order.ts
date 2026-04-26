/**
 * Tool: submit_order
 * POST to existing hermes-api at http://127.0.0.1:4300/api/coo/submit-order.
 * Uses the same fetch patterns as openclaw-client.ts.
 */

import { HERMES_API } from '../config.js';
import { logger } from '@hermes/logger';
import type { ToolContext, ToolDef } from './index.js';

export interface SubmitOrderArgs {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  type?: 'market' | 'limit' | 'stop';
  limitPx?: number;
  strategyId?: string;
  reason?: string;
}

export interface SubmitOrderResult {
  ok: boolean;
  orderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  type: string;
  submittedAt: string;
  error?: string;
}

async function submitOrder(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<SubmitOrderResult> {
  const symbol = String(args.symbol ?? '').toUpperCase().trim();
  const side: 'buy' | 'sell' = args.side === 'sell' ? 'sell' : 'buy';
  const qty = Number(args.qty ?? 0);
  const type: 'market' | 'limit' | 'stop' =
    args.type === 'limit' || args.type === 'stop' ? args.type as 'limit' | 'stop' : 'market';
  const limitPx = typeof args.limitPx === 'number' ? args.limitPx : undefined;
  const strategyId = typeof args.strategyId === 'string' ? args.strategyId : undefined;
  const reason = typeof args.reason === 'string' ? args.reason : `COO pipeline tool submit_order`;

  if (!symbol || !qty) {
    throw new Error('submit_order: symbol and qty are required');
  }

  const body: Record<string, unknown> = {
    symbol,
    side,
    qty,
    type,
    operator: 'coo-pipeline',
    tickId: ctx.tickId,
    reason,
  };
  if (limitPx !== undefined) body.limitPx = limitPx;
  if (strategyId) body.strategyId = strategyId;

  try {
    const res = await fetch(`${HERMES_API}/api/coo/submit-order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.warn({ status: res.status, symbol, side, qty }, 'submit_order: non-ok response');
      return {
        ok: false,
        symbol,
        side,
        qty,
        type,
        submittedAt: new Date().toISOString(),
        error: `HTTP ${res.status}: ${errText.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as Record<string, unknown>;
    const result: SubmitOrderResult = {
      ok: true,
      symbol,
      side,
      qty,
      type,
      submittedAt: new Date().toISOString(),
    };
    if (data.orderId) (result as { orderId?: string }).orderId = String(data.orderId);
    return result;
  } catch (err) {
    const errStr = String(err);
    logger.error({ err: errStr, symbol, side, qty }, 'submit_order: fetch failed');
    return {
      ok: false,
      symbol,
      side,
      qty,
      type,
      submittedAt: new Date().toISOString(),
      error: errStr,
    };
  }
}

export const SUBMIT_ORDER_TOOL: ToolDef = {
  name: 'submit_order',
  description: 'Submit a trade order to hermes-api via /api/coo/submit-order. Returns orderId on success.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Symbol to trade (e.g. BTC-USD)' },
      side: { type: 'string', enum: ['buy', 'sell'], description: 'Buy or sell' },
      qty: { type: 'number', description: 'Quantity to trade' },
      type: { type: 'string', enum: ['market', 'limit', 'stop'], description: 'Order type', default: 'market' },
      limitPx: { type: 'number', description: 'Limit price (required for type=limit)' },
      strategyId: { type: 'string', description: 'Strategy ID to attribute this order to' },
      reason: { type: 'string', description: 'Reason for the order' },
    },
    required: ['symbol', 'side', 'qty'],
    additionalProperties: false,
  },
  fn: submitOrder,
};
