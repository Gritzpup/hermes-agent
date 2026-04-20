import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const HERMES_API = process.env.HERMES_API_URL ?? 'http://localhost:4300';
export const HEALTH_PORT = Number(process.env.OPENCLAW_HERMES_PORT ?? 4395);
export const POLL_INTERVAL_MS = Number(process.env.OPENCLAW_HERMES_POLL_MS ?? 30_000);
export const DRY_RUN = process.env.OPENCLAW_HERMES_DRY_RUN === '1';
export const SESSION_ID = process.env.OPENCLAW_HERMES_SESSION ?? 'hermes-bridge';
export const OPENCLAW_CMD = process.env.OPENCLAW_CMD ?? 'openclaw';

export const RUNTIME_DIR = path.resolve(MODULE_DIR, '../.runtime');
export const SEEN_EVENTS_FILE = path.join(RUNTIME_DIR, 'seen-events.jsonl');
export const DIRECTIVES_FILE = path.join(RUNTIME_DIR, 'coo-directives.jsonl');
export const ACTIONS_LOG = path.join(RUNTIME_DIR, 'coo-actions.log');
export const OUTCOMES_LOG = path.join(RUNTIME_DIR, 'coo-outcomes.jsonl');
export const HALT_FILE = path.join(RUNTIME_DIR, 'HALT');

export const FIRM_API_RUNTIME = path.resolve(MODULE_DIR, '../../api/.runtime/paper-ledger');
export const FIRM_EVENTS_FILE = path.join(FIRM_API_RUNTIME, 'events.jsonl');
export const FIRM_JOURNAL_FILE = path.join(FIRM_API_RUNTIME, 'journal.jsonl');
export const JOURNAL_TAIL_COUNT = Number(process.env.OPENCLAW_HERMES_JOURNAL_TAIL ?? 20);
