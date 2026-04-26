/**
 * Qdrant RAG Client — research-agent local copy
 *
 * Identical contract to services/market-data/src/qdrant.ts but lives here
 * so research-agent has no circular dependency on market-data.
 *
 * Collections:
 *   - journal_events  — weekly strategy memos + journal entries
 *   - news            — news articles with sentiment scores
 *   - onchain_signals — DeFiLlama + Hyperliquid flow signals
 *
 * Embeddings via Ollama nomic-embed-text on the same remote host.
 */

import { logger } from '@hermes/logger';

/* ── Config ───────────────────────────────────────────────────────── */

const QDRANT_URL  = process.env.QDRANT_URL ?? 'http://127.0.0.1:7405';
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://192.168.1.8:11434';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';
const VECTOR_SIZE = 768; // nomic-embed-text default

/* ── Collection names ─────────────────────────────────────────────── */

export const COLLECTIONS = {
  JOURNAL_EVENTS:   'journal_events',
  NEWS:             'news',
  ONCHAIN_SIGNALS:  'onchain_signals',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/* ── Types ────────────────────────────────────────────────────────── */

export interface SearchResult {
  id:      string;
  score:   number;
  payload: Record<string, unknown>;
}

/* ── Fetch helper with timeout ───────────────────────────────────── */

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ── Embedding helper ─────────────────────────────────────────────── */

export async function embedText(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetchWithTimeout(
      `${OLLAMA_BASE}/api/embeddings`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: EMBED_MODEL, prompt: text }),
        signal:  controller.signal,
      },
      9_000,
    );

    clearTimeout(timer);

    if (!response.ok) throw new Error(`Ollama embed failed: ${response.status}`);
    const payload = await response.json() as { embedding?: number[] };
    if (!payload?.embedding?.length) throw new Error('empty embedding returned');
    return payload.embedding;
  } catch (err) {
    clearTimeout(timer);
    logger.warn({ err }, 'embedText failed — returning zero vector');
    return new Array(VECTOR_SIZE).fill(0);
  }
}

/* ── Upsert ───────────────────────────────────────────────────────── */

/**
 * Upsert a point into a Qdrant collection.
 * Silent failure: logs a warning but never throws so callers stay healthy.
 */
export async function upsert(
  collection: CollectionName,
  id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const vector = await embedText(
      typeof payload.text === 'string' ? payload.text :
      typeof payload.content === 'string' ? payload.content :
      JSON.stringify(payload),
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);

    const response = await fetchWithTimeout(
      `${QDRANT_URL}/collections/${collection}/points`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ points: [{ id, vector, payload }] }),
        signal:  controller.signal,
      },
      9_000,
    );

    clearTimeout(timer);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Qdrant upsert ${response.status}: ${body}`);
    }
  } catch (err) {
    logger.warn({ err, collection, id }, 'qdrant upsert failed — skipping');
  }
}

/* ── Search ───────────────────────────────────────────────────────── */

/**
 * Semantic search in a Qdrant collection.
 * Returns empty array on any error (never throws).
 */
export async function search(
  collection: CollectionName,
  query: string,
  k = 5,
): Promise<SearchResult[]> {
  try {
    const vector = await embedText(query);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);

    const response = await fetchWithTimeout(
      `${QDRANT_URL}/collections/${collection}/points/search`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ vector, limit: k, with_payload: true }),
        signal:  controller.signal,
      },
      9_000,
    );

    clearTimeout(timer);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Qdrant search ${response.status}: ${body}`);
    }

    const payload = await response.json() as {
      result?: Array<{ id: string | number; score?: number; payload?: Record<string, unknown> }>;
    };

    return (payload?.result ?? []).map((p) => ({
      id:      String(p.id),
      score:   p.score ?? 0,
      payload: p.payload ?? {},
    }));
  } catch (err) {
    logger.warn({ err, collection, query }, 'qdrant search failed — returning empty');
    return [];
  }
}

/* ── Collection existence check + creation ──────────────────────── */

export async function ensureCollection(name: CollectionName): Promise<void> {
  try {
    const response = await fetchWithTimeout(
      `${QDRANT_URL}/collections/${name}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      5_000,
    );
    if (response.ok) return; // already exists

    if (response.status !== 404) {
      const body = await response.text().catch(() => '');
      throw new Error(`unexpected status ${response.status}: ${body}`);
    }

    const createRes = await fetchWithTimeout(
      `${QDRANT_URL}/collections/${name}`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ vectors: { size: VECTOR_SIZE, distance: 'Cosine' } }),
      },
      5_000,
    );

    if (!createRes.ok) {
      const body = await createRes.text().catch(() => '');
      throw new Error(`Qdrant create collection failed ${createRes.status}: ${body}`);
    }

    logger.info({ collection: name }, 'qdrant collection created');
  } catch (err) {
    logger.warn({ err, collection: name }, 'ensureCollection failed');
  }
}

export async function bootstrapCollections(): Promise<void> {
  await Promise.allSettled(
    Object.values(COLLECTIONS).map((c) => ensureCollection(c)),
  );
}
