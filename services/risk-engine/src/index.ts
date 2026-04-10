import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import type { MarketSnapshot, OrderIntent, RiskCheck, RiskEngineState, SystemSettings } from '@hermes/contracts';

const app = express();
const port = Number(process.env.PORT ?? 4301);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_RUNTIME_DIR = path.resolve(MODULE_DIR, '../../api/.runtime/paper-ledger');
const PAPER_FILL_LEDGER_PATH = process.env.PAPER_FILL_LEDGER_PATH ?? path.join(API_RUNTIME_DIR, 'fills.jsonl');
const EVENT_CALENDAR_SNAPSHOT_PATH = process.env.EVENT_CALENDAR_SNAPSHOT_PATH ?? path.resolve(MODULE_DIR, '../../api/.runtime/event-calendar/snapshot.json');
const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://127.0.0.1:4302';
const HERMES_API_URL = process.env.HERMES_API_URL ?? 'http://127.0.0.1:4300';

const settings: SystemSettings = {
  paperBroker: 'alpaca-paper',
  liveBroker: 'coinbase-live',
  universe: parseSymbols(process.env.TRADING_UNIVERSE, ['BTC-USD', 'ETH-USD', 'SPY', 'QQQ', 'NVDA']),
  riskCaps: {
    maxTradeNotional: Number(process.env.RISK_MAX_TRADE_NOTIONAL ?? 5_000),
    maxDailyLoss: Number(process.env.RISK_MAX_DAILY_LOSS ?? 1_200),
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

app.use(cors());
app.use(express.json());

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
  if (currentDayLoss <= -settings.riskCaps.maxDailyLoss) {
    blockedReasons.push('daily-loss-breach');
  }

  const marketHealth = await getMarketDataHealth();
  if (marketHealth === 'critical') {
    blockedReasons.push('stale-market-data');
  }

  const blockedSymbols = await getBlockedSymbolsFromCalendar();
  const lastReason = blockedSymbols.length > 0 ? `Event embargo active for ${blockedSymbols.join(', ')}` : blockedReasons[0] ?? '';

  return {
    asOf: new Date().toISOString(),
    killSwitchArmed: blockedReasons.length > 0,
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
  if (!symbol) {
    return null;
  }

  try {
    const response = await fetch(`${MARKET_DATA_URL}/snapshots`);
    if (!response.ok) {
      return null;
    }
    const body = await response.json() as { snapshots?: MarketSnapshot[] };
    return Array.isArray(body.snapshots)
      ? body.snapshots.find((snapshot) => snapshot.symbol === symbol) ?? null
      : null;
  } catch {
    return null;
  }
}

async function getCurrentDayLoss(): Promise<number> {
  try {
    if (!fs.existsSync(PAPER_FILL_LEDGER_PATH)) {
      return 0;
    }

    const today = new Date().toISOString().slice(0, 10);
    return fs.readFileSync(PAPER_FILL_LEDGER_PATH, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { timestamp?: string; side?: string; source?: string; pnlImpact?: number })
      .filter((entry) => entry.side === 'sell' && entry.source === 'broker')
      .filter((entry) => typeof entry.timestamp === 'string' && entry.timestamp.startsWith(today))
      .reduce((sum, entry) => sum + Math.min(entry.pnlImpact ?? 0, 0), 0);
  } catch {
    return 0;
  }
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
