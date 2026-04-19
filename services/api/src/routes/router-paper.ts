import { Router } from 'express';
import type { MarketSnapshot, LaneRollup } from '@hermes/contracts';
import { drawdownSizingFactor } from '../paper-engine/engine-entry.js';
import {
  BROKER_ROUTER_URL,
  BROKER_STARTING_EQUITY,
  MARKET_DATA_URL,
  LIVE_BROKER,
} from '../lib/constants.js';
import { fetchJson } from '../lib/utils-http.js';
import { round } from '../lib/utils-generic.js';
import {
  normalizeBrokerAccounts,
  normalizeBrokerPositions,
  dedupeMarketSnapshots,
  extractBrokerPnL
} from '../lib/utils-normalization.js';
import { asRecord } from '../lib/utils-generic.js';
import type { BrokerRouterAccountResponse } from '../lib/types-broker.js';

// Cache paper-desk snapshot for 60s to prevent 50MB journal reads from blocking the event loop.
// COO FIX: Was 5s but strategy-director cycle takes ~26s, so cache was always stale.
// The journal grows with every trade — without this, /paper-desk hangs after 100+ new trades.
let _paperDeskCache: { data: any; ts: number } = { data: null, ts: 0 };
const PAPER_DESK_CACHE_TTL_MS = 60_000; // COO: was 5s — bump to 60s to match strategy-director cycle (~26s)
let _deps: { paperEngine: any } | null = null; // Set in createPaperRouter()

// Cache for broker router responses (10s TTL — broker API can be slow)
let _brokerCache: { data: any; ts: number } = { data: null, ts: 0 };
const BROKER_CACHE_TTL_MS = 10_000;

// Rebuild cache in background (non-blocking). Called after serving stale cache.
function rebuildCacheInBackground(): void {
  if (!_deps) return;
  setImmediate(async () => {
    try {
      const snap = await Promise.race([
        _deps!.paperEngine.getSnapshot(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('snapshot-timeout')), 5000))
      ]);
      if (snap) {
        _paperDeskCache = { data: snap, ts: Date.now() };
      }
    } catch {
      // Best-effort — stale cache is still served
    }
  });
}

// Pre-warm the 50MB journal cache on startup so /paper-desk responds instantly.
// Without this, the first request blocks for 30+ seconds on getSnapshot().
// Note: deps is passed at runtime when createPaperRouter() is called.
export function createPaperRouter(deps: { paperEngine: any }) {
  // Warm cache 2s after router creation (engine finishes loading before we hit the journal)
  setTimeout(() => {
    try {
      const snap = deps.paperEngine.getSnapshot();
      _paperDeskCache = { data: snap, ts: Date.now() };
      console.log('[paper-desk] cache warmed:', snap.totalTrades, 'trades, WR=' + (snap.winRate?.toFixed(1) ?? '?') + '%');
    } catch (e) {
      console.warn('[paper-desk] cache warm failed:', (e as Error).message);
    }
  }, 2000);

  _deps = deps; // Store for background rebuild access

  const router = Router();

  router.get('/paper-desk', async (_req, res) => {
    const now = Date.now();

    // COO FIX: Always serve cached snapshot (stale is better than blocking for 26s).
    // Rebuild cache in background after serving. This prevents API timeouts during
    // strategy-director cycles which take 26+ seconds.
    if (_paperDeskCache.data) {
      const paperDesk = { ..._paperDeskCache.data };
      // Fetch broker state fresh (don't cache — needs real-time equity)
      try {
        const brokerState = await Promise.race([
          fetchJson<BrokerRouterAccountResponse>(BROKER_ROUTER_URL, '/account'),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
        ]);
        if (brokerState) {
          const brokerAccts = normalizeBrokerAccounts(brokerState.brokers ?? []);
          const brokerPos = normalizeBrokerPositions(brokerState.brokers ?? []);
          paperDesk.brokerAccounts = brokerAccts;
          paperDesk.brokerPositions = brokerPos;
          paperDesk.liveBrokerEquity = Math.round(
            brokerAccts.reduce((s, a) => s + (a.equity ?? 0), 0) * 100) / 100;
          // COO FIX: Add Coinbase simulated equity ($100K + journal PnL) to total.
          const cbRollup = (paperDesk.brokerRollups ?? []).find((r: any) => r.broker === 'coinbase-live');
          const coinbasePnl = cbRollup?.realizedPnl ?? 0;
          paperDesk.totalEquity = round(paperDesk.liveBrokerEquity + 100_000 + coinbasePnl, 2);
          paperDesk.firmOpenPositions = brokerPos.length;
          let totalOpenRisk = brokerPos.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
          if (paperDesk.analytics) paperDesk.analytics.totalOpenRisk = round(totalOpenRisk, 2);
        }
      } catch { /* broker fetch failed — use cached equity */ }
      res.json(paperDesk);

      // Rebuild cache in background (non-blocking)
      if (now - _paperDeskCache.ts >= PAPER_DESK_CACHE_TTL_MS) {
        rebuildCacheInBackground();
      }
      return;
    }

    // No cache — must build fresh (first request after startup)
    const paperDesk = deps.paperEngine.getSnapshot();
    _paperDeskCache = { data: paperDesk, ts: now };
    try {
      const brokerState = await fetchJson<BrokerRouterAccountResponse>(BROKER_ROUTER_URL, '/account');
      if (brokerState) {
        const brokerAccts = normalizeBrokerAccounts(brokerState.brokers ?? []);
        const brokerPos = normalizeBrokerPositions(brokerState.brokers ?? []);
        paperDesk.brokerAccounts = brokerAccts;
        paperDesk.brokerPositions = brokerPos;

        // Journal-authoritative totals from all lanes (FIX #1)
        const lanes: LaneRollup[] = paperDesk.lanes ?? [];
        const firmTrades   = lanes.reduce((s: number, l: LaneRollup) => s + (l.trades ?? 0), 0);
        const firmWins     = lanes.reduce((s: number, l: LaneRollup) => s + (l.wins ?? 0), 0);
        const firmLosses   = lanes.reduce((s: number, l: LaneRollup) => s + (l.losses ?? 0), 0);
        const firmRealized = Math.round(lanes.reduce((s: number, l: LaneRollup) => s + (l.realizedPnl ?? 0), 0) * 100) / 100;
        const firmWinRate  = firmTrades ? Math.round(firmWins / firmTrades * 1000) / 10 : 0;

        // Journal-authoritative card values (FIX #2)
        paperDesk.realizedPnl       = firmRealized;
        paperDesk.totalTrades       = firmTrades;
        paperDesk.totalWins         = firmWins;
        paperDesk.totalLosses        = firmLosses;
        paperDesk.winRate           = firmWinRate;
        paperDesk.firmTotalTrades   = firmTrades;
        paperDesk.firmWinRate       = firmWinRate;

        // Synthetic firm-paper equity: Coinbase (simulated) + Alpaca + OANDA
        // COO FIX: All 3 brokers run $100K paper = $300K firm equity.
        // Use journal rollup PnL (authoritative — includes Grid + Maker + Scalpers).
        const alpacaAcct    = brokerAccts.find((a: any) => a.broker === 'alpaca-paper');
        const oandaAcct     = brokerAccts.find((a: any) => a.broker === 'oanda-rest');
        const coinbaseAcct  = brokerAccts.find((a: any) => a.broker === 'coinbase-live');
        let combinedEquity  = (alpacaAcct?.equity ?? 0) + (oandaAcct?.equity ?? 0);

        // Coinbase: no real equity — simulate as $100K + journal rollup PnL (includes Grid/Maker)
        const cbRollup = (paperDesk.brokerRollups ?? []).find((r: any) => r.broker === 'coinbase-live');
        const coinbasePnl = cbRollup?.realizedPnl ?? 0;
        combinedEquity += (BROKER_STARTING_EQUITY + coinbasePnl); // $100K + journal PnL

        // Mark coinbase-live as paper-simulated (FIX #4)
        const cb = brokerAccts.find((a) => a.broker === LIVE_BROKER);
        if (cb) (cb as any).paperSimulated = true;

        // Real broker equity: sum of broker account equity (FIX #3)
        paperDesk.liveBrokerEquity = Math.round(
          brokerAccts.reduce((s, a) => s + (a.equity ?? 0), 0) * 100
        ) / 100;
        paperDesk.firmOpenPositions = brokerPos.length;

        // Open risk: sum of unrealized P&L from broker positions (kept — correct)
        let totalOpenRisk = brokerPos.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
        if (paperDesk.analytics) paperDesk.analytics.totalOpenRisk = round(totalOpenRisk, 2);

        if (combinedEquity > 0) {
          paperDesk.totalEquity   = round(combinedEquity, 2);
          paperDesk.startingEquity = BROKER_STARTING_EQUITY * 3;
          paperDesk.totalDayPnl   = round(combinedEquity - paperDesk.startingEquity, 2);
        }
      }
    } catch { /* best-effort */ }

    res.json(paperDesk);
  });

  router.get('/risk-controls', (_req, res) => {
    res.json(deps.paperEngine.getRiskControlSnapshot());
  });

  router.post('/risk-controls/circuit-breaker/review', (req, res) => {
    const note = typeof req.body?.note === 'string' && req.body.note.trim().length > 0
      ? req.body.note.trim()
      : 'manual review complete';
    res.json(deps.paperEngine.acknowledgeCircuitBreaker(note));
  });

  router.get('/walk-forward', (_req, res) => {
    res.json({ asOf: new Date().toISOString(), results: deps.paperEngine.getWalkForwardSnapshot() });
  });

  router.get('/forensics/losses', (req, res) => {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 12;
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim().length > 0
      ? req.query.symbol.trim().toUpperCase()
      : undefined;
    res.json({
      asOf: new Date().toISOString(),
      symbol: symbol ?? null,
      rows: deps.paperEngine.getLossForensics(limit, symbol)
    });
  });

  router.get('/market-snapshots', async (_req, res) => {
    const marketData = await fetchJson<{ snapshots?: MarketSnapshot[] }>(MARKET_DATA_URL, '/snapshots');
    res.json(dedupeMarketSnapshots([...(marketData?.snapshots ?? []), ...deps.paperEngine.getMarketSnapshots()]));
  });

  router.get('/agent-configs', (_req, res) => {
    res.json(deps.paperEngine.getAgentConfigs());
  });

  router.get('/live-readiness', (_req, res) => {
    res.json(deps.paperEngine.getLiveReadiness());
  });

  router.get('/drawdown-sizing', (_req, res) => {
    const engine = deps.paperEngine;
    const hwm = engine.equityHighWaterMark ?? 0;
    const nav = engine.getDeskEquity?.() ?? hwm;
    const ddPct = hwm > 0 ? Math.max(0, ((hwm - nav) / hwm) * 100) : 0;
    const factor = drawdownSizingFactor(engine);
    res.json({ highWaterMark: hwm, nav, drawdownPct: Math.round(ddPct * 100) / 100, factor: Math.round(factor * 1000) / 1000 });
  });

  return router;
}
