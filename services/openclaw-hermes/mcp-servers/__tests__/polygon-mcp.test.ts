/**
 * polygon-mcp.test.ts — Mock Polygon HTTP, assert cache, assert 5xx degradation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cachedFetch, cacheKey, jsonRpcSuccess, jsonRpcError } from '../base.js';

// ── Mock Redis before importing base.ts ────────────────────────────────────────

const mockRedisGet = vi.fn<() => Promise<string | null>>();
const mockRedisSetex = vi.fn<() => Promise<string>>();

vi.stubGlobal('__redisMock', { get: mockRedisGet, setex: mockRedisSetex });

vi.mock('@hermes/infra', () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    setex: (...args: unknown[]) => mockRedisSetex(...args),
  },
}));

// ── Re-import after mocks are set up ─────────────────────────────────────────

// We need to test the base.ts module with our mocks applied.
// Since ESM caches modules, we import base.ts at the top of the file
// (before mocks are ready). The cachedFetch function will use the
// real @hermes/infra import inside its closure, which is already mocked.

// ── Cache key tests ───────────────────────────────────────────────────────────

describe('cacheKey — deterministic hashing', () => {
  it('same args produce same key', () => {
    const k1 = cacheKey('polygon', 'get_quote', { symbol: 'AAPL' });
    const k2 = cacheKey('polygon', 'get_quote', { symbol: 'AAPL' });
    expect(k1).toBe(k2);
  });

  it('different args produce different keys', () => {
    const k1 = cacheKey('polygon', 'get_quote', { symbol: 'AAPL' });
    const k2 = cacheKey('polygon', 'get_quote', { symbol: 'GOOGL' });
    expect(k1).not.toBe(k2);
  });

  it('different servers produce different keys', () => {
    const k1 = cacheKey('polygon', 'get_quote', { symbol: 'AAPL' });
    const k2 = cacheKey('finnhub', 'get_quote', { symbol: 'AAPL' });
    expect(k1).not.toBe(k2);
  });

  it('key format is mcp:{server}:{tool}:{hash}', () => {
    const key = cacheKey('polygon', 'get_quote', { symbol: 'AAPL' });
    expect(key).toMatch(/^mcp:polygon:get_quote:[a-f0-9]{12}$/);
  });
});

// ── cachedFetch — upstream hit, cache miss → upstream called, result cached ────

describe('cachedFetch — upstream hit, cache miss', () => {
  beforeEach(() => {
    mockRedisGet.mockResolvedValue(null);
    mockRedisSetex.mockResolvedValue('OK');
  });

  it('first call fetches from upstream and caches result with 30s TTL', async () => {
    let upstreamCalls = 0;
    const fetcher = async () => {
      upstreamCalls++;
      return { price: 150.25, symbol: 'AAPL' };
    };

    const key = cacheKey('polygon', 'get_quote', { symbol: 'AAPL' });
    const result = await cachedFetch(key, fetcher);

    expect(result.fromCache).toBe(false);
    expect(result.data).toEqual({ price: 150.25, symbol: 'AAPL' });
    expect(upstreamCalls).toBe(1);
    // Verify TTL was set to 30 seconds
    expect(mockRedisSetex).toHaveBeenCalledWith(key, 30, expect.any(String));
  });

  it('second call returns cached value without calling upstream', async () => {
    const cachedData = { price: 150.25, symbol: 'AAPL' };
    mockRedisGet.mockResolvedValue(
      JSON.stringify({ data: cachedData, cachedAt: Date.now() }),
    );

    let upstreamCalls = 0;
    const fetcher = async () => {
      upstreamCalls++;
      return { price: 999, symbol: 'NEVER_CALLED' };
    };

    const key = cacheKey('polygon', 'get_quote', { symbol: 'AAPL' });
    const result = await cachedFetch(key, fetcher);

    expect(result.fromCache).toBe(true);
    expect(result.data).toEqual(cachedData);
    expect(upstreamCalls).toBe(0); // upstream NOT called — cache hit
  });
});

// ── cachedFetch — graceful degradation on 5xx ─────────────────────────────────

describe('cachedFetch — graceful degradation on 5xx', () => {
  beforeEach(() => {
    mockRedisGet.mockResolvedValue(null);
    mockRedisSetex.mockResolvedValue('OK');
  });

  it('5xx with stale cache available returns last cached value', async () => {
    const staleData = { price: 149.50, symbol: 'AAPL' };
    mockRedisGet.mockResolvedValue(
      JSON.stringify({ data: staleData, cachedAt: Date.now() - 10_000 }),
    );

    const failingFetcher = async () => {
      const err = new Error('503 Service Unavailable') as Error & { status: number };
      err.status = 503;
      throw err;
    };

    const key = cacheKey('polygon', 'get_quote', { symbol: 'AAPL' });
    const result = await cachedFetch(key, failingFetcher);

    expect(result.fromCache).toBe(true);
    expect(result.data).toEqual(staleData);
    expect(result.cachedAt).toBeDefined();
  });

  it('5xx with no cache available returns null', async () => {
    mockRedisGet.mockResolvedValue(null);

    const failingFetcher = async () => {
      const err = new Error('503') as Error & { status: number };
      err.status = 503;
      throw err;
    };

    const key = cacheKey('polygon', 'get_quote', { symbol: 'AAPL' });
    const result = await cachedFetch(key, failingFetcher);

    expect(result.fromCache).toBe(false);
    expect(result.data).toBe(null);
  });

  it('4xx (client error) does NOT fall back to cache', async () => {
    mockRedisGet.mockResolvedValue(null);

    const notFoundFetcher = async () => {
      const err = new Error('404 Not Found') as Error & { status: number };
      err.status = 404;
      throw err;
    };

    const key = cacheKey('polygon', 'get_quote', { symbol: 'INVALID' });
    const result = await cachedFetch(key, notFoundFetcher);

    expect(result.fromCache).toBe(false);
    expect(result.data).toBe(null);
  });
});

// ── jsonRpc helpers ───────────────────────────────────────────────────────────

describe('jsonRpc helpers', () => {
  it('jsonRpcSuccess returns valid JSON-RPC 2.0 response', () => {
    const r = jsonRpcSuccess(42, { price: 150 });
    expect(r).toEqual({
      jsonrpc: '2.0',
      id: 42,
      result: { price: 150 },
    });
  });

  it('jsonRpcError returns valid JSON-RPC 2.0 error', () => {
    const r = jsonRpcError(42, -32603, 'Internal error', { hint: 'check API key' });
    expect(r).toEqual({
      jsonrpc: '2.0',
      id: 42,
      error: { code: -32603, message: 'Internal error', data: { hint: 'check API key' } },
    });
  });

  it('jsonRpcError omits data field when undefined', () => {
    const r = jsonRpcError(1, -32601, 'Method not found');
    expect(r.error).not.toHaveProperty('data');
  });
});
