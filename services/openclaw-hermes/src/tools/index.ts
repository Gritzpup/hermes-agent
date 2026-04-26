/**
 * Typed Tool Registry — services/openclaw-hermes/src/tools/index.ts
 *
 * Registers and invokes the 10 COO bridge tools.
 * Each tool writes a small outcome event to Redis (TTL 1 hour) for observability.
 *
 * Tools map to the TradingAgents 5-phase pipeline:
 *   Analyst  → read_positions, read_pnl, read_journal_window, query_news_sentiment,
 *              query_fundamentals, query_onchain_signal, get_compliance_status
 *   Research → propose_allocation (read-side: read_positions, read_pnl)
 *   Trader   → submit_order
 *   Risk     → halt_symbol
 *   Portfolio → (orchestrates via PipelineRunner)
 */

import { redis } from '@hermes/infra';
import { TOPICS } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { ReadPositionsResult } from './read_positions.js';
import type { ReadPnlResult } from './read_pnl.js';
import type { ReadJournalWindowResult } from './read_journal_window.js';
import type { ProposeAllocationResult } from './propose_allocation.js';
import type { HaltSymbolResult } from './halt_symbol.js';
import type { QueryNewsSentimentResult } from './query_news_sentiment.js';
import type { QueryFundamentalsResult } from './query_fundamentals.js';
import type { SubmitOrderResult } from './submit_order.js';
import type { GetComplianceStatusResult } from './get_compliance_status.js';
import type { QueryOnchainSignalResult } from './query_onchain_signal.js';

export interface ToolContext {
  /** Tick ID for this pipeline run */
  tickId: string;
  /** ISO timestamp of the tick */
  tickAt: string;
  /** Rolling context from hermes-poller */
  rollingContext: Record<string, unknown>;
  /** Symbol filter — some tools may be called with a specific symbol */
  symbol?: string;
  /** Strategy filter */
  strategyId?: string;
}

// Tool signatures
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  fn: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

interface ToolOutcomeEvent {
  ulid: string;
  tool: string;
  tickId: string;
  ts: string;
  ok: boolean;
  args: Record<string, unknown>;
  result: unknown;
  err?: string;
  durationMs: number;
}

function generateUlid(): string {
  // ULID-like: timestamp-safe 26-char base32 string
  // Use a simple time-based prefix + random suffix matching ULID spirit
  const t = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, '0');
  return `${t}${rand}`;
}

async function writeToolOutcome(event: ToolOutcomeEvent): Promise<void> {
  try {
    const key = `hermes:tool-events:${event.tool}:${event.ulid}`;
    await redis.setex(key, 3600, JSON.stringify(event));
  } catch (err) {
    logger.warn({ err, tool: event.tool, ulid: event.ulid }, 'failed to write tool outcome event');
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    if (this.tools.has(def.name)) {
      logger.warn({ tool: def.name }, 'ToolRegistry: tool already registered, overwriting');
    }
    this.tools.set(def.name, def);
    logger.debug({ tool: def.name }, 'ToolRegistry: registered');
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): string[] {
    return [...this.tools.keys()];
  }

  getDef(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown> {
    const def = this.tools.get(toolName);
    if (!def) {
      throw new Error(`ToolRegistry: unknown tool "${toolName}"`);
    }

    const ulid = generateUlid();
    const start = Date.now();
    let ok = false;
    let result: unknown = null;
    let err: string | undefined;

    try {
      result = await def.fn(ctx, args);
      ok = true;
      return result;
    } catch (e) {
      err = String(e);
      throw e;
    } finally {
      const durationMs = Date.now() - start;
      // Fire-and-forget: write outcome event without blocking the response
      const outcome: ToolOutcomeEvent = {
        ulid,
        tool: toolName,
        tickId: ctx.tickId,
        ts: new Date().toISOString(),
        ok,
        args,
        result,
        durationMs,
      };
      if (err !== undefined) (outcome as { err?: string }).err = err;
      void writeToolOutcome(outcome);
    }
  }

  /**
   * Register all 10 standard tools.
   * Call once at startup.
   */
  registerDefaults(): void {
    // Dynamically import each tool module so tree-shaking works and
    // each file can be developed/tested in isolation.
    void import('./read_positions.js').then((m) => this.register(m.READ_POSITIONS_TOOL));
    void import('./read_pnl.js').then((m) => this.register(m.READ_PNL_TOOL));
    void import('./read_journal_window.js').then((m) => this.register(m.READ_JOURNAL_WINDOW_TOOL));
    void import('./propose_allocation.js').then((m) => this.register(m.PROPOSE_ALLOCATION_TOOL));
    void import('./halt_symbol.js').then((m) => this.register(m.HALT_SYMBOL_TOOL));
    void import('./query_news_sentiment.js').then((m) => this.register(m.QUERY_NEWS_SENTIMENT_TOOL));
    void import('./query_fundamentals.js').then((m) => this.register(m.QUERY_FUNDAMENTALS_TOOL));
    void import('./submit_order.js').then((m) => this.register(m.SUBMIT_ORDER_TOOL));
    void import('./get_compliance_status.js').then((m) => this.register(m.GET_COMPLIANCE_STATUS_TOOL));
    void import('./query_onchain_signal.js').then((m) => this.register(m.QUERY_ONCHAIN_SIGNAL_TOOL));
    logger.info({ count: 10 }, 'ToolRegistry: defaults registered');
  }

  /**
   * Synchronous register for use before all async imports resolve.
   * Used in tests where we want deterministic ordering.
   */
  registerSync(defs: ToolDef[]): void {
    for (const def of defs) this.register(def);
  }
}

// Re-export types for consumers
export type { ReadPositionsResult } from './read_positions.js';
export type { ReadPnlResult } from './read_pnl.js';
export type { ReadJournalWindowResult } from './read_journal_window.js';
export type { ProposeAllocationResult } from './propose_allocation.js';
export type { HaltSymbolResult } from './halt_symbol.js';
export type { QueryNewsSentimentResult } from './query_news_sentiment.js';
export type { QueryFundamentalsResult } from './query_fundamentals.js';
export type { SubmitOrderResult } from './submit_order.js';
export type { GetComplianceStatusResult } from './get_compliance_status.js';
export type { QueryOnchainSignalResult } from './query_onchain_signal.js';
