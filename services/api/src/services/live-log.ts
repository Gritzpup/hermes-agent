/**
 * Live Log — a circular buffer of timestamped log lines that the SSE streams to the frontend.
 * Engine modules push lines here as things happen. No polling needed.
 */

export interface LogEntry {
  ts: number;
  source: string;
  text: string;
}

const MAX_ENTRIES = 400;
const entries: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

export function pushLog(source: string, text: string): void {
  const entry: LogEntry = { ts: Date.now(), source, text };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  for (const fn of listeners) {
    try { fn(entry); } catch { /* ignore */ }
  }
}

export function getRecentLog(limit = 80): LogEntry[] {
  return entries.slice(-limit);
}

export function onLogEntry(fn: (entry: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
