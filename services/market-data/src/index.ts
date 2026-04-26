// @ts-nocheck
import './load-env.js';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs/promises';
import { redis, TOPICS } from '@hermes/infra';
import { logger, setupErrorEmitter } from '@hermes/logger';
setupErrorEmitter(logger);
import type { HealthStatus } from './types.js';
import { isCryptoSymbol, isAlpacaEquity, isOandaSymbol } from './utils.js';
import { bootstrapCollections } from './qdrant.js';
import { startOnchainPoller } from './onchain.js';
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
  fetchOandaSnapshots,
  fetchAlpacaClockState
} from './data-sources.js';

/* ── Express setup ───────────────────────────────────────────────── */

const app = express();
const port = Number(process.env.PORT ?? 4302);
// 15s default — equities move on minute-scale during RTH; faster than this wastes
// Alpaca/OANDA quota without improving signal. Crypto is unaffected (Coinbase WS pushes).
const refreshMs = Number(process.env.MARKET_DATA_REFRESH_MS ?? 15_000);

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

    // Session gating: skip provider polls when the market is closed. Prices cannot
    // change, so the calls waste quota without adding signal. We reuse the last
    // known snapshots for that provider so the dashboard stays populated.
    // Alpaca clock is cached 30s server-side (fetchAlpacaClockState), so this is cheap.
    const clock = await fetchAlpacaClockState();
    const alpacaOpen = clock.session === 'regular' || clock.session === 'unknown';  // unknown = credentials missing, let the snapshot call handle it
    const utcDay = new Date().getUTCDay();
    const utcHour = new Date().getUTCHours();
    // Forex: closed Friday 22:00 UTC → Sunday 22:00 UTC.
    const oandaClosed = utcDay === 6 || (utcDay === 0 && utcHour < 22);

    const lastAlpaca = snapshotState.snapshots.filter((s) => isAlpacaEquity(s.symbol));
    const lastOanda = snapshotState.snapshots.filter((s) => isOandaSymbol(s.symbol));

    const [alpaca, coinbase, oanda] = await Promise.all([
      alpacaOpen
        ? fetchAlpacaSnapshots(equities)
        : Promise.resolve({ snapshots: lastAlpaca, source: { provider: 'alpaca', status: 'offline', detail: `Session gated: ${clock.detail}` } }),
      fetchCoinbaseSnapshots(crypto),
      oandaClosed
        ? Promise.resolve({ snapshots: lastOanda, source: { provider: 'oanda', status: 'offline', detail: 'Session gated: forex market closed (weekend).' } })
        : fetchOandaSnapshots(oandaSymbols)
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

  // ── Phase-2 additions: RAG + on-chain ───────────────────────────────
  await bootstrapCollections();
  startOnchainPoller();
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
