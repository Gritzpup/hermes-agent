import path from 'node:path';
import { fileURLToPath } from 'node:url';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const HISTORY_LIMIT = 48;
export const OUTCOME_HISTORY_LIMIT = 200; // Larger window for Half-Kelly and performance analysis
export const FILL_LIMIT = 50;
export const JOURNAL_LIMIT = 24;
export const TICK_MS = Number(process.env.PAPER_ENGINE_TICK_MS ?? 1_000);
export const STARTING_EQUITY = Number(process.env.HERMES_STARTING_EQUITY ?? 100_000);
export const EQUITY_FEE_BPS = 0.5;
export const CRYPTO_FEE_BPS = 5.0;
export const PAPER_BROKER = 'alpaca-paper';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LEDGER_DIR = process.env.PAPER_LEDGER_DIR ?? path.resolve(MODULE_DIR, '../../.runtime/paper-ledger');
export const MARKET_DATA_RUNTIME_PATH = process.env.MARKET_DATA_RUNTIME_PATH ?? path.resolve(MODULE_DIR, '../../../.runtime/market-data.json');
export const BROKER_ROUTER_URL = process.env.BROKER_ROUTER_URL ?? 'http://127.0.0.1:4303';
export const FILL_LEDGER_PATH = path.join(LEDGER_DIR, 'fills.jsonl');
export const JOURNAL_LEDGER_PATH = path.join(LEDGER_DIR, 'journal.jsonl');
export const STATE_SNAPSHOT_PATH = path.join(LEDGER_DIR, 'paper-state.json');
export const AGENT_CONFIG_OVERRIDES_PATH = path.join(LEDGER_DIR, 'agent-config-overrides.json');
export const EVENT_LOG_PATH = path.join(LEDGER_DIR, 'events.jsonl');
export const SYMBOL_GUARD_PATH = path.join(LEDGER_DIR, 'symbol-guards.json');
export const WEEKLY_REPORT_DIR = path.join(LEDGER_DIR, 'weekly-reports');
export const DAILY_CIRCUIT_BREAKER_DD_PCT = Number(process.env.DAILY_CIRCUIT_BREAKER_DD_PCT ?? 3.2);
export const WEEKLY_CIRCUIT_BREAKER_DD_PCT = Number(process.env.WEEKLY_CIRCUIT_BREAKER_DD_PCT ?? 6.5);
export const STATE_PERSIST_INTERVAL_TICKS = Number(process.env.STATE_PERSIST_INTERVAL_TICKS ?? 60); // persist every 60 ticks (was every tick)
// Fix #8: Tightened crypto gating per Codex -- fewer marginal entries = higher win rate
export const CRYPTO_MAX_ENTRY_SPREAD_BPS = Number(process.env.CRYPTO_MAX_ENTRY_SPREAD_BPS ?? 2.2);
export const CRYPTO_MAX_EST_SLIPPAGE_BPS = Number(process.env.CRYPTO_MAX_EST_SLIPPAGE_BPS ?? 1.6);
export const CRYPTO_MIN_BOOK_DEPTH_NOTIONAL = Number(process.env.CRYPTO_MIN_BOOK_DEPTH_NOTIONAL ?? 120_000);
export const DATA_FRESHNESS_SLO_MS = Number(process.env.DATA_FRESHNESS_SLO_MS ?? 7_500);
// COO FIX: Per-pair daily loss limit — prevent GBP/USD-style catastrophic runs.
// If a symbol loses more than this in 24h (UTC), all agents targeting it are paused.
export const PER_PAIR_DAILY_LOSS_LIMIT_USD = Number(process.env.PER_PAIR_DAILY_LOSS_LIMIT_USD ?? 200);
// COO FIX: Equity-curve circuit breaker — flatten all if firm drawdown exceeds threshold.
// Tracks high-water mark and triggers flatten+halt when drawdown breaches.
export const EQUITY_DRAWDOWN_CIRCUIT_BREAKER_PCT = Number(process.env.EQUITY_DRAWDOWN_CIRCUIT_BREAKER_PCT ?? 10.0); // COO: Was 2% (too tight), raised to 10% — fires only on serious drawdowns.
export const ORDER_ACK_SLO_MS = Number(process.env.ORDER_ACK_SLO_MS ?? 2_500);
export const BROKER_ERROR_SLO_PCT = Number(process.env.BROKER_ERROR_SLO_PCT ?? 5.0);
export const BROKER_SYNC_MS = Number(process.env.PAPER_BROKER_SYNC_MS ?? 5_000);
export const REAL_PAPER_AUTOPILOT = (process.env.REAL_PAPER_AUTOPILOT ?? 'true').toLowerCase() === 'true';
export const COINBASE_LIVE_ROUTING_ENABLED = (process.env.COINBASE_LIVE_ROUTING_ENABLED ?? '0') === '1';
export const HERMES_BROKER_ORDER_PREFIX = 'paper-agent-';
// COO: Crypto correlation cap — BTC and ETH are ~0.85 correlated. Limit simultaneous grid entries
// to prevent double exposure during correlated moves. Max 2 crypto grid positions at once.
export const MAX_CRYPTO_GRID_POSITIONS = Number(process.env.MAX_CRYPTO_GRID_POSITIONS ?? 2);
