// @ts-nocheck
import cors from 'cors';
import express from 'express';
import fs from 'node:fs/promises';
import { redis, TOPICS } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { HealthStatus } from './types.js';
import { isCryptoSymbol, isAlpacaEquity, isOandaSymbol } from './utils.js';
import {
  universe,
  runtimeDir,
  runtimeFile,
  snapshotState,
  setSnapshotState,
  lastRefreshError,
  setLastRefreshError,
  lastSuccessfulRefreshAt,
  setLastSuccessfulRefreshAt,
  refreshInFlight,
  setRefreshInFlight,
  buildEmptySnapshotState,
  loadPersistedSnapshot,
  persistSnapshotState,
  flushTickBuffer,
  FLUSH_INTERVAL_MS
} from './data-processing.js';
import {
  coinbaseWsConnected,
  coinbaseWsLastMessageAt,
  coinbaseMicrostructureState,
  startCoinbaseFeed,
  fetchAlpacaSnapshots,
  fetchCoinbaseSnapshots,
  fetchOandaSnapshots
} from './data-sources.js';

/* ── Express setup ───────────────────────────────────────────────── */

const app = express();
const port = Number(process.env.PORT ?? 4302);
const refreshMs = Number(process.env.MARKET_DATA_REFRESH_MS ?? 5_000);

app.use(cors());

/* ── Routes ──────────────────────────────────────────────────────── */

app.get('/health', (_req, res) => {
  const ageMs = lastSuccessfulRefreshAt > 0 ? Date.now() - lastSuccessfulRefreshAt : Number.POSITIVE_INFINITY;
  const status: HealthStatus =
    lastSuccessfulRefreshAt === 0
      ? 'warning'
      : ageMs > refreshMs * 3
        ? 'critical'
        : ageMs > refreshMs * 1.5
          ? 'warning'
          : 'healthy';

  res.json({
    service: 'market-data',
    status,
    timestamp: new Date().toISOString(),
    message: status === 'healthy' ? 'Live market polling is current.' : lastRefreshError,
    sources: snapshotState.sources,
    runtimePath: runtimeFile
  });
});

app.get('/snapshots', (_req, res) => {
  res.json(snapshotState);
});

app.get('/microstructure', (_req, res) => {
  res.json({
    asOf: new Date().toISOString(),
    connected: coinbaseWsConnected,
    lastMessageAt: coinbaseWsLastMessageAt > 0 ? new Date(coinbaseWsLastMessageAt).toISOString() : null,
    snapshots: Array.from(coinbaseMicrostructureState.values())
  });
});

/* ── Core loop ───────────────────────────────────────────────────── */

async function refreshSnapshots(): Promise<void> {
  if (refreshInFlight) return;
  setRefreshInFlight(true);
  try {
    const equities = universe.filter((symbol) => isAlpacaEquity(symbol));
    const crypto = universe.filter((symbol) => isCryptoSymbol(symbol));
    const oandaSymbols = universe.filter((symbol) => isOandaSymbol(symbol));
    const [alpaca, coinbase, oanda] = await Promise.all([
      fetchAlpacaSnapshots(equities),
      fetchCoinbaseSnapshots(crypto),
      fetchOandaSnapshots(oandaSymbols)
    ]);

    setSnapshotState({
      asOf: new Date().toISOString(),
      universe,
      snapshots: [...alpaca.snapshots, ...coinbase.snapshots, ...oanda.snapshots].sort((left, right) => left.symbol.localeCompare(right.symbol)),
      sources: [alpaca.source, coinbase.source, oanda.source]
    });

    // HFT: Broadcast full universe refresh to Redis
    await redis.publish(TOPICS.MARKET_TICK, JSON.stringify({
      type: 'full_refresh',
      asOf: snapshotState.asOf,
      count: snapshotState.snapshots.length
    }));

    if (alpaca.source.status === 'live' || coinbase.source.status === 'live' || oanda.source.status === 'live') {
      setLastSuccessfulRefreshAt(Date.now());
      setLastRefreshError('Market polling healthy.');
    } else {
      setLastRefreshError([alpaca.source.detail, coinbase.source.detail, oanda.source.detail].filter(Boolean).join(' '));
    }

    await persistSnapshotState();
  } catch (error) {
    const msg = `Market refresh failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    setLastRefreshError(msg);
    setSnapshotState(buildEmptySnapshotState({
      alpacaStatus: 'degraded',
      alpacaDetail: msg,
      coinbaseStatus: 'degraded',
      coinbaseDetail: msg,
      oandaStatus: 'degraded',
      oandaDetail: msg
    }));
    await persistSnapshotState();
  } finally {
    setRefreshInFlight(false);
  }
}

async function bootstrap(): Promise<void> {
  await fs.mkdir(runtimeDir, { recursive: true });
  const persisted = await loadPersistedSnapshot();
  if (persisted) {
    setSnapshotState(persisted);
    const parsed = Date.parse(persisted.asOf);
    if (!Number.isNaN(parsed)) {
      setLastSuccessfulRefreshAt(parsed);
    }
    setLastRefreshError('Loaded persisted market snapshot.');
  }

  startCoinbaseFeed(universe.filter((symbol) => isCryptoSymbol(symbol)));
  await refreshSnapshots();
  void persistSnapshotState();
}

/* ── Timers & start ──────────────────────────────────────────────── */

// Start tick-buffer flush timer
setInterval(() => {
  void flushTickBuffer();
}, FLUSH_INTERVAL_MS);

void bootstrap();
setInterval(() => {
  void refreshSnapshots();
}, refreshMs);

app.listen(port, '0.0.0.0', () => {
  console.log(`[market-data] listening on http://0.0.0.0:${port}`);
});
