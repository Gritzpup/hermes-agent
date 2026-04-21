/**
 * Error-emitter — emits structured error events to the firm events.jsonl stream.
 *
 * Key design:
 *   - Shape: { timestamp, source: "error-event", service, errorType, message,
 *              errorHash, count, firstSeen, scriptKeyHint, area }
 *   - Dedup: per (service, errorHash) within a 5-min sliding window
 *   - Secret redaction: strips sk-*, ghp_*, gho_*, sk_*, password= patterns
 *   - Non-fatal: missing events dir silently skips the write
 *   - Process-memory dedup only — no persistence across restarts
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Hardcoded path to the firm event stream.  Do NOT import from config.ts
// to keep this module usable from any service without circular-dep risk.
const EVENTS_FILE = '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger/events.jsonl';

export const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ── Dedup state ────────────────────────────────────────────────────────────

interface DedupEntry {
  count: number;
  firstSeen: number;   // Date.now() ms at first occurrence in current window
}

const dedupMap = new Map<string, DedupEntry>();

// ── Error hashing ──────────────────────────────────────────────────────────

/** Fast hash of an error for dedup — uses constructor name + message + first stack line. */
function errorHash(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const stackFirst = err instanceof Error ? (err.stack ?? '').split('\n')[1] ?? '' : '';
  const input = `${err instanceof Error ? err.constructor.name : 'Error'}|${msg}|${stackFirst}`;
  return createHash('md5').update(input).digest('hex').slice(0, 12);
}

// ── Secret redaction ──────────────────────────────────────────────────────

/** Strip tokens and credentials from a string. */
function redactString(s: string): string {
  return s
    .replace(/(sk-[A-Za-z0-9_-]{20,})/gi, '[REDACTED]')
    .replace(/(ghp_[A-Za-z0-9]{36})/g, '[REDACTED]')
    .replace(/(gho_[A-Za-z0-9]{36})/g, '[REDACTED]')
    .replace(/(sk_[A-Za-z0-9]{32,})/g, '[REDACTED]')
    // JWT tokens (header.payload.signature — any issuer)
    .replace(/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, '[REDACTED]')
    // HTTP Authorization headers
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{20,}/gi, '$1[REDACTED]')
    .replace(/(Basic\s+)[A-Za-z0-9+/=]{20,}/g, '$1[REDACTED]')
    .replace(/(password|passwd|secret|token|api[_-]?key|apikey)[=:]["']?[A-Za-z0-9_/-]{4,}/gi, '$1=[REDACTED]');
}

// ── Event emission ─────────────────────────────────────────────────────────

/**
 * Write a structured error event to events.jsonl.
 * Silently skips if the events directory does not exist.
 */
function writeErrorEvent(line: string): void {
  const dir = '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger';
  try {
    if (!existsSync(dir)) return;
    appendFileSync(EVENTS_FILE, line, { encoding: 'utf8' });
  } catch {
    // Non-fatal
  }
}

/**
 * Emit a firm error.
 *
 * @param service   - Name of the service emitting the error
 * @param err       - The error (Error object or anything coerceable to string)
 * @param hint      - Optional { scriptKey?, area? } to guide the COO's self-heal decision
 */
export function emitFirmError(
  service: string,
  err: unknown,
  hint?: { scriptKey?: string; area?: string },
): void {
  const windowMs = Number(process.env.ERROR_EMITTER_WINDOW_MS ?? DEFAULT_WINDOW_MS);
  const hash = errorHash(err);
  const dedupKey = `${service}:${hash}`;
  const now = Date.now();

  // Prune stale dedup entries so the map doesn't grow unbounded in long-running
  // processes. Entries older than 2× window are unambiguously expired.
  const staleCutoff = now - 2 * windowMs;
  for (const [k, v] of dedupMap) {
    if (v.firstSeen < staleCutoff) dedupMap.delete(k);
  }

  const existing = dedupMap.get(dedupKey);

  if (existing && now - existing.firstSeen < windowMs) {
    // Within dedup window — bump count in memory but do NOT re-emit to events.jsonl
    existing.count += 1;
    dedupMap.set(dedupKey, existing);
    return;
  }

  // Window expired or first occurrence — reset window and emit
  dedupMap.set(dedupKey, { count: 1, firstSeen: now });

  const errorType = err instanceof Error ? err.constructor.name : 'Error';
  const rawMsg = err instanceof Error ? err.message : String(err);
  const message = redactString(rawMsg.slice(0, 300));

  const entry = {
    timestamp: new Date().toISOString(),
    source: 'error-event',            // ← what hermes-poller.ts filters on
    service,
    errorType,
    message,
    errorHash: hash,
    count: 1,
    firstSeen: new Date(now).toISOString(),
    scriptKeyHint: hint?.scriptKey ?? null,
    area: hint?.area ?? null,
  };

  writeErrorEvent(JSON.stringify(entry) + '\n');
}
