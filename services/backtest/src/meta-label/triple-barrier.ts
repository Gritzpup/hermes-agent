/**
 * Triple-Barrier Label Generator
 *
 * Reads closed trades from the paper ledger journal, computes triple-barrier labels,
 * and writes a labeled dataset for Phase 3 model training (xgboost).
 *
 * Barrier rules:
 *   +1  if exitReason === 'take-profit' OR pnl > +X% (X = takeProfitPct from config, default 0.5%)
 *   -1  if exitReason === 'stop-loss' OR pnl < -X%
 *    0  if time-based exit (neither barrier hit)
 *
 * Features per trade: pnlBps, holdTicks, entryConfidence, sessionQuality, regime, realizedCostBps
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_JOURNAL_PATH = process.env.JOURNAL_LEDGER_PATH
  ?? path.resolve(MODULE_DIR, '../../../api/.runtime/paper-ledger/journal.jsonl');
const DEFAULT_OUTPUT_PATH = process.env.TRIPLE_BARRIER_OUTPUT_PATH
  ?? path.resolve(MODULE_DIR, '../../../api/.runtime/paper-ledger/triple-barrier.jsonl');
const DEFAULT_TP_PCT = 0.5; // default take-profit threshold %

interface TradeJournalEntry {
  id: string;
  symbol: string;
  strategyId?: string;
  strategy?: string;
  lane?: string;
  entryAt: string;
  exitAt: string;
  realizedPnl: number;
  realizedPnlPct: number;
  holdTicks?: number;
  confidencePct?: number;
  regime?: string;
  exitReason: string;
  orderFlowBias?: string;
  macroVeto?: boolean;
  tags?: string[];
  realizedCostBps?: number;
}

interface TripleBarrierRecord {
  entryAt: string;
  symbol: string;
  strategyId: string;
  features: {
    pnlBps: number;
    holdTicks: number;
    entryConfidence: number;
    sessionQuality: number;
    regime: number;
    realizedCostBps: number;
  };
  label: 1 | -1 | 0;
}

/**
 * Compute session quality score (0-1) based on tags and order flow.
 * Higher = better trading conditions.
 */
function sessionQuality(entry: TradeJournalEntry): number {
  let score = 0.5; // neutral baseline
  const tags = entry.tags ?? [];
  // Good conditions
  if (tags.includes('session-asia') || tags.includes('session-london') || tags.includes('session-ny')) score += 0.1;
  if (entry.orderFlowBias === 'bullish' || entry.orderFlowBias === 'bearish') score += 0.15;
  if (!entry.macroVeto) score += 0.1;
  // Bad conditions
  if (tags.includes('low-volume') || tags.includes('high-spread')) score -= 0.2;
  if (tags.includes('embargoed')) score -= 0.3;
  return Math.max(0, Math.min(1, score));
}

/**
 * Regime to numeric encoding.
 */
function regimeCode(regime?: string): number {
  const map: Record<string, number> = {
    trending: 1, breakout: 2, mean_revert: 3, chop: 4,
    risk_on: 5, risk_off: 6, volatile: 7, calm: 8,
  };
  return map[regime?.toLowerCase() ?? ''] ?? 0;
}

/**
 * Apply triple-barrier labeling rules.
 * tpPct: take-profit threshold as decimal fraction (e.g. 0.005 = 0.5%)
 * slPct: stop-loss threshold as decimal fraction (e.g. 0.005 = 0.5%)
 */
function labelTrade(entry: TradeJournalEntry, tpPct = DEFAULT_TP_PCT, _slPct = DEFAULT_TP_PCT): 1 | -1 | 0 {
  const pnlPct = entry.realizedPnlPct ?? 0;
  const exit = (entry.exitReason ?? '').toLowerCase();

  if (exit === 'take-profit' || pnlPct > tpPct * 100) return 1;
  if (exit === 'stop-loss' || pnlPct < -tpPct * 100) return -1;
  return 0;
}

/**
 * Read journal entries from a JSONL file.
 */
function readJournal(journalPath: string): TradeJournalEntry[] {
  try {
    if (!fs.existsSync(journalPath)) return [];
    const content = fs.readFileSync(journalPath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TradeJournalEntry)
      .filter((entry) => entry.exitAt && entry.realizedPnl !== undefined);
  } catch {
    return [];
  }
}

/**
 * Write labeled records to a JSONL file.
 */
function writeLabels(outputPath: string, records: TripleBarrierRecord[]): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(outputPath, lines, 'utf8');
}

/**
 * Generate triple-barrier labels from a journal.
 *
 * @param journalPath  Path to journal.jsonl (or env JOURNAL_LEDGER_PATH)
 * @param outputPath   Path to write triple-barrier.jsonl
 * @returns summary counts
 */
export async function generateTripleBarrierLabels(
  journalPath: string = DEFAULT_JOURNAL_PATH,
  outputPath: string = DEFAULT_OUTPUT_PATH
): Promise<{ count: number; positives: number; negatives: number; neutrals: number }> {
  const entries = readJournal(journalPath);
  const records: TripleBarrierRecord[] = [];

  for (const entry of entries) {
    const label = labelTrade(entry);
    records.push({
      entryAt: entry.entryAt,
      symbol: entry.symbol,
      strategyId: entry.strategyId ?? entry.strategy ?? 'unknown',
      features: {
        pnlBps: Math.round(entry.realizedPnlPct * 100), // convert % to bps
        holdTicks: entry.holdTicks ?? 0,
        entryConfidence: entry.confidencePct ?? 0.5,
        sessionQuality: sessionQuality(entry),
        regime: regimeCode(entry.regime),
        realizedCostBps: entry.realizedCostBps ?? 0,
      },
      label,
    });
  }

  writeLabels(outputPath, records);

  const positives = records.filter((r) => r.label === 1).length;
  const negatives = records.filter((r) => r.label === -1).length;
  const neutrals = records.filter((r) => r.label === 0).length;

  return { count: records.length, positives, negatives, neutrals };
}
