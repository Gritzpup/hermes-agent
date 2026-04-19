/**
 * Live Log — a circular buffer of timestamped log lines that the SSE streams to the frontend.
 * Engine modules push lines here as things happen. No polling needed.
 */
const MAX_ENTRIES = 400;
const entries = [];
const listeners = new Set();
export function pushLog(source, text) {
    const entry = { ts: Date.now(), source, text };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES)
        entries.shift();
    for (const fn of listeners) {
        try {
            fn(entry);
        }
        catch { /* ignore */ }
    }
}
export function getRecentLog(limit = 80) {
    return entries.slice(-limit);
}
export function onLogEntry(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
