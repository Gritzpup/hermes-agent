/**
 * FinRL-X inference client.
 *
 * POSTs to http://127.0.0.1:7410/edge_score with a trading-state body and
 * returns the edge_score number (∈ [0, 1]).
 *
 * On timeout / 5xx / Python sidecar down → returns null so the caller
 * falls back to rule-based execution.
 *
 * LRU memoization: last 100 calls with 5-second TTL.
 */

export interface EdgeScoreRequest {
  symbol: string;
  side: "long" | "short" | "flat";
  price: number;
  book_imb: number;
  position: number;
  cash: number;
  step?: number;
  news_risk?: number; // optional risk_multiplier override
  apply_news_risk?: boolean;
  headlines?: string[];
}

export interface EdgeScoreResponse {
  edge_score: number;
  edge_score_raw: number;
  risk_multiplier: number;
  symbol: string;
  side: string;
}

const FINRL_URL = process.env.FINRL_INFERENCE_URL ?? "http://127.0.0.1:7410";
const REQUEST_TIMEOUT_MS = Number(process.env.FINRL_TIMEOUT_MS ?? 100);

// ── LRU cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: number | null;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();
const _cacheOrder: string[] = []; // insertion-order for LRU eviction
const MAX_CACHE = 100;
const CACHE_TTL_MS = 5000;

function _cacheKey(req: EdgeScoreRequest): string {
  return `${req.symbol}:${req.side}:${req.price.toFixed(4)}:${req.book_imb.toFixed(4)}:${req.position}:${req.cash.toFixed(2)}`;
}

function _fromCache(key: string): number | null | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    const idx = _cacheOrder.indexOf(key);
    if (idx !== -1) _cacheOrder.splice(idx, 1);
    return undefined;
  }
  return entry.value;
}

function _toCache(key: string, value: number | null): void {
  if (_cache.size >= MAX_CACHE) {
    const oldest = _cacheOrder.shift();
    if (oldest) _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  _cacheOrder.push(key);
}

// ── Fetch wrapper with timeout ────────────────────────────────────────────────

function _fetchWithTimeout(
  url: string,
  body: EdgeScoreRequest,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Query the FinRL-X inference server for an edge score.
 *
 * @returns edge_score ∈ [0, 1], or null if the server is unreachable/timeout/error.
 */
export async function getEdgeScore(
  req: EdgeScoreRequest,
): Promise<number | null> {
  const cacheKey = _cacheKey(req);
  const cached = _fromCache(cacheKey);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await _fetchWithTimeout(
      `${FINRL_URL}/edge_score`,
      req,
      controller.signal,
    );
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[finrl-inference] server error ${res.status}`);
      _toCache(cacheKey, null);
      return null;
    }

    const json = (await res.json()) as EdgeScoreResponse;
    const score = json.edge_score;
    _toCache(cacheKey, score);
    return score;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`[finrl-inference] timeout (>${REQUEST_TIMEOUT_MS}ms) for ${req.symbol}`);
    } else {
      console.warn(`[finrl-inference] fetch error:`, err instanceof Error ? err.message : String(err));
    }
    _toCache(cacheKey, null);
    return null;
  }
}

/**
 * Check whether the FinRL-X inference server is reachable.
 */
export async function isFinrlServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${FINRL_URL}/health`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
