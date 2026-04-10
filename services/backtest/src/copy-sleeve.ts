import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  AssetClass,
  CopySleeveBacktestPeriod,
  CopySleeveBacktestRequest,
  CopySleeveBacktestResult,
  CopySleeveFilingSnapshot,
  CopySleeveHolding,
  CopySleeveManagerConfig,
  CopySleeveManagerId,
  CopySleevePortfolioSnapshot
} from '@hermes/contracts';
import { fetchCandles } from './historical-data.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = process.env.COPY_SLEEVE_RUNTIME_DIR ?? path.resolve(moduleDir, '../.runtime/copy-sleeve');
const secUserAgent = process.env.SEC_USER_AGENT ?? 'Hermes Trading Firm support@hermes.local';
const secBaseUrl = process.env.SEC_BASE_URL ?? 'https://www.sec.gov';
const portfolioCacheTtlMs = Number(process.env.COPY_SLEEVE_CACHE_MS ?? 10 * 60 * 1000);

const MANAGERS: Record<CopySleeveManagerId, CopySleeveManagerConfig> = {
  'berkshire-hathaway': {
    id: 'berkshire-hathaway',
    name: 'Berkshire Hathaway Inc',
    cik: '1067983',
    benchmarkSymbol: 'SPY'
  }
};

const BERKSHIRE_SYMBOL_MAP = new Map<string, string>([
  ['APPLE INC', 'AAPL'],
  ['AMERICAN EXPRESS CO', 'AXP'],
  ['BANK AMERICA CORP', 'BAC'],
  ['COCA COLA CO', 'KO'],
  ['CHEVRON CORP NEW', 'CVX'],
  ['MOODYS CORP', 'MCO'],
  ['OCCIDENTAL PETE CORP', 'OXY'],
  ['CHUBB LIMITED', 'CB'],
  ['KRAFT HEINZ CO', 'KHC'],
  ['ALPHABET INC', 'GOOGL'],
  ['DAVITA INC', 'DVA'],
  ['KROGER CO', 'KR'],
  ['VISA INC', 'V'],
  ['SIRIUS XM HOLDINGS INC', 'SIRI'],
  ['MASTERCARD INCORPORATED', 'MA'],
  ['VERISIGN INC', 'VRSN'],
  ['CONSTELLATION BRANDS INC', 'STZ'],
  ['CAPITAL ONE FINL CORP', 'COF'],
  ['UNITEDHEALTH GROUP INC', 'UNH'],
  ['DOMINOS PIZZA INC', 'DPZ'],
  ['ALLY FINL INC', 'ALLY'],
  ['AON PLC', 'AON'],
  ['NUCOR CORP', 'NUE'],
  ['LENNAR CORP', 'LEN'],
  ['POOL CORP', 'POOL'],
  ['AMAZON COM INC', 'AMZN'],
  ['LOUISIANA PAC CORP', 'LPX'],
  ['NEW YORK TIMES CO', 'NYT'],
  ['HEICO CORP NEW', 'HEI'],
  ['CHARTER COMMUNICATIONS INC N', 'CHTR'],
  ['LAMAR ADVERTISING CO NEW', 'LAMR'],
  ['ALLEGION PLC', 'ALLE'],
  ['NVR INC', 'NVR'],
  ['JEFFERIES FINL GROUP INC', 'JEF'],
  ['DIAGEO PLC', 'DEO'],
  ['AMERICAN AIRLINES GROUP INC', 'AAL'],
  ['RH', 'RH'],
  ['LIBERTY LIVE HOLDINGS INC', 'LLYVK'],
  ['LIBERTY MEDIA CORP DEL', 'FWONK'],
  ['ATLANTA BRAVES HLDGS INC', 'BATRA']
]);

interface FilingReference {
  accessionNumber: string;
  filingDate: string;
  availableAt: string;
  filingHref: string;
  filingType: string;
}

interface RawHolding {
  issuerName: string;
  titleOfClass: string;
  cusip: string;
  shares: number;
  valueUsd: number;
  putCall: string | null;
}

interface ResolvedHolding extends CopySleeveHolding {
  tradedValueUsd: number;
}

const filingSnapshotCache = new Map<string, { cachedAt: number; snapshot: CopySleeveFilingSnapshot }>();
const portfolioCache = new Map<string, { cachedAt: number; snapshot: CopySleevePortfolioSnapshot }>();
const filingListCache = new Map<CopySleeveManagerId, { cachedAt: number; filings: FilingReference[] }>();
const priceCache = new Map<string, { cachedAt: number; returnPct: number | null }>();

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

function normalizeIssuerName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#39;/g, '\'');
}

function extractTag(source: string, tag: string): string {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXmlEntities(match[1]!.trim()) : '';
}

function assetClassForSymbol(symbol: string): AssetClass {
  const normalized = symbol.toUpperCase();
  if (normalized.endsWith('-USD')) {
    const base = normalized.split('-')[0] ?? '';
    if (['BTC', 'ETH', 'SOL', 'XRP'].includes(base)) return 'crypto';
    if (base === 'PAXG') return 'commodity-proxy';
    if (base === 'BCO' || base === 'WTICO') return 'commodity';
    return 'commodity-proxy';
  }
  if (normalized.includes('_')) {
    if (normalized.startsWith('USB')) return 'bond';
    if (normalized.startsWith('BCO') || normalized.startsWith('WTICO')) return 'commodity';
    return 'forex';
  }
  return 'equity';
}

function holdingCostBps(symbol: string): number {
  const assetClass = assetClassForSymbol(symbol);
  switch (assetClass) {
    case 'crypto': return 20;
    case 'forex': return 6;
    case 'bond': return 5;
    case 'commodity': return 8;
    case 'commodity-proxy': return 9;
    default: return 10;
  }
}

function getManager(managerId: CopySleeveManagerId): CopySleeveManagerConfig {
  const manager = MANAGERS[managerId];
  if (!manager) {
    throw new Error(`Unknown copy-sleeve manager: ${managerId}`);
  }
  return manager;
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

function parseAtomFeed(xml: string): FilingReference[] {
  const filings: FilingReference[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml))) {
    const entry = match[1] ?? '';
    const filingType = extractTag(entry, 'filing-type') || extractTag(entry, 'title').split(' ')[0] || '13F-HR';
    if (!filingType.startsWith('13F')) continue;
    const accessionNumber = extractTag(entry, 'accession-number');
    const filingDate = extractTag(entry, 'filing-date');
    const availableAt = extractTag(entry, 'updated') || `${filingDate}T00:00:00.000Z`;
    const filingHref = extractTag(entry, 'filing-href');
    if (!accessionNumber || !filingDate || !filingHref) continue;
    filings.push({ accessionNumber, filingDate, availableAt, filingHref, filingType });
  }
  return filings.sort((left, right) => Date.parse(right.availableAt) - Date.parse(left.availableAt));
}

function parseInfoTableXml(xml: string): RawHolding[] {
  const holdings: RawHolding[] = [];
  const blockRegex = /<infoTable>([\s\S]*?)<\/infoTable>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(xml))) {
    const block = match[1] ?? '';
    const issuerName = extractTag(block, 'nameOfIssuer');
    const titleOfClass = extractTag(block, 'titleOfClass');
    const cusip = extractTag(block, 'cusip');
    const shares = Number(extractTag(block, 'sshPrnamt') || 0);
    const valueUsd = Number(extractTag(block, 'value') || 0);
    const putCall = extractTag(block, 'putCall') || null;
    if (!issuerName || !Number.isFinite(valueUsd)) continue;
    holdings.push({ issuerName, titleOfClass, cusip, shares: Number.isFinite(shares) ? shares : 0, valueUsd, putCall });
  }
  return holdings;
}

function resolveHolding(raw: RawHolding): { symbol: string | null; resolutionMethod: 'manual-map' | 'openfigi' | 'unresolved'; reason?: string } {
  if (raw.putCall) {
    return { symbol: null, resolutionMethod: 'unresolved', reason: 'Derivative / option position not copied.' };
  }

  const normalizedIssuer = normalizeIssuerName(raw.issuerName);
  const direct = BERKSHIRE_SYMBOL_MAP.get(normalizedIssuer);
  if (direct) {
    if (normalizedIssuer === 'ALPHABET INC') {
      const title = normalizeIssuerName(raw.titleOfClass);
      if (title.includes('CLASS C') || title.includes('CL C')) {
        return { symbol: 'GOOG', resolutionMethod: 'manual-map', reason: 'Alphabet class C resolved from title of class.' };
      }
      if (title.includes('CLASS A') || title.includes('CL A')) {
        return { symbol: 'GOOGL', resolutionMethod: 'manual-map', reason: 'Alphabet class A resolved from title of class.' };
      }
    }
    return { symbol: direct, resolutionMethod: 'manual-map' };
  }

  if (normalizedIssuer === 'ALPHABET INC') {
    return { symbol: 'GOOGL', resolutionMethod: 'manual-map', reason: 'Alphabet defaulted to class A because the filing did not disambiguate the class.' };
  }

  return { symbol: null, resolutionMethod: 'unresolved', reason: 'No reliable ticker mapping available yet.' };
}

function aggregateHoldings(rawHoldings: RawHolding[]): ResolvedHolding[] {
  const totalValueUsd = rawHoldings.reduce((sum, holding) => sum + holding.valueUsd, 0);
  const grouped = new Map<string, { holding: ResolvedHolding; valueUsd: number; shares: number }>();

  for (const raw of rawHoldings) {
    const resolution = resolveHolding(raw);
    const isResolved = resolution.symbol !== null;
    const key = isResolved
      ? `symbol:${resolution.symbol}`
      : `unresolved:${normalizeIssuerName(raw.issuerName)}:${raw.cusip || 'no-cusip'}:${normalizeIssuerName(raw.titleOfClass || 'UNKNOWN')}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        holding: {
          issuerName: raw.issuerName,
          titleOfClass: raw.titleOfClass || undefined,
          cusip: raw.cusip || undefined,
          symbol: resolution.symbol ?? undefined,
          valueUsd: 0,
          shares: 0,
          weightPct: 0,
          resolved: isResolved,
          resolutionMethod: resolution.resolutionMethod,
          reason: resolution.reason,
          tradedValueUsd: 0
        },
        valueUsd: raw.valueUsd,
        shares: raw.shares
      });
    } else {
      existing.valueUsd += raw.valueUsd;
      existing.shares += raw.shares;
      if (!existing.holding.symbol && resolution.symbol) {
        existing.holding.symbol = resolution.symbol;
        existing.holding.resolved = true;
        existing.holding.resolutionMethod = resolution.resolutionMethod;
      }
    }
  }

  return Array.from(grouped.values())
    .map(({ holding, valueUsd, shares }) => ({
      ...holding,
      valueUsd,
      shares,
      tradedValueUsd: valueUsd
    }))
    .map((holding) => ({
      ...holding,
      weightPct: totalValueUsd > 0 ? round((holding.valueUsd / totalValueUsd) * 100, 3) : 0
    }))
    .sort((left, right) => right.weightPct - left.weightPct);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': secUserAgent,
      Accept: 'application/json,text/html,application/xml,text/xml;q=0.9,*/*;q=0.8'
    }
  });
  if (!response.ok) {
    throw new Error(`SEC request failed (${response.status}) for ${url}`);
  }
  return await response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': secUserAgent,
      Accept: 'application/json,text/html,application/xml,text/xml;q=0.9,*/*;q=0.8'
    }
  });
  if (!response.ok) {
    throw new Error(`SEC request failed (${response.status}) for ${url}`);
  }
  return await response.json() as T;
}

async function fetchFilings(managerId: CopySleeveManagerId): Promise<FilingReference[]> {
  const cached = filingListCache.get(managerId);
  if (cached && Date.now() - cached.cachedAt < portfolioCacheTtlMs) {
    return cached.filings;
  }

  const manager = getManager(managerId);
  const atomUrl = `${secBaseUrl}/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(manager.cik)}&type=13F-HR&owner=exclude&count=40&output=atom`;
  const feed = await fetchText(atomUrl);
  const filings = parseAtomFeed(feed);
  filingListCache.set(managerId, { cachedAt: Date.now(), filings });
  return filings;
}

async function fetchFilingSnapshot(managerId: CopySleeveManagerId, filing: FilingReference): Promise<CopySleeveFilingSnapshot> {
  const cacheKey = `${managerId}:${filing.accessionNumber}`;
  const cached = filingSnapshotCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < portfolioCacheTtlMs) {
    return cached.snapshot;
  }

  const filingBase = new URL('.', filing.filingHref).toString();
  const indexUrl = new URL('index.json', filingBase).toString();
  const index = await fetchJson<{ directory?: { item?: Array<{ name?: string; size?: string }> } }>(indexUrl);
  const items = index.directory?.item ?? [];
  const xmlCandidates = items.filter((item) => typeof item.name === 'string' && item.name.toLowerCase().endsWith('.xml'));
  const selectedXml = xmlCandidates
    .filter((item) => item.name !== 'primary_doc.xml')
    .sort((left, right) => Number(right.size ?? 0) - Number(left.size ?? 0))[0]
    ?? xmlCandidates.find((item) => item.name === 'primary_doc.xml')
    ?? null;

  if (!selectedXml?.name) {
    throw new Error(`No XML information table found for ${filing.accessionNumber}`);
  }

  const xmlUrl = new URL(selectedXml.name, filingBase).toString();
  const xml = await fetchText(xmlUrl);
  const rawHoldings = parseInfoTableXml(xml);
  const totalValueUsd = rawHoldings.reduce((sum, holding) => sum + holding.valueUsd, 0);
  const holdings = aggregateHoldings(rawHoldings);
  const resolvedWeightPct = holdings.filter((holding) => holding.resolved).reduce((sum, holding) => sum + holding.weightPct, 0);
  const unresolvedWeightPct = holdings.filter((holding) => !holding.resolved).reduce((sum, holding) => sum + holding.weightPct, 0);

  const snapshot: CopySleeveFilingSnapshot = {
    accessionNumber: filing.accessionNumber,
    filingDate: filing.filingDate,
    availableAt: filing.availableAt,
    filingHref: filing.filingHref,
    totalValueUsd: round(totalValueUsd, 2),
    holdings,
    resolvedWeightPct: round(resolvedWeightPct, 3),
    unresolvedWeightPct: round(unresolvedWeightPct, 3)
  };

  filingSnapshotCache.set(cacheKey, { cachedAt: Date.now(), snapshot });
  return snapshot;
}

function chooseActiveFiling(filings: FilingReference[], atIso: string): FilingReference | null {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return filings[0] ?? null;
  const chosen = filings
    .filter((filing) => Date.parse(filing.availableAt) <= at)
    .sort((left, right) => Date.parse(right.availableAt) - Date.parse(left.availableAt))[0] ?? null;
  return chosen;
}

function uniqueSortedDates(values: string[]): string[] {
  return Array.from(new Set(values))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
}

function buildPeriods(startDate: string, endDate: string, filings: FilingReference[]): Array<{ startDate: string; endDate: string; filing: FilingReference | null }> {
  const boundaries = uniqueSortedDates([
    startDate,
    endDate,
    ...filings
      .filter((filing) => Date.parse(filing.availableAt) > Date.parse(startDate) && Date.parse(filing.availableAt) < Date.parse(endDate))
      .map((filing) => filing.availableAt)
  ]);
  const periods: Array<{ startDate: string; endDate: string; filing: FilingReference | null }> = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const periodStart = boundaries[index]!;
    const periodEnd = boundaries[index + 1]!;
    periods.push({ startDate: periodStart, endDate: periodEnd, filing: chooseActiveFiling(filings, periodStart) });
  }
  return periods;
}

function computeTurnoverPct(previousWeights: Map<string, number>, currentWeights: Map<string, number>): number {
  const symbols = new Set<string>([...previousWeights.keys(), ...currentWeights.keys()]);
  let turnover = 0;
  for (const symbol of symbols) {
    const previous = previousWeights.get(symbol) ?? 0;
    const current = currentWeights.get(symbol) ?? 0;
    turnover += Math.abs(current - previous);
  }
  return round(turnover * 50, 3); // 0.5 * sum(|delta weights|) expressed in percentage points
}

function assetClassForPortfolioSymbol(symbol: string): AssetClass {
  return assetClassForSymbol(symbol);
}

async function fetchSymbolReturn(symbol: string, startDate: string, endDate: string): Promise<number | null> {
  const cacheKey = `${symbol}:${startDate}:${endDate}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < portfolioCacheTtlMs) {
    return cached.returnPct;
  }

  const candles = await fetchCandles(symbol, startDate, endDate);
  if (candles.length < 1) {
    priceCache.set(cacheKey, { cachedAt: Date.now(), returnPct: null });
    return null;
  }
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  if (first.close <= 0 || last.close <= 0) {
    priceCache.set(cacheKey, { cachedAt: Date.now(), returnPct: null });
    return null;
  }
  const returnPct = ((last.close / first.close) - 1) * 100;
  priceCache.set(cacheKey, { cachedAt: Date.now(), returnPct });
  return returnPct;
}

async function buildPortfolioForDate(managerId: CopySleeveManagerId, asOf: string): Promise<CopySleevePortfolioSnapshot> {
  const cacheKey = `${managerId}:${cacheBucket(asOf)}`;
  const cached = portfolioCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < portfolioCacheTtlMs) {
    return cached.snapshot;
  }

  const manager = getManager(managerId);
  const filings = await fetchFilings(managerId);
  const current = chooseActiveFiling(filings, asOf);
  const recentRefs = filings.slice(0, 4);
  const recentSnapshots = await Promise.all(recentRefs.map((filing) => fetchFilingSnapshot(managerId, filing)));
  const notes: string[] = [];
  if (!current) {
    notes.push('No filing available at or before the requested date.');
  }
  if ((recentSnapshots[0]?.resolvedWeightPct ?? 0) < 50) {
    notes.push('Resolution coverage is still partial; unresolved holdings remain in cash.');
  }

  const snapshot: CopySleevePortfolioSnapshot = {
    asOf,
    managerId,
    managerName: manager.name,
    benchmarkSymbol: manager.benchmarkSymbol,
    latestFiling: current ? await fetchFilingSnapshot(managerId, current) : null,
    recentFilings: recentSnapshots,
    notes
  };

  portfolioCache.set(cacheKey, { cachedAt: Date.now(), snapshot });
  return snapshot;
}

export async function getCopySleevePortfolioSnapshot(managerId: CopySleeveManagerId = 'berkshire-hathaway', asOf = new Date().toISOString()): Promise<CopySleevePortfolioSnapshot> {
  return buildPortfolioForDate(managerId, asOf);
}

export async function runCopySleeveBacktest(request: Partial<CopySleeveBacktestRequest>): Promise<CopySleeveBacktestResult> {
  const managerId = request.managerId ?? 'berkshire-hathaway';
  const manager = getManager(managerId);
  const now = new Date();
  const { startDate, endDate } = request.startDate && request.endDate
    ? { startDate: request.startDate, endDate: request.endDate }
    : getLastCompletedQuarterRange(now);
  const capital = request.capital && request.capital > 0 ? request.capital : 100_000;
  const benchmarkSymbol = request.benchmarkSymbol && request.benchmarkSymbol.trim() ? request.benchmarkSymbol.trim().toUpperCase() : manager.benchmarkSymbol;

  const filings = (await fetchFilings(managerId)).filter((filing) => Date.parse(filing.availableAt) <= Date.parse(endDate));
  if (filings.length === 0) {
    throw new Error(`No 13F filings available for ${manager.name} on or before ${endDate}`);
  }

  const periods = buildPeriods(startDate, endDate, filings);
  const startFiling = chooseActiveFiling(filings, startDate) ?? filings[0] ?? null;
  if (!startFiling) {
    throw new Error(`No start filing available for ${manager.name}`);
  }

  let netCapital = capital;
  let grossCapital = capital;
  let benchmarkCapital = capital;
  let maxEquity = capital;
  let maxDrawdownPct = 0;
  let totalFeesUsd = 0;
  let totalGrossReturnPct = 0;
  let totalNetReturnPct = 0;
  let rebalances = 0;
  const curve: number[] = [capital];
  const periodsResult: CopySleeveBacktestPeriod[] = [];
  const notes: string[] = [];

  let previousFilingAccession = startFiling.accessionNumber;
  let previousWeights = new Map<string, number>();
  const startSnapshot = await fetchFilingSnapshot(managerId, startFiling);
  for (const holding of startSnapshot.holdings.filter((item) => item.resolved && item.symbol)) {
    previousWeights.set(holding.symbol!, holding.weightPct / 100);
  }

  if (startSnapshot.resolvedWeightPct < 50) {
    notes.push(`Start-of-quarter resolution coverage is only ${startSnapshot.resolvedWeightPct.toFixed(1)}%; cash / unresolved holdings dilute the copy basket.`);
  }

  for (const period of periods) {
    if (!period.filing) {
      notes.push(`Skipping ${period.startDate} → ${period.endDate}: no active filing.`);
      continue;
    }

    const snapshot = await fetchFilingSnapshot(managerId, period.filing);
    const currentWeights = new Map<string, number>();
    const resolvedHoldings = snapshot.holdings.filter((holding) => holding.resolved && holding.symbol);
    for (const holding of resolvedHoldings) {
      currentWeights.set(holding.symbol!, holding.weightPct / 100);
    }

    const touchedSymbols = new Set<string>([...previousWeights.keys(), ...currentWeights.keys()]);
    const holdings: CopySleeveBacktestPeriod['holdings'] = [];
    let grossReturnPct = 0;
    let feesPct = 0;

    for (const symbol of touchedSymbols) {
      const weight = currentWeights.get(symbol) ?? 0;
      if (weight <= 0) continue;
      const returnPct = await fetchSymbolReturn(symbol, period.startDate, period.endDate);
      if (returnPct === null) {
        notes.push(`Missing market data for ${symbol} in ${period.startDate} → ${period.endDate}; returning 0 for that slice.`);
        continue;
      }
      const contributionPct = weight * returnPct;
      grossReturnPct += contributionPct;
      const costBps = holdingCostBps(symbol);
      holdings.push({
        issuerName: resolvedHoldings.find((holding) => holding.symbol === symbol)?.issuerName ?? symbol,
        symbol,
        weightPct: round(weight * 100, 3),
        returnPct: round(returnPct, 3),
        contributionPct: round(contributionPct, 3),
        estimatedCostBps: costBps
      });
    }

    for (const symbol of touchedSymbols) {
      const previous = previousWeights.get(symbol) ?? 0;
      const current = currentWeights.get(symbol) ?? 0;
      const delta = Math.abs(current - previous);
      if (delta <= 0) continue;
      feesPct += delta * (holdingCostBps(symbol) / 10_000);
    }

    const turnoverPct = computeTurnoverPct(previousWeights, currentWeights);
    const feesUsd = round(netCapital * feesPct, 2);
    const periodNetReturnPct = grossReturnPct - (feesUsd / netCapital) * 100;
    const grossCapitalAfter = grossCapital * (1 + grossReturnPct / 100);
    const netCapitalAfter = netCapital * (1 + periodNetReturnPct / 100);

    totalFeesUsd += feesUsd;
    totalGrossReturnPct += grossReturnPct;
    totalNetReturnPct += periodNetReturnPct;
    grossCapital = grossCapitalAfter;
    netCapital = netCapitalAfter;
    benchmarkCapital = benchmarkCapital * (1 + (await fetchSymbolReturn(benchmarkSymbol, period.startDate, period.endDate) ?? 0) / 100);
    maxEquity = Math.max(maxEquity, netCapital);
    maxDrawdownPct = Math.max(maxDrawdownPct, maxEquity > 0 ? ((maxEquity - netCapital) / maxEquity) * 100 : 0);
    curve.push(round(netCapital, 2));

    if (period.filing.accessionNumber !== previousFilingAccession) {
      rebalances += 1;
      previousFilingAccession = period.filing.accessionNumber;
    }

    const turnoverReason = turnoverPct > 0 ? `rebalance turnover ${turnoverPct.toFixed(2)}%` : 'held prior basket';
    periodsResult.push({
      startDate: period.startDate,
      endDate: period.endDate,
      filingDate: period.filing.filingDate,
      accessionNumber: period.filing.accessionNumber,
      resolvedWeightPct: snapshot.resolvedWeightPct,
      unresolvedWeightPct: snapshot.unresolvedWeightPct,
      turnoverPct,
      grossReturnPct: round(grossReturnPct, 3),
      netReturnPct: round(periodNetReturnPct, 3),
      feesUsd,
      notes: [turnoverReason, snapshot.resolvedWeightPct < 50 ? 'Low resolution coverage; much of the filing stayed in cash.' : 'Resolution coverage acceptable.'],
      holdings
    });

    previousWeights = currentWeights;
  }

  const benchmarkReturnPct = ((benchmarkCapital / capital) - 1) * 100;
  const netReturnPct = ((netCapital / capital) - 1) * 100;
  const grossReturnPct = ((grossCapital / capital) - 1) * 100;
  const resolvedCoveragePct = periodsResult.length > 0
    ? periodsResult.reduce((sum, period) => sum + period.resolvedWeightPct, 0) / periodsResult.length
    : startSnapshot.resolvedWeightPct;
  const unresolvedWeightPct = periodsResult.length > 0
    ? periodsResult.reduce((sum, period) => sum + period.unresolvedWeightPct, 0) / periodsResult.length
    : startSnapshot.unresolvedWeightPct;

  if (resolvedCoveragePct < 50) {
    notes.push(`Only ${resolvedCoveragePct.toFixed(1)}% of filing weight was confidently mapped to tradeable symbols; the rest stayed as cash/unresolved.`);
  }

  return {
    id: `copy-sleeve-${managerId}-${randomUUID()}`,
    managerId,
    managerName: manager.name,
    benchmarkSymbol,
    capital: round(capital, 2),
    startDate,
    endDate,
    totalReturnPct: round(netReturnPct, 3),
    grossReturnPct: round(grossReturnPct, 3),
    netReturnPct: round(netReturnPct, 3),
    benchmarkReturnPct: round(benchmarkReturnPct, 3),
    totalPnL: round(netCapital - capital, 2),
    totalFeesUsd: round(totalFeesUsd, 2),
    maxDrawdownPct: round(maxDrawdownPct, 3),
    rebalances,
    resolvedCoveragePct: round(resolvedCoveragePct, 3),
    unresolvedWeightPct: round(unresolvedWeightPct, 3),
    periods: periodsResult,
    curve,
    notes
  };
}
