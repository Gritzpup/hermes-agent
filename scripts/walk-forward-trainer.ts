/**
 * Walk-Forward Trainer CLI
 * Phase G4 — Walk-Forward Validation
 *
 * CLI entry point for running walk-forward training folds.
 * Usage:
 *   npx tsx scripts/walk-forward-trainer.ts --symbol BTC-USD --start 2026-01-01 --end 2026-04-01 --style momentum --targetBps 8 --stopBps 5 --hold 120 --size 0.05
 */

import { fetchCandles } from '../services/backtest/src/historical-data.js';
import { buildFoldWindows, WF_MAX_FOLDS, WF_MIN_TRAIN_WINDOW_MS, WF_PURGE_BUFFER_MS, WF_VALIDATION_WINDOW_MS } from './walk-forward-partitioner.js';
import type { BacktestAgentConfig } from '@hermes/contracts';

const BACKTEST_URL = process.env.BACKTEST_SERVICE_URL ?? 'http://localhost:4305';

async function runBacktest(
  agentConfig: BacktestAgentConfig,
  symbol: string,
  startDate: string,
  endDate: string
): Promise<any> {
  const response = await fetch(`${BACKTEST_URL}/backtest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentConfig, symbol, startDate, endDate })
  });
  if (!response.ok) throw new Error(`Backtest failed: ${response.status}`);
  return response.json();
}

function parseArgs(): {
  symbol: string;
  start: string;
  end: string;
  config: BacktestAgentConfig;
} {
  const args = process.argv.slice(2);
  let symbol = 'BTC-USD';
  let start = '';
  let end = new Date().toISOString().split('T')[0]!;
  let style: BacktestAgentConfig['style'] = 'momentum';
  let targetBps = 8;
  let stopBps = 5;
  let maxHoldTicks = 120;
  let sizeFraction = 0.05;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--symbol': symbol = args[++i] ?? symbol; break;
      case '--start':  start = args[++i] ?? start;  break;
      case '--end':    end = args[++i] ?? end;        break;
      case '--style':  style = (args[++i] ?? 'momentum') as BacktestAgentConfig['style']; break;
      case '--targetBps':   targetBps = Number(args[++i]);    break;
      case '--stopBps':     stopBps = Number(args[++i]);      break;
      case '--hold':        maxHoldTicks = Number(args[++i]); break;
      case '--size':        sizeFraction = Number(args[++i]);  break;
    }
  }

  if (!start) {
    const d = new Date(end);
    d.setDate(d.getDate() - 90);
    start = d.toISOString().split('T')[0]!;
  }

  const config: BacktestAgentConfig = { style, targetBps, stopBps, maxHoldTicks, cooldownTicks: 5, sizeFraction, spreadLimitBps: 3 };
  return { symbol, start, end, config };
}

async function main() {
  const { symbol, start, end, config } = parseArgs();
  console.log(`[wf-trainer] Training ${symbol} (${start} → ${end})`);
  console.log(`[wf-trainer] Config:`, JSON.stringify(config));

  const candles = await fetchCandles(symbol, start, end);
  if (candles.length === 0) {
    console.error('[wf-trainer] No candle data found');
    process.exit(1);
  }
  console.log(`[wf-trainer] Loaded ${candles.length} candles`);

  const folds = buildFoldWindows(candles, WF_MAX_FOLDS);
  console.log(`[wf-trainer] Partitioned into ${folds.length} folds`);

  for (const fold of folds) {
    console.log(`\n[wf-trainer] === Fold ${fold.foldIndex} ===`);
    console.log(`[wf-trainer] Train: ${fold.trainStart} → ${fold.trainEnd}`);
    console.log(`[wf-trainer] Val:   ${fold.valStart} → ${fold.valEnd}`);

    try {
      const trainResult = await runBacktest(config, symbol, fold.trainStart, fold.trainEnd);
      console.log(`[wf-trainer] Train result: PF=${trainResult.profitFactor?.toFixed(3) ?? '?'}, WR=${trainResult.winRate?.toFixed(1) ?? '?'}%, trades=${trainResult.totalTrades}`);

      const valResult = await runBacktest(config, symbol, fold.valStart, fold.valEnd);
      const passes = valResult.totalTrades >= 30 && valResult.profitFactor >= 1.0;
      console.log(`[wf-trainer] Val result: PF=${valResult.profitFactor?.toFixed(3) ?? '?'}, WR=${valResult.winRate?.toFixed(1) ?? '?'}%, trades=${valResult.totalTrades} → ${passes ? 'PASS ✅' : 'FAIL ❌'}`);
    } catch (err) {
      console.error(`[wf-trainer] Fold ${fold.foldIndex} error:`, err);
    }
  }

  console.log('\n[wf-trainer] Done.');
}

main().catch(err => {
  console.error('[wf-trainer] Fatal:', err);
  process.exit(1);
});
