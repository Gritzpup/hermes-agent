/**
 * Tests for finrl-shadow.ts
 * - mock Redis, assert shadow log writes with correct TTL
 * - isShadowEnabled returns correct value from HERMES_FINRL_SHADOW env
 * - getRecentShadowDecisions returns sorted decisions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Redis mock ────────────────────────────────────────────────────────────────

const _storedData = new Map<string, string>();
const _ttlData = new Map<string, number>();

const mockRedis = {
  setex: vi.fn(async (key: string, ttlSecs: number, value: string) => {
    _storedData.set(key, value);
    _ttlData.set(key, ttlSecs);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => {
    return _storedData.get(key) ?? null;
  }),
  scan: vi.fn(async (cursor: string, ...args: string[]) => {
    const pattern = args[1];
    const allKeys = Array.from(_storedData.keys()).filter((k) => {
      if (pattern === '*') return true;
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return re.test(k);
    });
    return ['0', allKeys] as [string, string[]];
  }),
  setexWithTTL: (key: string, ttlSecs: number, value: string) => {
    _storedData.set(key, value);
    _ttlData.set(key, ttlSecs);
    return Promise.resolve('OK');
  },
};

vi.mock('@hermes/infra', () => ({
  redis: mockRedis,
}));

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('isShadowEnabled', () => {
  it('returns false when HERMES_FINRL_SHADOW is not set', async () => {
    const original = process.env.HERMES_FINRL_SHADOW;
    delete process.env.HERMES_FINRL_SHADOW;
    const { isShadowEnabled } = await import('../finrl-shadow.js');
    expect(isShadowEnabled()).toBe(false);
    if (original !== undefined) process.env.HERMES_FINRL_SHADOW = original;
  });

  it('returns false when HERMES_FINRL_SHADOW=off', async () => {
    process.env.HERMES_FINRL_SHADOW = 'off';
    const { isShadowEnabled } = await import('../finrl-shadow.js');
    expect(isShadowEnabled()).toBe(false);
    process.env.HERMES_FINRL_SHADOW = 'off';
  });

  it('returns true when HERMES_FINRL_SHADOW=on', async () => {
    process.env.HERMES_FINRL_SHADOW = 'on';
    const { isShadowEnabled } = await import('../finrl-shadow.js');
    expect(isShadowEnabled()).toBe(true);
    process.env.HERMES_FINRL_SHADOW = 'off';
  });
});

describe('recordShadowDecision', () => {
  beforeEach(() => {
    _storedData.clear();
    _ttlData.clear();
    vi.clearAllMocks();
    process.env.HERMES_FINRL_SHADOW = 'on';
  });

  afterEach(() => {
    process.env.HERMES_FINRL_SHADOW = 'off';
    vi.restoreAllMocks();
  });

  it('writes to Redis with key prefix hermes:finrl:shadow:', async () => {
    const { recordShadowDecision } = await import('../finrl-shadow.js');
    await recordShadowDecision({
      symbol: 'BTC-USD',
      recommendedEdgeScore: 0.72,
      ruleBasedAction: 'market_buy',
      price: 100.0,
      bookImb: 0.2,
      position: 0,
      cash: 10000,
      shadowEnabled: true,
      finrlServerUp: true,
    });

    expect(mockRedis.setex).toHaveBeenCalledTimes(1);
    const [key] = mockRedis.setex.mock.calls[0]!;
    expect(key).toMatch(/^hermes:finrl:shadow:/);
  });

  it('writes with TTL of 14 days in seconds', async () => {
    const { recordShadowDecision } = await import('../finrl-shadow.js');
    await recordShadowDecision({
      symbol: 'ETH-USD',
      recommendedEdgeScore: null,
      ruleBasedAction: 'hold',
      price: 50.0,
      bookImb: 0.0,
      position: 1,
      cash: 5000,
      shadowEnabled: true,
      finrlServerUp: false,
    });

    const [, ttl] = mockRedis.setex.mock.calls[0]!;
    expect(ttl).toBe(14 * 24 * 60 * 60);
  });

  it('stores a JSON record with all required fields', async () => {
    const { recordShadowDecision } = await import('../finrl-shadow.js');
    await recordShadowDecision({
      symbol: 'SOL-USD',
      recommendedEdgeScore: 0.88,
      ruleBasedAction: 'limit_post',
      price: 25.0,
      bookImb: -0.1,
      position: 2,
      cash: 2500,
      shadowEnabled: true,
      finrlServerUp: true,
    });

    const [, , rawValue] = mockRedis.setex.mock.calls[0]!;
    const record = JSON.parse(rawValue);
    expect(record.symbol).toBe('SOL-USD');
    expect(record.recommendedEdgeScore).toBe(0.88);
    expect(record.ruleBasedAction).toBe('limit_post');
    expect(record.price).toBe(25.0);
    expect(record.bookImb).toBe(-0.1);
    expect(record.position).toBe(2);
    expect(record.cash).toBe(2500);
    expect(record.shadowEnabled).toBe(true);
    expect(record.finrlServerUp).toBe(true);
    expect(record.id).toBeDefined();
    expect(record.ts).toBeDefined();
    expect(typeof record.id).toBe('string');
    expect(typeof record.ts).toBe('number');
  });

  it('no-ops when HERMES_FINRL_SHADOW is not on', async () => {
    process.env.HERMES_FINRL_SHADOW = 'off';
    const { recordShadowDecision } = await import('../finrl-shadow.js');
    await recordShadowDecision({
      symbol: 'DOGE-USD',
      recommendedEdgeScore: 0.5,
      ruleBasedAction: 'hold',
      price: 1.0,
      bookImb: 0.0,
      position: 0,
      cash: 1000,
      shadowEnabled: false,
      finrlServerUp: false,
    });

    expect(mockRedis.setex).not.toHaveBeenCalled();
  });

  it('generates a valid 26-char ULID', async () => {
    const { recordShadowDecision } = await import('../finrl-shadow.js');
    await recordShadowDecision({
      symbol: 'XRP-USD',
      recommendedEdgeScore: 0.65,
      ruleBasedAction: 'market_sell',
      price: 10.0,
      bookImb: 0.5,
      position: 5,
      cash: 5000,
      shadowEnabled: true,
      finrlServerUp: true,
    });

    const [, , rawValue] = mockRedis.setex.mock.calls[0]!;
    const record = JSON.parse(rawValue);
    // ULID is 26 chars: 10 timestamp + 16 random
    expect(record.id).toHaveLength(26);
    // ULID uses Crockford Base32 chars
    expect(record.id).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });
});

describe('getRecentShadowDecisions', () => {
  beforeEach(() => {
    _storedData.clear();
    _ttlData.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array when no keys match', async () => {
    mockRedis.scan.mockResolvedValueOnce(['0', []]);
    const { getRecentShadowDecisions } = await import('../finrl-shadow.js');
    const results = await getRecentShadowDecisions('BTC-USD');
    expect(results).toEqual([]);
  });

  it('returns sorted decisions by ts ascending', async () => {
    const now = Date.now();
    const entry1 = JSON.stringify({
      symbol: 'BTC-USD', ts: now - 1000, id: 'old',
      recommendedEdgeScore: 0.5, ruleBasedAction: 'hold',
      price: 100, bookImb: 0, position: 0, cash: 10000,
      shadowEnabled: true, finrlServerUp: true,
    });
    const entry2 = JSON.stringify({
      symbol: 'BTC-USD', ts: now, id: 'new',
      recommendedEdgeScore: 0.8, ruleBasedAction: 'market_buy',
      price: 101, bookImb: 0.1, position: 0, cash: 10000,
      shadowEnabled: true, finrlServerUp: true,
    });
    mockRedis.scan.mockResolvedValueOnce(['0', ['k1', 'k2']]);
    mockRedis.get.mockResolvedValueOnce(entry1).mockResolvedValueOnce(entry2);

    const { getRecentShadowDecisions } = await import('../finrl-shadow.js');
    const results = await getRecentShadowDecisions('BTC-USD');

    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('old');
    expect(results[1]!.id).toBe('new');
    expect(results[0]!.ts).toBeLessThan(results[1]!.ts);
  });

  it('filters by symbol', async () => {
    const btcEntry = JSON.stringify({
      symbol: 'BTC-USD', ts: Date.now(), id: 'btc',
      recommendedEdgeScore: 0.5, ruleBasedAction: 'hold',
      price: 100, bookImb: 0, position: 0, cash: 10000,
      shadowEnabled: true, finrlServerUp: true,
    });
    const ethEntry = JSON.stringify({
      symbol: 'ETH-USD', ts: Date.now(), id: 'eth',
      recommendedEdgeScore: 0.6, ruleBasedAction: 'buy',
      price: 50, bookImb: 0, position: 0, cash: 5000,
      shadowEnabled: true, finrlServerUp: true,
    });
    mockRedis.scan.mockResolvedValueOnce(['0', ['k1', 'k2']]);
    mockRedis.get.mockResolvedValueOnce(btcEntry).mockResolvedValueOnce(ethEntry);

    const { getRecentShadowDecisions } = await import('../finrl-shadow.js');
    const results = await getRecentShadowDecisions('BTC-USD');

    expect(results).toHaveLength(1);
    expect(results[0]!.symbol).toBe('BTC-USD');
  });
});
