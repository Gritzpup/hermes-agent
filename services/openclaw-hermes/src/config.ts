import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const HERMES_API = process.env.HERMES_API_URL ?? 'http://localhost:4300';
export const HEALTH_PORT = Number(process.env.OPENCLAW_HERMES_PORT ?? 4395);
export const POLL_INTERVAL_MS = Number(process.env.OPENCLAW_HERMES_POLL_MS ?? 600_000);  // 10 min — LLM tick. Strategic decisions (pause losing strategies, amplify winners, directives, pattern surfacing) don't need sub-minute latency. Halt/systemic-risk handled by fast-path (30s, rule-based, no LLM).
export const FAST_PATH_INTERVAL_MS = Number(process.env.OPENCLAW_HERMES_FASTPATH_MS ?? 30_000);  // 30s — rule-based halt check (drawdown, broker outage); NO LLM, so cheap to run often.
export const FAST_PATH_DRAWDOWN_USD = Number(process.env.OPENCLAW_HERMES_DD_USD ?? 500);  // Halt if realized losses in the last FAST_PATH_WINDOW_MS exceed this dollar amount.
export const FAST_PATH_WINDOW_MS = Number(process.env.OPENCLAW_HERMES_FP_WINDOW_MS ?? 60 * 60_000);  // 60 min rolling window for drawdown check.
export const FAST_PATH_MIN_UNHEALTHY_BROKERS = Number(process.env.OPENCLAW_HERMES_FP_BROKERS ?? 2);  // Halt if this many brokers report unhealthy simultaneously.
export const DRY_RUN = process.env.OPENCLAW_HERMES_DRY_RUN === '1';
export const SESSION_ID = process.env.OPENCLAW_HERMES_SESSION ?? 'hermes-bridge';
export const OPENCLAW_CMD = process.env.OPENCLAW_CMD ?? 'openclaw';

export const RUNTIME_DIR = path.resolve(MODULE_DIR, '../.runtime');
export const SEEN_EVENTS_FILE = path.join(RUNTIME_DIR, 'seen-events.jsonl');
export const DIRECTIVES_FILE = path.join(RUNTIME_DIR, 'coo-directives.jsonl');
export const ACTIONS_LOG = path.join(RUNTIME_DIR, 'coo-actions.log');
export const OUTCOMES_LOG = path.join(RUNTIME_DIR, 'coo-outcomes.jsonl');
export const APPROVALS_DIR = path.join(RUNTIME_DIR, 'pending-approvals');
// Approval mode: 'auto' (COO fully autonomous - default per user directive), 'halt' (gate only halts),
// 'risky' (gate halt + force-close + set-max-positions), 'all' (every non-noop action).
export const APPROVAL_MODE = (process.env.OPENCLAW_HERMES_APPROVAL_MODE ?? 'auto') as 'auto' | 'halt' | 'risky' | 'all';
export const HALT_FILE = path.join(RUNTIME_DIR, 'HALT');
// Shared MiniMax-busy lock. When a manual pi invocation is in flight, the bridge
// yields its tick to avoid racing on the same MiniMax account (plan supports only
// 1-2 concurrent agents). pi wrappers touch this file on start, trap-remove on exit.
// Stale locks (mtime > 5 min) are ignored.
export const MINIMAX_BUSY_LOCK = process.env.MINIMAX_BUSY_LOCK ?? '/tmp/minimax-busy.lock';
export const MINIMAX_LOCK_STALE_MS = Number(process.env.MINIMAX_LOCK_STALE_MS ?? 5 * 60_000);

export const FIRM_API_RUNTIME = path.resolve(MODULE_DIR, '../../api/.runtime/paper-ledger');
export const FIRM_EVENTS_FILE = path.join(FIRM_API_RUNTIME, 'events.jsonl');
export const FIRM_JOURNAL_FILE = path.join(FIRM_API_RUNTIME, 'journal.jsonl');
export const JOURNAL_TAIL_COUNT = Number(process.env.OPENCLAW_HERMES_JOURNAL_TAIL ?? 50);
