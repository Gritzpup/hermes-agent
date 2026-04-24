import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

// Load .env from repo root before reading any env vars
dotenvConfig({ path: '/mnt/Storage/github/hermes-trading-firm/.env' });

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const HERMES_API = process.env.HERMES_API_URL ?? 'http://localhost:4300';
export const HEALTH_PORT = Number(process.env.OPENCLAW_HERMES_PORT ?? 4395);
export const POLL_INTERVAL_MS = Number(process.env.OPENCLAW_HERMES_POLL_MS ?? 600_000);
export const FAST_PATH_INTERVAL_MS = Number(process.env.OPENCLAW_HERMES_FASTPATH_MS ?? 30_000);
export const FAST_PATH_DRAWDOWN_USD = Number(process.env.OPENCLAW_HERMES_DD_USD ?? 500);
export const FAST_PATH_WINDOW_MS = Number(process.env.OPENCLAW_HERMES_FP_WINDOW_MS ?? 60 * 60_000);
export const FAST_PATH_MIN_UNHEALTHY_BROKERS = Number(process.env.OPENCLAW_HERMES_FP_BROKERS ?? 2);
export const DRY_RUN = process.env.OPENCLAW_HERMES_DRY_RUN === '1';
export const SESSION_ID = process.env.OPENCLAW_HERMES_SESSION ?? 'hermes-bridge';

// ── Kimi API (replaces openclaw → MiniMax indirection) ──────────────────────
export const KIMI_API_KEY = process.env.KIMI_API_KEY ?? '';
export const KIMI_BASE_URL = process.env.KIMI_BASE_URL ?? 'http://localhost:11235';
export const KIMI_MODEL = process.env.KIMI_MODEL ?? 'kimi-for-coding';
export const KIMI_TIMEOUT_MS = Number(process.env.KIMI_TIMEOUT_MS ?? 60_000);

// ── Ollama (Bonsai COO) ─────────────────────────────────────────────────────
// Bonsai-1.7b or bonsai-8b running locally on the Ollama host.
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://192.168.1.8:11434';
export const OLLAMA_COO_MODEL = process.env.OLLAMA_COO_MODEL ?? 'bonsai-1.7b';
export const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120_000);

// ── CFO integration ─────────────────────────────────────────────────────────
export const CFO_URL = process.env.CFO_URL ?? 'http://localhost:4309';
export const CFO_ALERTS_PATH = process.env.CFO_ALERTS_PATH ?? '/tmp/cfo-alerts.json';

// ── Runtime paths ───────────────────────────────────────────────────────────
export const RUNTIME_DIR = path.resolve(MODULE_DIR, '../.runtime');
export const SEEN_EVENTS_FILE = path.join(RUNTIME_DIR, 'seen-events.jsonl');
export const DIRECTIVES_FILE = path.join(RUNTIME_DIR, 'coo-directives.jsonl');
export const ACTIONS_LOG = path.join(RUNTIME_DIR, 'coo-actions.log');
export const OUTCOMES_LOG = path.join(RUNTIME_DIR, 'coo-outcomes.jsonl');
export const APPROVALS_DIR = path.join(RUNTIME_DIR, 'pending-approvals');
export const APPROVAL_MODE = (process.env.OPENCLAW_HERMES_APPROVAL_MODE ?? 'auto') as 'auto' | 'halt' | 'risky' | 'all';
export const HALT_FILE = path.join(RUNTIME_DIR, 'HALT');

// ── Legacy openclaw / MiniMax (deprecated, kept for backward compatibility) ─
// The bridge no longer spawns openclaw or yields to MiniMax locks.
// These constants are harmless no-ops now.
export const OPENCLAW_CMD = process.env.OPENCLAW_CMD ?? 'openclaw';
export const MINIMAX_BUSY_LOCK = process.env.MINIMAX_BUSY_LOCK ?? '/tmp/minimax-busy.lock';
export const MINIMAX_LOCK_STALE_MS = Number(process.env.MINIMAX_LOCK_STALE_MS ?? 10 * 60_000);

// ── Firm data paths ─────────────────────────────────────────────────────────
export const FIRM_API_RUNTIME = path.resolve(MODULE_DIR, '../../api/.runtime/paper-ledger');
export const FIRM_EVENTS_FILE = path.join(FIRM_API_RUNTIME, 'events.jsonl');
export const FIRM_JOURNAL_FILE = path.join(FIRM_API_RUNTIME, 'journal.jsonl');
export const JOURNAL_TAIL_COUNT = Number(process.env.OPENCLAW_HERMES_JOURNAL_TAIL ?? 50);
