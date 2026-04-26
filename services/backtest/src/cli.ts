/**
 * CLI — services/backtest/src/cli.ts
 *
 * Command: pnpm backtest:agents --since=<days> --variant=<phase{0..4}|all>
 *
 * Runs the agent-replay harness + SHAP attribution and writes markdown reports
 * to services/backtest/reports/<timestamp>-<variant>.md
 *
 * SMOKE-MODE: HERMES_BACKTEST_SMOKE=1 → last 24h, max 100 entries, <60s
 * FULL-MODE:  HERMES_BACKTEST_SMOKE=0 → last 90 days, default
 */

import './load-env.js';
import type { PhaseVariant, ReplayReport } from './agent-replay.js';
import { runAgentReplay, reportToMarkdown } from './agent-replay.js';
import { computeAttribution, attributionToMarkdown } from './attribution.js';
import type { AttributionSummary } from './attribution.js';
import { logger } from '@hermes/logger';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ── Argument parsing ──────────────────────────────────────────────────────────

interface CliArgs {
  since?: number;   // days
  variant: PhaseVariant;
  smoke: boolean;
  liveEval: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    variant: 'all',
    smoke: false,
    liveEval: false,
    help: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--since=')) {
      const days = parseInt(arg.slice('--since='.length), 10);
      if (!isNaN(days) && days > 0) args.since = days;
    } else if (arg.startsWith('--variant=')) {
      const v = arg.slice('--variant='.length).trim();
      if (isValidVariant(v)) {
        args.variant = v as PhaseVariant;
      } else {
        console.error(`[backtest:cli] Unknown variant: ${v}. Valid: phase0, phase1, phase2, phase3, phase4, all`);
        process.exit(1);
      }
    } else if (arg === '--smoke') {
      args.smoke = true;
    } else if (arg === '--live-eval') {
      args.liveEval = true;
    }
  }

  // HERMES_BACKTEST_SMOKE env var overrides
  if (process.env.HERMES_BACKTEST_SMOKE === '1') {
    args.smoke = true;
  }

  return args;
}

function isValidVariant(v: string): boolean {
  return ['phase0', 'phase1', 'phase2', 'phase3', 'phase4', 'all'].includes(v);
}

// ── Help ──────────────────────────────────────────────────────────────────────

const HELP = `
Hermes Agent Backtest CLI

USAGE
  pnpm backtest:agents [options]

OPTIONS
  --since=<days>     Number of days to replay (default: 90 for full, 1 for smoke)
  --variant=<phase>  Phase variant: phase0 | phase1 | phase2 | phase3 | phase4 | all
                     (default: all)
  --smoke            Smoke mode: last 24h, max 100 entries, <60s
  --live-eval        Start live-eval lane alongside replay
  --help, -h        Show this help

ENVIRONMENT
  HERMES_BACKTEST_SMOKE=1   Enable smoke mode (same as --smoke)
  HERMES_LIVE_EVAL=on|off   Enable live-eval lane (default: off)

EXAMPLES
  # Smoke test (24h, fast)
  HERMES_BACKTEST_SMOKE=1 pnpm backtest:agents --variant=phase1

  # Full 90-day replay of all phases
  pnpm backtest:agents --variant=all --since=90

  # Replay only Phase 0 (fees + concentration)
  pnpm backtest:agents --variant=phase0 --since=30

  # With live-eval lane
  HERMES_LIVE_EVAL=on pnpm backtest:agents --variant=all

OUTPUT
  Reports written to: services/backtest/reports/<timestamp>-<variant>.md
  Attribution appended to the report.
`.trim();

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(HELP);
    return;
  }

  const runMode = args.smoke ? 'SMOKE' : 'FULL';
  const sinceDays = args.since ?? (args.smoke ? 1 : 90);
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();

  console.log(`[backtest:agents] starting — mode=${runMode} variant=${args.variant} since=${since}`);
  console.log(`[backtest:agents] journal: services/api/.runtime/paper-ledger/journal.jsonl`);

  // ── Live-eval lane ────────────────────────────────────────────────────────
  if (args.liveEval || process.env.HERMES_LIVE_EVAL === 'on') {
    // Dynamic import to avoid loading the live-eval module in non-eval mode
    const { startLiveEvalLane } = await import('./live-eval.js');
    const { started, reason } = await startLiveEvalLane();
    if (started) {
      console.log('[backtest:agents] live-eval lane started');
    } else {
      console.log(`[backtest:agents] live-eval lane not started: ${reason}`);
    }
  }

  // ── Agent replay ───────────────────────────────────────────────────────────
  console.time('[backtest:agents] replay');
  const replayReport = await runAgentReplay({
    variant: args.variant,
    since,
    smoke: args.smoke,
  });
  console.timeEnd('[backtest:agents] replay');

  // ── SHAP attribution ───────────────────────────────────────────────────────
  console.time('[backtest:agents] attribution');
  const attribution = computeAttribution(replayReport);
  const attributionMarkdown = attributionToMarkdown(attribution);
  console.timeEnd('[backtest:agents] attribution');

  // ── Merge attribution into report markdown ─────────────────────────────────
  const reportsDir = path.resolve(__dir, '../reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${ts}-${args.variant}.md`;
  const filePath = path.join(reportsDir, filename);

  const reportMarkdown = buildFullReport(replayReport, attribution, attributionMarkdown);
  fs.writeFileSync(filePath, reportMarkdown, 'utf-8');

  // ── Console summary ────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════');
  console.log(`  BACKTEST REPORT — ${args.variant.toUpperCase()} [${runMode}]`);
  console.log('═══════════════════════════════════════');
  console.log(`  Entries:          ${replayReport.totalEntries}`);
  console.log(`  Actual P&L:       $${replayReport.totalActualPnl.toFixed(2)}`);
  console.log(`  Simulated P&L:    $${replayReport.totalSimulatedPnl.toFixed(2)}`);
  console.log(`  P&L Delta:        $${replayReport.totalPnlDelta.toFixed(2)}`);
  console.log(`  Dominant phase:   ${attribution.dominantPhase ?? 'N/A'}`);
  console.log(`  p-value:          ${attribution.pValue !== null ? attribution.pValue.toFixed(4) : 'N/A'}`);
  console.log(`  95% CI:           [$${attribution.confidenceInterval[0]?.toFixed(2)}, $${attribution.confidenceInterval[1]?.toFixed(2)}]`);
  console.log(`  Divergences:      ${replayReport.divergences.length}`);
  console.log(`  Duration:         ${replayReport.durationMs}ms`);
  console.log(`  Report:           ${filePath}`);
  console.log('═══════════════════════════════════════\n');

  // ── Promotion gate check ────────────────────────────────────────────────────
  if (!args.smoke) {
    const pass = checkPromotionGate(replayReport, attribution);
    if (pass) {
      console.log('✅  PROMOTION GATE: PASS — ready for shadow live evaluation');
    } else {
      console.warn('⚠️  PROMOTION GATE: FAIL — do not ship to live capital');
    }
  } else {
    console.log('[smoke] Promotion gate skipped (smoke mode)');
  }

  logger.info(
    {
      variant: args.variant,
      mode: runMode,
      entries: replayReport.totalEntries,
      pnlDelta: replayReport.totalPnlDelta,
      dominantPhase: attribution.dominantPhase,
      reportPath: filePath,
    },
    'backtest:agents: complete'
  );
}

function buildFullReport(
  replay: ReplayReport,
  attribution: AttributionSummary,
  attributionMarkdown: string
): string {
  return [
    reportToMarkdown(replay),
    '\n\n---\n\n',
    attributionMarkdown,
    '\n\n---\n\n',
    '## Live-Eval Lane Status',
    '',
    '| Flag | Value |',
    '|---|---|',
    `| HERMES_LIVE_EVAL | ${process.env.HERMES_LIVE_EVAL ?? 'not set'} |`,
    `| Mode | ${replay.mode.toUpperCase()} |`,
    '',
    `*Report generated at ${new Date().toISOString()}*`,
  ].join('\n');
}

function checkPromotionGate(
  replay: { totalPnlDelta: number; divergences: Array<unknown> },
  attr: { pValue: number | null; confidenceInterval: [number, number] }
): boolean {
  // Rule: positive net P&L delta AND p < 0.05 AND CI lower bound > 0
  const pnlPositive = replay.totalPnlDelta > 0;
  const significant = attr.pValue !== null && attr.pValue < 0.05;
  const ciPositive = attr.confidenceInterval[0] > 0;
  return pnlPositive && significant && ciPositive;
}

main(process.argv).catch((err) => {
  console.error('[backtest:agents] fatal:', err);
  process.exit(1);
});
