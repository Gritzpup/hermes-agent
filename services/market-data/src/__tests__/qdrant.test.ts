/**
 * qdrant.test.ts
 * Tests for the Qdrant RAG client.
 * Mocks the Qdrant HTTP API and Ollama embeddings so we test the client
 * logic without needing live services.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@hermes/logger', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Qdrant client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('embedText', () => {
    it('calls Ollama embeddings API with correct model', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: new Array(768).fill(0.01) }),
      });

      const { embedText } = await import('../qdrant.js');
      const vector = await embedText('Bitcoin on-chain update');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/embeddings');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('nomic-embed-text');
      expect(body.prompt).toBe('Bitcoin on-chain update');
      expect(vector).toHaveLength(768);
    });

    it('returns zero vector on error', async () => {
      fetchMock.mockRejectedValue(new Error('Ollama down'));

      const { embedText } = await import('../qdrant.js');
      const vector = await embedText('test');

      expect(vector).toHaveLength(768);
      expect(vector.every((v: number) => v === 0)).toBe(true);
    });
  });

  describe('upsert', () => {
    it('calls Qdrant PUT with correct payload', async () => {
      // Embed mock
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: new Array(768).fill(0.05) }),
      });
      // Upsert mock
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed' }),
      });

      const { upsert } = await import('../qdrant.js');
      await upsert('journal_events', 'mem:BTC-USD:2026-04-20', {
        text: 'BTC had a strong week',
        pnl: 120.5,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [_embedUrl, embedInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(_embedUrl).toContain('/api/embeddings');

      const [upsertUrl, upsertInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(upsertUrl).toContain('/collections/journal_events/points');
      expect(upsertInit.method).toBe('PUT');

      const body = JSON.parse(upsertInit.body as string) as { points: Array<{ id: string; payload: { pnl: number } }> };
      expect(body.points).toHaveLength(1);
      const pt = body.points[0]!;
      expect(pt.id).toBe('mem:BTC-USD:2026-04-20');
      expect(pt.payload.pnl).toBe(120.5);
    });

    it('does not throw on Qdrant error', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: new Array(768).fill(0) }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'internal error',
      });

      const { upsert } = await import('../qdrant.js');
      await expect(
        upsert('news', 'id1', { text: 'test' }),
      ).resolves.not.toThrow();
    });
  });

  describe('search', () => {
    it('calls Qdrant search endpoint and returns results', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: new Array(768).fill(0.1) }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [
            {
              id:      'mem:BTC-USD:2026-04-20',
              score:   0.92,
              payload: { text: 'BTC weekly summary', pnl: 450 },
            },
            {
              id:      'mem:ETH-USD:2026-04-20',
              score:   0.78,
              payload: { text: 'ETH analysis', pnl: 120 },
            },
          ],
        }),
      });

      const { search } = await import('../qdrant.js');
      const results = await search('journal_events', 'BTC momentum', 5);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('mem:BTC-USD:2026-04-20');
      expect(results[0].score).toBe(0.92);
      expect(results[0].payload.pnl).toBe(450);
      expect(results[1].id).toBe('mem:ETH-USD:2026-04-20');

      const [_embedUrl, embedInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const [searchUrl, searchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(searchUrl).toContain('/collections/journal_events/points/search');
      expect(searchInit.method).toBe('POST');
      const body = JSON.parse(searchInit.body as string);
      expect(body.limit).toBe(5);
      expect(body.with_payload).toBe(true);
    });

    it('returns empty array on Qdrant error', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: new Array(768).fill(0) }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'server error',
      });

      const { search } = await import('../qdrant.js');
      const results = await search('onchain_signals', 'BTC flow', 3);
      expect(results).toHaveLength(0);
    });
  });

  describe('ensureCollection', () => {
    it('skips creation if collection already exists (200)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ready' }),
      });

      const { ensureCollection } = await import('../qdrant.js');
      await ensureCollection('journal_events');

      // Should only call GET, not PUT
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/collections/journal_events');
      expect(init.method).toBe('GET');
    });

    it('creates collection on 404', async () => {
      // First call: GET → 404
      fetchMock.mockResolvedValueOnce({
        ok:    false,
        status: 404,
        text: async () => 'not found',
      });
      // Second call: PUT → 200
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { uid: 1 } }),
      });

      const { ensureCollection } = await import('../qdrant.js');
      await ensureCollection('news');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [_getUrl, getInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const [putUrl, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(getInit.method).toBe('GET');
      expect(putUrl).toContain('/collections/news');
      expect(putInit.method).toBe('PUT');
      const body = JSON.parse(putInit.body as string);
      expect(body.vectors.size).toBe(768);
      expect(body.vectors.distance).toBe('Cosine');
    });
  });
});
