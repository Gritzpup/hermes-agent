/**
 * Memory Agent — Kimi-powered Weekly Strategy Summarizer
 *
 * Reads the last 7 days of journal entries from the paper-ledger journal.jsonl,
 * composes a structured memo prompt, and dispatches it to Kimi via the CLI
 * subprocess (`kimi -p "$(cat /tmp/memory-agent-prompt.txt)" --no-session`).
 *
 * The resulting memo is upserted to the Qdrant 'journal_events' collection
 * for long-horizon RAG context.
 *
 * A cron-like scheduler fires once per week (every Sunday at 20:00 UTC) and
 * calls summarizeWeek() for every active strategyId found in the journal.
 */

import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '@hermes/logger';
import { upsert, COLLECTIONS } from './qdrant.js';

/* ── Config ───────────────────────────────────────────────────────── */

const JOURNAL_PATH = process.env.JOURNAL_PATH ??
  path.resolve(process.cwd(), '../../api/.runtime/paper-ledger/journal.jsonl');

const WEEK_MS   = 7 * 24 * 60 * 60 * 1_000;
const KIMI_HARD_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

// Cron-like: run every Sunday at 20:00 UTC
const CRON_DAY_UTC  = 0;   // Sunday
const CRON_HOUR_UTC = 20;

/* ── Types ────────────────────────────────────────────────────────── */

export interface JournalEntry {
  strategyId?:  string;
  symbol?:      string;
  action?:      string;
  pnl?:         number;
  regime?:      string;
  timestamp?:   string;
  [key: string]: unknown;
}

export interface WeeklySummary {
  strategyId:  string;
  weekStart:   string;
  weekEnd:     string;
  totalTrades: number;
  pnlSum:      number;
  winRate:     number;
  memo:        string;
  timestamp:   string;
}

/* ── Journal reader ────────────────────────────────────────────────── */

function readJournalEntries(strategyId: string, lookbackMs: number): JournalEntry[] {
  const cutoff = Date.now() - lookbackMs;
  const entries: JournalEntry[] = [];

  try {
    if (!fsSync.existsSync(JOURNAL_PATH)) {
      logger.warn({ JOURNAL_PATH }, 'memory: journal.jsonl not found — returning empty entries');
      return [];
    }

    const lines = fsSync.readFileSync(JOURNAL_PATH, 'utf8').split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JournalEntry;
        const ts = entry.timestamp
          ? new Date(entry.timestamp).getTime()
          : null;

        if (ts !== null && ts < cutoff) continue;
        if (strategyId && entry.strategyId !== strategyId) continue;

        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }
  } catch (err) {
    logger.error({ err, JOURNAL_PATH }, 'memory: failed to read journal');
  }

  return entries;
}

/* ── Stats from entries ─────────────────────────────────────────────── */

function computeStats(entries: JournalEntry[]): {
  totalTrades: number;
  pnlSum:      number;
  winCount:    number;
} {
  const trades = entries.filter((e) => e.action === 'fill' || e.action === 'close' || e.action === 'trade');
  const pnlSum  = trades.reduce((sum, e) => sum + (typeof e.pnl === 'number' ? e.pnl : 0), 0);
  const winCount = trades.filter((e) => typeof e.pnl === 'number' && e.pnl > 0).length;

  return {
    totalTrades: trades.length,
    pnlSum,
    winCount,
  };
}

/* ── Build memo prompt ─────────────────────────────────────────────── */

function buildMemoPrompt(
  strategyId: string,
  entries: JournalEntry[],
  stats:    ReturnType<typeof computeStats>,
  weekStart: string,
  weekEnd:   string,
): string {
  const winRate = stats.totalTrades > 0
    ? ((stats.winCount / stats.totalTrades) * 100).toFixed(1)
    : 'N/A';

  const entriesSnippet = entries
    .slice(0, 30)
    .map((e) => JSON.stringify(e))
    .join('\n');

  return `You are Hermes Trading Firm's Memory Agent.
Summarize the trading outcomes for strategy **${strategyId}** over the past week (${weekStart} → ${weekEnd}).

**Stats:**
- Total trades: ${stats.totalTrades}
- Net PnL (USD): ${stats.pnlSum.toFixed(2)}
- Win rate: ${winRate}%

**Recent journal entries (up to 30):**
${entriesSnippet}

Write a structured memo with these sections:
1. **Week Overview** — one-paragraph summary of what happened.
2. **Regime Changes** — note any regime or market-condition shifts.
3. **Win/Loss Patterns** — what worked, what didn't.
4. **Surprises** — unexpected events or deviations from expectation.
5. **Recommendations** — actionable notes for the coming week.

Respond ONLY with the memo. Do not include any preamble or explanation.`;
}

/* ── Invoke Kimi CLI subprocess ───────────────────────────────────── */

async function invokeKimi(prompt: string): Promise<string> {
  const promptFile = '/tmp/memory-agent-prompt.txt';

  // Write prompt to temp file (kimi CLI takes input via stdin or file)
  fsSync.writeFileSync(promptFile, prompt, 'utf8');

  return new Promise((resolve, reject) => {
    const kid = spawn(
      'kimi',
      ['-p', prompt, '--no-session'],
      { timeout: KIMI_HARD_TIMEOUT_MS },
    );

    let stdout = '';
    let stderr = '';

    kid.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    kid.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    // Safety: hard-kill after 10 min
    const killTimer = setTimeout(() => {
      kid.kill('SIGTERM');
      reject(new Error(`kimi subprocess exceeded ${KIMI_HARD_TIMEOUT_MS / 1000}s hard timeout`));
    }, KIMI_HARD_TIMEOUT_MS);

    kid.on('close', (code: number | null) => {
      clearTimeout(killTimer);
      if (code === 0 || stdout.length > 0) {
        resolve(stdout.trim());
      } else {
        logger.warn({ code, stderr }, 'memory: kimi CLI exited non-zero with no stdout');
        reject(new Error(`kimi CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    kid.on('error', (err: Error) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

/* ── Core summarization ────────────────────────────────────────────── */

export async function summarizeWeek(strategyId: string): Promise<WeeklySummary | null> {
  const now    = new Date();
  const weekEnd   = now.toISOString();
  const weekStart = new Date(now.getTime() - WEEK_MS).toISOString();

  const entries = readJournalEntries(strategyId, WEEK_MS);
  if (entries.length === 0) {
    logger.info({ strategyId }, 'memory: no journal entries found for strategy this week');
    return null;
  }

  const stats = computeStats(entries);
  const prompt = buildMemoPrompt(strategyId, entries, stats, weekStart, weekEnd);

  let memo = '';
  try {
    memo = await invokeKimi(prompt);
  } catch (err) {
    logger.error({ err, strategyId }, 'memory: kimi call failed — writing stub memo');
    memo = [
      `## Weekly Summary — ${strategyId} (${weekStart.slice(0, 10)} → ${weekEnd.slice(0, 10)})`,
      '',
      `*Memory agent was unable to reach Kimi. Stats: ${stats.totalTrades} trades, PnL $${stats.pnlSum.toFixed(2)}, ${stats.winCount} wins.*`,
    ].join('\n');
  }

  const summary: WeeklySummary = {
    strategyId,
    weekStart,
    weekEnd,
    totalTrades: stats.totalTrades,
    pnlSum:      stats.pnlSum,
    winRate:     stats.totalTrades > 0 ? stats.winCount / stats.totalTrades : 0,
    memo,
    timestamp:   new Date().toISOString(),
  };

  // Upsert to Qdrant (fire-and-forget; failure is non-critical)
  const qdrantId = `mem:${strategyId}:${weekStart.slice(0, 10)}`;
  void upsert(COLLECTIONS.JOURNAL_EVENTS, qdrantId, {
    strategyId:  summary.strategyId,
    weekStart:   summary.weekStart,
    weekEnd:     summary.weekEnd,
    totalTrades: summary.totalTrades,
    pnlSum:      summary.pnlSum,
    winRate:     summary.winRate,
    text:        summary.memo,
    timestamp:   summary.timestamp,
  }).catch((e) => logger.warn({ e, strategyId }, 'memory: Qdrant upsert failed'));

  logger.info({ strategyId, trades: stats.totalTrades, pnl: stats.pnlSum }, 'memory: weekly summary written');

  return summary;
}

/* ── Active strategy discovery ────────────────────────────────────── */

function discoverActiveStrategyIds(): string[] {
  // Heuristic: strategies that appear in the last 14 days of the journal
  const lookbackMs = 14 * 24 * 60 * 60 * 1_000;
  const cutoff = Date.now() - lookbackMs;
  const seen   = new Set<string>();

  try {
    if (!fsSync.existsSync(JOURNAL_PATH)) return [];
    const lines = fsSync.readFileSync(JOURNAL_PATH, 'utf8').split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JournalEntry;
        const ts   = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
        if (ts !== null && ts >= cutoff && entry.strategyId) {
          seen.add(entry.strategyId);
        }
      } catch {
        // skip
      }
    }
  } catch (err) {
    logger.error({ err, JOURNAL_PATH }, 'memory: failed to discover strategy IDs');
  }

  return Array.from(seen);
}

/* ── Cron-like scheduler ───────────────────────────────────────────── */

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastWeeklyRun = 0;

function scheduleNextWeekly(): void {
  const now      = new Date();
  const nextSunday = new Date(now);
  nextSunday.setUTCDate(now.getUTCDate() + ((CRON_DAY_UTC + 7 - now.getUTCDay()) % 7 || 7));
  nextSunday.setUTCHours(CRON_HOUR_UTC, 0, 0, 0);
  if (nextSunday <= now) nextSunday.setUTCDate(nextSunday.getUTCDate() + 7);

  const delayMs = nextSunday.getTime() - now.getTime();
  logger.info({ delayMs, nextRun: nextSunday.toISOString() }, 'memory: next weekly run scheduled');

  setTimeout(async () => {
    await runWeeklySummaries();
    scheduleNextWeekly();
  }, delayMs);
}

async function runWeeklySummaries(): Promise<void> {
  const weekAgo = Date.now() - lastWeeklyRun;
  // Don't re-run if already run in the last 5 days
  if (lastWeeklyRun > 0 && weekAgo < 5 * 24 * 60 * 60 * 1_000) {
    logger.info('memory: skipping weekly run (already ran recently)');
    return;
  }

  lastWeeklyRun = Date.now();
  const strategyIds = discoverActiveStrategyIds();
  logger.info({ count: strategyIds.length }, 'memory: starting weekly summaries');

  await Promise.allSettled(
    strategyIds.map((id) => summarizeWeek(id)),
  );
}

/**
 * Start the memory agent scheduler.
 * Call this from research-agent's index.ts bootstrap.
 */
export function startMemoryScheduler(): void {
  logger.info('starting memory scheduler (weekly on Sundays 20:00 UTC)');

  // Also do an immediate catch-up run on startup so Qdrant is seeded
  void runWeeklySummaries();

  scheduleNextWeekly();
}

/**
 * Manually trigger a weekly summary for one or all strategies.
 * Useful for ad-hoc runs via an HTTP endpoint.
 */
export async function triggerWeeklySummary(strategyId?: string): Promise<WeeklySummary[]> {
  const ids = strategyId ? [strategyId] : discoverActiveStrategyIds();
  return (await Promise.allSettled(ids.map((id) => summarizeWeek(id))))
    .filter((r): r is PromiseFulfilledResult<WeeklySummary | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((s): s is WeeklySummary => s !== null);
}
