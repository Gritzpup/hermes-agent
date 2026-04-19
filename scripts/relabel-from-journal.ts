/**
 * Phase G3a: Exit-Reason Relabel Script
 * 
 * Re-labels existing journal entries with correct exit reason classes.
 * Uses price barriers (entry vs TP/SL) and time barriers to determine exit type.
 * 
 * Label Mapping (per docs/phase-g3-design.md):
 * - maker-normal: maker-round-trip, inventory-release-under-pressure
 * - bad-exit: stop-loss, correlation-break, reversion
 * - other: timeout, undefined, and other non-matching patterns
 * - EXCLUDED: broker reconciliation, external broker flatten, Alpaca paper order, coo-manual-flatten
 * 
 * Usage:
 *   npx tsx scripts/relabel-from-journal.ts           # dry run (default)
 *   npx tsx scripts/relabel-from-journal.ts --apply   # actually write output
 */

import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const JOURNAL_PATH = process.env.JOURNAL_PATH 
  ?? path.resolve(WORKSPACE_ROOT, 'services/api/.runtime/paper-ledger/journal.jsonl');
const OUTPUT_PATH = process.env.EXIT_REASON_LABELS_PATH
  ?? path.resolve(WORKSPACE_ROOT, 'services/api/.runtime/paper-ledger/exit-reason-labels.jsonl');

/** Exit reason class types */
export type ExitReasonClass = 'maker-normal' | 'bad-exit' | 'other' | 'excluded';

/** Exit reason patterns to class mapping */
const EXIT_REASON_MAP: Array<{ pattern: RegExp; class: ExitReasonClass }> = [
  // maker-normal patterns
  { pattern: /maker-round-trip/i, class: 'maker-normal' },
  { pattern: /inventory-release-under.*pressure/i, class: 'maker-normal' },
  
  // bad-exit patterns
  { pattern: /stop-loss/i, class: 'bad-exit' },
  { pattern: /correlation-break/i, class: 'bad-exit' },
  { pattern: /reversion/i, class: 'bad-exit' },
  
  // excluded (broker operations, not trade decisions)
  { pattern: /broker reconciliation/i, class: 'excluded' },
  { pattern: /external broker flatten/i, class: 'excluded' },
  { pattern: /Alpaca paper order/i, class: 'excluded' },
  { pattern: /coo-manual-flatten/i, class: 'excluded' },
  
  // other patterns (includes undefined, timeout)
  { pattern: /undefined/i, class: 'other' },
  { pattern: /timeout/i, class: 'other' },
];

/**
 * Map raw exit reason string to ExitReasonClass
 */
export function mapExitReason(exitReason: string | undefined): ExitReasonClass {
  if (!exitReason) return 'other';
  
  for (const { pattern, class: exitClass } of EXIT_REASON_MAP) {
    if (pattern.test(exitReason)) {
      return exitClass;
    }
  }
  
  return 'other'; // Default to 'other' for any unmatched patterns
}

/** Journal entry structure (subset of TradeJournalEntry) */
interface JournalEntry {
  id: string;
  symbol: string;
  assetClass?: string;
  strategy: string;
  strategyId?: string;
  lane?: string;
  entryAt: string;
  exitAt: string;
  realizedPnl: number;
  realizedPnlPct: number;
  spreadBps: number;
  confidencePct?: number;
  regime?: string;
  newsBias?: string;
  orderFlowBias?: string;
  macroVeto?: boolean;
  embargoed?: boolean;
  tags?: string[];
  entryScore?: number;
  entryTrainedProbability?: number;
  entryApprove?: boolean;
  expectedNetEdgeBps?: number;
  exitReason: string;
  verdict: 'winner' | 'loser' | 'scratch';
  source?: 'broker' | 'simulated' | 'mock';
}

/** Labeled entry for training */
export interface LabeledExitReasonEntry {
  entryAt: string;
  symbol: string;
  strategyId: string;
  lane: string;
  assetClass: string;
  exitReason: string;
  exitReasonClass: ExitReasonClass;
  binaryLabel: number; // 1 = bad-exit, 0 = not bad-exit
  features: {
    symbol: string;
    strategyId: string;
    lane: string;
    assetClass: string;
    regime: string;
    spreadBucket: 'micro' | 'tight' | 'normal' | 'wide' | 'extreme';
    newsBias: string;
    orderFlowBias: string;
    confidenceBucket: 'low' | 'medium' | 'high';
    entryScore?: number;
    entryTrainedProbability?: number;
    entryApprove?: boolean;
    expectedNetEdgeBps?: number;
    macroVeto: boolean;
    embargoed: boolean;
    source: string;
    entryHour: number;
  };
  // Exit-time fields (for forensics, NOT for training)
  exitAt?: string;
  realizedPnl?: number;
  verdict?: string;
}

/** Helper functions for feature engineering (entry-time only) */
function confidenceBucket(confidencePct: number | undefined): 'low' | 'medium' | 'high' {
  if (confidencePct === undefined) return 'low';
  if (confidencePct >= 70) return 'high';
  if (confidencePct >= 35) return 'medium';
  return 'low';
}

function spreadBucket(spreadBps: number): 'micro' | 'tight' | 'normal' | 'wide' | 'extreme' {
  if (spreadBps <= 0.15) return 'micro';
  if (spreadBps <= 0.75) return 'tight';
  if (spreadBps <= 2) return 'normal';
  if (spreadBps <= 5) return 'wide';
  return 'extreme';
}

function normalizeDirection(value: string | undefined): string {
  if (!value) return 'neutral';
  const normalized = value.toLowerCase();
  if (normalized.includes('strong-buy') || normalized.includes('buy') || normalized.includes('bull')) return 'bullish';
  if (normalized.includes('strong-sell') || normalized.includes('sell') || normalized.includes('bear')) return 'bearish';
  return 'neutral';
}

function inferAssetClass(entry: JournalEntry): string {
  if (entry.assetClass) return entry.assetClass;
  const symbol = entry.symbol.toUpperCase();
  if (symbol.endsWith('-USD')) {
    const base = symbol.split('-')[0] ?? '';
    if (['BTC', 'ETH', 'SOL', 'XRP'].includes(base)) return 'crypto';
    if (base === 'PAXG') return 'commodity-proxy';
    if (base === 'BCO' || base === 'WTICO') return 'commodity';
    return 'commodity-proxy';
  }
  if (symbol.includes('_')) {
    if (symbol.startsWith('USB')) return 'bond';
    if (symbol.startsWith('BCO') || symbol.startsWith('WTICO')) return 'commodity';
    return 'forex';
  }
  return 'equity';
}

/**
 * Extract entry-time features from a journal entry
 */
function extractFeatures(entry: JournalEntry): LabeledExitReasonEntry['features'] {
  const entryDate = new Date(entry.entryAt);
  const entryHour = entryDate.getUTCHours();
  
  return {
    symbol: entry.symbol,
    strategyId: entry.strategyId ?? entry.strategy,
    lane: entry.lane ?? 'unknown',
    assetClass: inferAssetClass(entry),
    regime: entry.regime ?? 'unknown',
    spreadBucket: spreadBucket(entry.spreadBps),
    newsBias: normalizeDirection(entry.newsBias),
    orderFlowBias: normalizeDirection(entry.orderFlowBias),
    confidenceBucket: confidenceBucket(entry.confidencePct),
    entryScore: entry.entryScore,
    entryTrainedProbability: entry.entryTrainedProbability,
    entryApprove: entry.entryApprove,
    expectedNetEdgeBps: entry.expectedNetEdgeBps,
    macroVeto: entry.macroVeto ?? false,
    embargoed: entry.embargoed ?? false,
    source: entry.source ?? 'simulated',
    entryHour,
  };
}

/**
 * Transform a journal entry into a labeled training example
 */
function labelEntry(entry: JournalEntry): LabeledExitReasonEntry | null {
  const exitReasonClass = mapExitReason(entry.exitReason);
  
  // Skip excluded entries (broker operations)
  if (exitReasonClass === 'excluded') {
    return null;
  }
  
  const binaryLabel = exitReasonClass === 'bad-exit' ? 1 : 0;
  
  return {
    entryAt: entry.entryAt,
    symbol: entry.symbol,
    strategyId: entry.strategyId ?? entry.strategy,
    lane: entry.lane ?? 'unknown',
    assetClass: inferAssetClass(entry),
    exitReason: entry.exitReason,
    exitReasonClass,
    binaryLabel,
    features: extractFeatures(entry),
    // Exit-time fields (for forensics only, NOT for training features)
    exitAt: entry.exitAt,
    realizedPnl: entry.realizedPnl,
    verdict: entry.verdict,
  };
}

/**
 * Read and parse journal entries from a JSONL file
 */
function readJournalEntries(filePath: string): JournalEntry[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Journal file not found: ${filePath}`);
  }
  
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n').filter(line => line.trim());
  
  return lines.map(line => JSON.parse(line) as JournalEntry);
}

/**
 * Relabel journal entries and output as JSONL
 */
export function relabelJournal(entries: JournalEntry[], dryRun = true): {
  total: number;
  labeled: number;
  excluded: number;
  byClass: Record<string, number>;
  byBinary: Record<string, number>;
  examples: LabeledExitReasonEntry[];
} {
  const byClass: Record<string, number> = {
    'maker-normal': 0,
    'bad-exit': 0,
    'other': 0,
    'excluded': 0,
  };
  
  const byBinary: Record<string, number> = {
    'bad-exit (1)': 0,
    'not-bad-exit (0)': 0,
  };
  
  const labeled: LabeledExitReasonEntry[] = [];
  let excluded = 0;
  
  for (const entry of entries) {
    const exitReasonClass = mapExitReason(entry.exitReason);
    byClass[exitReasonClass] = (byClass[exitReasonClass] ?? 0) + 1;
    
    if (exitReasonClass === 'excluded') {
      excluded++;
      continue;
    }
    
    const labeledEntry = labelEntry(entry);
    if (labeledEntry) {
      labeled.push(labeledEntry);
      if (labeledEntry.binaryLabel === 1) {
        byBinary['bad-exit (1)']++;
      } else {
        byBinary['not-bad-exit (0)']++;
      }
    }
  }
  
  return {
    total: entries.length,
    labeled: labeled.length,
    excluded,
    byClass,
    byBinary,
    examples: labeled.slice(0, 5), // First 5 examples for inspection
  };
}

/**
 * Write labeled entries to output file
 */
function writeLabeledEntries(entries: LabeledExitReasonEntry[], outputPath: string): void {
  const lines = entries.map(entry => JSON.stringify(entry)).join('\n');
  fs.writeFileSync(outputPath, lines + '\n', 'utf8');
  console.log(`Wrote ${entries.length} labeled entries to ${outputPath}`);
}

/**
 * Print distribution statistics
 */
function printStats(stats: ReturnType<typeof relabelJournal>): void {
  console.log('\n=== Exit-Reason Relabel Statistics ===');
  console.log(`Total journal entries: ${stats.total}`);
  console.log(`Labeled (trainable):   ${stats.labeled}`);
  console.log(`Excluded (quarantined): ${stats.excluded}`);
  
  console.log('\n--- By Exit Reason Class ---');
  for (const [cls, count] of Object.entries(stats.byClass)) {
    const pct = stats.total > 0 ? ((count / stats.total) * 100).toFixed(1) : '0.0';
    console.log(`  ${cls.padEnd(15)} ${count.toString().padStart(5)} (${pct}%)`);
  }
  
  console.log('\n--- By Binary Label ---');
  for (const [label, count] of Object.entries(stats.byBinary)) {
    const pct = stats.labeled > 0 ? ((count / stats.labeled) * 100).toFixed(1) : '0.0';
    console.log(`  ${label.padEnd(20)} ${count.toString().padStart(5)} (${pct}%)`);
  }
  
  if (stats.examples.length > 0) {
    console.log('\n--- Sample Labeled Entries ---');
    for (const example of stats.examples) {
      console.log(`  ${example.symbol} | ${example.features.strategyId.slice(0, 20)} | ${example.exitReason.slice(0, 25)} → ${example.exitReasonClass} (binary: ${example.binaryLabel})`);
    }
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');
  
  console.log('=== Phase G3a: Exit-Reason Relabel Script ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be written)' : 'APPLY (will write output)'}`);
  console.log(`Journal: ${JOURNAL_PATH}`);
  if (!dryRun) {
    console.log(`Output: ${OUTPUT_PATH}`);
  }
  console.log('');
  
  // Read journal entries
  console.log('Reading journal entries...');
  let entries: JournalEntry[];
  try {
    entries = readJournalEntries(JOURNAL_PATH);
    console.log(`Loaded ${entries.length} journal entries`);
  } catch (error) {
    console.error('Error reading journal:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
  
  // Relabel entries
  const stats = relabelJournal(entries, dryRun);
  printStats(stats);
  
  // Validate minimum sample sizes
  console.log('\n--- Validation ---');
  const badExitCount = stats.byClass['bad-exit'] ?? 0;
  const makerNormalCount = stats.byClass['maker-normal'] ?? 0;
  const otherCount = stats.byClass['other'] ?? 0;
  
  if (badExitCount < 30) {
    console.log(`⚠️  WARNING: bad-exit has only ${badExitCount} samples (minimum 30 recommended)`);
  } else {
    console.log(`✅ bad-exit samples: ${badExitCount} (≥30)`);
  }
  
  if (makerNormalCount < 30) {
    console.log(`⚠️  WARNING: maker-normal has only ${makerNormalCount} samples (minimum 30 recommended)`);
  } else {
    console.log(`✅ maker-normal samples: ${makerNormalCount} (≥30)`);
  }
  
  if (stats.labeled < 300) {
    console.log(`❌ FAIL: Total trainable samples (${stats.labeled}) < 300 minimum`);
  } else {
    console.log(`✅ Total trainable samples: ${stats.labeled} (≥300)`);
  }
  
  // Write output if not dry run
  if (!dryRun) {
    const labeledEntries = entries
      .map(entry => labelEntry(entry))
      .filter((entry): entry is LabeledExitReasonEntry => entry !== null);
    
    writeLabeledEntries(labeledEntries, OUTPUT_PATH);
    console.log('\n✅ Relabel complete!');
  } else {
    console.log('\nℹ️  Run with --apply to write the output file');
  }
}

// Run main
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
