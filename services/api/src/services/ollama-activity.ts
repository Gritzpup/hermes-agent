// @ts-nocheck
/**
 * Shared append-only ring-buffer log for ALL Ollama calls across the codebase.
 * Consumed by the Ollama terminal pane and optionally exposed via /api/ollama-activity.
 */

import { randomUUID } from 'node:crypto';

export type OllamaActivityStatus = 'started' | 'complete' | 'error';

export interface OllamaActivityEvent {
  id: string;
  timestamp: string;
  source: string;               // e.g. 'ai-council-hermes3', 'ai-council-qwen', 'insider-radar', 'strategy-director'
  model: string;
  status: OllamaActivityStatus;
  latencyMs?: number;
  promptPreview: string;        // first 120 chars
  responsePreview: string;       // first 120 chars
  errorPreview?: string;         // first 120 chars
}

/** Ring buffer: last MAX entries */
const MAX_ENTRIES = 200;
const _log: OllamaActivityEvent[] = [];

export function logOllamaCall({
  source,
  model,
  prompt,
  responseSummary,
  latencyMs,
  status,
  errorPreview,
}: {
  source: string;
  model: string;
  prompt: string;
  responseSummary?: string;
  latencyMs?: number;
  status: OllamaActivityStatus;
  errorPreview?: string;
}): void {
  const entry: OllamaActivityEvent = {
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

export function getRecentOllamaActivity(limit = 40): OllamaActivityEvent[] {
  return _log.slice(-limit);
}
