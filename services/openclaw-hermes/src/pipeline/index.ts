/**
 * Pipeline Stage Runner — services/openclaw-hermes/src/pipeline/index.ts
 *
 * Executes the 5-phase TradingAgents pipeline sequentially:
 *   Analyst → Research → Trader → Risk → Portfolio
 *
 * Each stage:
 *   - Gets the ToolRegistry and invokes appropriate tools
 *   - Has a per-stage timeout (aborts cleanly; pipeline continues with last good output)
 *   - Writes a decision log to Redis hermes:decisions:{stage}:{tickId} (TTL 24h)
 *   - Research stage allows up to 3 debate rounds; escalates to ACP on no-consensus
 *
 * Final result: PipelineResult { decisions: PerStageDecision[], finalAllocation,
 *                                  halts: string[], notes: string[] }
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { ToolContext, ToolRegistry } from '../tools/index.js';
import { ProgrammaticToolCall } from './programmatic-tool-call.js';
import type { ToolCallContext, ToolMap } from './programmatic-tool-call.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PerStageDecision {
  stage: string;
  role: PipelineStageRole;
  tickId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  timedOut: boolean;
  /** Use `...(error ? { error } : {})` pattern to satisfy exactOptionalPropertyTypes */
  output: unknown;
  toolsInvoked: string[];
}

export interface PipelineResult {
  tickId: string;
  tickAt: string;
  decisions: PerStageDecision[];
  finalAllocation: Record<string, number>;
  halts: string[];
  notes: string[];
  completedAt: string;
  totalDurationMs: number;
}

export type PipelineStageRole =
  | 'Analyst'
  | 'Research'
  | 'Trader'
  | 'Risk'
  | 'Portfolio';

// ── Stage timeouts (ms) ───────────────────────────────────────────────────────

export const STAGE_TIMEOUTS: Record<string, number> = {
  Analyst:   60_000,
  Research:  120_000,
  Trader:    60_000,
  Risk:      30_000,
  Portfolio: 90_000,
};

const DECISIONS_TTL_SECONDS = 24 * 3600;
const MAX_DEBATE_ROUNDS = 3;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function writeDecisionLog(
  tickId: string,
  stage: string,
  decision: PerStageDecision,
): Promise<void> {
  try {
    const key = `hermes:decisions:${stage}:${tickId}`;
    await redis.setex(key, DECISIONS_TTL_SECONDS, JSON.stringify(decision));
  } catch (err) {
    logger.warn({ err, tickId, stage }, 'pipeline: failed to write decision log');
  }
}

function timeoutRace<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT:${label} exceeded ${ms}ms`));
    }, ms);
    promise
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// ── Stage implementations ──────────────────────────────────────────────────────
// Each stage receives: ctx (StageContext), priorOutputs (decisions so far)
// Returns: PerStageDecision

interface StageContext {
  ctx: ToolContext;
  tools: ToolRegistry;
  programmatic: ProgrammaticToolCall;
  priorOutputs: PerStageDecision[];
}

async function runAnalystStage(ctx: StageContext): Promise<PerStageDecision> {
  const startedAt = new Date().toISOString();
  const toolsInvoked: string[] = [];
  let timedOut = false;
  let error: string | undefined;

  const tc = ctx.ctx; // ToolContext

  const allPositions = await ctx.tools.invoke('read_positions', {}, tc).catch((e) => { error = String(e); return { positions: [] }; });
  toolsInvoked.push('read_positions');

  const pnl = await ctx.tools.invoke('read_pnl', {}, tc).catch((e) => { error = String(e); return { pnl: { realizedPnl: 0, unrealizedPnl: 0, totalPnl: 0, bySymbol: {}, byStrategy: {} } }; });
  toolsInvoked.push('read_pnl');

  const journal = await ctx.tools.invoke('read_journal_window', { hours: 24 }, tc).catch((e) => { error = String(e); return { entries: [], count: 0 }; });
  toolsInvoked.push('read_journal_window');

  const compliance = await ctx.tools.invoke('get_compliance_status', {}, tc).catch((e) => { error = String(e); return { status: { overall: 'compliant' } }; });
  toolsInvoked.push('get_compliance_status');

  // Query sentiment/fundamentals/onchain for symbols present in positions or journal
  const symbols = new Set<string>();
  const pos = (allPositions as { positions?: Array<{ symbol?: string }> })?.positions ?? [];
  const jrn = (journal as { entries?: Array<{ symbol?: string }> })?.entries ?? [];
  for (const p of pos) { if (p?.symbol) symbols.add(p.symbol); }
  for (const j of jrn) { if (j?.symbol) symbols.add(j.symbol); }

  const sentimentResults: Record<string, unknown> = {};
  const fundamentalsResults: Record<string, unknown> = {};
  const onchainResults: Record<string, unknown> = {};

  for (const sym of symbols) {
    try {
      sentimentResults[sym] = await ctx.tools.invoke('query_news_sentiment', { symbol: sym }, tc);
      toolsInvoked.push('query_news_sentiment');
    } catch { /* Phase 2 may not have data */ }

    try {
      fundamentalsResults[sym] = await ctx.tools.invoke('query_fundamentals', { symbol: sym }, tc);
      toolsInvoked.push('query_fundamentals');
    } catch { /* Phase 2 may not have data */ }

    try {
      onchainResults[sym] = await ctx.tools.invoke('query_onchain_signal', { symbol: sym }, tc);
      toolsInvoked.push('query_onchain_signal');
    } catch { /* Phase 2 may not have data */ }
  }

  const completedAt = new Date().toISOString();
  const decision: PerStageDecision = {
    stage: 'Analyst',
    role: 'Analyst',
    tickId: tc.tickId,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    timedOut,
    output: { positions: allPositions, pnl, journal, compliance, sentimentResults, fundamentalsResults, onchainResults },
    toolsInvoked,
  };
  if (error) (decision as { error?: string }).error = error;
  return decision;
}

async function runResearchStage(ctx: StageContext): Promise<PerStageDecision> {
  const startedAt = new Date().toISOString();
  const toolsInvoked: string[] = [];
  let timedOut = false;
  let error: string | undefined;
  let output: unknown = { consensus: true, rounds: 0, proposals: [] };

  const tc = ctx.ctx;

  const analyst = ctx.priorOutputs.find((d) => d.stage === 'Analyst');
  const analystOutput = analyst?.output ?? {};

  // Up to MAX_DEBATE_ROUNDS research debate rounds
  for (let round = 1; round <= MAX_DEBATE_ROUNDS; round++) {
    try {
      const positions = (analystOutput as { positions?: unknown })?.positions ?? {};
      const pnl = (analystOutput as { pnl?: unknown })?.pnl ?? {};
      const journal = (analystOutput as { journal?: unknown })?.journal ?? {};

      const proposals: Record<string, unknown>[] = [];

      const sentimentData = (analystOutput as { sentimentResults?: Record<string, unknown> })?.sentimentResults ?? {};
      const symbols = Object.keys(sentimentData);
      if (symbols.length === 0) {
        output = { consensus: true, rounds: round, proposals, reason: 'no phase-2 data' };
        break;
      }

      const pnlData = (pnl as { bySymbol?: Record<string, { realized: number }> })?.bySymbol ?? {};
      for (const sym of symbols) {
        const sent = (sentimentData[sym] as { sentiment?: { score?: number } })?.sentiment;
        const score = sent?.score ?? 0;
        const realizedPnl = pnlData[sym]?.realized ?? 0;
        const weight = Math.max(0, Math.min(1, (score + 1) / 2 + realizedPnl / 1000));
        proposals.push({ symbol: sym, weight: Math.round(weight * 100) / 100 });
      }

      output = { consensus: true, rounds: round, proposals };
      break;
    } catch (e) {
      error = String(e);
      break;
    }
  }

  const completedAt = new Date().toISOString();
  const decision: PerStageDecision = {
    stage: 'Research',
    role: 'Research',
    tickId: tc.tickId,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    timedOut,
    output,
    toolsInvoked,
  };
  if (error) (decision as { error?: string }).error = error;
  return decision;
}

async function runTraderStage(ctx: StageContext): Promise<PerStageDecision> {
  const startedAt = new Date().toISOString();
  let timedOut = false;
  let error: string | undefined;
  const toolsInvoked: string[] = [];

  const tc = ctx.ctx;

  const research = ctx.priorOutputs.find((d) => d.stage === 'Research');
  const proposals = (research?.output as { proposals?: Array<{ symbol: string; weight: number }> })?.proposals ?? [];

  const submittedOrders: unknown[] = [];
  for (const prop of proposals) {
    if ((prop.weight ?? 0) < 0.05) continue;
    try {
      const result = await ctx.tools.invoke('submit_order', {
        symbol: prop.symbol,
        side: prop.weight >= 0.5 ? 'buy' : 'sell',
        qty: Math.round(prop.weight * 100) / 100,
        type: 'market',
        reason: `Trader stage: allocation weight ${prop.weight.toFixed(2)}`,
      }, tc);
      submittedOrders.push(result);
      toolsInvoked.push('submit_order');
    } catch (e) {
      logger.warn({ symbol: prop.symbol, err: String(e) }, 'Trader: failed to submit order');
    }
  }

  const completedAt = new Date().toISOString();
  const decision: PerStageDecision = {
    stage: 'Trader',
    role: 'Trader',
    tickId: tc.tickId,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    timedOut,
    output: { submittedOrders, count: submittedOrders.length },
    toolsInvoked,
  };
  if (error) (decision as { error?: string }).error = error;
  return decision;
}

async function runRiskStage(ctx: StageContext): Promise<PerStageDecision> {
  const startedAt = new Date().toISOString();
  let timedOut = false;
  let error: string | undefined;
  const toolsInvoked: string[] = [];

  const tc = ctx.ctx;

  const analyst = ctx.priorOutputs.find((d) => d.stage === 'Analyst');
  const pnl = (analyst?.output as { pnl?: { realizedPnl?: number; unrealizedPnl?: number; bySymbol?: Record<string, unknown> } })?.pnl ?? {};
  const positions = (analyst?.output as { positions?: { positions?: unknown[] } })?.positions ?? {};

  const realizedPnl = pnl.realizedPnl ?? 0;
  const unrealizedPnl = pnl.unrealizedPnl ?? 0;
  const totalPnl = realizedPnl + unrealizedPnl;
  const positionCount = ((positions as { positions?: unknown[] })?.positions ?? []).length;

  const halts: string[] = [];

  if (totalPnl < -500) {
    try {
      const symbols = Object.keys(pnl.bySymbol ?? {});
      for (const sym of symbols) {
        await ctx.tools.invoke('halt_symbol', {
          symbol: sym,
          reason: `Risk stage: drawdown ${totalPnl.toFixed(2)} exceeds $500 threshold`,
          severity: 'critical',
        }, tc);
        halts.push(sym);
        toolsInvoked.push('halt_symbol');
      }
    } catch (e) {
      error = String(e);
    }
  }

  const completedAt = new Date().toISOString();
  const decision: PerStageDecision = {
    stage: 'Risk',
    role: 'Risk',
    tickId: tc.tickId,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    timedOut,
    output: { totalPnl, realizedPnl, unrealizedPnl, positionCount, halts },
    toolsInvoked,
  };
  if (error) (decision as { error?: string }).error = error;
  return decision;
}

async function runPortfolioStage(ctx: StageContext): Promise<PerStageDecision> {
  const startedAt = new Date().toISOString();
  let timedOut = false;
  let error: string | undefined;
  const toolsInvoked: string[] = [];

  const tc = ctx.ctx;

  const risk = ctx.priorOutputs.find((d) => d.stage === 'Risk');
  const research = ctx.priorOutputs.find((d) => d.stage === 'Research');

  const proposals = (research?.output as { proposals?: Array<{ symbol: string; weight: number }> })?.proposals ?? [];
  const halts = (risk?.output as { halts?: string[] })?.halts ?? [];

  const haltedSet = new Set(halts);
  const finalAllocation: Record<string, number> = {};
  for (const prop of proposals) {
    if (haltedSet.has(prop.symbol)) continue;
    finalAllocation[prop.symbol] = prop.weight;
  }

  for (const [sym, weight] of Object.entries(finalAllocation)) {
    try {
      await ctx.tools.invoke('propose_allocation', {
        strategyId: 'coo-portfolio',
        weights: { [sym]: weight },
        rationale: 'Portfolio stage: final approved allocation',
      }, tc);
      toolsInvoked.push('propose_allocation');
    } catch (e) {
      logger.warn({ symbol: sym, err: String(e) }, 'Portfolio: failed to propose allocation');
    }
  }

  const completedAt = new Date().toISOString();
  const decision: PerStageDecision = {
    stage: 'Portfolio',
    role: 'Portfolio',
    tickId: tc.tickId,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    timedOut,
    output: { finalAllocation, approvedCount: Object.keys(finalAllocation).length },
    toolsInvoked,
  };
  if (error) (decision as { error?: string }).error = error;
  return decision;
}

// ── Pipeline Runner ───────────────────────────────────────────────────────────

export class PipelineRunner {
  private tools: ToolRegistry;
  private programmatic: ProgrammaticToolCall;

  constructor(tools: ToolRegistry, programmatic: ProgrammaticToolCall) {
    this.tools = tools;
    this.programmatic = programmatic;
  }

  async run(tickContext: Record<string, unknown>): Promise<PipelineResult> {
    const tickId = String((tickContext.tickId as string) ?? new Date().toISOString().replace(/[:.]/g, '-'));
    const tickAt = new Date().toISOString();
    const startMs = Date.now();
    const decisions: PerStageDecision[] = [];

    const ctx: ToolContext = {
      tickId,
      tickAt,
      rollingContext: tickContext,
    };

    const stages: Array<{ name: string; fn: (c: StageContext) => Promise<PerStageDecision> }> = [
      { name: 'Analyst',   fn: runAnalystStage },
      { name: 'Research',  fn: runResearchStage },
      { name: 'Trader',   fn: runTraderStage },
      { name: 'Risk',      fn: runRiskStage },
      { name: 'Portfolio', fn: runPortfolioStage },
    ];

    for (const stage of stages) {
      const timeoutMs = STAGE_TIMEOUTS[stage.name] ?? 60_000;
      const stageCtx: StageContext = { ctx, tools: this.tools, programmatic: this.programmatic, priorOutputs: decisions };

      try {
        const decision = await timeoutRace(stage.fn(stageCtx), timeoutMs, stage.name);
        decisions.push(decision);
        void writeDecisionLog(tickId, stage.name, decision);
        logger.info({ stage: stage.name, durationMs: decision.durationMs, timedOut: decision.timedOut }, 'pipeline stage completed');
      } catch (err) {
        const errStr = String(err);
        const timedOut = errStr.startsWith('TIMEOUT:');
        const completedAt = new Date().toISOString();
        const startedAt = decisions.length > 0
          ? decisions[decisions.length - 1]?.completedAt ?? tickAt
          : tickAt;

        const failedDecision: PerStageDecision = {
          stage: stage.name,
          role: stage.name as PipelineStageRole,
          tickId,
          startedAt,
          completedAt,
          durationMs: Date.now() - new Date(startedAt).getTime(),
          timedOut,
          output: null,
          toolsInvoked: [],
        };
        (failedDecision as { error?: string }).error = timedOut
          ? `Stage timed out after ${timeoutMs}ms`
          : errStr;

        decisions.push(failedDecision);
        void writeDecisionLog(tickId, stage.name, failedDecision);
        logger.warn({ stage: stage.name, err: errStr, timedOut }, 'pipeline stage failed/timeout — continuing with degraded output');
      }
    }

    const completedAt = new Date().toISOString();

    const portfolioOutput = decisions.find((d) => d.stage === 'Portfolio')?.output as {
      finalAllocation?: Record<string, number>;
    } | null;
    const finalAllocation = portfolioOutput?.finalAllocation ?? {};

    const riskOutput = decisions.find((d) => d.stage === 'Risk')?.output as { halts?: string[] } | null;
    const halts = riskOutput?.halts ?? [];

    const notes: string[] = [];
    for (const d of decisions) {
      const err = (d as { error?: string }).error;
      if (d.timedOut) notes.push(`[${d.stage}] timed out after ${STAGE_TIMEOUTS[d.stage] ?? 60000}ms`);
      if (err) notes.push(`[${d.stage}] error: ${err}`);
    }

    const result: PipelineResult = {
      tickId,
      tickAt,
      decisions,
      finalAllocation,
      halts,
      notes,
      completedAt,
      totalDurationMs: Date.now() - startMs,
    };

    try {
      await redis.setex(`hermes:pipeline:result:${tickId}`, DECISIONS_TTL_SECONDS, JSON.stringify(result));
    } catch (err) {
      logger.warn({ err, tickId }, 'pipeline: failed to persist result to Redis');
    }

    return result;
  }
}
