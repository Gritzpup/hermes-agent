/**
 * Tests for finrl-inference.ts
 * - mock fetch, assert timeout returns null
 * - LRU memoization: identical requests return cached value
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getEdgeScore, isFinrlServerUp } from '../finrl-inference.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRequest(overrides = {}) {
  return {
    symbol: 'BTC-USD',
    side: 'long' as const,
    price: 100.0,
    book_imb: 0.1,
    position: 0,
    cash: 10000,
    ...overrides,
  };
}

function fakeResponse(body: object, ok = true, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    ok,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('getEdgeScore', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    // Reset module-level cache between tests
    // (the LRU cache is module-level so we clear via a fresh import trick)
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns edge_score when server responds 200', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ edge_score: 0.73, edge_score_raw: 0.8, risk_multiplier: 1.0 }),
    );
    const { getEdgeScore: fn } = await import('../finrl-inference.js');
    const score = await fn(makeRequest());
    expect(score).toBe(0.73);
  });

  it('returns null on 5xx server error', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ error: 'server error' }, false, 500));
    const { getEdgeScore: fn } = await import('../finrl-inference.js');
    const score = await fn(makeRequest());
    expect(score).toBeNull();
  });

  it('returns null on fetch network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { getEdgeScore: fn } = await import('../finrl-inference.js');
    const score = await fn(makeRequest());
    expect(score).toBeNull();
  });

  it('returns null on timeout (abort)', async () => {
    const controller = { abort: vi.fn(), signal: { aborted: true } };
    fetchMock.mockImplementationOnce(() => {
      return new Promise((_, reject) => {
        setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 5);
      });
    });
    const { getEdgeScore: fn } = await import('../finrl-inference.js');
    const score = await fn(makeRequest());
    expect(score).toBeNull();
  });

  it('returns null for non-ok response (e.g. 404)', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({}, false, 404));
    const { getEdgeScore: fn } = await import('../finrl-inference.js');
    const score = await fn(makeRequest());
    expect(score).toBeNull();
  });

  it('memoizes identical requests within TTL', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ edge_score: 0.55 }),
    );
    const { getEdgeScore: fn } = await import('../finrl-inference.js');
    const req = makeRequest();
    await fn(req);
    await fn(req);
    await fn(req);
    // fetch should be called only once
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hits cache on second call within TTL window', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ edge_score: 0.91 }),
    );
    const { getEdgeScore: fn } = await import('../finrl-inference.js');
    const score1 = await fn(makeRequest({ price: 101.0 }));
    const score2 = await fn(makeRequest({ price: 101.0 }));
    expect(score1).toBe(0.91);
    expect(score2).toBe(0.91);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache for different request params', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse({ edge_score: 0.5 }))
      .mockResolvedValueOnce(fakeResponse({ edge_score: 0.8 }));
    const { getEdgeScore: fn } = await import('../finrl-inference.js');
    await fn(makeRequest({ price: 99.0 }));
    await fn(makeRequest({ price: 101.0 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('isFinrlServerUp', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns true when /health returns 200', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 'ok' }, true, 200));
    const { isFinrlServerUp: fn } = await import('../finrl-inference.js');
    const up = await fn();
    expect(up).toBe(true);
  });

  it('returns false when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));
    const { isFinrlServerUp: fn } = await import('../finrl-inference.js');
    const up = await fn();
    expect(up).toBe(false);
  });
});
