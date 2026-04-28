// @ts-nocheck
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { MarketSnapshot, MarketDataSourceState, MarketDataSnapshotResponse, BrokerId } from '@hermes/contracts';
import type { SourceStatus } from './types.js';
import { isAlpacaEquity, isCryptoSymbol, isOandaSymbol } from './utils.js';

/* ── Runtime paths ───────────────────────────────────────────────── */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const runtimeDir = path.resolve(moduleDir, '../../.runtime');
export const runtimeFile = path.join(runtimeDir, 'market-data.json');

/* ── Shared mutable state ────────────────────────────────────────── */

export const previousPrices = new Map<string, number>();
/** Tracks each symbol's UTC-midnight open price for changePct computation.
 * Reset automatically when a new UTC day is detected. */
export const dailyOpenPrices = new Map<string, number>();
let currentUtcDate = '';
export let lastRefreshError = 'Waiting for first market refresh.';
export let lastSuccessfulRefreshAt = 0;
export let refreshInFlight = false;

export function setLastRefreshError(value: string): void {
  lastRefreshError = value;
}
export function setLastSuccessfulRefreshAt(value: number): void {
  lastSuccessfulRefreshAt = value;
}
export function setRefreshInFlight(value: boolean): void {
  refreshInFlight = value;
}

/** Returns the daily open price for a symbol, initialising it from the current
 * price if this is the first tick of the UTC day.  The stored open is cleared
 * automatically when the UTC date rolls over. */
export function getDailyOpen(symbol: string, currentPrice: number): number {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  if (today !== currentUtcDate) {
    // New UTC day — clear all stored opens and start fresh
    dailyOpenPrices.clear();
    currentUtcDate = today;
  }
  if (!dailyOpenPrices.has(symbol)) {
    dailyOpenPrices.set(symbol, currentPrice);
  }
  return dailyOpenPrices.get(symbol)!;
}

/* ── Default universe ────────────────────────────────────────────── */

const defaultUniverse = [
  // Crypto — Coinbase live
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'AVAX-USD', 'PAXG-USD', 'LINK-USD',
  // Forex — OANDA practice
  'EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD',
  // Stock indices (CFDs) — OANDA practice
  'SPX500_USD', 'NAS100_USD', 'US30_USD',
  // Bonds — OANDA practice
  'USB02Y_USD', 'USB05Y_USD', 'USB10Y_USD', 'USB30Y_USD',
  // Commodities — OANDA practice
  'XAU_USD', 'XAG_USD', 'BCO_USD', 'WTICO_USD',
  // Green energy / industrial metals — OANDA practice
  'NATGAS_USD', 'XCU_USD', 'XPT_USD', 'XPD_USD',
  // US Stocks — Alpaca paper
  'SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'META', 'AMD',
  // Volatility — Alpaca paper (VIX ETF proxy)
  'VIXY'
];

export const universe = (process.env.MARKET_DATA_UNIVERSE ?? defaultUniverse.join(','))
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

/* ── Snapshot state ──────────────────────────────────────────────── */

export function buildSourceState(
  venue: BrokerId,
  symbols: string[],
  status: SourceStatus,
  detail: string
): MarketDataSourceState {
  return {
    venue,
    symbols,
    status,
    detail,
    updatedAt: new Date().toISOString()
  };
}

export function buildEmptySnapshotState(params: {
  alpacaStatus: SourceStatus;
  alpacaDetail: string;
  coinbaseStatus: SourceStatus;
  coinbaseDetail: string;
  oandaStatus: SourceStatus;
  oandaDetail: string;
}): MarketDataSnapshotResponse {
  return {
    asOf: new Date().toISOString(),
    universe,
    snapshots: [],
    sources: [
      buildSourceState(
        'alpaca-paper',
        universe.filter((symbol) => isAlpacaEquity(symbol)),
        params.alpacaStatus,
        params.alpacaDetail
      ),
      buildSourceState(
        'coinbase-live',
        universe.filter((symbol) => isCryptoSymbol(symbol)),
        params.coinbaseStatus,
        params.coinbaseDetail
      ),
      buildSourceState(
        'oanda-rest',
        universe.filter((symbol) => isOandaSymbol(symbol)),
        params.oandaStatus,
        params.oandaDetail
      )
    ]
  };
}

export let snapshotState: MarketDataSnapshotResponse = buildEmptySnapshotState({
  alpacaStatus: 'stale',
  alpacaDetail: 'Waiting for first successful Alpaca refresh.',
  coinbaseStatus: 'stale',
  coinbaseDetail: 'Waiting for first successful Coinbase refresh.',
  oandaStatus: 'stale',
  oandaDetail: 'Waiting for first successful OANDA refresh.'
});

export function setSnapshotState(value: MarketDataSnapshotResponse): void {
  snapshotState = value;
}

export function upsertSnapshotState(nextSnapshot: MarketSnapshot): void {
  const snapshots = [...snapshotState.snapshots];
  const existingIndex = snapshots.findIndex((entry) => entry.symbol === nextSnapshot.symbol);
  if (existingIndex >= 0) {
    snapshots[existingIndex] = nextSnapshot;
  } else {
    snapshots.push(nextSnapshot);
  }

  snapshots.sort((left, right) => left.symbol.localeCompare(right.symbol));
  snapshotState = {
    ...snapshotState,
    asOf: new Date().toISOString(),
    snapshots
  };
}

export function patchSourceState(venue: BrokerId, status: SourceStatus, detail: string): void {
  const sources = snapshotState.sources.map((source) => (
    source.venue === venue
      ? {
          ...source,
          status,
          detail,
          updatedAt: new Date().toISOString()
        }
      : source
  ));

  snapshotState = {
    ...snapshotState,
    asOf: new Date().toISOString(),
    sources
  };
}

/* ── Tick buffer (HFT) ───────────────────────────────────────────── */

const tickBuffer: Array<{ symbol: string; price: number; size: number; side: string | null; broker: string }> = [];
const MAX_BUFFER_SIZE = 1000;
export const FLUSH_INTERVAL_MS = 250;

export function pushTick(tick: { symbol: string; price: number; size: number; side?: string | null; broker: string }) {
  tickBuffer.push({ ...tick, side: tick.side ?? null });
  if (tickBuffer.length >= MAX_BUFFER_SIZE) {
    void flushTickBuffer();
  }
}

export async function flushTickBuffer() {
  if (tickBuffer.length === 0) return;
  const batch = [...tickBuffer];
  tickBuffer.length = 0;

  try {
    // Optimized batch insert for TimescaleDB throughput
    const query = `
      INSERT INTO "MarketTick" (timestamp, symbol, price, size, side, broker)
      VALUES ${batch.map((_, i) => `(NOW(), $${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(', ')}
    `;
    const params = batch.flatMap(t => [t.symbol, t.price, t.size, t.side, t.broker]);
    await db().query(query, params);
  } catch (err) {
    logger.error({ err }, 'Failed to flush tick buffer to TimescaleDB');
    // Fallback: put back into buffer if it wasn't a schema error?
    // For now just drop to avoid memory leaks if DB is down.
  }
}

/* ── Persistence ─────────────────────────────────────────────────── */

function isPersistedSnapshot(value: unknown): value is MarketSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const snapshot = value as Partial<MarketSnapshot>;
  if (snapshot.source === 'mock' || snapshot.source === 'simulated') {
    return false;
  }
  if (snapshot.qualityFlags?.includes('fallback-data')) {
    return false;
  }
  return typeof snapshot.symbol === 'string' && typeof snapshot.lastPrice === 'number';
}

function isPersistedSourceState(value: unknown): value is MarketDataSourceState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const source = value as Partial<MarketDataSourceState>;
  return (
    (source.venue === 'alpaca-paper' || source.venue === 'coinbase-live' || source.venue === 'oanda-rest') &&
    (source.status === 'live' || source.status === 'degraded' || source.status === 'stale') &&
    Array.isArray(source.symbols) &&
    typeof source.detail === 'string' &&
    typeof source.updatedAt === 'string'
  );
}

export async function loadPersistedSnapshot(): Promise<MarketDataSnapshotResponse | null> {
  try {
    const text = await fs.readFile(runtimeFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<MarketDataSnapshotResponse>;
    if (!parsed || !Array.isArray(parsed.snapshots) || !Array.isArray(parsed.sources)) {
      return null;
    }

    const snapshots = parsed.snapshots.filter(isPersistedSnapshot);
    const sources = parsed.sources.filter(isPersistedSourceState);

    return {
      asOf: typeof parsed.asOf === 'string' ? parsed.asOf : new Date().toISOString(),
      universe: Array.isArray(parsed.universe) ? parsed.universe.filter((value): value is string => typeof value === 'string') : universe,
      snapshots,
      sources
    };
  } catch {
    return null;
  }
}

export async function persistSnapshotState(): Promise<void> {
  try {
    await fs.mkdir(runtimeDir, { recursive: true });
    const tmpFile = `${runtimeFile}.tmp`;
    await fs.writeFile(tmpFile, `${JSON.stringify(snapshotState, null, 2)}\n`, 'utf8');
    await fs.rename(tmpFile, runtimeFile);
  } catch (error) {
    lastRefreshError = `Failed to persist market snapshot: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
}
