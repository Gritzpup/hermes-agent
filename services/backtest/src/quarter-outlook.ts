import { createHash } from 'node:crypto';
import { runBacktest } from './simulation.js';
import type {
  BacktestAgentConfig,
  BacktestCandle,
  BacktestResult,
  QuarterSimulationClassKey,
  QuarterSimulationClassSummary,
  QuarterSimulationLastQuarterSummary,
  QuarterSimulationNextQuarterSummary,
  QuarterSimulationReport,
  QuarterSimulationSymbolSummary
} from '@hermes/contracts';

const INTERVAL = '1h';
const SIMULATIONS = 500;
const BLOCK_SIZE = 24;
const STARTING_EQUITY = 100_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface SymbolPlan {
  classKey: QuarterSimulationClassKey;
  label: string;
  canonicalSymbol: string;
  yahooSymbol: string;
  config: BacktestAgentConfig;
}

interface SymbolRun extends SymbolPlan {
  result: BacktestResult;
  strategyCurve: number[];
  strategyReturns: number[];
  benchmarkCurve: number[];
  benchmarkReturns: number[];
}

const configById = new Map<string, BacktestAgentConfig>([
  ['agent-eth-revert', { style: 'mean-reversion', targetBps: 120, stopBps: 100, maxHoldTicks: 60, cooldownTicks: 8, sizeFraction: 0.06, spreadLimitBps: 5 }],
  ['agent-sol-momentum', { style: 'momentum', targetBps: 100, stopBps: 80, maxHoldTicks: 25, cooldownTicks: 6, sizeFraction: 0.06, spreadLimitBps: 5 }],
  ['agent-qqq-trend', { style: 'momentum', targetBps: 18, stopBps: 9, maxHoldTicks: 5, cooldownTicks: 4, sizeFraction: 0.1, spreadLimitBps: 2.5 }],
  ['agent-nvda-breakout', { style: 'breakout', targetBps: 28, stopBps: 15, maxHoldTicks: 6, cooldownTicks: 3, sizeFraction: 0.09, spreadLimitBps: 5 }],
  ['agent-eurusd-trend', { style: 'momentum', targetBps: 12, stopBps: 8, maxHoldTicks: 10, cooldownTicks: 3, sizeFraction: 0.08, spreadLimitBps: 2 }],
  ['agent-gbpusd-revert', { style: 'mean-reversion', targetBps: 15, stopBps: 10, maxHoldTicks: 12, cooldownTicks: 4, sizeFraction: 0.07, spreadLimitBps: 3 }],
  ['agent-us10y-watch', { style: 'mean-reversion', targetBps: 10, stopBps: 7, maxHoldTicks: 16, cooldownTicks: 4, sizeFraction: 0.05, spreadLimitBps: 2.5 }]
]);

function needConfig(id: string): BacktestAgentConfig {
  const config = configById.get(id);
  if (!config) throw new Error(`Missing config: ${id}`);
  return {
    style: config.style,
    targetBps: config.targetBps,
    stopBps: config.stopBps,
    maxHoldTicks: config.maxHoldTicks,
    cooldownTicks: config.cooldownTicks,
    sizeFraction: config.sizeFraction,
    spreadLimitBps: config.spreadLimitBps,
    entryThresholdMultiplier: 1,
    exitThresholdMultiplier: 1
  };
}

const plans: SymbolPlan[] = [
  { classKey: 'crypto', label: 'ETH', canonicalSymbol: 'ETH-USD', yahooSymbol: 'ETH-USD', config: needConfig('agent-eth-revert') },
  { classKey: 'crypto', label: 'SOL', canonicalSymbol: 'SOL-USD', yahooSymbol: 'SOL-USD', config: needConfig('agent-sol-momentum') },
  { classKey: 'stocks', label: 'QQQ', canonicalSymbol: 'QQQ', yahooSymbol: 'QQQ', config: needConfig('agent-qqq-trend') },
  { classKey: 'stocks', label: 'NVDA', canonicalSymbol: 'NVDA', yahooSymbol: 'NVDA', config: needConfig('agent-nvda-breakout') },
  { classKey: 'forex', label: 'EUR/USD', canonicalSymbol: 'EUR_USD', yahooSymbol: 'EURUSD=X', config: needConfig('agent-eurusd-trend') },
  { classKey: 'forex', label: 'GBP/USD', canonicalSymbol: 'GBP_USD', yahooSymbol: 'GBPUSD=X', config: needConfig('agent-gbpusd-revert') },
  { classKey: 'bond', label: '10Y Treasury proxy', canonicalSymbol: 'USB10Y_USD', yahooSymbol: 'IEF', config: needConfig('agent-us10y-watch') }
];

let cachedQuarterOutlook: { key: string; report: QuarterSimulationReport; refreshedAt: string } | null = null;

function round(value: number, decimals = 3): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

function hashSeed(value: string): number {
  const hash = createHash('sha256').update(value).digest();
  return hash.readUInt32LE(0);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function maxDrawdownPct(curve: number[]): number {
  if (curve.length === 0) return 0;
  let peak = curve[0] ?? 0;
  let maxDd = 0;
  for (const value of curve) {
    if (value > peak) peak = value;
    const dd = peak > 0 ? ((peak - value) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

function returnsFromCurve(curve: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i += 1) {
    const prev = curve[i - 1];
    const curr = curve[i];
    if (!prev || !curr) continue;
    returns.push((curr - prev) / prev);
  }
  return returns;
}

function normalizedCurve(curve: number[]): number[] {
  const start = curve[0] ?? 1;
  return curve.map((value) => value / start);
}

function aggregateEqualWeightCurves(curves: number[][]): number[] {
  const validCurves = curves.filter((curve) => curve.length > 0);
  if (validCurves.length === 0) return [];
  const minLen = Math.min(...validCurves.map((curve) => curve.length));
  const agg: number[] = [];
  for (let i = 0; i < minLen; i += 1) {
    const avg = validCurves.reduce((sum, curve) => sum + (curve[i] ?? curve[curve.length - 1] ?? 1), 0) / validCurves.length;
    agg.push(avg);
  }
  return agg;
}

function bootstrapScenario(returns: number[], horizon: number, seed: number): { finalReturnPct: number; maxDdPct: number; curve: number[] } {
  const rng = mulberry32(seed);
  const path: number[] = [1];
  if (returns.length === 0) {
    return { finalReturnPct: 0, maxDdPct: 0, curve: [1] };
  }

  for (let step = 0; step < horizon; step += 1) {
    const blockStart = Math.floor(rng() * Math.max(returns.length - BLOCK_SIZE, 1));
    const block = returns.slice(blockStart, blockStart + BLOCK_SIZE);
    const sampled = block[step % Math.max(block.length, 1)] ?? returns[Math.floor(rng() * returns.length)] ?? 0;
    const next = (path[path.length - 1] ?? 1) * (1 + sampled);
    path.push(next);
  }

  return {
    finalReturnPct: ((path[path.length - 1] ?? 1) - 1) * 100,
    maxDdPct: maxDrawdownPct(path.map((v) => v * STARTING_EQUITY)),
    curve: path
  };
}

function pick(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.floor(values.length * percentile)));
  return values[index] ?? 0;
}

function getLastCompletedQuarterRange(asOf = new Date()): { startDate: string; endDate: string } {
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth();
  const currentQuarter = Math.floor(month / 3);
  let quarter = currentQuarter - 1;
  let quarterYear = year;
  if (quarter < 0) {
    quarter = 3;
    quarterYear -= 1;
  }
  const startMonth = quarter * 3;
  const startDate = new Date(Date.UTC(quarterYear, startMonth, 1, 0, 0, 0, 0)).toISOString();
  const endDate = new Date(Date.UTC(quarterYear, startMonth + 3, 0, 23, 59, 59, 999)).toISOString();
  return { startDate, endDate };
}

async function fetchYahooCandles(symbol: string, start: string, end: string): Promise<BacktestCandle[]> {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set('period1', String(Math.floor(new Date(start).getTime() / 1000)));
  url.searchParams.set('period2', String(Math.floor(new Date(end).getTime() / 1000)));
  url.searchParams.set('interval', INTERVAL);
  url.searchParams.set('includePrePost', 'false');
  url.searchParams.set('events', 'div,splits');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json'
        },
        signal: controller.signal
      });

      if (response.ok) {
        const body = await response.json() as {
          chart?: {
            error?: { description?: string } | null;
            result?: Array<{
              timestamp?: number[];
              indicators?: {
                quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }>;
              };
            }>;
          };
        };
        const result = body.chart?.result?.[0];
        const timestamps = result?.timestamp ?? [];
        const quote = result?.indicators?.quote?.[0];
        const candles: BacktestCandle[] = [];
        for (let index = 0; index < timestamps.length; index += 1) {
          const timestamp = timestamps[index];
          const close = quote?.close?.[index];
          if (timestamp === undefined || close === undefined || close === null) continue;
          const open = quote?.open?.[index] ?? close;
          const high = quote?.high?.[index] ?? close;
          const low = quote?.low?.[index] ?? close;
          const volume = quote?.volume?.[index] ?? 0;
          candles.push({
            timestamp: new Date(timestamp * 1000).toISOString(),
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume)
          });
        }
        if (candles.length > 50) return candles.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      }

      if (attempt < 2) await sleep(750 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Yahoo fetch failed for ${symbol}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeLastQuarter(strategyCurve: number[], benchmarkCurve: number[], trades: number, winRate: number): QuarterSimulationLastQuarterSummary {
  const normalizedStrategy = normalizedCurve(strategyCurve);
  const normalizedBenchmark = normalizedCurve(benchmarkCurve);
  return {
    strategyReturnPct: round(((normalizedStrategy.at(-1) ?? 1) - 1) * 100, 3),
    strategyMaxDrawdownPct: round(maxDrawdownPct(normalizedStrategy.map((value) => value * STARTING_EQUITY)), 3),
    benchmarkReturnPct: round(((normalizedBenchmark.at(-1) ?? 1) - 1) * 100, 3),
    benchmarkMaxDrawdownPct: round(maxDrawdownPct(normalizedBenchmark.map((value) => value * STARTING_EQUITY)), 3),
    winRate: round(winRate, 1),
    trades
  };
}

function summarizeNextQuarter(strategyReturns: number[], benchmarkReturns: number[], horizon: number, seedScope: string): QuarterSimulationNextQuarterSummary {
  const simulations = Array.from({ length: SIMULATIONS }, (_, index) => bootstrapScenario(strategyReturns, horizon, hashSeed(`${seedScope}:strategy:${index}`)));
  const benchmarkSimulations = Array.from({ length: SIMULATIONS }, (_, index) => bootstrapScenario(benchmarkReturns, horizon, hashSeed(`${seedScope}:benchmark:${index}`)));
  const strategyFinals = simulations.map((scenario) => scenario.finalReturnPct).sort((left, right) => left - right);
  const strategyDrawdowns = simulations.map((scenario) => scenario.maxDdPct).sort((left, right) => left - right);
  const benchmarkFinals = benchmarkSimulations.map((scenario) => scenario.finalReturnPct).sort((left, right) => left - right);
  const benchmarkDrawdowns = benchmarkSimulations.map((scenario) => scenario.maxDdPct).sort((left, right) => left - right);
  const strategyPositivePct = (simulations.filter((scenario) => scenario.finalReturnPct > 0).length / simulations.length) * 100;
  const benchmarkPositivePct = (benchmarkSimulations.filter((scenario) => scenario.finalReturnPct > 0).length / benchmarkSimulations.length) * 100;

  return {
    strategyMedianReturnPct: round(pick(strategyFinals, 0.5), 2),
    strategyP25ReturnPct: round(pick(strategyFinals, 0.25), 2),
    strategyP75ReturnPct: round(pick(strategyFinals, 0.75), 2),
    strategyMedianMaxDrawdownPct: round(pick(strategyDrawdowns, 0.5), 2),
    strategyPositivePct: round(strategyPositivePct, 1),
    benchmarkMedianReturnPct: round(pick(benchmarkFinals, 0.5), 2),
    benchmarkP25ReturnPct: round(pick(benchmarkFinals, 0.25), 2),
    benchmarkP75ReturnPct: round(pick(benchmarkFinals, 0.75), 2),
    benchmarkMedianMaxDrawdownPct: round(pick(benchmarkDrawdowns, 0.5), 2),
    benchmarkPositivePct: round(benchmarkPositivePct, 1)
  };
}

function buildSymbolSummary(item: SymbolRun): QuarterSimulationSymbolSummary {
  return {
    symbol: item.canonicalSymbol,
    strategyReturnPct: round(((item.strategyCurve.at(-1) ?? 1) - 1) * 100, 2),
    strategyWinRate: item.result.winRate,
    strategyProfitFactor: item.result.profitFactor,
    strategyMaxDrawdownPct: item.result.maxDrawdownPct,
    strategyTrades: item.result.totalTrades,
    benchmarkReturnPct: round(((item.benchmarkCurve.at(-1) ?? 1) - 1) * 100, 2),
    benchmarkMaxDrawdownPct: round(maxDrawdownPct(item.benchmarkCurve.map((value) => value * STARTING_EQUITY)), 2)
  };
}

function computeAccuracyPct(lastQuarter: QuarterSimulationLastQuarterSummary, nextQuarter: QuarterSimulationNextQuarterSummary): number {
  const reliabilityBase = (nextQuarter.strategyPositivePct * 0.6) + (lastQuarter.winRate * 0.4);
  const uncertaintyPenalty = Math.min(15, Math.max(0, nextQuarter.strategyP75ReturnPct - nextQuarter.strategyP25ReturnPct) * 10);
  return round(Math.max(0, Math.min(100, reliabilityBase - uncertaintyPenalty)), 1);
}

function buildClassSummary(classKey: QuarterSimulationClassKey, items: SymbolRun[]): QuarterSimulationClassSummary {
  const symbols = items.map((item) => item.canonicalSymbol);
  if (items.length === 0) {
    return {
      classKey,
      symbols,
      accuracyPct: 0,
      lastQuarter: {
        strategyReturnPct: 0,
        strategyMaxDrawdownPct: 0,
        benchmarkReturnPct: 0,
        benchmarkMaxDrawdownPct: 0,
        winRate: 0,
        trades: 0
      },
      nextQuarter: {
        strategyMedianReturnPct: 0,
        strategyP25ReturnPct: 0,
        strategyP75ReturnPct: 0,
        strategyMedianMaxDrawdownPct: 0,
        strategyPositivePct: 0,
        benchmarkMedianReturnPct: 0,
        benchmarkP25ReturnPct: 0,
        benchmarkP75ReturnPct: 0,
        benchmarkMedianMaxDrawdownPct: 0,
        benchmarkPositivePct: 0
      },
      perSymbol: []
    };
  }

  const strategyCurve = aggregateEqualWeightCurves(items.map((item) => item.strategyCurve));
  const benchmarkCurve = aggregateEqualWeightCurves(items.map((item) => item.benchmarkCurve));
  const trades = items.reduce((sum, item) => sum + item.result.totalTrades, 0);
  const winsApprox = items.reduce((sum, item) => sum + (item.result.totalTrades * item.result.winRate / 100), 0);
  const winRate = trades > 0 ? (winsApprox / trades) * 100 : 0;
  const strategyReturns = returnsFromCurve(strategyCurve);
  const benchmarkReturns = returnsFromCurve(benchmarkCurve);
  const horizon = strategyReturns.length;

  const lastQuarter = summarizeLastQuarter(strategyCurve, benchmarkCurve, trades, winRate);
  const nextQuarter = summarizeNextQuarter(strategyReturns, benchmarkReturns, horizon, classKey);

  return {
    classKey,
    symbols,
    accuracyPct: computeAccuracyPct(lastQuarter, nextQuarter),
    lastQuarter,
    nextQuarter,
    perSymbol: items.map((item) => buildSymbolSummary(item))
  };
}

function buildNotes(items: SymbolRun[]): string[] {
  const notes = [
    'Projected next-quarter ranges are bootstrap estimates from last-quarter return paths, not profit guarantees.',
    'This report is equal-weighted across the active symbols in each class and excludes BTC because the current crypto pilots are ETH and SOL.'
  ];
  const weakSymbols = items.filter((item) => item.result.profitFactor < 1).map((item) => item.canonicalSymbol);
  if (weakSymbols.length > 0) {
    notes.push(`Weakest current legs by profit factor: ${weakSymbols.join(', ')}.`);
  }
  return notes;
}

export async function getQuarterOutlookReport(asOf = new Date()): Promise<QuarterSimulationReport> {
  const normalizedAsOf = Number.isNaN(asOf.getTime()) ? new Date() : asOf;
  const range = getLastCompletedQuarterRange(normalizedAsOf);
  const key = `${range.startDate}:${range.endDate}`;
  if (cachedQuarterOutlook?.key === key) {
    return cachedQuarterOutlook.report;
  }

  const report = await buildQuarterOutlookReport(normalizedAsOf, range.startDate, range.endDate);
  cachedQuarterOutlook = {
    key,
    report,
    refreshedAt: new Date().toISOString()
  };
  return report;
}

async function buildQuarterOutlookReport(asOf: Date, startDate: string, endDate: string): Promise<QuarterSimulationReport> {
  const symbolResults: SymbolRun[] = [];
  const notes: string[] = [];

  for (const plan of plans) {
    try {
      const candles = await fetchYahooCandles(plan.yahooSymbol, startDate, endDate);
      const result = runBacktest(candles, plan.config, plan.canonicalSymbol);
      const strategyCurve = normalizedCurve(result.equityCurve);
      const benchmarkCurve = normalizedCurve(candles.map((candle) => candle.close * STARTING_EQUITY / candles[0]!.close));
      symbolResults.push({
        ...plan,
        result,
        strategyCurve,
        strategyReturns: returnsFromCurve(strategyCurve),
        benchmarkCurve,
        benchmarkReturns: returnsFromCurve(benchmarkCurve)
      });
    } catch (error) {
      notes.push(`${plan.canonicalSymbol} unavailable for quarter outlook: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  const classMap: Record<QuarterSimulationClassKey, SymbolRun[]> = {
    crypto: symbolResults.filter((item) => item.classKey === 'crypto'),
    stocks: symbolResults.filter((item) => item.classKey === 'stocks'),
    forex: symbolResults.filter((item) => item.classKey === 'forex'),
    bond: symbolResults.filter((item) => item.classKey === 'bond')
  };

  const classSummaries = Object.entries(classMap).map(([classKey, items]) => buildClassSummary(classKey as QuarterSimulationClassKey, items));
  const overallStrategyCurve = aggregateEqualWeightCurves(symbolResults.map((item) => item.strategyCurve));
  const overallBenchmarkCurve = aggregateEqualWeightCurves(symbolResults.map((item) => item.benchmarkCurve));
  const overallStrategyReturns = returnsFromCurve(overallStrategyCurve);
  const overallBenchmarkReturns = returnsFromCurve(overallBenchmarkCurve);
  const overallTrades = symbolResults.reduce((sum, item) => sum + item.result.totalTrades, 0);
  const overallWins = symbolResults.reduce((sum, item) => sum + (item.result.totalTrades * item.result.winRate / 100), 0);
  const overallWinRate = overallTrades > 0 ? (overallWins / overallTrades) * 100 : 0;

  return {
    asOf: asOf.toISOString(),
    generatedAt: new Date().toISOString(),
    capital: STARTING_EQUITY,
    startDate,
    endDate,
    interval: INTERVAL,
    overall: {
      lastQuarter: summarizeLastQuarter(overallStrategyCurve, overallBenchmarkCurve, overallTrades, overallWinRate),
      nextQuarter: summarizeNextQuarter(overallStrategyReturns, overallBenchmarkReturns, overallStrategyReturns.length, 'overall'),
      strategyCurve: overallStrategyCurve,
      benchmarkCurve: overallBenchmarkCurve
    },
    classSummaries,
    notes: [...notes, ...buildNotes(symbolResults)]
  };
}

