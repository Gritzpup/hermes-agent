// @ts-nocheck
/**
 * Shared append-only ring-buffer log for ALL Ollama calls across the codebase.
 * Consumed by the Ollama terminal pane and optionally exposed via /api/ollama-activity.
 */
import { randomUUID } from 'node:crypto';
/** Ring buffer: last MAX entries */
const MAX_ENTRIES = 200;
const _log = [];
export function logOllamaCall({ source, model, prompt, responseSummary, latencyMs, status, errorPreview, }) {
    const entry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        source,
        model,
        status,
        latencyMs,
        promptPreview: (prompt ?? '').slice(0, 120),
        responsePreview: (responseSummary ?? '').slice(0, 120),
        errorPreview: errorPreview ? String(errorPreview).slice(0, 120) : undefined,
    };
    _log.push(entry);
    if (_log.length > MAX_ENTRIES) {
        _log.splice(0, _log.length - MAX_ENTRIES);
    }
}
export function getRecentOllamaActivity(limit = 40) {
    return _log.slice(-limit);
}
