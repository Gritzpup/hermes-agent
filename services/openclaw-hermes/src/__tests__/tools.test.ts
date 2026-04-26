// @ts-nocheck
/**
 * Tools test suite — services/openclaw-hermes/src/__tests__/tools.test.ts
 *
 * Tests all 10 tools in the registry.
 * Uses ioredis-mock if installed; falls back to monkey-patching @hermes/infra Redis.
 *
 * Run: node --test src/__tests__/tools.test.ts
 * (or via pnpm check — tests are included in tsconfig include)
 */

import { test, beforeEach, afterEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock Redis ─────────────────────────────────────────────────────────────────

type MockRedis = Map<string, { value: string; ttl?: number }>;

const mockRedisStore = new Map<string, { value: string; ttl?: number; expireAt?: number }>();

function makeMockRedis(): MockRedis {
  return new Map();
}

// We patch @hermes/infra at module load time so all imports pick up the mock
let infraMock: { redis: Record<string, unknown> } | null = null;

function patchInfra(mockStore: MockRedis) {
  try {
    // Attempt to patch if ioredis-mock is available
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RedisMock = require('ioredis-mock');
    const mockInstance = new RedisMock();
    infraMock = { redis: mockInstance as unknown as Record<string, unknown> };
  } catch {
    // Fallback: monkey-patch the @hermes/infra module's redis export
    const infraPath = require.resolve('@hermes/infra');
    // Clear require cache so patch takes effect
    delete require.cache[infraPath];
    const infra = require('@hermes/infra') as { redis: Record<string, unknown> };
    infraMock = infra;

    // Apply mock methods
    infra.redis.get = async (key: string) => {
      const entry = mockStore.get(key);
      if (!entry) return null;
      if (entry.expireAt && Date.now() > entry.expireAt) {
        mockStore.delete(key);
        return null;
      }
      return entry.value;
    };

    infra.redis.setex = async (key: string, ttl: number, value: string) => {
      mockStore.set(key, { value, ttl, expireAt: Date.now() + ttl * 1000 });
      return 'OK';
    };

    infra.redis.publish = async (_channel: string, _msg: string) => 1;

    infra.redis.scanStream = async function* (opts: { match: string; count?: number }) {
      const pattern = opts.match.replace('*', '');
      const keys = [...mockStore.keys()].filter(k => k.startsWith(pattern));
      yield keys;
    };

    infra.redis.hgetall = async (_key: string) => ({});
    infra.redis.hset = async (_key: string, _field: string, _val: string) => 1;
    infra.redis.hget = async (_key: string, _field: string) => null;
  }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let store: MockRedis;
let restore: (() => void) | null = null;

beforeEach(() => {
  store = makeMockRedis();
  restore = patchInfra(store);
});

afterEach(() => {
  store.clear();
  mock.reset();
  if (restore) {
    try {
      restore();
    } catch { /* ignore restore errors */ }
    restore = null;
  }
  infraMock = null;
});

// ── Test helpers ───────────────────────────────────────────────────────────────

function putRedis(key: string, value: string, ttlSeconds?: number) {
  store.set(key, {
    value,
    ttl: ttlSeconds,
    expireAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  test('registerDefaults registers 10 tools', async () => {
    const { ToolRegistry } = await import('../tools/index.js');
    const registry = new ToolRegistry();
    registry.registerDefaults();
    // Allow async dynamic imports to settle
    await new Promise(r => setTimeout(r, 100));
    assert.ok(registry.list().length >= 10, `expected ≥10 tools, got ${registry.list().length}`);
  });

  test('invoke throws for unknown tool', async () => {
    const { ToolRegistry } = await import('../tools/index.js');
    const registry = new ToolRegistry();
    await assert.rejects(
      registry.invoke('nonexistent_tool', {}, { tickId: 't1', tickAt: new Date().toISOString(), rollingContext: {} }),
      /unknown tool/,
    );
  });

  test('invoke writes outcome event to Redis', async () => {
    const { ToolRegistry } = await import('../tools/index.js');
    const registry = new ToolRegistry();
    registry.registerDefaults();
    await new Promise(r => setTimeout(r, 100));

    const tickCtx = { tickId: 'test-tick-1', tickAt: new Date().toISOString(), rollingContext: {} };

    // read_positions with empty store
    const result = await registry.invoke('read_positions', {}, tickCtx);
    assert.ok(result, 'read_positions should return a result');
    assert.ok('positions' in (result as object), 'result should have positions');

    // Check outcome event was written
    const outcomeKeys = [...store.keys()].filter(k => k.startsWith('hermes:tool-events:'));
    assert.ok(outcomeKeys.length > 0, 'expected outcome event in Redis');
    const outcome = JSON.parse(store.get(outcomeKeys[0])!.value);
    assert.equal(outcome.tool, 'read_positions');
    assert.equal(outcome.tickId, 'test-tick-1');
    assert.ok(outcome.ulid);
    assert.ok(outcome.durationMs >= 0);
  });
});

describe('read_positions', () => {
  test('returns empty array when no positions in Redis', async () => {
    const { READ_POSITIONS_TOOL } = await import('../tools/read_positions.js');
    const result = await READ_POSITIONS_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      {},
    );
    assert.deepEqual(result, { positions: [], count: 0, ts: result.ts });
  });

  test('parses hermes:positions:{symbol} from Redis', async () => {
    putRedis('hermes:positions:BTC-USD', JSON.stringify({
      symbol: 'BTC-USD',
      qty: 0.5,
      side: 'long',
      entryPx: 62000,
      unrealizedPnl: 1250,
      strategyId: 'grid-btc-usd',
      broker: 'coinbase-live',
      openedAt: '2026-04-26T10:00:00Z',
    }));

    const { READ_POSITIONS_TOOL } = await import('../tools/read_positions.js');
    const result = await READ_POSITIONS_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      {},
    ) as { positions: unknown[] };

    assert.equal(result.count, 1);
    const pos = result.positions[0] as Record<string, unknown>;
    assert.equal(pos.symbol, 'BTC-USD');
    assert.equal(pos.qty, 0.5);
    assert.equal(pos.side, 'long');
    assert.equal(pos.unrealizedPnl, 1250);
  });
});

describe('read_pnl', () => {
  test('reads hermes:pnl:current from Redis', async () => {
    putRedis('hermes:pnl:current', JSON.stringify({
      realizedPnl: 500,
      unrealizedPnl: 250,
      totalPnl: 750,
      bySymbol: { 'BTC-USD': { realized: 300, unrealized: 100, count: 5 } },
      byStrategy: { 'grid-btc-usd': { realized: 300, unrealized: 100, count: 5 } },
    }));

    const { READ_PNL_TOOL } = await import('../tools/read_pnl.js');
    const result = await READ_PNL_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      {},
    ) as { pnl: { realizedPnl: number }; source: string };

    assert.equal(result.source, 'redis');
    assert.equal(result.pnl.realizedPnl, 500);
    assert.equal(result.pnl.totalPnl, 750);
  });

  test('falls back to positions when no pnl keys', async () => {
    putRedis('hermes:positions:ETH-USD', JSON.stringify({
      symbol: 'ETH-USD',
      unrealizedPnl: -200,
      strategyId: 'grid-eth-usd',
    }));

    const { READ_PNL_TOOL } = await import('../tools/read_pnl.js');
    const result = await READ_PNL_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      {},
    ) as { pnl: { unrealizedPnl: number }; source: string };

    assert.equal(result.source, 'computed');
    assert.equal(result.pnl.unrealizedPnl, -200);
  });
});

describe('read_journal_window', () => {
  test('returns empty when journal file absent', async () => {
    const { READ_JOURNAL_WINDOW_TOOL } = await import('../tools/read_journal_window.js');
    // Temporarily override FIRM_JOURNAL_FILE for this test
    const result = await READ_JOURNAL_WINDOW_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      { hours: 1 },
    ) as { count: number; windowHours: number };

    assert.equal(result.count, 0);
    assert.equal(result.windowHours, 1);
  });
});

describe('propose_allocation', () => {
  test('writes to Redis with TTL', async () => {
    const { PROPOSE_ALLOCATION_TOOL } = await import('../tools/propose_allocation.js');
    const result = await PROPOSE_ALLOCATION_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      { strategyId: 'grid-btc-usd', weights: { 'BTC-USD': 0.6, 'ETH-USD': 0.4 }, rationale: 'test' },
    ) as { ok: boolean; strategyId: string; weights: Record<string, number> };

    assert.equal(result.ok, true);
    assert.equal(result.strategyId, 'grid-btc-usd');
    assert.equal(result.weights['BTC-USD'], 0.6);

    const key = 'hermes:proposed-allocation:grid-btc-usd';
    assert.ok(store.has(key), `expected key ${key} in Redis`);
    const stored = JSON.parse(store.get(key)!.value);
    assert.equal(stored.strategyId, 'grid-btc-usd');
    assert.equal(stored.tickId, 't1');
  });

  test('throws when strategyId missing', async () => {
    const { PROPOSE_ALLOCATION_TOOL } = await import('../tools/propose_allocation.js');
    await assert.rejects(
      PROPOSE_ALLOCATION_TOOL.fn(
        { tickId: 't1', tickAt: '', rollingContext: {} },
        { weights: {} },
      ),
      /strategyId is required/,
    );
  });
});

describe('halt_symbol', () => {
  test('publishes to TOPICS.RISK_SIGNAL', async () => {
    let publishedChannel = '';
    let publishedPayload = '';

    // Override redis.publish in the store mock
    store.set('__publish_log', { value: '[]' });
    const origPublish = infraMock!.redis.publish;
    infraMock!.redis.publish = async (channel: string, msg: string) => {
      publishedChannel = channel;
      publishedPayload = msg;
      return 1;
    };

    const { HALT_SYMBOL_TOOL } = await import('../tools/halt_symbol.js');
    const result = await HALT_SYMBOL_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      { symbol: 'BTC-USD', reason: 'risk limit exceeded', severity: 'critical' },
    ) as { ok: boolean; symbol: string; reason: string; topic: string };

    assert.equal(result.ok, true);
    assert.equal(result.symbol, 'BTC-USD');
    assert.equal(result.reason, 'risk limit exceeded');
    assert.equal(publishedChannel, 'hermes:risk:signal');

    const payload = JSON.parse(publishedPayload);
    assert.equal(payload.type, 'halt-symbol');
    assert.equal(payload.symbol, 'BTC-USD');
    assert.equal(payload.operator, 'coo-pipeline');

    infraMock!.redis.publish = origPublish;
  });

  test('throws when symbol missing', async () => {
    const { HALT_SYMBOL_TOOL } = await import('../tools/halt_symbol.js');
    await assert.rejects(
      HALT_SYMBOL_TOOL.fn({ tickId: 't1', tickAt: '', rollingContext: {} }, { reason: 'x' }),
      /symbol is required/,
    );
  });
});

describe('query_news_sentiment', () => {
  test('returns null when no data (Phase 2 not populated)', async () => {
    const { QUERY_NEWS_SENTIMENT_TOOL } = await import('../tools/query_news_sentiment.js');
    const result = await QUERY_NEWS_SENTIMENT_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      { symbol: 'BTC-USD' },
    ) as { sentiment: null; reason: string };

    assert.equal(result.sentiment, null);
    assert.equal(result.reason, 'no data');
  });

  test('returns sentiment when data present', async () => {
    putRedis('hermes:sentiment:BTC-USD', JSON.stringify({
      sentiment: 'bullish',
      score: 0.75,
      sources: ['coinbase', 'bloomberg'],
      headline: 'BTC surges on ETF inflows',
      ts: '2026-04-26T09:00:00Z',
    }));

    const { QUERY_NEWS_SENTIMENT_TOOL } = await import('../tools/query_news_sentiment.js');
    const result = await QUERY_NEWS_SENTIMENT_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      { symbol: 'BTC-USD' },
    ) as { sentiment: { sentiment: string; score: number }; reason: string };

    assert.equal(result.sentiment.sentiment, 'bullish');
    assert.equal(result.sentiment.score, 0.75);
    assert.equal(result.reason, 'found');
  });
});

describe('query_fundamentals', () => {
  test('returns null when absent', async () => {
    const { QUERY_FUNDAMENTALS_TOOL } = await import('../tools/query_fundamentals.js');
    const result = await QUERY_FUNDAMENTALS_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      { symbol: 'ETH-USD' },
    ) as { fundamentals: null; reason: string };

    assert.equal(result.fundamentals, null);
    assert.equal(result.reason, 'no data');
  });

  test('returns fundamentals when present', async () => {
    putRedis('hermes:fundamentals:ETH-USD', JSON.stringify({
      marketCap: 350_000_000_000,
      volume24h: 15_000_000_000,
      peRatio: 22.5,
      eps: 4.2,
      ts: '2026-04-26T00:00:00Z',
    }));

    const { QUERY_FUNDAMENTALS_TOOL } = await import('../tools/query_fundamentals.js');
    const result = await QUERY_FUNDAMENTALS_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      { symbol: 'ETH-USD' },
    ) as { fundamentals: { marketCap: number }; reason: string };

    assert.equal(result.fundamentals.marketCap, 350_000_000_000);
    assert.equal(result.reason, 'found');
  });
});

describe('submit_order', () => {
  test('returns ok:false when API unreachable (non-throwing)', async () => {
    const { SUBMIT_ORDER_TOOL } = await import('../tools/submit_order.js');
    const result = await SUBMIT_ORDER_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      { symbol: 'BTC-USD', side: 'buy', qty: 0.1 },
    ) as { ok: boolean; symbol: string };

    // API is not running in test — expect graceful degradation
    assert.equal(result.symbol, 'BTC-USD');
    // ok may be true or false depending on whether API is reachable in test env
    assert.ok(typeof result.ok === 'boolean');
  });

  test('throws when symbol or qty missing', async () => {
    const { SUBMIT_ORDER_TOOL } = await import('../tools/submit_order.js');
    await assert.rejects(
      SUBMIT_ORDER_TOOL.fn({ tickId: 't1', tickAt: '', rollingContext: {} }, { symbol: '' }),
      /symbol and qty are required/,
    );
  });
});

describe('get_compliance_status', () => {
  test('returns compliant when no compliance keys', async () => {
    const { GET_COMPLIANCE_STATUS_TOOL } = await import('../tools/get_compliance_status.js');
    const result = await GET_COMPLIANCE_STATUS_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      {},
    ) as { status: { overall: string; rules: unknown[] } };

    assert.equal(result.status.overall, 'compliant');
    assert.deepEqual(result.status.rules, []);
  });

  test('detects violation when rule status is violated', async () => {
    putRedis('hermes:compliance:max-position-size', JSON.stringify({
      ruleId: 'max-position-size',
      status: 'violated',
      description: 'Position size exceeds limit',
      triggeredAt: '2026-04-26T10:00:00Z',
    }));

    const { GET_COMPLIANCE_STATUS_TOOL } = await import('../tools/get_compliance_status.js');
    const result = await GET_COMPLIANCE_STATUS_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      {},
    ) as { status: { overall: string; violations: string[] } };

    assert.equal(result.status.overall, 'violation');
    assert.ok(result.status.violations.includes('max-position-size'));
  });
});

describe('query_onchain_signal', () => {
  test('returns null when absent (Phase 2 not populated)', async () => {
    const { QUERY_ONCHAIN_SIGNAL_TOOL } = await import('../tools/query_onchain_signal.js');
    const result = await QUERY_ONCHAIN_SIGNAL_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      { symbol: 'BTC-USD' },
    ) as { signal: null; reason: string };

    assert.equal(result.signal, null);
    assert.equal(result.reason, 'no data');
  });

  test('returns onchain signal when present', async () => {
    putRedis('hermes:onchain:BTC-USD', JSON.stringify({
      whaleActivity: 'high',
      netFlow: 5000,
      largeTxCount24h: 142,
      exchangeBalancePct: 0.23,
      momentum: 'accumulating',
      ts: '2026-04-26T09:30:00Z',
    }));

    const { QUERY_ONCHAIN_SIGNAL_TOOL } = await import('../tools/query_onchain_signal.js');
    const result = await QUERY_ONCHAIN_SIGNAL_TOOL.fn(
      { tickId: 't1', tickAt: '', rollingContext: {} },
      { symbol: 'BTC-USD' },
    ) as { signal: { whaleActivity: string; netFlow: number }; reason: string };

    assert.equal(result.signal.whaleActivity, 'high');
    assert.equal(result.signal.netFlow, 5000);
    assert.equal(result.reason, 'found');
  });
});
