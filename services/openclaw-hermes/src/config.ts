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

// ── Local model proxy (port 9000) — auto-routes to Bonsai/ollama by model name ──
export const MODEL_PROXY_URL = process.env.MODEL_PROXY_URL ?? 'http://192.168.1.8:9000/v1';
export const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 300_000);

// ── Per-model backend selection (used when proxy is not available) ────────────
// Bonsai WSL (llama-server): http://192.168.1.8:8082/v1 — bonsai-1.7b, bonsai-8b
// Ollama (native): http://192.168.1.8:11434/v1 — phi3.5, qwen2.5:7b, etc.
// qwen3:8b is too slow for COO cadence — do NOT use.
export const BONSAI_BASE_URL = process.env.BONSAI_BASE_URL ?? 'http://192.168.1.8:8082';
export const BONSAI_MODEL = process.env.BONSAI_MODEL ?? 'Bonsai-1.7B-Q1.gguf';
export const BONSAI_TIMEOUT_MS = Number(process.env.BONSAI_TIMEOUT_MS ?? 120_000);
export const OLLAMA_DIRECT_URL = process.env.OLLAMA_DIRECT_URL ?? 'http://192.168.1.8:11434';
export const OLLAMA_COO_MODEL = process.env.OLLAMA_COO_MODEL ?? 'qwen2.5:7b';
export const OLLAMA_REASONING_MODEL = process.env.OLLAMA_REASONING_MODEL ?? 'qwen2.5:7b';

// ── MiniMax API (MiniMax-M2.7-highspeed, cloud) ───────────────────────────────
export const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? '';
export const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/anthropic';
export const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7-highspeed';
export const MINIMAX_TIMEOUT_MS = Number(process.env.MINIMAX_TIMEOUT_MS ?? 120_000);

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
