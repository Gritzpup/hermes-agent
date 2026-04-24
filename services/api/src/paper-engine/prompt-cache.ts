// @ts-nocheck
/**
 * Prompt cache for LLM providers (Kimi, Ollama, Claude, Gemini).
 *
 * Caches responses keyed by a hash of (model + systemPrompt + userPrompt).
 * TTL: 5 minutes (300_000 ms).
 *
 * In-memory Map as primary store; Redis as optional cross-process L2 cache.
 * Set PROMPT_CACHE_REDIS_TTL=0 to disable Redis entirely.
 */

import crypto from 'node:crypto';
import { redis } from '@hermes/infra';

export interface CachedPrompt {
  response: unknown;
  cachedAt: number;
  expiresAt: number;
  provider: string;
  model: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000; // 5 minutes

// In-memory L1 cache: key → { response, cachedAt, expiresAt }
const memoryCache = new Map<string, CachedPrompt>();

// ── Key generation ──────────────────────────────────────────────────────────

/**
 * Deterministic cache key from provider + model + prompts.
 */
export function promptCacheKey(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): string {
  const raw = `${provider}::${model}::${systemPrompt}::${userPrompt}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return `prompt:${hash}`;
}

// ── Memory cache ────────────────────────────────────────────────────────────

export function memoryCacheGet(key: string): CachedPrompt | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return entry;
}

export function memoryCacheSet(key: string, entry: CachedPrompt): void {
  memoryCache.set(key, entry);
  // Expire from memory after TTL + 30 s grace period
  setTimeout(() => memoryCache.delete(key), entry.expiresAt - Date.now() + 30_000);
}

// ── Redis L2 cache ───────────────────────────────────────────────────────────

const USE_REDIS = process.env.PROMPT_CACHE_REDIS_TTL !== '0';
const REDIS_TTL_S = parseInt(process.env.PROMPT_CACHE_REDIS_TTL ?? '300', 10);

export async function redisCacheGet(key: string): Promise<CachedPrompt | null> {
  if (!USE_REDIS) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CachedPrompt;
    if (Date.now() > entry.expiresAt) {
      await redis.del(key).catch(() => {});
      return null;
    }
    return entry;
  } catch { return null; }
}

export async function redisCacheSet(key: string, entry: CachedPrompt): Promise<void> {
  if (!USE_REDIS) return;
  try {
    const ttl = Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    await redis.set(key, JSON.stringify(entry), { EX: Math.min(ttl, REDIS_TTL_S) });
  } catch { /* non-critical */ }
}

// ── Unified cache API ───────────────────────────────────────────────────────

export interface CacheOptions {
  ttlMs?: number;
  provider?: string;
  model?: string;
}

/**
 * Get cached response, or null if not found / expired.
 */
export async function cacheGet(
  key: string,
  _options?: CacheOptions
): Promise<CachedPrompt | null> {
  // L1: memory first
  const mem = memoryCacheGet(key);
  if (mem) return mem;
  // L2: Redis
  return redisCacheGet(key);
}

/**
 * Store a response in both memory and Redis caches.
 */
export async function cacheSet(
  key: string,
  response: unknown,
  options: CacheOptions = {}
): Promise<void> {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const entry: CachedPrompt = {
    response,
    cachedAt: Date.now(),
    expiresAt: Date.now() + ttl,
    provider: options.provider ?? 'unknown',
    model: options.model ?? 'unknown',
  };
  memoryCacheSet(key, entry);
  await redisCacheSet(key, entry);
}

// ── Convenience wrapper for provider evaluate() methods ───────────────────────

/**
 * Wraps an LLM fetch call with prompt caching.
 * On cache hit, returns the cached response.
 * On cache miss, calls fetchFn, caches the result, then returns it.
 *
 * @param fetchFn  The actual LLM API call (returns parsed response)
 * @param cacheKey Cache key (precomputed via promptCacheKey)
 * @param options  TTL and provider/model metadata
 */
export async function withPromptCache<T>(
  fetchFn: () => Promise<T>,
  cacheKey: string,
  options: CacheOptions = {}
): Promise<T> {
  const cached = await cacheGet(cacheKey, options);
  if (cached) {
    console.debug(`[prompt-cache] HIT key=${cacheKey} provider=${options.provider} model=${options.model}`);
    return cached.response as T;
  }

  const response = await fetchFn();
  await cacheSet(cacheKey, response, options);
  return response;
}
