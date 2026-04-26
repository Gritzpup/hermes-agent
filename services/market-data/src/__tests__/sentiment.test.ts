/**
 * sentiment.test.ts
 * Tests for FinGPT v3 sentiment scoring.
 * Mocks the Ollama HTTP API so we test prompt construction and score parsing
 * without needing a live model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the infra and logger modules before importing sentiment
vi.mock('@hermes/infra', () => ({
  redis: {
    set:    vi.fn().mockResolvedValue('OK'),
    get:    vi.fn().mockResolvedValue(null),
    hset:   vi.fn().mockResolvedValue(Promise.resolve(1)),
    expire: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@hermes/logger', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('scoreSentiment', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a SentimentResult with correct score range', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            score:      0.75,
            horizon:    '1d',
            confidence: 0.88,
            reasoning:  'Bullish on BTC due to ETF inflows.',
          }),
        },
      }),
    });

    // Lazy import so mocks are in place first
    const { scoreSentiment } = await import('../sentiment.js');
    const result = await scoreSentiment('Bitcoin shows strong momentum', 'BTC-USD');

    expect(result.symbol).toBe('BTC-USD');
    expect(result.score).toBe(0.75);
    expect(result.horizon).toBe('1d');
    expect(result.confidence).toBe(0.88);
  });

  it('clamps score to [-1, 1] range', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            score:      1.5,   // out of range
            horizon:    '1w',
            confidence: 0.95,
          }),
        },
      }),
    });

    const { scoreSentiment } = await import('../sentiment.js');
    const result = await scoreSentiment('Extreme bullish signal', 'ETH-USD');
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(-1);
  });

  it('returns neutral fallback on HTTP error', async () => {
    fetchMock.mockResolvedValue({
      ok:    false,
      status: 500,
    });

    const { scoreSentiment } = await import('../sentiment.js');
    const result = await scoreSentiment('Some news', 'SOL-USD');

    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.symbol).toBe('SOL-USD');
  });

  it('returns neutral fallback on fetch throw', async () => {
    fetchMock.mockRejectedValue(new Error('network unreachable'));

    const { scoreSentiment } = await import('../sentiment.js');
    const result = await scoreSentiment('Some news', 'XRP-USD');

    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it('handles malformed JSON gracefully', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: 'This is not JSON at all {broken',
        },
      }),
    });

    const { scoreSentiment } = await import('../sentiment.js');
    const result = await scoreSentiment('Bad response', 'DOGE-USD');

    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it('constructs correct Ollama API payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: '{"score":0,"horizon":"1d","confidence":0}' } }),
    });

    const { scoreSentiment } = await import('../sentiment.js');
    await scoreSentiment('Test headline about AAPL', 'AAPL-USD');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/chat');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('martain7r/finance-llama-8b:q4_k_m');
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('AAPL-USD');
    expect(body.messages[0].content).toContain('Test headline about AAPL');
  });

  it('scoreSentimentNews returns array with combined score', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({ score: 0.5, horizon: '1h', confidence: 0.7 }),
        },
      }),
    });

    const { scoreSentimentNews } = await import('../sentiment.js');
    const results = await scoreSentimentNews('BTC-USD', [
      { headline: 'Bitcoin surges', source: 'CoinDesk', publishedAt: '2026-04-26T10:00:00Z' },
      { headline: 'BTC ETF inflows rise', source: 'Reuters', publishedAt: '2026-04-26T11:00:00Z' },
    ]);

    expect(Array.isArray(results)).toBe(true);
    expect(results[0]?.score).toBe(0.5);
  });
});
