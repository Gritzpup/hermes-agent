/**
 * Walk-Forward Validator
 * Phase G4 — Walk-Forward Validation
 *
 * Runs challenger params against validation windows and computes per-fold metrics.
 * Applies the purge buffer to prevent information leakage.
 */

import type { BacktestAgentConfig, BacktestResult } from '@hermes/contracts';
import { applyPurge } from '../../../../scripts/walk-forward-partitioner.js';

const BACKTEST_URL = process.env.BACKTEST_SERVICE_URL ?? 'http://localhost:4305';

/** Minimum trades per regime to report it as valid */
const MIN_TRADES_PER_REGIME = 30;
/** Minimum folds that must pass */
const WF_MIN_FOLDS_PASS = 3;

export interface WFValidationResult {
  fold: number;
  trainStart: string;
  trainEnd: string;
  valStart: string;
  valEnd: string;
  profitFactor: number;
  winRate: number;
  totalTrades: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  totalReturnPct: number;
  passes: boolean;
  rejectionReason: string | null;
  regimeMetrics: Array<{
    regime: string;
    trades: number;
    expectancy: number;
    winRate: number;
    profitFactor: number;
  }>;
}

async function runBacktest(
  agentConfig: BacktestAgentConfig,
  symbol: string,
  startDate: string,
  endDate: string,
  signal?: AbortSignal
): Promise<BacktestResult> {
  const url = `${BACKTEST_URL}/backtest`;
  const options: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentConfig, symbol, startDate, endDate })
  };
  if (signal) options.signal = signal;
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Backtest service error ${response.status}`);
  }
  return response.json() as Promise<BacktestResult>;
}

function evaluateRegimeGate(regimeMetrics: WFValidationResult['regimeMetrics']): {
  passes: boolean;
  reason: string | null;
} {
  for (const rm of regimeMetrics) {
    if (rm.trades < MIN_TRADES_PER_REGIME) continue;
    if (rm.expectancy < -2) {
      return { passes: false, reason: `Regime ${rm.regime} has expectancy ${rm.expectancy.toFixed(2)}R < -2R` };
    }
  }
  return { passes: true, reason: null };
}

/**
 * Validate a challenger config on a single validation window.
 * Returns fold-level pass/fail with structured rejection reason.
 */
export async function runValidationFold(
  challengerConfig: BacktestAgentConfig,
  symbol: string,
  fold: {
    fold: number;
    trainStart: string;
    trainEnd: string;
    valStart: string;
    valEnd: string;
    purgeCutoff: string;
  },
  timeoutMs = 120_000
): Promise<WFValidationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await runBacktest(
      challengerConfig,
      symbol,
      fold.valStart,
      fold.valEnd,
      controller.signal
    );

    // Apply purge buffer: exclude fills near the boundary
    const purgedFills = applyPurge(result.fills ?? [], fold.purgeCutoff);
    const fills = purgedFills.purgedFills;

    const wins = fills.filter(f => f.pnl > 0).length;
    const losses = fills.filter(f => f.pnl < 0).length;
    const totalWin = wins > 0 ? fills.filter(f => f.pnl > 0).reduce((s, f) => s + f.pnl, 0) : 0;
    const totalLoss = losses > 0 ? Math.abs(fills.filter(f => f.pnl < 0).reduce((s, f) => s + f.pnl, 0)) : 0;

    // Basic gate: ≥ 30 trades, PF ≥ 1.0, no catastrophic drawdown
    const passes = result.totalTrades >= 30
      && result.profitFactor >= 1.0
      && result.maxDrawdownPct < 20;

    let rejectionReason: string | null = null;
    if (result.totalTrades < 30) {
      rejectionReason = `Only ${result.totalTrades} trades (< 30 minimum)`;
    } else if (result.profitFactor < 1.0) {
      rejectionReason = `PF ${result.profitFactor.toFixed(2)} < 1.0`;
    } else if (result.maxDrawdownPct >= 20) {
      rejectionReason = `Max drawdown ${result.maxDrawdownPct.toFixed(1)}% >= 20%`;
    }

    // Compute regime metrics (simplified single-regime for now)
    const regimeMetrics = [{
      regime: 'normal',
      trades: fills.length,
      expectancy: fills.length > 0 ? fills.reduce((s, f) => s + f.pnl, 0) / fills.length : 0,
      winRate: fills.length > 0 ? (wins / fills.length) * 100 : 0,
      profitFactor: totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0
    }];

    if (passes && rejectionReason === null) {
      const regimeCheck = evaluateRegimeGate(regimeMetrics);
      if (!regimeCheck.passes) {
        rejectionReason = regimeCheck.reason;
      }
    }

    return {
      fold: fold.fold,
      trainStart: fold.trainStart,
      trainEnd: fold.trainEnd,
      valStart: fold.valStart,
      valEnd: fold.valEnd,
      profitFactor: result.profitFactor,
      winRate: result.totalTrades > 0 ? (wins / result.totalTrades) * 100 : 0,
      totalTrades: result.totalTrades,
      maxDrawdownPct: result.maxDrawdownPct,
      sharpeRatio: result.sharpeRatio,
      totalReturnPct: result.totalReturnPct,
      passes: rejectionReason === null && passes,
      rejectionReason,
      regimeMetrics
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function summarizeValidation(foldResults: WFValidationResult[]): {
  foldsPassed: number;
  foldsTotal: number;
  avgProfitFactor: number;
  avgWinRate: number;
  totalTrades: number;
  overallPass: boolean;
  rejectionReasons: string[];
} {
  const passed = foldResults.filter(r => r.passes);
  const avgPF = foldResults.length > 0
    ? foldResults.reduce((s, r) => s + r.profitFactor, 0) / foldResults.length
    : 0;
  const avgWR = foldResults.length > 0
    ? foldResults.reduce((s, r) => s + r.winRate, 0) / foldResults.length
    : 0;
  const totalTrades = foldResults.reduce((s, r) => s + r.totalTrades, 0);

  const rejectionReasons = foldResults
    .filter(r => !r.passes)
    .map(r => `Fold ${r.fold}: ${r.rejectionReason}`);

  return {
    foldsPassed: passed.length,
    foldsTotal: foldResults.length,
    avgProfitFactor: avgPF,
    avgWinRate: avgWR,
    totalTrades,
    overallPass: passed.length >= WF_MIN_FOLDS_PASS && avgPF >= 1.0,
    rejectionReasons
  };
}
