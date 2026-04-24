import './load-env.js';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redis, TOPICS } from '@hermes/infra';
import { logger, setupErrorEmitter } from '@hermes/logger';
setupErrorEmitter(logger);
import type { AssetClass, MarketSnapshot, OrderIntent, RiskCheck, RiskEngineState, SystemSettings, CrossAssetSignal } from '@hermes/contracts';


const app = express();
const port = Number(process.env.PORT ?? 4301);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_RUNTIME_DIR = path.resolve(MODULE_DIR, '../../api/.runtime/paper-ledger');
const PAPER_FILL_LEDGER_PATH = process.env.PAPER_FILL_LEDGER_PATH ?? path.join(API_RUNTIME_DIR, 'fills.jsonl');
const PAPER_JOURNAL_PATH = process.env.PAPER_JOURNAL_PATH ?? path.join(API_RUNTIME_DIR, 'journal.jsonl');
const EVENT_CALENDAR_SNAPSHOT_PATH = process.env.EVENT_CALENDAR_SNAPSHOT_PATH ?? path.resolve(MODULE_DIR, '../../api/.runtime/event-calendar/snapshot.json');
const HERMES_API_URL = process.env.HERMES_API_URL ?? 'http://127.0.0.1:4300';
const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://127.0.0.1:4302';
const EMERGENCY_HALT_FILE = path.resolve(MODULE_DIR, '../../../api/.runtime/emergency-halt.json');

// HFT: Local cache for market data to eliminate HTTP latency in the critical path
const marketCache = new Map<string, MarketSnapshot>();

// Initialize Redis Subscriptions for real-time risk monitoring
const subscriber = redis.duplicate();
subscriber.subscribe(TOPICS.MARKET_TICK, (err) => {
  if (err) logger.error({ err }, 'Failed to subscribe to redis topic');
});

app.use(cors());
app.use(express.json());

subscriber.on('message', (channel, message) => {
  if (channel === TOPICS.MARKET_TICK) {
    try {
      const snapshot = JSON.parse(message) as MarketSnapshot;
      if (snapshot.symbol) {
        marketCache.set(snapshot.symbol, snapshot);
      }
    } catch (err) {
      // Ignore parse errors from full_refresh events
    }
  }
});
const settings: SystemSettings = {
  paperBroker: 'alpaca-paper',
  liveBroker: 'coinbase-live',
  universe: parseSymbols(process.env.TRADING_UNIVERSE, ['BTC-USD', 'ETH-USD', 'SPY', 'QQQ', 'NVDA']),
  riskCaps: {
    maxTradeNotional: Number(process.env.RISK_MAX_TRADE_NOTIONAL ?? 5_000),
    maxDailyLoss: Number(process.env.RISK_MAX_DAILY_LOSS ?? 500),
    maxStrategyExposurePct: Number(process.env.RISK_MAX_STRATEGY_EXPOSURE_PCT ?? 22),
    maxSymbolExposurePct: Number(process.env.RISK_MAX_SYMBOL_EXPOSURE_PCT ?? 12),
    maxDrawdownPct: Number(process.env.RISK_MAX_DRAWDOWN_PCT ?? 4),
    maxSlippageBps: Number(process.env.RISK_MAX_SLIPPAGE_BPS ?? 12)
  },
  killSwitches: [
    'broker disconnect',
    'stale market data',
    'daily loss breach',
    'session drawdown breach',
    'excessive slippage',
    'manual operator override'
  ],
  notes: [
    'Alpaca is reserved for paper execution.',
    'Coinbase live rollout should stay crypto-only and small-size first.',
    'Risk engine derives current day loss from broker-backed paper fill exits until broker-side realized PnL reconciliation is fully wired.'
  ]
};

const FIRM_CAPITAL = Number(process.env.RISK_FIRM_CAPITAL ?? 100_000);
const FORCE_KILL_SWITCH = (process.env.RISK_FORCE_KILL_SWITCH ?? '').toLowerCase() === 'true';

app.get('/health', async (_req, res) => {
  const state = await buildState();
  res.json({
    service: 'risk-engine',
    status: state.killSwitchArmed ? 'warning' : 'healthy',
    timestamp: state.asOf,
    state
  });
});

app.get('/state', async (_req, res) => {
  res.json(await buildState());
});

app.get('/settings', (_req, res) => {
  res.json(settings);
});

app.post('/evaluate', async (req, res) => {
  const order = req.body as Partial<OrderIntent>;
  const state = await buildState();
  const blockedReasons = [...state.blockedReasons];
  const marketSnapshot = await getMarketSnapshot(typeof order.symbol === 'string' ? order.symbol : null);

  if (typeof order.notional !== 'number' || order.notional <= 0) {
    blockedReasons.push('invalid-notional');
  }
  if (typeof order.notional === 'number' && order.notional > settings.riskCaps.maxTradeNotional) {
    blockedReasons.push('trade-notional-cap');
  }
  if (typeof order.notional === 'number' && order.notional > (FIRM_CAPITAL * settings.riskCaps.maxSymbolExposurePct) / 100) {
    blockedReasons.push('symbol-exposure-cap');
  }
  if (order.broker === 'coinbase-live' && typeof order.symbol === 'string' && !order.symbol.endsWith('-USD')) {
    blockedReasons.push('coinbase-crypto-only-rollout');
  }
  if (typeof order.symbol === 'string' && !marketSnapshot) {
    blockedReasons.push('missing-market-snapshot');
  }
  if (marketSnapshot) {
    if (marketSnapshot.status !== 'live' || marketSnapshot.source === 'mock' || marketSnapshot.source === 'simulated') {
      blockedReasons.push('non-live-tape');
    }
    if (marketSnapshot.tradable === false) {
      blockedReasons.push(
        marketSnapshot.session && marketSnapshot.session !== 'regular'
          ? 'session-gate'
          : 'tape-quality-gate'
      );
    }
    if (typeof marketSnapshot.spreadBps === 'number' && marketSnapshot.spreadBps > settings.riskCaps.maxSlippageBps) {
      blockedReasons.push('max-slippage-breach');
    }
  }
  if (typeof order.symbol === 'string' && state.blockedSymbols?.includes(order.symbol)) {
    blockedReasons.push('event-embargo');
  }

  const allowed = blockedReasons.length === 0;
  const riskCheck: RiskCheck = {
    allowed,
    reason: allowed
      ? 'Risk approved within current pilot caps.'
      : `Rejected: ${blockedReasons.join(', ')}.`,
    maxNotional: settings.riskCaps.maxTradeNotional,
    maxDailyLoss: settings.riskCaps.maxDailyLoss,
    killSwitchArmed: state.killSwitchArmed,
    blockedReasons,
    currentDayLoss: state.currentDayLoss
  };

  // Publish to Redis so broker-router can read from cache (sub-ms) instead of HTTP
  // Key: risk:order:<orderId> TTL: 5s (covers the average evaluation window)
  const cacheKey = `risk:order:${order.id ?? randomUUID()}`;
  await redis.setex(cacheKey, 5, JSON.stringify(riskCheck));

  res.json(riskCheck);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`[risk-engine] listening on http://0.0.0.0:${port}`);
});

async function buildState(): Promise<RiskEngineState> {
  const currentDayLoss = await getCurrentDayLoss();
  const blockedReasons: string[] = [];

  if (FORCE_KILL_SWITCH) {
    blockedReasons.push('manual-operator-override');
  }
  // STEP 3b: Emergency-halt kill switch — written by POST /api/emergency-halt, no restart needed
  // sync check every tick (no caching) so a 3AM COO activation takes effect on the next tick
  if (fs.existsSync(EMERGENCY_HALT_FILE)) {
    blockedReasons.push('manual-emergency-halt');
  }
  if (currentDayLoss <= -settings.riskCaps.maxDailyLoss) {
    blockedReasons.push('daily-loss-breach');
  }

  const marketHealth = await getMarketDataHealth();
  if (marketHealth === 'critical') {
    blockedReasons.push('stale-market-data');
  }

  // STEP 3: Firm-level feed-staleness gate — if ANY traded symbol exceeds 2× its
  // per-symbol threshold, block all new entries until feeds recover.
  const STALE_MAX_MS: Record<AssetClass, number> = {
    crypto: 15_000,
    equity: 120_000,
    forex: 120_000,
    bond: 300_000,
    commodity: 300_000,
    'commodity-proxy': 300_000
  };
  for (const [, snapshot] of marketCache) {
    if (!snapshot.updatedAt) continue;
    const maxStale = STALE_MAX_MS[snapshot.assetClass] ?? 60_000;
    const snapshotAge = Date.now() - new Date(snapshot.updatedAt).getTime();
    if (snapshotAge > maxStale * 2) {
      blockedReasons.push('feed-staleness');
      break;
    }
  }

  const blockedSymbols = await getBlockedSymbolsFromCalendar();
  const lastReason = blockedSymbols.length > 0 ? `Event embargo active for ${blockedSymbols.join(', ')}` : blockedReasons[0] ?? '';

  const killSwitchArmed = blockedReasons.length > 0;
  
  // HFT: Broadcast risk signals if we arm the kill switch
  if (killSwitchArmed) {
    const signal: CrossAssetSignal = {
      timestamp: new Date().toISOString(),
      type: 'signal' as any, // 'risk-off' might not be in CrossAssetSignalType union
      symbol: '*',
      severity: 'critical',
      message: `Risk-Off: ${blockedReasons.join(', ')}`,
      metadata: { reasons: blockedReasons }
    };
    redis.publish(TOPICS.RISK_SIGNAL, JSON.stringify(signal)).catch(err => {
      logger.error({ err }, 'Failed to broadcast risk signal');
    });
  }

  return {
    asOf: new Date().toISOString(),
    killSwitchArmed,
    blockedReasons,
    currentDayLoss: round(currentDayLoss, 2),
    maxDailyLoss: settings.riskCaps.maxDailyLoss,
    maxTradeNotional: settings.riskCaps.maxTradeNotional,
    maxSymbolExposurePct: settings.riskCaps.maxSymbolExposurePct,
    maxStrategyExposurePct: settings.riskCaps.maxStrategyExposurePct,
    blockedSymbols,
    lastReason
  };
}


async function getMarketDataHealth(): Promise<'healthy' | 'warning' | 'critical'> {
  try {
    const response = await fetch(`${MARKET_DATA_URL}/health`);
    if (!response.ok) {
      return 'critical';
    }
    const body = await response.json() as { status?: 'healthy' | 'warning' | 'critical' };
    return body.status ?? 'warning';
  } catch {
    return 'critical';
  }
}

async function getMarketSnapshot(symbol: string | null): Promise<MarketSnapshot | null> {
  if (!symbol) return null;
  // HFT: Return from local cache (sub-millisecond) instead of HTTP fetch
  return marketCache.get(symbol) ?? null;
}


// Reasons that indicate synthetic/reconciliation entries, NOT real closed trades.
// These are quarantined from analytics to avoid KPI pollution.
// NOTE: Inlined here because risk-engine cannot import from @hermes/api.
// Mirrored from @hermes/contracts QUARANTINED_EXIT_REASONS.
const QUARANTINED_EXIT_REASONS = new Set([
  'broker reconciliation',
  'external broker flatten'
]);

/**
 * trailing 24h realized loss (not calendar day).  PnL is attributed to the trade's
 * exitAt timestamp so that day-rollover gaming and DST-like edge cases are handled
 * robustly — "how much did I lose in the last 24 h?" rather than "what did today close at?".
 */
async function getCurrentDayLoss(): Promise<number> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let total = 0;
  try {
    if (fs.existsSync(PAPER_JOURNAL_PATH)) {
      const lines = fs.readFileSync(PAPER_JOURNAL_PATH, 'utf8').split('\n');
      for (const raw of lines) {
        if (!raw.trim()) continue;
        try {
          const entry = JSON.parse(raw) as { exitAt?: string; realizedPnl?: number; exitReason?: string };
          // Phase H2 / Phase I: Skip synthetic/reconciliation entries.
          if (entry.exitReason && QUARANTINED_EXIT_REASONS.has(entry.exitReason)) continue;
          const exitMs = Date.parse(entry.exitAt ?? '');
          if (Number.isFinite(exitMs) && exitMs >= cutoff && typeof entry.realizedPnl === 'number') {
            total += entry.realizedPnl;
          }
        } catch {
          // skip malformed line
        }
      }
    }
  } catch {
    // journal unreadable — fall through to fills fallback
  }
  if (total === 0 && fs.existsSync(PAPER_FILL_LEDGER_PATH)) {
    try {
      total = fs.readFileSync(PAPER_FILL_LEDGER_PATH, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { timestamp?: string; side?: string; source?: string; pnlImpact?: number })
        .filter((e) => {
          const tsMs = Date.parse(e.timestamp ?? '');
          return e.side === 'sell' && e.source === 'broker'
              && Number.isFinite(tsMs) && tsMs >= cutoff;
        })
        .reduce((sum, e) => sum + Math.min(e.pnlImpact ?? 0, 0), 0);
    } catch {}
  }
  return Math.min(total, 0);
}

async function getBlockedSymbolsFromCalendar(): Promise<string[]> {
  try {
    const response = await fetch(`${HERMES_API_URL}/api/calendar`);
    if (response.ok) {
      const parsed = await response.json() as {
        activeEmbargoes?: Array<{ symbol?: string; blocked?: boolean }>;
      };
      return Array.isArray(parsed.activeEmbargoes)
        ? parsed.activeEmbargoes
            .filter((entry) => entry?.blocked === true && typeof entry.symbol === 'string')
            .map((entry) => entry.symbol as string)
        : [];
    }
  } catch {
    // Fall back to persisted snapshot below.
  }

  try {
    if (!fs.existsSync(EVENT_CALENDAR_SNAPSHOT_PATH)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(EVENT_CALENDAR_SNAPSHOT_PATH, 'utf8')) as {
      activeEmbargoes?: Array<{ symbol?: string; blocked?: boolean }>;
    };
    return Array.isArray(parsed.activeEmbargoes)
      ? parsed.activeEmbargoes
          .filter((entry) => entry?.blocked === true && typeof entry.symbol === 'string')
          .map((entry) => entry.symbol as string)
      : [];
  } catch {
    return [];
  }
}

function parseSymbols(raw: string | undefined, fallback: string[]): string[] {
  const parsed = raw
    ?.split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  return parsed && parsed.length > 0 ? parsed : fallback;
}

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}
