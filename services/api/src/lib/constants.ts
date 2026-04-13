import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SystemSettings } from '@hermes/contracts';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const STRATEGY_LEDGER_DIR = process.env.PAPER_LEDGER_DIR ?? path.resolve(MODULE_DIR, '../../.runtime/paper-ledger');
export const STRATEGY_JOURNAL_PATH = path.join(STRATEGY_LEDGER_DIR, 'journal.jsonl');
export const STRATEGY_EVENT_LOG_PATH = path.join(STRATEGY_LEDGER_DIR, 'events.jsonl');

export const BROKER_STARTING_EQUITY = Number(process.env.BROKER_STARTING_EQUITY ?? 100_000);
export const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://127.0.0.1:4302';
export const RISK_ENGINE_URL = process.env.RISK_ENGINE_URL ?? 'http://127.0.0.1:4301';
export const BROKER_ROUTER_URL = process.env.BROKER_ROUTER_URL ?? 'http://127.0.0.1:4303';
export const REVIEW_LOOP_URL = process.env.REVIEW_LOOP_URL ?? 'http://127.0.0.1:4304';
export const BACKTEST_URL = process.env.BACKTEST_URL ?? 'http://127.0.0.1:4305';
export const STRATEGY_LAB_URL = process.env.STRATEGY_LAB_URL ?? 'http://127.0.0.1:4306';

export const DEFAULT_SETTINGS: SystemSettings = {
  paperBroker: 'alpaca-paper',
  liveBroker: 'coinbase-live',
  universe: ['BTC-USD', 'ETH-USD', 'SPY', 'QQQ', 'NVDA'],
  riskCaps: {
    maxTradeNotional: 5_000,
    maxDailyLoss: 1_200,
    maxStrategyExposurePct: 22,
    maxSymbolExposurePct: 12,
    maxDrawdownPct: 4,
    maxSlippageBps: 12
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
    'Alpaca remains paper-only.',
    'Coinbase remains the only live venue.',
    'Strategies stay paper until live-readiness gates and broker reconciliation both pass.'
  ]
};
