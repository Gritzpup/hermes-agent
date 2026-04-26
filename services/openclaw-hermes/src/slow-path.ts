/**
 * Slow Path — services/openclaw-hermes/src/slow-path.ts
 *
 * The COO bridge slow LLM tick runs every 10 min (POLL_INTERVAL_MS).
 * This module wires the new TradingAgents pipeline into that cadence.
 *
 * HERMES_AGENTS env flag:
 *   'pipeline' (default) — run the 5-phase PipelineRunner
 *   'monolith'           — keep existing askCoo() legacy behavior
 *
 * The fast-path (fast-path.ts) is NOT affected — it stays rule-based 30s.
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import { handleCooResponse } from './actions.js';
import type { CooResponse } from './openclaw-client.js';
import { askCoo } from './openclaw-client.js';
import { buildRollingContext } from './hermes-poller.js';
import { pollEvents } from './hermes-poller.js';
import { ToolRegistry } from './tools/index.js';
import { PipelineRunner } from './pipeline/index.js';
import { ProgrammaticToolCall } from './pipeline/programmatic-tool-call.js';
import type { ToolCallContext } from './pipeline/programmatic-tool-call.js';
import type { PipelineResult } from './pipeline/index.js';
import { DRY_RUN, HALT_FILE, HERMES_API } from './config.js';
import type { ToolMap } from './pipeline/programmatic-tool-call.js';
import type { ToolContext } from './tools/index.js';
import fs from 'node:fs';
import { appendJsonl } from './state.js';
import { DIRECTIVES_FILE } from './config.js';

export const HERMES_AGENTS_MODE = (process.env.HERMES_AGENTS ?? 'pipeline') as 'pipeline' | 'monolith';

// ── Tool registry singleton (created once) ────────────────────────────────────

let _registry: ToolRegistry | null = null;

function getToolRegistry(): ToolRegistry {
  if (!_registry) {
    _registry = new ToolRegistry();
    _registry.registerDefaults();
    logger.info('slow-path: ToolRegistry initialised');
  }
  return _registry;
}

// ── Pipeline tool map ──────────────────────────────────────────────────────────

/**
 * Build a ToolMap from the registry for use with ProgrammaticToolCall.
 * Each tool is wrapped to match ToolFn signature.
 */
function buildToolMap(registry: ToolRegistry): ToolMap {
  const map: ToolMap = {};
  for (const name of registry.list()) {
    map[name] = async (ctx: ToolCallContext, args: Record<string, unknown>) => {
      const sym = ctx.symbol;
      const strat = ctx.strategyId;
      const tc: ToolContext = {
        tickId: ctx.tickId,
        tickAt: ctx.tickAt,
        rollingContext: (ctx as unknown as ToolContext).rollingContext ?? {},
        ...(typeof sym === 'string' ? { symbol: sym } : {}),
        ...(typeof strat === 'string' ? { strategyId: strat } : {}),
      };
      return registry.invoke(name, args, tc);
    };
  }
  return map;
}

// ── Pipeline slow-path tick ────────────────────────────────────────────────────

async function pipelineTick(
  tickId: string,
  events: unknown[],
  rollingContext: Record<string, unknown>,
): Promise<PipelineResult> {
  const registry = getToolRegistry();
  const toolMap = buildToolMap(registry);

  const toolCtx: ToolCallContext = {
    tickId,
    tickAt: new Date().toISOString(),
    rollingContext,
  };

  const programmatic = new ProgrammaticToolCall(toolMap, toolCtx);
  const runner = new PipelineRunner(registry, programmatic);

  logger.info({ tickId, mode: HERMES_AGENTS_MODE }, 'slow-path: running pipeline tick');
  const result = await runner.run(rollingContext);
  logger.info({ tickId, totalDurationMs: result.totalDurationMs, decisions: result.decisions.length }, 'slow-path: pipeline tick complete');

  return result;
}

// ── Legacy monolith tick ───────────────────────────────────────────────────────

async function monolithTick(
  compact: Array<{ source: string; summary: string; severity: string; payload: unknown }>,
  rollingContext: Record<string, unknown>,
): Promise<CooResponse | null> {
  logger.info({ mode: HERMES_AGENTS_MODE }, 'slow-path: running legacy monolith tick');
  return askCoo(compact, rollingContext);
}

// ── Persist pipeline result to Redis + enact actions ──────────────────────────

async function persistAndEnact(result: PipelineResult): Promise<void> {
  const tickId = result.tickId;

  // Write decisions to Redis (already written per-stage in PipelineRunner)
  // Write final result to a separate key for the /health endpoint
  try {
    await redis.setex(`hermes:pipeline:latest:${tickId}`, 3600, JSON.stringify(result));
  } catch (err) {
    logger.warn({ err, tickId }, 'slow-path: failed to persist pipeline result');
  }

  // Enact halting actions via the existing /api/coo/* endpoints
  if (DRY_RUN || fs.existsSync(HALT_FILE)) {
    logger.info({ tickId }, 'slow-path: DRY_RUN or HALT_FILE set — skipping enactment');
    return;
  }

  for (const symbol of result.halts) {
    try {
      await fetch(`${HERMES_API}/api/coo/halt-symbol`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, reason: `pipeline-${tickId}`, operator: 'coo-pipeline' }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.warn({ err, symbol, tickId }, 'slow-path: failed to enact halt');
    }
  }

  // Record notes as COO directives
  for (const note of result.notes) {
    appendJsonl(DIRECTIVES_FILE, { note, tickId, source: 'pipeline' });
    try {
      await fetch(`${HERMES_API}/api/coo/note`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: note, tickId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* non-fatal */ }
  }

  // Record final allocation as a directive
  if (Object.keys(result.finalAllocation).length > 0) {
    const allocStr = JSON.stringify(result.finalAllocation);
    appendJsonl(DIRECTIVES_FILE, { directive: `final-allocation: ${allocStr}`, tickId, source: 'pipeline' });
  }
}

// ── Public: slow-path tick entrypoint ────────────────────────────────────────

export interface SlowPathTickOptions {
  force?: boolean;
}

export async function slowPathTick(opts: SlowPathTickOptions = {}): Promise<void> {
  const tickId = `sp-${Date.now().toString(36)}`;
  const tickAt = new Date().toISOString();

  try {
    const events = await pollEvents();
    const rollingContext = await buildRollingContext();
    const compact = events.map((e) => ({
      source: e.source,
      summary: e.summary,
      severity: e.severity,
      payload: e.payload,
    }));

    if (compact.length === 0 && !opts.force) {
      logger.debug({ tickId }, 'slow-path: no new events, skipping');
      return;
    }

    if (HERMES_AGENTS_MODE === 'monolith') {
      const resp = await monolithTick(compact, rollingContext);
      if (resp) {
        await handleCooResponse(resp);
      }
      return;
    }

    // Default: pipeline mode
    const result = await pipelineTick(tickId, compact, rollingContext);
    await persistAndEnact(result);
  } catch (err) {
    logger.error({ err, tickId }, 'slow-path tick failed');
  }
}
