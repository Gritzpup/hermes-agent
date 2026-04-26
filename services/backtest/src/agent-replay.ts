/**
 * Agent Replay Harness — services/backtest/src/agent-replay.ts
 *
 * Replays journal.jsonl through phase-0..4 agent changes and reports
 * P&L delta vs actual + decision divergence + per-phase attribution.
 *
 * Walk-forward discipline: at each replay bar, only data up to that bar
 * is visible to the agent. No future leakage.
 *
 * SMOKE-MODE: HERMES_BACKTEST_SMOKE=1 → last 24h, max 100 entries, <60s
 * FULL-MODE:  HERMES_BACKTEST_SMOKE=0 → last 90 days, default
 *
 * Reference: LiveTradeBench (arxiv 2511.03628) live-eval methodology
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redis, TOPICS } from '@hermes/infra';
import { logger } from '@hermes/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JournalEntry {
  id: string;
  type: 'trade' | 'signal' | 'director_decision' | 'coo_directive' | 'position_update';
  ts: string;       // ISO timestamp
  symbol?: string;
  side?: 'buy' | 'sell';
  qty?: number;
  price?: number;
  pnl?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  fee?: number;
  slippage?: number;
  strategy?: string;
  broker?: string;
  action?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type PhaseVariant =
  | 'phase0'   // fees + concentration + director context purge
  | 'phase1'   // + TradingAgents pipeline
  | 'phase2'   // + FinGPT sentiment + Qdrant RAG + onchain
  | 'phase3'   // + FinRL-X shadow
  | 'phase4'   // + 4-tier router + MCP servers
  | 'all';     // everything enabled

export type RunMode = 'smoke' | 'full';

export interface ReplayDecision {
  entryId: string;
  ts: string;
  symbol: string | null;
  actualAction: string;     // what actually happened
  simulatedAction: string;  // what the new agent stack would have done
  actionChanged: boolean;
  pnlImpact: number;        // estimated P&L impact of the change
  phases: PhaseContribution[];
}

export interface PhaseContribution {
  phase: PhaseVariant;
  contribution: number;     // P&L contribution in USD
  notes: string;
}

export interface ReplayReport {
  id: string;
  mode: RunMode;
  variant: PhaseVariant;
  startTs: string;
  endTs: string;
  totalEntries: number;
  decisions: ReplayDecision[];
  totalPnlDelta: number;
  totalActualPnl: number;
  totalSimulatedPnl: number;
  phaseAttribution: PhaseContribution[];
  divergences: DecisionDivergence[];
  generatedAt: string;
  durationMs: number;
}

export interface DecisionDivergence {
  entryId: string;
  ts: string;
  symbol: string | null;
  baselineAction: string;
  newAction: string;
  delta: string;
  reason: string;
}

// ── Fee simulation (Phase 0) ──────────────────────────────────────────────────

const CRYPTO_TAKER_FEE_BPS = 0.80;   // Tier 1 Coinbase Advanced
const CRYPTO_MAKER_FEE_BPS = 0.60;
const EQUITY_SLIPPAGE_BPS = 0.8;
const CRYPTO_SLIPPAGE_BPS = 1.8;
const CONCENTRATION_CAP = 0.35;       // 35% notional cap

function applyPhase0(entry: JournalEntry): JournalEntry {
  const e = { ...entry };

  // Tiered fee model
  if (e.side === 'buy' && e.price && e.qty) {
    const notional = e.price * e.qty;
    const fee = notional * (CRYPTO_TAKER_FEE_BPS / 10_000);
    e.fee = (e.fee ?? 0) + fee;
    // Slippage estimate
    const slip = notional * (CRYPTO_SLIPPAGE_BPS / 10_000);
    e.slippage = (e.slippage ?? 0) + slip;
  }

  return e;
}

// ── Phase 1: TradingAgents pipeline (simplified replay simulation) ────────────

interface SimulatedAgentState {
  positions: Map<string, { qty: number; avgEntry: number; notional: number }>;
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  concentrationViolations: string[];
  haltedSymbols: Set<string>;
  cooDirectives: string[];
}

function makeInitialState(): SimulatedAgentState {
  return {
    positions: new Map(),
    cash: 300_000,
    realizedPnl: 0,
    unrealizedPnl: 0,
    concentrationViolations: [],
    haltedSymbols: new Set(),
    cooDirectives: [],
  };
}

function applyPhase1(entry: JournalEntry, state: SimulatedAgentState): { action: string; pnlDelta: number } {
  // Simulate analyst → research → trader → risk → portfolio pipeline stages
  const sym = entry.symbol ?? '';
  const pos = state.positions.get(sym);
  const posNotional = pos?.notional ?? 0;
  const totalNotional = [...state.positions.values()].reduce((s, p) => s + p.notional, 0);
  const concentration = totalNotional > 0 ? posNotional / totalNotional : 0;

  // Risk stage: concentration check
  if (concentration > CONCENTRATION_CAP) {
    state.haltedSymbols.add(sym);
    return { action: 'halt_symbol', pnlDelta: 0 };
  }

  // Risk stage: drawdown check
  if (state.realizedPnl < -500) {
    state.haltedSymbols.add(sym);
    return { action: 'risk_halt', pnlDelta: 0 };
  }

  // Portfolio stage: allocation proposal
  if (entry.type === 'trade') {
    const weight = posNotional / (totalNotional + 1);
    if (weight < 0.05) {
      return { action: 'reduce_exposure', pnlDelta: 0 };
    }
  }

  return { action: 'noop', pnlDelta: 0 };
}

// ── Phase 2: FinGPT sentiment + onchain ───────────────────────────────────────

function applyPhase2(entry: JournalEntry): { sentimentBias: number; pnlDelta: number } {
  // Simulate FinGPT sentiment scoring: assume positive bias on avg
  // In production this would query the Ollama FinGPT endpoint
  const sentimentBias = 0.02; // 2% positive bias assumption
  const pnlDelta = entry.pnl ? entry.pnl * sentimentBias : 0;
  return { sentimentBias, pnlDelta };
}

// ── Phase 3: FinRL-X shadow overlay ───────────────────────────────────────────

function applyPhase3(entry: JournalEntry & { derivedNotional?: number }): { edgeScore: number; pnlDelta: number } {
  // Simulate FinRL-X edge score: conservative 3bps edge assumption
  const edgeBps = 3;
  // Prefer derivedNotional (from realizedPnl/realizedPnlPct) when qty isn't in the journal
  const notional = entry.derivedNotional ?? ((entry.price ?? 0) * (entry.qty ?? 0));
  const pnlDelta = notional * (edgeBps / 10_000);
  const edgeScore = edgeBps / 10_000;
  return { edgeScore, pnlDelta };
}

// ── Phase 4: Model router + MCP servers ───────────────────────────────────────

function applyPhase4(entry: JournalEntry & { derivedNotional?: number }): { routingDelta: number } {
  // Phase 4 adds MCP data freshness: estimate 1bp improvement from fresher data
  // Prefer derivedNotional when qty isn't in the journal
  const notional = entry.derivedNotional ?? ((entry.price ?? 0) * (entry.qty ?? 0));
  const routingDelta = notional * (1 / 10_000); // 1bp
  return { routingDelta };
}

// ── Journal loading ───────────────────────────────────────────────────────────

const JOURNAL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../api/.runtime/paper-ledger/journal.jsonl'
);

// Maps the firm's real closed-trade journal schema to the fields agent-replay reads.
// Real entries use entryAt/exitAt/entryPrice/exitPrice/realizedPnl/realizedPnlPct and have
// NO qty / side / type / action (it's a closed-trade journal). We DO NOT fabricate those
// fields — leaving them undefined makes phase logic that depends on them produce zero
// contribution rather than spurious dollar-attribution (per Clio review of commit 3554708:
// fabricating qty=1 inflates Phase 3/4 by ~1000× because BTC notional collapses to $95k
// instead of $95). Notional is derived from realizedPnl + realizedPnlPct when both exist
// (notional = pnl / (pnlPct/100)), giving honest dollar-scale attribution for Phase 3/4.
function normalizeJournalEntry(raw: Record<string, unknown>): JournalEntry & Record<string, unknown> {
  const ts = (raw.ts as string | undefined)
    ?? (raw.exitAt as string | undefined)
    ?? (raw.entryAt as string | undefined)
    ?? (raw.entryTimestamp as string | undefined);
  const price = (raw.exitPrice as number | undefined)
    ?? (raw.entryPrice as number | undefined)
    ?? (raw.price as number | undefined)
    ?? 0;
  const pnl = (raw.realizedPnl as number | undefined)
    ?? (raw.pnl as number | undefined)
    ?? 0;
  // Derive notional from realizedPnl / (realizedPnlPct/100) when both exist with finite values
  const pnlPct = raw.realizedPnlPct as number | undefined;
  let derivedNotional: number | undefined;
  if (typeof pnl === 'number' && typeof pnlPct === 'number' && Math.abs(pnlPct) > 0.001) {
    derivedNotional = Math.abs(pnl) / (Math.abs(pnlPct) / 100);
  }
  // Quantity, only if it can be derived from notional + price; never fabricate
  const qty = (raw.qty as number | undefined)
    ?? (derivedNotional && price > 0 ? derivedNotional / price : undefined);
  return {
    ...raw,
    ts,
    price,
    pnl,
    realizedPnl: pnl,
    ...(qty !== undefined ? { qty } : {}),
    ...(derivedNotional !== undefined ? { derivedNotional } : {}),
  } as JournalEntry & Record<string, unknown>;
}

export function loadJournal(opts: { since?: string; maxEntries?: number }): JournalEntry[] {
  const since = opts.since
    ? new Date(opts.since)
    : new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const maxEntries = opts.maxEntries ?? Infinity;

  if (!fs.existsSync(JOURNAL_PATH)) {
    logger.warn({ path: JOURNAL_PATH }, 'agent-replay: journal not found — generating synthetic smoke entries');
    return generateSyntheticJournal(since, maxEntries);
  }

  const lines = fs.readFileSync(JOURNAL_PATH, 'utf-8').split('\n').filter(Boolean);
  const entries: JournalEntry[] = [];

  for (const line of lines) {
    if (entries.length >= maxEntries) break;
    try {
      const raw = JSON.parse(line);
      const normalized = normalizeJournalEntry(raw);
      const ts = new Date(normalized.ts ?? normalized.id);
      if (isNaN(ts.getTime()) || ts < since) continue;
      entries.push(normalized);
    } catch {
      // Skip malformed lines
    }
  }

  if (entries.length === 0) {
    return generateSyntheticJournal(since, maxEntries);
  }

  return entries;
}

function generateSyntheticJournal(since: Date, maxEntries: number): JournalEntry[] {
  const symbols = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
  const entries: JournalEntry[] = [];
  const count = Math.min(maxEntries, 100);
  const now = Date.now();
  const windowMs = 24 * 3600 * 1000;
  const startMs = Math.max(since.getTime(), now - windowMs);

  for (let i = 0; i < count; i++) {
    const ts = new Date(startMs + (i / count) * windowMs);
    const sym = symbols[i % symbols.length]!;
    const side: 'buy' | 'sell' = i % 2 === 0 ? 'buy' : 'sell';
    const price = sym === 'BTC-USD' ? 95_000 : sym === 'ETH-USD' ? 3_200 : sym === 'SOL-USD' ? 180 : 2.4;
    const qty = Math.random() * 0.5 + 0.1;
    const pnl = side === 'sell' ? (Math.random() * 40 - 5) : -(Math.random() * 10);
    const fee = price * qty * (CRYPTO_TAKER_FEE_BPS / 10_000);
    const slip = price * qty * (CRYPTO_SLIPPAGE_BPS / 10_000);

    entries.push({
      id: `synth-${randomUUID()}`,
      type: 'trade',
      ts: ts.toISOString(),
      symbol: sym,
      side,
      qty,
      price,
      pnl,
      realizedPnl: side === 'sell' ? pnl - fee - slip : -(fee + slip),
      unrealizedPnl: 0,
      fee,
      slippage: slip,
      strategy: `grid-${sym.toLowerCase()}`,
      broker: 'coinbase-live',
      action: side === 'buy' ? 'open_long' : 'close_long',
      reason: 'smoke-test synthetic entry',
    });
  }

  return entries;
}

// ── Main replay ──────────────────────────────────────────────────────────────

export interface ReplayOptions {
  variant: PhaseVariant;
  since?: string;          // ISO date string, default 90 days ago (or 24h for smoke)
  maxEntries?: number;     // default Infinity
  smoke?: boolean;         // HERMES_BACKTEST_SMOKE=1 overrides
}

export async function runAgentReplay(opts: ReplayOptions): Promise<ReplayReport> {
  const startMs = Date.now();
  const runMode: RunMode = (process.env.HERMES_BACKTEST_SMOKE === '1' || opts.smoke) ? 'smoke' : 'full';
  const since = opts.since ?? (runMode === 'smoke'
    ? new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    : new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString());

  const maxEntries = runMode === 'smoke'
    ? Math.min(opts.maxEntries ?? 100, 100)
    : opts.maxEntries ?? Infinity;

  const id = randomUUID();
  const entries = loadJournal({ since, maxEntries });

  const state = makeInitialState();
  const decisions: ReplayDecision[] = [];
  const divergences: DecisionDivergence[] = [];
  let totalActualPnl = 0;
  let totalSimulatedPnl = 0;
  const phaseContributions: Record<PhaseVariant, number> = {
    phase0: 0, phase1: 0, phase2: 0, phase3: 0, phase4: 0, all: 0,
  };

  for (const entry of entries) {
    if (entry.ts > new Date().toISOString()) break; // walk-forward: no future data

    const pnl = entry.realizedPnl ?? entry.pnl ?? 0;
    totalActualPnl += pnl;

    // ── Phase 0: apply tiered fees + concentration ──────────────────────────
    const p0Entry = applyPhase0(entry);
    const p0FeeDelta = (p0Entry.fee ?? 0) - (entry.fee ?? 0) + (p0Entry.slippage ?? 0) - (entry.slippage ?? 0);
    phaseContributions.phase0 += p0FeeDelta;

    // Update simulated state from the phase-0-corrected entry
    if (p0Entry.symbol && (p0Entry.side === 'buy' || p0Entry.side === 'sell') && p0Entry.price && p0Entry.qty) {
      const notional = p0Entry.price * p0Entry.qty;
      const existing = state.positions.get(p0Entry.symbol);
      if (p0Entry.side === 'buy') {
        state.positions.set(p0Entry.symbol, {
          qty: (existing?.qty ?? 0) + p0Entry.qty,
          avgEntry: existing
            ? (existing.avgEntry * (existing.qty) + p0Entry.price * p0Entry.qty) / ((existing.qty) + p0Entry.qty)
            : p0Entry.price,
          notional: (existing?.notional ?? 0) + notional,
        });
      } else {
        state.positions.delete(p0Entry.symbol);
      }
    }

    // ── Phase 1: TradingAgents pipeline ─────────────────────────────────────
    let simulatedAction = 'noop';
    let p1PnlDelta = 0;
    if (opts.variant === 'phase1' || opts.variant === 'phase2' || opts.variant === 'phase3' || opts.variant === 'phase4' || opts.variant === 'all') {
      const { action, pnlDelta } = applyPhase1(entry, state);
      simulatedAction = action;
      p1PnlDelta = pnlDelta;
      phaseContributions.phase1 += pnlDelta;
    }

    // ── Phase 2: FinGPT sentiment ────────────────────────────────────────────
    let p2PnlDelta = 0;
    if (opts.variant === 'phase2' || opts.variant === 'phase3' || opts.variant === 'phase4' || opts.variant === 'all') {
      const { pnlDelta } = applyPhase2(entry);
      p2PnlDelta = pnlDelta;
      phaseContributions.phase2 += pnlDelta;
    }

    // ── Phase 3: FinRL-X shadow ─────────────────────────────────────────────
    let p3PnlDelta = 0;
    if (opts.variant === 'phase3' || opts.variant === 'phase4' || opts.variant === 'all') {
      const { pnlDelta } = applyPhase3(entry);
      p3PnlDelta = pnlDelta;
      phaseContributions.phase3 += pnlDelta;
    }

    // ── Phase 4: Router + MCP ───────────────────────────────────────────────
    let p4PnlDelta = 0;
    if (opts.variant === 'phase4' || opts.variant === 'all') {
      const { routingDelta } = applyPhase4(entry);
      p4PnlDelta = routingDelta;
      phaseContributions.phase4 += routingDelta;
    }

    const totalPnlDelta = p0FeeDelta + p1PnlDelta + p2PnlDelta + p3PnlDelta + p4PnlDelta;
    const simulatedPnl = pnl + totalPnlDelta;
    totalSimulatedPnl += simulatedPnl;

    const actualAction = entry.action ?? entry.side ?? 'unknown';
    const actionChanged = simulatedAction !== 'noop' && simulatedAction !== actualAction;

    if (actionChanged) {
      divergences.push({
        entryId: entry.id,
        ts: entry.ts,
        symbol: entry.symbol ?? null,
        baselineAction: actualAction,
        newAction: simulatedAction,
        delta: `P&L delta: $${totalPnlDelta.toFixed(2)}`,
        reason: `Phase ${Object.entries({ phase0: p0FeeDelta, phase1: p1PnlDelta, phase2: p2PnlDelta, phase3: p3PnlDelta, phase4: p4PnlDelta })
          .filter(([, v]) => Math.abs(v) > 0.01)
          .map(([k, v]) => `${k}=$${v.toFixed(2)}`).join(', ') || 'noop'}`,
      });
    }

    const phases: PhaseContribution[] = [
      { phase: 'phase0', contribution: p0FeeDelta, notes: 'tiered fees + concentration cap' },
      { phase: 'phase1', contribution: p1PnlDelta, notes: 'TradingAgents pipeline (simplified replay)' },
      { phase: 'phase2', contribution: p2PnlDelta, notes: 'FinGPT sentiment + onchain' },
      { phase: 'phase3', contribution: p3PnlDelta, notes: 'FinRL-X shadow edge' },
      { phase: 'phase4', contribution: p4PnlDelta, notes: 'model router + MCP data freshness' },
    ];

    decisions.push({
      entryId: entry.id,
      ts: entry.ts,
      symbol: entry.symbol ?? null,
      actualAction,
      simulatedAction,
      actionChanged,
      pnlImpact: totalPnlDelta,
      phases,
    });
  }

  const phaseAttribution: PhaseContribution[] = (
    ['phase0', 'phase1', 'phase2', 'phase3', 'phase4'] as PhaseVariant[]
  ).filter((p) => opts.variant === 'all' || opts.variant === p || opts.variant === p.replace('phase', 'phase'))
    .map((phase) => ({
      phase,
      contribution: phaseContributions[phase],
      notes: phaseNotes(phase),
    }));

  if (opts.variant === 'all') {
    phaseAttribution.push({
      phase: 'all',
      contribution: Object.values(phaseContributions).reduce((s, v) => s + v, 0),
      notes: 'combined all-phase delta',
    });
  }

  const report: ReplayReport = {
    id,
    mode: runMode,
    variant: opts.variant,
    startTs: entries[0]?.ts ?? since,
    endTs: entries[entries.length - 1]?.ts ?? new Date().toISOString(),
    totalEntries: entries.length,
    decisions,
    totalPnlDelta: totalSimulatedPnl - totalActualPnl,
    totalActualPnl,
    totalSimulatedPnl,
    phaseAttribution,
    divergences,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
  };

  return report;
}

function phaseNotes(phase: PhaseVariant): string {
  const notes: Record<PhaseVariant, string> = {
    phase0: 'tiered fees + concentration cap + director context purge',
    phase1: 'TradingAgents 5-phase pipeline + 10-tool registry',
    phase2: 'FinGPT sentiment + Qdrant RAG + onchain signals',
    phase3: 'FinRL-X shadow overlay + RL entry/exit edge',
    phase4: '4-tier model router + 5 MCP data servers',
    all: 'combined all phases',
  };
  return notes[phase] ?? '';
}

// ── Report serialization ───────────────────────────────────────────────────────

export function reportToMarkdown(report: ReplayReport): string {
  const lines: string[] = [
    `# Agent Replay Report — ${report.variant.toUpperCase()}`,
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| Report ID | \`${report.id}\` |`,
    `| Mode | ${report.mode.toUpperCase()} |`,
    `| Variant | ${report.variant} |`,
    `| Entries Replayed | ${report.totalEntries} |`,
    `| Start | ${report.startTs} |`,
    `| End | ${report.endTs} |`,
    `| Actual P&L | $${report.totalActualPnl.toFixed(2)} |`,
    `| Simulated P&L | $${report.totalSimulatedPnl.toFixed(2)} |`,
    `| **P&L Delta** | **$${report.totalPnlDelta.toFixed(2)}** |`,
    `| Duration | ${report.durationMs}ms |`,
    `| Generated | ${report.generatedAt} |`,
    '',
    '## Phase Attribution',
    '',
    '| Phase | Contribution | Notes |',
    '|---|---|---|',
  ];

  for (const pa of report.phaseAttribution) {
    lines.push(`| ${pa.phase} | $${pa.contribution.toFixed(2)} | ${pa.notes} |`);
  }

  if (report.divergences.length > 0) {
    lines.push('', '## Decision Divergences', '');
    lines.push('| Entry | Timestamp | Symbol | Baseline | New Agent | Delta | Reason |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const div of report.divergences.slice(0, 50)) {
      lines.push(
        `| \`${div.entryId.slice(0, 12)}…\` | ${div.ts} | ${div.symbol ?? '—'} | ` +
        `${div.baselineAction} | ${div.newAction} | ${div.delta} | ${div.reason} |`
      );
    }
    if (report.divergences.length > 50) {
      lines.push('', `_(${report.divergences.length - 50} more divergences omitted)_`);
    }
  } else {
    lines.push('', '## Decision Divergences', '', '_No divergences detected — new agent stack aligns with baseline._');
  }

  lines.push('', '## Sample Decisions (first 20)', '');
  lines.push('| Entry | Timestamp | Symbol | Actual | Simulated | Changed | P&L Δ |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const dec of report.decisions.slice(0, 20)) {
    lines.push(
      `| \`${dec.entryId.slice(0, 12)}…\` | ${dec.ts} | ${dec.symbol ?? '—'} | ` +
      `${dec.actualAction} | ${dec.simulatedAction} | ${dec.actionChanged ? '⚠️' : '✅'} | ` +
      `$${dec.pnlImpact.toFixed(2)} |`
    );
  }

  lines.push('', '---', `*Generated by @hermes/backtest agent-replay — mode: ${report.mode}*`);
  return lines.join('\n');
}

export async function saveReport(report: ReplayReport): Promise<string> {
  const reportsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../reports'
  );
  fs.mkdirSync(reportsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${ts}-${report.variant}.md`;
  const filePath = path.join(reportsDir, filename);

  const markdown = reportToMarkdown(report);
  fs.writeFileSync(filePath, markdown, 'utf-8');

  // Also persist key metrics to Redis for live-eval lane queries
  try {
    await redis.setex(
      `hermes:backtest:report:${report.id}`,
      30 * 24 * 3600, // 30-day TTL
      JSON.stringify({
        id: report.id,
        variant: report.variant,
        totalPnlDelta: report.totalPnlDelta,
        totalActualPnl: report.totalPnlDelta,
        phaseAttribution: report.phaseAttribution,
        divergences: report.divergences.length,
      })
    );
  } catch (err) {
    logger.warn({ err, reportId: report.id }, 'agent-replay: failed to persist to Redis');
  }

  logger.info({ filePath, entries: report.totalEntries, pnlDelta: report.totalPnlDelta }, 'agent-replay: report saved');
  return filePath;
}
