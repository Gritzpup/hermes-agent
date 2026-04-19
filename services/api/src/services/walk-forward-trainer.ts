/**
 * Walk-Forward Trainer
 * Phase G4 — Walk-Forward Validation
 *
 * Trains a challenger agent config against an expanding window.
 * Calls the backtest service (port 4305) via HTTP.
 */

import type { BacktestAgentConfig, BacktestResult } from '@hermes/contracts';

const BACKTEST_URL = process.env.BACKTEST_SERVICE_URL ?? 'http://localhost:4305';

export interface WFTrainingResult {
  fold: number;
  profitFactor: number;
  winRate: number;
  totalTrades: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  totalReturnPct: number;
  equityCurve: number[];
  fills: BacktestResult['fills'];
  trainedAt: string;
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
    const text = await response.text();
    throw new Error(`Backtest service error ${response.status}: ${text}`);
  }

  return response.json() as Promise<BacktestResult>;
}

/**
 * Train a challenger config on an expanding window (trainFold).
 * Returns metrics needed for the walk-forward gate.
 */
export async function runTrainingFold(
  challengerConfig: BacktestAgentConfig,
  symbol: string,
  trainFold: {
    fold: number;
    trainStart: string;
    trainEnd: string;
  },
  timeoutMs = 120_000
): Promise<WFTrainingResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await runBacktest(
      challengerConfig,
      symbol,
      trainFold.trainStart,
      trainFold.trainEnd,
      controller.signal
    );

    const fills = result.fills ?? [];
    const wins = fills.filter(f => f.pnl > 0).length;
    const losses = fills.filter(f => f.pnl < 0).length;

    return {
      fold: trainFold.fold,
      profitFactor: result.profitFactor,
      winRate: result.totalTrades > 0 ? (wins / result.totalTrades) * 100 : 0,
      totalTrades: result.totalTrades,
      maxDrawdownPct: result.maxDrawdownPct,
      sharpeRatio: result.sharpeRatio,
      totalReturnPct: result.totalReturnPct,
      equityCurve: result.equityCurve ?? [],
      fills,
      trainedAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compute regime-stratified metrics from fills.
 * Regimes: panic / trend / normal / compression / chop
 * Classification is based on consecutive fill signs and volatility.
 */
export interface WFRegimeMetrics {
  regime: string;
  trades: number;
  expectancy: number;
  winRate: number;
  profitFactor: number;
}

export function computeRegimeMetrics(
  fills: BacktestResult['fills'],
  _equityCurve: number[]
): WFRegimeMetrics[] {
  if (fills.length < 5) {
    return [
      { regime: 'normal', trades: fills.length, expectancy: 0, winRate: 0, profitFactor: 0 }
    ];
  }

  // Simple regime classification based on volatility of fills
  const pnls = fills.map(f => f.pnl);
  const avgPnl = pnls.reduce((s, p) => s + p, 0) / pnls.length;
  const variance = pnls.reduce((s, p) => s + (p - avgPnl) ** 2, 0) / pnls.length;
  const stdPnl = Math.sqrt(variance);

  // Regime by volatility
  const isHighVol = stdPnl > Math.abs(avgPnl) * 2;
  const isUpward = fills.slice(-Math.min(10, fills.length)).filter(f => f.pnl > 0).length >
    fills.slice(-Math.min(10, fills.length)).filter(f => f.pnl < 0).length;

  let regime: string;
  if (isHighVol) {
    regime = isUpward ? 'chop' : 'panic';
  } else {
    regime = isUpward ? 'trend' : 'compression';
  }

  const wins = fills.filter(f => f.pnl > 0);
  const losses = fills.filter(f => f.pnl < 0);
  const totalWin = wins.reduce((s, f) => s + f.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, f) => s + f.pnl, 0));

  return [{
    regime,
    trades: fills.length,
    expectancy: fills.length > 0 ? pnls.reduce((s, p) => s + p, 0) / fills.length : 0,
    winRate: fills.length > 0 ? (wins.length / fills.length) * 100 : 0,
    profitFactor: totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0
  }];
}
