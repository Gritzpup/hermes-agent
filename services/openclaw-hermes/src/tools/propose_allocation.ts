/**
 * Tool: propose_allocation
 * Writes a proposed allocation to Redis hermes:proposed-allocation:{strategyId}
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { ToolContext, ToolDef } from './index.js';

export interface ProposeAllocationArgs {
  strategyId: string;
  weights: Record<string, number>; // symbol → weight (0-1)
  rationale?: string;
}

export interface ProposeAllocationResult {
  ok: boolean;
  strategyId: string;
  weights: Record<string, number>;
  writtenAt: string;
  ttlSeconds: number;
}

async function proposeAllocation(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ProposeAllocationResult> {
  const strategyId = String(args.strategyId ?? '');
  const weights = (args.weights as Record<string, number>) ?? {};
  const rationale = typeof args.rationale === 'string' ? args.rationale : undefined;

  if (!strategyId) {
    throw new Error('propose_allocation: strategyId is required');
  }

  const key = `hermes:proposed-allocation:${strategyId}`;
  const ttlSeconds = 24 * 3600;
  const payload = {
    strategyId,
    weights,
    rationale,
    tickId: ctx.tickId,
    proposedAt: new Date().toISOString(),
  };

  await redis.setex(key, ttlSeconds, JSON.stringify(payload));
  logger.info({ strategyId, weights, key }, 'propose_allocation: written');

  return {
    ok: true,
    strategyId,
    weights,
    writtenAt: new Date().toISOString(),
    ttlSeconds,
  };
}

export const PROPOSE_ALLOCATION_TOOL: ToolDef = {
  name: 'propose_allocation',
  description: 'Write a proposed allocation (symbol weights) to Redis. Consumed by services that respect COO allocation proposals.',
  inputSchema: {
    type: 'object',
    properties: {
      strategyId: { type: 'string', description: 'Strategy ID this allocation applies to' },
      weights: { type: 'object', description: 'Map of symbol → weight (0-1)', additionalProperties: { type: 'number' } },
      rationale: { type: 'string', description: 'Optional rationale for this allocation' },
    },
    required: ['strategyId', 'weights'],
    additionalProperties: false,
  },
  fn: proposeAllocation,
};
