import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type {
  BacktestCandle,
  MacroPreservationAllocation,
  MacroPreservationAssetSymbol,
  MacroPreservationBacktestPeriod,
  MacroPreservationBacktestRequest,
  MacroPreservationBacktestResult,
  MacroPreservationCpiObservation,
  MacroPreservationPortfolioSnapshot,
  MacroPreservationRegime
} from '@hermes/contracts';
import { fetchCandles } from './historical-data.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const cacheTtlMs = Number(process.env.MACRO_SLEEVE_CACHE_MS ?? 10 * 60 * 1000);
const fredCpiUrl = process.env.MACRO_CPI_URL ?? 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL';
const defaultBenchmarkSymbol: MacroPreservationAssetSymbol | 'SPY' = 'SPY';
const defaultCashSymbol: MacroPreservationAssetSymbol = 'BIL';
const defaultInflationThresholdPct = Number(process.env.MACRO_INFLATION_THRESHOLD_PCT ?? 2.5);
const defaultStartDate = '2010-01-01T00:00:00.000Z';

const ASSET_CONFIG: Record<MacroPreservationAssetSymbol, { name: string; costBps: number; capPct: number }> = {
  GLD: { name: 'Gold Trust', costBps: 8, capPct: 0.45 },
  SLV: { name: 'Silver Trust', costBps: 10, capPct: 0.2 },
  USO: { name: 'Oil Fund', costBps: 12, capPct: 0.3 },
  DBC: { name: 'Commodity Fund', costBps: 10, capPct: 0.35 },
  BIL: { name: 'Short Treasury Fund', costBps: 2, capPct: 1 }
};

const REAL_ASSETS: MacroPreservationAssetSymbol[] = ['GLD', 'SLV', 'USO', 'DBC'];

interface CpiPoint {
  observationDate: string;
  availableAt: string;
  cpi: number;
  yoyPct: number;
  momentumPct: number;
}

interface PriceSeries {
  symbol: string;
  dates: string[];
  epochs: number[];
  closes: number[];
  dailyReturns: number[];
  closeByDate: Map<string, number>;
  firstDate: string | null;
  lastDate: string | null;
}

interface MacroState {
  inflationObservation: CpiPoint | null;
  inflationHot: boolean;
  regime: MacroPreservationRegime;
  spyReturn63d: number;
  spyReturn126d: number;
  notes: string[];
}

interface MacroSelection {
  regime: MacroPreservationRegime;
  inflationObservation: CpiPoint | null;
  inflationHot: boolean;
  allocations: MacroPreservationAllocation[];
  notes: string[];
}

const cpiCache = new Map<string, { cachedAt: number; points: CpiPoint[] }>();
const priceCache = new Map<string, { cachedAt: number; series: PriceSeries }>();
const snapshotCache = new Map<string, { cachedAt: number; snapshot: MacroPreservationPortfolioSnapshot }>();
const backtestCache = new Map<string, { cachedAt: number; result: MacroPreservationBacktestResult }>();

function cacheBucket(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(Math.floor(parsed / 60_000) * 60_000).toISOString();
}

function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toDateKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function parseDateKey(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function startOfTradingDayIso(value: string): string {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0)).toISOString();
}

function uniqueDates(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => parseDateKey(left) - parseDateKey(right));
}

function buildDefaultRange(): { startDate: string; endDate: string } {
  return {
    startDate: defaultStartDate,
    endDate: new Date().toISOString()
  };
}

async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': process.env.SEC_USER_AGENT ?? 'Hermes Trading Firm support@hermes.local',
        Accept: 'text/csv,text/plain,*/*'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Macro preservation data request failed (${response.status}) for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseCpiCsv(csv: string): CpiPoint[] {
  const lines = csv.trim().split(/\r?\n/);
  const rows = lines.slice(1);
  const raw = rows
    .map((line) => line.split(','))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({ observationDate: parts[0] ?? '', cpi: Number(parts[1] ?? '') }))
    .filter((row) => row.observationDate && Number.isFinite(row.cpi) && row.cpi > 0);

  const points: CpiPoint[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index]!;
    const history12 = raw[index - 12];
    const history6 = raw[index - 6];
    if (!history12 || !Number.isFinite(history12.cpi)) continue;
    const yoyPct = ((current.cpi / history12.cpi) - 1) * 100;
    const yoy6MonthsAgo = history6 && raw[index - 18] && Number.isFinite(raw[index - 18]!.cpi)
      ? ((history6.cpi / raw[index - 18]!.cpi) - 1) * 100
      : 0;
    const momentumPct = yoyPct - yoy6MonthsAgo;
    const observation = new Date(`${current.observationDate}T00:00:00.000Z`);
    const release = new Date(Date.UTC(observation.getUTCFullYear(), observation.getUTCMonth() + 1, 16, 0, 0, 0, 0));
    points.push({
      observationDate: current.observationDate,
      availableAt: release.toISOString(),
      cpi: current.cpi,
      yoyPct: round(yoyPct, 3),
      momentumPct: round(momentumPct, 3)
    });
  }
  return points.sort((left, right) => Date.parse(left.availableAt) - Date.parse(right.availableAt));
}

async function fetchCpiSeries(): Promise<CpiPoint[]> {
  const cached = cpiCache.get(fredCpiUrl);
  if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
    return cached.points;
  }
  const csv = await fetchText(fredCpiUrl);
  const points = parseCpiCsv(csv);
  cpiCache.set(fredCpiUrl, { cachedAt: Date.now(), points });
  return points;
}

async function fetchPriceSeries(symbol: string, startDate: string, endDate: string): Promise<PriceSeries> {
  const cacheKey = `${symbol}:${startDate}:${endDate}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
    return cached.series;
  }

  const candles = await fetchCandles(symbol, startDate, endDate);
  if (candles.length === 0) {
    throw new Error(`No candle data returned for ${symbol} from ${startDate} to ${endDate}`);
  }

  const sorted = [...candles].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const dates = sorted.map((candle) => toDateKey(candle.timestamp));
  const epochs = sorted.map((candle) => Date.parse(startOfTradingDayIso(candle.timestamp)));
  const closes = sorted.map((candle) => candle.close);
  const closeByDate = new Map<string, number>();
  for (const candle of sorted) {
    closeByDate.set(toDateKey(candle.timestamp), candle.close);
  }
  const dailyReturns = closes.map((close, index) => {
    if (index === 0) return 0;
    const current = close ?? 0;
    const previous = closes[index - 1] ?? current;
    return previous > 0 ? (current / previous) - 1 : 0;
  });

  const series: PriceSeries = {
    symbol,
    dates,
    epochs,
    closes,
    dailyReturns,
    closeByDate,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null
  };

  priceCache.set(cacheKey, { cachedAt: Date.now(), series });
  return series;
}

function getCloseOnDate(series: PriceSeries, dateKey: string): number | null {
  const close = series.closeByDate.get(dateKey);
  if (typeof close === 'number' && Number.isFinite(close)) return close;
  return null;
}

function trailingReturnPct(series: PriceSeries, index: number, lookback: number): number {
  if (index < lookback || index <= 0) return 0;
  const current = series.closes[index] ?? 0;
  const previous = series.closes[index - lookback] ?? 0;
  if (!(current > 0) || !(previous > 0)) return 0;
  return ((current / previous) - 1) * 100;
}

function computeCpiAtIndex(cpiSeries: CpiPoint[], dateEpoch: number): CpiPoint | null {
  let latest: CpiPoint | null = null;
  for (const point of cpiSeries) {
    if (Date.parse(point.availableAt) <= dateEpoch) {
      latest = point;
      continue;
    }
    break;
  }
  return latest;
}

function getCommonStartDate(seriesList: PriceSeries[]): string | null {
  let latestFirst: string | null = null;
  for (const series of seriesList) {
    if (!series.firstDate) continue;
    if (!latestFirst || parseDateKey(series.firstDate) > parseDateKey(latestFirst)) {
      latestFirst = series.firstDate;
    }
  }
  return latestFirst;
}

function buildAlignedPriceHistory(seriesMap: Map<string, PriceSeries>, benchmarkDates: string[]): Record<string, number[]> {
  const aligned: Record<string, number[]> = {};
  for (const [symbol, series] of seriesMap.entries()) {
    const values: number[] = [];
    let lastClose: number | null = null;
    for (const dateKey of benchmarkDates) {
      const close = getCloseOnDate(series, dateKey);
      if (typeof close === 'number' && Number.isFinite(close)) {
        lastClose = close;
      }
      if (!(lastClose && lastClose > 0)) {
        throw new Error(`Missing aligned price for ${symbol} on ${dateKey}`);
      }
      values.push(lastClose);
    }
    aligned[symbol] = values;
  }
  return aligned;
}

function chooseRegime(latestObservation: CpiPoint | null, spyReturn63d: number): MacroPreservationRegime {
  if (!latestObservation) {
    return 'cash';
  }
  if (latestObservation.yoyPct < 3.0) {
    return 'cash';
  }
  if (spyReturn63d < 0 && latestObservation.momentumPct < 0) {
    return 'stagflation';
  }
  if (latestObservation.momentumPct < 0) {
    return 'cooling';
  }
  return 'inflation';
}

function macroBias(symbol: MacroPreservationAssetSymbol, latestObservation: CpiPoint, regime: MacroPreservationRegime, spyReturn63d: number): number {
  const hot = regime !== 'cash';
  const riskOff = spyReturn63d < 0;
  const momentumBonus = clamp(latestObservation.momentumPct / 4, -0.4, 0.6);
  const inflationBonus = clamp((latestObservation.yoyPct - 3.0) / 4, 0, 1.2);

  switch (symbol) {
    case 'GLD':
      return (hot ? 1.2 : 0.2) + (riskOff ? 0.6 : 0.2) + momentumBonus + inflationBonus * 0.35;
    case 'SLV':
      return (hot ? 0.9 : 0.1) + (riskOff ? 0.15 : 0.05) + momentumBonus * 0.8 + inflationBonus * 0.25;
    case 'USO':
      return (hot ? 1.1 : -0.15) + (latestObservation.momentumPct > 0 ? 0.6 : -0.2) + (riskOff ? -0.1 : 0.15) + inflationBonus * 0.5;
    case 'DBC':
      return (hot ? 1.0 : 0.15) + (riskOff ? 0.3 : 0.15) + momentumBonus * 0.9 + inflationBonus * 0.35;
    case 'BIL':
      return 0;
  }
}

function normalizeTrailingReturn(value: number, scale: number): number {
  return clamp(value / scale, -1.5, 1.5);
}

function selectPortfolio(
  asOfIndex: number,
  alignedPrices: Record<string, number[]>,
  benchmarkSymbol: string,
  cashSymbol: MacroPreservationAssetSymbol,
  cpiSeries: CpiPoint[],
  dateEpochs: number[],
  inflationThresholdPct: number
): MacroSelection {
  const dateEpoch = dateEpochs[asOfIndex] ?? dateEpochs[dateEpochs.length - 1] ?? Date.now();
  const latestObservation = computeCpiAtIndex(cpiSeries, dateEpoch);
  const spySeries = alignedPrices[benchmarkSymbol];
  const cashSeries = alignedPrices[cashSymbol];
  if (!spySeries || !cashSeries) {
    throw new Error('Missing benchmark or cash series for macro preservation selection.');
  }

  const spySeriesObject: PriceSeries = {
    symbol: benchmarkSymbol,
    dates: [],
    epochs: [],
    closes: spySeries,
    dailyReturns: [],
    closeByDate: new Map(),
    firstDate: null,
    lastDate: null
  };

  const spyReturn63d = trailingReturnPct(spySeriesObject, asOfIndex, 63);
  const spyReturn126d = trailingReturnPct(spySeriesObject, asOfIndex, 126);
  const inflationHot = Boolean(latestObservation && latestObservation.yoyPct >= inflationThresholdPct);
  const regime = chooseRegime(latestObservation, spyReturn63d);

  if (!latestObservation || !inflationHot) {
    return {
      regime: 'cash',
      inflationObservation: latestObservation,
      inflationHot: false,
      allocations: [
        {
          symbol: cashSymbol,
          name: ASSET_CONFIG[cashSymbol].name,
          weightPct: 100,
          trailingReturnPct: round(trailingReturnPct({ ...spySeriesObject, closes: cashSeries }, asOfIndex, 63), 3),
          score: 1,
          estimatedCostBps: ASSET_CONFIG[cashSymbol].costBps,
          reason: 'CPI is below the inflation threshold or unavailable; stay in cash.'
        }
      ],
      notes: [
        latestObservation ? `Latest CPI YoY ${latestObservation.yoyPct.toFixed(2)}% is below the ${inflationThresholdPct.toFixed(2)}% inflation threshold.` : 'No CPI observation is available yet for this date.'
      ]
    };
  }

  const riskBudget = regime === 'stagflation' ? 0.8 : regime === 'cooling' ? 0.7 : 0.85;
  const assetScores = REAL_ASSETS.map((symbol) => {    const series = alignedPrices[symbol];
    if (!series) {
      return null;
    }
    const seriesObject: PriceSeries = {
      symbol,
      dates: [],
      epochs: [],
      closes: series,
      dailyReturns: [],
      closeByDate: new Map(),
      firstDate: null,
      lastDate: null
    };
    const ret63 = trailingReturnPct(seriesObject, asOfIndex, 63);
    const ret126 = trailingReturnPct(seriesObject, asOfIndex, 126);
    const score = 0.55 * normalizeTrailingReturn(ret63, 12) + 0.35 * normalizeTrailingReturn(ret126, 20) + macroBias(symbol, latestObservation, regime, spyReturn63d);
    const reason = score > 0
      ? `${symbol} has positive macro bias and ${ret63.toFixed(2)}% / ${ret126.toFixed(2)}% momentum.`
      : `${symbol} is weak on momentum and stays off the sleeve.`;
    return {
      symbol,
      weightPct: 0,
      trailingReturnPct: ret63,
      score,
      estimatedCostBps: ASSET_CONFIG[symbol].costBps,
      reason,
      name: ASSET_CONFIG[symbol].name,
      ret126
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const positiveScores = assetScores.filter((entry) => entry.score > 0);
  if (positiveScores.length === 0) {
    return {
      regime,
      inflationObservation: latestObservation,
      inflationHot: true,
      allocations: [
        {
          symbol: cashSymbol,
          name: ASSET_CONFIG[cashSymbol].name,
          weightPct: 100,
          trailingReturnPct: round(trailingReturnPct({ ...spySeriesObject, closes: cashSeries }, asOfIndex, 63), 3),
          score: 1,
          estimatedCostBps: ASSET_CONFIG[cashSymbol].costBps,
          reason: 'Inflation is active, but no real-asset sleeve has positive momentum after costs; stay in cash.'
        }
      ],
      notes: [
        `Inflation regime active (${latestObservation.yoyPct.toFixed(2)}% YoY) but every real-asset score is negative after momentum and macro bias.`
      ]
    };
  }

  const scoreTotal = positiveScores.reduce((sum, entry) => sum + entry.score, 0);
  const realAssetWeights = positiveScores.map((entry) => ({
    symbol: entry.symbol,
    weightPct: (entry.score / scoreTotal) * riskBudget
  }));
  let allocatedRealWeight = 0;
  const allocations: MacroPreservationAllocation[] = realAssetWeights
    .map((entry) => {
      const asset = assetScores.find((candidate) => candidate.symbol === entry.symbol)!;
      const cappedWeight = Math.min(entry.weightPct, ASSET_CONFIG[entry.symbol].capPct);
      allocatedRealWeight += cappedWeight;
      return {
        symbol: entry.symbol,
        name: asset.name,
        weightPct: round(cappedWeight * 100, 3),
        trailingReturnPct: round(asset.trailingReturnPct, 3),
        score: round(asset.score, 4),
        estimatedCostBps: asset.estimatedCostBps,
        reason: asset.reason
      };
    })
    .filter((entry) => entry.weightPct > 0)
    .sort((left, right) => right.weightPct - left.weightPct);

  const cashWeight = Math.max(0, 1 - allocatedRealWeight);
  const cashTrailing = round(trailingReturnPct({ ...spySeriesObject, closes: cashSeries }, asOfIndex, 63), 3);
  allocations.push({
    symbol: cashSymbol,
    name: ASSET_CONFIG[cashSymbol].name,
    weightPct: round(cashWeight * 100, 3),
    trailingReturnPct: cashTrailing,
    score: 0.2,
    estimatedCostBps: ASSET_CONFIG[cashSymbol].costBps,
    reason: cashWeight > 0 ? `Keep a ${round(cashWeight * 100, 1)}% cash cushion for preservation.` : 'No cash cushion required.'
  });

  return {
    regime,
    inflationObservation: latestObservation,
    inflationHot: true,
    allocations,
    notes: [
      `CPI YoY ${latestObservation.yoyPct.toFixed(2)}% is above the ${inflationThresholdPct.toFixed(2)}% inflation threshold.`,
      `SPY 63-day trend is ${spyReturn63d.toFixed(2)}% and 126-day trend is ${spyReturn126d.toFixed(2)}%.`
    ]
  };
}

function buildPeriodReturn(startIndex: number, endIndex: number, weights: Map<string, number>, alignedReturns: Record<string, number[]>, benchmarkSymbol: string, cashSymbol: MacroPreservationAssetSymbol): {
  sleeveReturnPct: number;
  benchmarkReturnPct: number;
  cashReturnPct: number;
} {
  let sleeve = 1;
  let benchmark = 1;
  let cash = 1;
  for (let index = startIndex; index < endIndex; index += 1) {
    let sleeveDaily = 0;
    for (const [symbol, weight] of weights.entries()) {
      const daily = alignedReturns[symbol]?.[index] ?? 0;
      sleeveDaily += weight * daily;
    }
    sleeve *= 1 + sleeveDaily;
    benchmark *= 1 + (alignedReturns[benchmarkSymbol]?.[index] ?? 0);
    cash *= 1 + (alignedReturns[cashSymbol]?.[index] ?? 0);
  }
  return {
    sleeveReturnPct: (sleeve - 1) * 100,
    benchmarkReturnPct: (benchmark - 1) * 100,
    cashReturnPct: (cash - 1) * 100
  };
}

function buildWeightsMap(allocations: MacroPreservationAllocation[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const allocation of allocations) {
    map.set(allocation.symbol, allocation.weightPct / 100);
  }
  return map;
}

function computeTurnoverPct(previousWeights: Map<string, number>, currentWeights: Map<string, number>): number {
  const symbols = new Set<string>([...previousWeights.keys(), ...currentWeights.keys()]);
  let turnover = 0;
  for (const symbol of symbols) {
    const previous = previousWeights.get(symbol) ?? 0;
    const current = currentWeights.get(symbol) ?? 0;
    turnover += Math.abs(current - previous);
  }
  return round(turnover * 50, 3);
}

function estimateFeesUsd(equity: number, allocations: MacroPreservationAllocation[], previousWeights: Map<string, number>): number {
  const currentWeights = buildWeightsMap(allocations);
  const symbols = new Set<string>([...previousWeights.keys(), ...currentWeights.keys()]);
  let feePct = 0;
  for (const symbol of symbols) {
    const previous = previousWeights.get(symbol) ?? 0;
    const current = currentWeights.get(symbol) ?? 0;
    const delta = Math.abs(current - previous);
    const costBps = ASSET_CONFIG[symbol as MacroPreservationAssetSymbol]?.costBps ?? 2;
    feePct += delta * (costBps / 10_000);
  }
  return round(equity * feePct, 2);
}

function createPeriod(
  startDate: string,
  endDate: string,
  decisionAt: string,
  selection: MacroSelection,
  alignedReturns: Record<string, number[]>,
  benchmarkSymbol: string,
  cashSymbol: MacroPreservationAssetSymbol,
  startIndex: number,
  endIndex: number,
  previousWeights: Map<string, number>,
  periodStartEquity: number
): { period: MacroPreservationBacktestPeriod; feeUsd: number; turnoverPct: number; weights: Map<string, number>; sleeveReturnPct: number; benchmarkReturnPct: number; cashReturnPct: number } {
  const weights = buildWeightsMap(selection.allocations);
  const turnoverPct = computeTurnoverPct(previousWeights, weights);
  const feeUsd = estimateFeesUsd(periodStartEquity, selection.allocations, previousWeights);
  const periodReturns = buildPeriodReturn(startIndex, endIndex, weights, alignedReturns, benchmarkSymbol, cashSymbol);
  const allocations = selection.allocations.map((allocation) => ({
    symbol: allocation.symbol,
    name: allocation.name,
    weightPct: allocation.weightPct,
    trailingReturnPct: allocation.trailingReturnPct,
    returnPct: round((periodReturns.sleeveReturnPct * (allocation.weightPct / 100)), 3),
    contributionPct: round(periodReturns.sleeveReturnPct * (allocation.weightPct / 100), 3),
    score: allocation.score,
    estimatedCostBps: allocation.estimatedCostBps,
    reason: allocation.reason
  }));

  return {
    period: {
      startDate,
      endDate,
      decisionAt,
      regime: selection.regime,
      inflationObservationDate: selection.inflationObservation?.observationDate ?? null,
      inflationYoY: round(selection.inflationObservation?.yoyPct ?? 0, 3),
      inflationMomentumPct: round(selection.inflationObservation?.momentumPct ?? 0, 3),
      sleeveReturnPct: round(periodReturns.sleeveReturnPct, 3),
      benchmarkReturnPct: round(periodReturns.benchmarkReturnPct, 3),
      cashReturnPct: round(periodReturns.cashReturnPct, 3),
      turnoverPct,
      feesUsd: feeUsd,
      notes: selection.notes,
      allocations
    },
    feeUsd,
    turnoverPct,
    weights,
    sleeveReturnPct: periodReturns.sleeveReturnPct,
    benchmarkReturnPct: periodReturns.benchmarkReturnPct,
    cashReturnPct: periodReturns.cashReturnPct
  };
}

function buildInflationCurve(periods: MacroPreservationBacktestPeriod[], startCapital: number): { inflationEquity: number; inflationBenchmarkEquity: number; inflationCashEquity: number; inflationPeriodCount: number } {
  let sleeveEquity = startCapital;
  let benchmarkEquity = startCapital;
  let cashEquity = startCapital;
  let count = 0;
  for (const period of periods) {
    if (period.regime === 'cash') continue;
    count += 1;
    sleeveEquity *= 1 + period.sleeveReturnPct / 100;
    benchmarkEquity *= 1 + period.benchmarkReturnPct / 100;
    cashEquity *= 1 + period.cashReturnPct / 100;
  }
  return {
    inflationEquity: sleeveEquity,
    inflationBenchmarkEquity: benchmarkEquity,
    inflationCashEquity: cashEquity,
    inflationPeriodCount: count
  };
}

async function prepareInputs(startDate: string, endDate: string, benchmarkSymbol: string, cashSymbol: MacroPreservationAssetSymbol): Promise<{
  benchmarkDates: string[];
  benchmarkEpochs: number[];
  benchmarkPrices: PriceSeries;
  cashPrices: PriceSeries;
  realAssetPrices: Record<MacroPreservationAssetSymbol, PriceSeries>;
  cpiSeries: CpiPoint[];
  commonStartDate: string;
}> {
  const fetchStart = shiftIsoDate(startDate, -540);
  
  // 45s hard deadline for data collection to avoid dashboard hangs
  const DATA_TIMEOUT_MS = 45_000;
  
  const dataPromise = Promise.all([
    fetchPriceSeries(benchmarkSymbol, fetchStart, endDate),
    fetchPriceSeries(cashSymbol, fetchStart, endDate),
    fetchCpiSeries(),
    ...REAL_ASSETS.map((symbol) => fetchPriceSeries(symbol, fetchStart, endDate))
  ]);

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Macro data fetch timed out after ${DATA_TIMEOUT_MS / 1000}s`)), DATA_TIMEOUT_MS);
  });

  const [benchmarkPrices, cashPrices, cpiSeries, ...assetResults] = await Promise.race([dataPromise, timeoutPromise]) as [
    PriceSeries,
    PriceSeries,
    CpiPoint[],
    ...PriceSeries[]
  ];
  
  const realAssetPrices = Object.fromEntries(assetResults.map((series) => [series.symbol as MacroPreservationAssetSymbol, series])) as Record<MacroPreservationAssetSymbol, PriceSeries>;
  const commonStartDate = getCommonStartDate([benchmarkPrices, cashPrices, ...Object.values(realAssetPrices)]) ?? startDate;
  const commonStartEpoch = parseDateKey(commonStartDate);
  const benchmarkDates = benchmarkPrices.dates.filter((dateKey) => parseDateKey(dateKey) >= commonStartEpoch);
  const benchmarkEpochs = benchmarkPrices.epochs.filter((epoch) => epoch >= commonStartEpoch);
  
  return { benchmarkDates, benchmarkEpochs, benchmarkPrices, cashPrices, realAssetPrices, cpiSeries, commonStartDate };
}

function buildAlignedReturns(seriesMap: Map<string, PriceSeries>, benchmarkDates: string[]): Record<string, number[]> {
  const aligned: Record<string, number[]> = {};
  for (const [symbol, series] of seriesMap.entries()) {
    const prices = buildAlignedCloseArray(series, benchmarkDates);
    aligned[symbol] = prices.map((close, index) => {
      if (index === 0) return 0;
      const previous = prices[index - 1] ?? close;
      return previous > 0 ? (close / previous) - 1 : 0;
    });
  }
  return aligned;
}

function buildAlignedCloseArray(series: PriceSeries, benchmarkDates: string[]): number[] {
  const values: number[] = [];
  let lastClose: number | null = null;
  for (const dateKey of benchmarkDates) {
    const close = series.closeByDate.get(dateKey);
    if (typeof close === 'number' && Number.isFinite(close)) {
      lastClose = close;
    }
    if (!(lastClose && lastClose > 0)) {
      throw new Error(`Missing aligned price for ${series.symbol} on ${dateKey}`);
    }
    values.push(lastClose);
  }
  return values;
}

export async function getMacroPreservationPortfolioSnapshot(
  asOf = new Date().toISOString(),
  request?: Partial<MacroPreservationBacktestRequest>
): Promise<MacroPreservationPortfolioSnapshot> {
  const benchmarkSymbol = (request?.benchmarkSymbol?.trim() || defaultBenchmarkSymbol).toUpperCase() as 'SPY';
  const cashSymbol = (request?.cashSymbol ?? defaultCashSymbol).toUpperCase() as MacroPreservationAssetSymbol;
  const inflationThresholdPct = Number.isFinite(request?.inflationThresholdPct ?? NaN)
    ? Number(request?.inflationThresholdPct)
    : defaultInflationThresholdPct;
  const cacheKey = `${cacheBucket(asOf)}:${benchmarkSymbol}:${cashSymbol}:${inflationThresholdPct}`;
  const cached = snapshotCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
    return cached.snapshot;
  }

  const endDate = asOf;
  const startDate = shiftIsoDate(asOf, -540);
  const inputs = await prepareInputs(startDate, endDate, benchmarkSymbol, cashSymbol);
  const seriesMap = new Map<string, PriceSeries>([
    [benchmarkSymbol, inputs.benchmarkPrices],
    [cashSymbol, inputs.cashPrices],
    ...Object.entries(inputs.realAssetPrices)
  ]);
  const alignedPrices = buildAlignedCloseArrayMap(seriesMap, inputs.benchmarkDates);
  const snapshotIndex = Math.max(0, inputs.benchmarkDates.length - 1);
  const selection = selectPortfolio(snapshotIndex, alignedPrices, benchmarkSymbol, cashSymbol, inputs.cpiSeries, inputs.benchmarkEpochs, inflationThresholdPct);
  const snapshot: MacroPreservationPortfolioSnapshot = {
    asOf,
    benchmarkSymbol,
    cashSymbol,
    inflationThresholdPct,
    latestObservation: selection.inflationObservation,
    recentObservations: inputs.cpiSeries.slice(-12),
    regime: selection.regime,
    inflationHot: selection.inflationHot,
    selectedAllocations: selection.allocations,
    notes: [
      ...selection.notes,
      selection.inflationObservation ? `Latest inflation observation released ${selection.inflationObservation.availableAt}.` : 'No released CPI observation is available yet.'
    ]
  };
  snapshotCache.set(cacheKey, { cachedAt: Date.now(), snapshot });
  return snapshot;
}

function buildAlignedCloseArrayMap(seriesMap: Map<string, PriceSeries>, benchmarkDates: string[]): Record<string, number[]> {
  const aligned: Record<string, number[]> = {};
  for (const [symbol, series] of seriesMap.entries()) {
    aligned[symbol] = buildAlignedCloseArray(series, benchmarkDates);
  }
  return aligned;
}

function buildAlignedReturnMap(seriesMap: Map<string, PriceSeries>, benchmarkDates: string[]): Record<string, number[]> {
  const aligned: Record<string, number[]> = {};
  for (const [symbol, series] of seriesMap.entries()) {
    const prices = buildAlignedCloseArray(series, benchmarkDates);
    aligned[symbol] = prices.map((close, index) => {
      if (index === 0) return 0;
      const previous = prices[index - 1] ?? close;
      return previous > 0 ? (close / previous) - 1 : 0;
    });
  }
  return aligned;
}

function buildPeriodBoundaries(benchmarkDates: string[], cpiSeries: CpiPoint[], benchmarkEpochs: number[]): number[] {
  const boundaries = new Set<number>();
  const firstEpoch = benchmarkEpochs[0];
  if (firstEpoch !== undefined) boundaries.add(0);
  let latestObservationDate: string | null = null;
  for (let index = 0; index < benchmarkEpochs.length; index += 1) {
    const epoch = benchmarkEpochs[index]!;
    const latestObservation = computeCpiAtIndex(cpiSeries, epoch);
    const observationDate = latestObservation?.observationDate ?? 'none';
    if (observationDate !== latestObservationDate) {
      boundaries.add(index);
      latestObservationDate = observationDate;
    }
  }
  boundaries.add(benchmarkDates.length);
  return Array.from(boundaries).sort((left, right) => left - right);
}

export async function runMacroPreservationBacktest(request: Partial<MacroPreservationBacktestRequest> = {}): Promise<MacroPreservationBacktestResult> {
  const benchmarkSymbol = (request.benchmarkSymbol?.trim() || defaultBenchmarkSymbol).toUpperCase() as 'SPY';
  const cashSymbol = (request.cashSymbol ?? defaultCashSymbol).toUpperCase() as MacroPreservationAssetSymbol;
  const inflationThresholdPct = Number.isFinite(request.inflationThresholdPct ?? NaN)
    ? Number(request.inflationThresholdPct)
    : defaultInflationThresholdPct;
  const range = request.startDate && request.endDate
    ? { startDate: request.startDate, endDate: request.endDate }
    : buildDefaultRange();
  const capital = request.capital && request.capital > 0 ? request.capital : Number(process.env.HERMES_STARTING_EQUITY ?? 300_000);
  const cacheKey = `${benchmarkSymbol}:${cashSymbol}:${inflationThresholdPct}:${range.startDate}:${range.endDate}:${capital}`;
  const cached = backtestCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
    return cached.result;
  }

  const inputs = await prepareInputs(range.startDate, range.endDate, benchmarkSymbol, cashSymbol);
  const seriesMap = new Map<string, PriceSeries>([
    [benchmarkSymbol, inputs.benchmarkPrices],
    [cashSymbol, inputs.cashPrices],
    ...Object.entries(inputs.realAssetPrices)
  ]);
  const alignedPrices = buildAlignedCloseArrayMap(seriesMap, inputs.benchmarkDates);
  const alignedReturns = buildAlignedReturnMap(seriesMap, inputs.benchmarkDates);

  const commonStartDate = inputs.commonStartDate;
  const effectiveStartDate = parseDateKey(toDateKey(range.startDate)) > parseDateKey(commonStartDate)
    ? toDateKey(range.startDate)
    : commonStartDate;
  const effectiveStartIndex = inputs.benchmarkDates.findIndex((dateKey) => parseDateKey(dateKey) >= parseDateKey(effectiveStartDate));
  if (effectiveStartIndex < 0) {
    throw new Error('No benchmark dates available for macro preservation backtest.');
  }

  const periodDates = inputs.benchmarkDates.slice(effectiveStartIndex);
  const periodEpochs = inputs.benchmarkEpochs.slice(effectiveStartIndex);
  const boundaries = buildPeriodBoundaries(periodDates, inputs.cpiSeries, periodEpochs);
  const periods: MacroPreservationBacktestPeriod[] = [];
  const curve: number[] = [capital];
  const benchmarkCurve: number[] = [capital];
  const cashCurve: number[] = [capital];
  let grossEquity = capital;
  let netEquity = capital;
  let benchmarkEquity = capital;
  let cashEquity = capital;
  let maxEquity = capital;
  let maxDrawdownPct = 0;
  let totalFeesUsd = 0;
  let previousWeights = new Map<string, number>([[cashSymbol, 1]]);

  const startOffset = effectiveStartIndex;
  for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
    const relativeStart = boundaries[boundaryIndex]!;
    const relativeEnd = boundaries[boundaryIndex + 1]!;
    const startIndex = startOffset + relativeStart;
    const endIndex = startOffset + relativeEnd;
    if (endIndex <= startIndex) continue;

    const decisionAt = inputs.benchmarkDates[startIndex]!;
    const selection = selectPortfolio(startIndex, alignedPrices, benchmarkSymbol, cashSymbol, inputs.cpiSeries, inputs.benchmarkEpochs, inflationThresholdPct);
    const weights = buildWeightsMap(selection.allocations);
    const turnoverPct = computeTurnoverPct(previousWeights, weights);
    const feeUsd = estimateFeesUsd(netEquity, selection.allocations, previousWeights);
    const startNetEquity = netEquity;
    const startBenchmarkEquity = benchmarkEquity;
    const startCashEquity = cashEquity;

    const periodReturns = buildPeriodReturn(startIndex, endIndex, weights, alignedReturns, benchmarkSymbol, cashSymbol);
    grossEquity *= 1 + periodReturns.sleeveReturnPct / 100;
    netEquity *= 1 + periodReturns.sleeveReturnPct / 100;
    netEquity -= feeUsd;
    benchmarkEquity *= 1 + periodReturns.benchmarkReturnPct / 100;
    cashEquity *= 1 + periodReturns.cashReturnPct / 100;
    totalFeesUsd += feeUsd;
    maxEquity = Math.max(maxEquity, netEquity);
    maxDrawdownPct = Math.max(maxDrawdownPct, maxEquity > 0 ? ((maxEquity - netEquity) / maxEquity) * 100 : 0);

    curve.push(round(netEquity, 2));
    benchmarkCurve.push(round(benchmarkEquity, 2));
    cashCurve.push(round(cashEquity, 2));

    const allocations = selection.allocations.map((allocation) => ({
      symbol: allocation.symbol,
      name: allocation.name,
      weightPct: allocation.weightPct,
      trailingReturnPct: round(allocation.trailingReturnPct, 3),
      returnPct: round(periodReturns.sleeveReturnPct * (allocation.weightPct / 100), 3),
      contributionPct: round(periodReturns.sleeveReturnPct * (allocation.weightPct / 100), 3),
      score: round(allocation.score, 4),
      estimatedCostBps: allocation.estimatedCostBps,
      reason: allocation.reason
    }));

    const period: MacroPreservationBacktestPeriod = {
      startDate: inputs.benchmarkDates[startIndex]!,
      endDate: inputs.benchmarkDates[endIndex - 1] ?? inputs.benchmarkDates[startIndex]!,
      decisionAt,
      regime: selection.regime,
      inflationObservationDate: selection.inflationObservation?.observationDate ?? null,
      inflationYoY: round(selection.inflationObservation?.yoyPct ?? 0, 3),
      inflationMomentumPct: round(selection.inflationObservation?.momentumPct ?? 0, 3),
      sleeveReturnPct: round((netEquity / startNetEquity - 1) * 100, 3),
      benchmarkReturnPct: round((benchmarkEquity / startBenchmarkEquity - 1) * 100, 3),
      cashReturnPct: round((cashEquity / startCashEquity - 1) * 100, 3),
      turnoverPct,
      feesUsd: round(feeUsd, 2),
      notes: [...selection.notes, feeUsd > 0 ? `Fees estimated at ${feeUsd.toFixed(2)} USD.` : 'No rebalance fee applied.'],
      allocations
    };

    periods.push(period);
    previousWeights = weights;
  }

  const inflationPeriods = periods.filter((period) => period.regime !== 'cash');
  const inflationCurve = buildInflationCurve(inflationPeriods, capital);
  const totalReturnPct = ((netEquity / capital) - 1) * 100;
  const grossReturnPct = ((grossEquity / capital) - 1) * 100;
  const benchmarkReturnPct = ((benchmarkEquity / capital) - 1) * 100;
  const cashReturnPct = ((cashEquity / capital) - 1) * 100;
  const inflationReturnPct = ((inflationCurve.inflationEquity / capital) - 1) * 100;
  const inflationBenchmarkReturnPct = ((inflationCurve.inflationBenchmarkEquity / capital) - 1) * 100;
  const inflationCashReturnPct = ((inflationCurve.inflationCashEquity / capital) - 1) * 100;

  const result: MacroPreservationBacktestResult = {
    id: `macro-preservation-${randomUUID()}`,
    capital,
    startDate: effectiveStartDate,
    endDate: range.endDate,
    benchmarkSymbol,
    cashSymbol,
    inflationThresholdPct,
    totalReturnPct: round(totalReturnPct, 3),
    grossReturnPct: round(grossReturnPct, 3),
    netReturnPct: round(totalReturnPct, 3),
    benchmarkReturnPct: round(benchmarkReturnPct, 3),
    cashReturnPct: round(cashReturnPct, 3),
    inflationReturnPct: round(inflationReturnPct, 3),
    inflationBenchmarkReturnPct: round(inflationBenchmarkReturnPct, 3),
    inflationCashReturnPct: round(inflationCashReturnPct, 3),
    inflationPeriodCount: inflationCurve.inflationPeriodCount,
    totalPnL: round(netEquity - capital, 2),
    totalFeesUsd: round(totalFeesUsd, 2),
    maxDrawdownPct: round(maxDrawdownPct, 3),
    periods,
    inflationPeriods,
    curve,
    benchmarkCurve,
    cashCurve,
    notes: [
      `Inflation threshold: ${inflationThresholdPct.toFixed(2)}% YoY CPI.`,
      `Data range adjusted to ${effectiveStartDate} to ensure all ETFs had overlap.`,
      `Cash fallback symbol: ${cashSymbol}.`,
      ...(periods.length === 0 ? ['No rebalance periods were generated.'] : [])
    ]
  };

  backtestCache.set(cacheKey, { cachedAt: Date.now(), result });
  return result;
}
