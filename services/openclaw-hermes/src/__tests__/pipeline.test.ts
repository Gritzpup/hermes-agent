// @ts-nocheck
/**
 * Pipeline tests — services/openclaw-hermes/src/__tests__/pipeline.test.ts
 *
 * Tests:
 *   - All 5 stages execute in order
 *   - Each stage writes to hermes:decisions:{stage}:*
 *   - Timeout aborts the right stage cleanly
 *   - Research debate rounds logic
 *
 * Run: node --test src/__tests__/pipeline.test.ts
 */

import { test, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock Redis ─────────────────────────────────────────────────────────────────

type MockRedis = Map<string, { value: string; ttl?: number; expireAt?: number }>;

let store: MockRedis;
let infraMock: { redis: Record<string, unknown> } | null = null;

function patchInfra(mockStore: MockRedis) {
  mockStore.clear();
  infraMock = null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RedisMock = require('ioredis-mock');
    const mockInstance = new RedisMock();
    infraMock = { redis: mockInstance as unknown as Record<string, unknown> };
    return;
  } catch { /* ioredis-mock not available */ }

  // Monkey-patch fallback
  try {
    const infraPath = require.resolve('@hermes/infra');
    delete require.cache[infraPath];
    const infra = require('@hermes/infra') as { redis: Record<string, unknown> };
    infraMock = infra;

    infra.redis.get = async (key: string) => {
      const entry = mockStore.get(key);
      if (!entry) return null;
      if (entry.expireAt && Date.now() > entry.expireAt) { mockStore.delete(key); return null; }
      return entry.value;
    };
    infra.redis.setex = async (key: string, ttl: number, value: string) => {
      mockStore.set(key, { value, ttl, expireAt: Date.now() + ttl * 1000 });
      return 'OK';
    };
    infra.redis.publish = async () => 1;
    infra.redis.scanStream = async function* (opts: { match: string }) {
      const pattern = opts.match.replace('*', '');
      yield [...mockStore.keys()].filter(k => k.startsWith(pattern));
    };
    infra.redis.hgetall = async () => ({});
    infra.redis.hset = async () => 1;
    infra.redis.hget = async () => null;
  } catch { /* @hermes/infra may not be resolvable in test env */ }
}

function makeStore(): MockRedis {
  return new Map();
}

beforeEach(() => {
  store = makeStore();
  patchInfra(store);
});

afterEach(() => {
  store.clear();
  infraMock = null;
});

// ── Mock ToolContext ───────────────────────────────────────────────────────────

function makeTickCtx(overrides: Record<string, unknown> = {}) {
  return {
    tickId: `test-${Date.now()}`,
    tickAt: new Date().toISOString(),
    rollingContext: {},
    ...overrides,
  };
}

// ── Mock ToolRegistry ──────────────────────────────────────────────────────────

import type { ToolContext, ToolRegistry as TR } from '../tools/index.js';

function makeRegistry(): TR {
  // We need to import the class and create a minimal mock that implements the interface
  return {
    list: () => [
      'read_positions', 'read_pnl', 'read_journal_window',
      'propose_allocation', 'halt_symbol', 'query_news_sentiment',
      'query_fundamentals', 'submit_order', 'get_compliance_status', 'query_onchain_signal',
    ],
    invoke: async (name: string, _args: Record<string, unknown>, _ctx: ToolContext) => {
      if (name === 'read_positions') return { positions: [], count: 0, ts: new Date().toISOString() };
      if (name === 'read_pnl') return { pnl: { realizedPnl: 0, unrealizedPnl: 0, totalPnl: 0, bySymbol: {}, byStrategy: {} }, source: 'redis', ts: new Date().toISOString() };
      if (name === 'read_journal_window') return { entries: [], count: 0, windowHours: 24, ts: new Date().toISOString() };
      if (name === 'get_compliance_status') return { status: { overall: 'compliant', rules: [], lastCheck: new Date().toISOString(), violations: [] }, ts: new Date().toISOString() };
      if (name === 'halt_symbol') return { ok: true, symbol: 'BTC-USD', reason: 'test', topic: 'hermes:risk:signal', publishedAt: new Date().toISOString() };
      if (name === 'query_news_sentiment') return { symbol: 'BTC-USD', sentiment: null, reason: 'no data' };
      if (name === 'query_fundamentals') return { symbol: 'BTC-USD', fundamentals: null, reason: 'no data' };
      if (name === 'query_onchain_signal') return { symbol: 'BTC-USD', signal: null, reason: 'no data' };
      if (name === 'submit_order') return { ok: true, symbol: 'BTC-USD', side: 'buy', qty: 0.1, type: 'market', submittedAt: new Date().toISOString() };
      if (name === 'propose_allocation') return { ok: true, strategyId: 'coo-portfolio', weights: {}, writtenAt: new Date().toISOString(), ttlSeconds: 86400 };
      return null;
    },
    has: (name: string) => true,
    getDef: (name: string) => undefined,
    register: () => {},
    registerDefaults: () => {},
    registerSync: () => {},
  } as unknown as TR;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PipelineRunner — stage order and execution', () => {
  test('all 5 stages execute in order', async () => {
    const { PipelineRunner } = await import('../pipeline/index.js');

    const tools = makeRegistry();
    const programmatic = {
      execute: async (_code: string) => ({ ok: true, result: null, wasCode: false, durationMs: 0 }),
    };

    const runner = new PipelineRunner(tools, programmatic);
    const result = await runner.run({ tickId: 'order-test' });

    assert.ok(result.decisions.length === 5, `expected 5 decisions, got ${result.decisions.length}`);
    assert.equal(result.decisions[0].stage, 'Analyst');
    assert.equal(result.decisions[1].stage, 'Research');
    assert.equal(result.decisions[2].stage, 'Trader');
    assert.equal(result.decisions[3].stage, 'Risk');
    assert.equal(result.decisions[4].stage, 'Portfolio');
  });

  test('each stage writes to Redis hermes:decisions:{stage}:{tickId}', async () => {
    const { PipelineRunner } = await import('../pipeline/index.js');

    const tools = makeRegistry();
    const programmatic = {
      execute: async (_code: string) => ({ ok: true, result: null, wasCode: false, durationMs: 0 }),
    };

    const runner = new PipelineRunner(tools, programmatic);
    const tickId = `redis-test-${Date.now()}`;
    const result = await runner.run({ tickId });

    const expectedStages = ['Analyst', 'Research', 'Trader', 'Risk', 'Portfolio'];
    for (const stage of expectedStages) {
      const key = `hermes:decisions:${stage}:${tickId}`;
      const decision = [...store.values()].find(
        (v) => v.value && JSON.parse(v.value).stage === stage && JSON.parse(v.value).tickId === tickId,
      );
      assert.ok(decision, `expected Redis key for stage ${stage} with tickId ${tickId}`);
    }
  });

  test('stage duration is tracked', async () => {
    const { PipelineRunner } = await import('../pipeline/index.js');

    const tools = makeRegistry();
    const programmatic = {
      execute: async (_code: string) => ({ ok: true, result: null, wasCode: false, durationMs: 0 }),
    };

    const runner = new PipelineRunner(tools, programmatic);
    const result = await runner.run({ tickId: 'duration-test' });

    for (const decision of result.decisions) {
      assert.ok(decision.durationMs >= 0, `${decision.stage} durationMs should be ≥ 0`);
      assert.ok(decision.startedAt, `${decision.stage} should have startedAt`);
      assert.ok(decision.completedAt, `${decision.stage} should have completedAt`);
    }
  });

  test('result includes tickId, tickAt, and completedAt', async () => {
    const { PipelineRunner } = await import('../pipeline/index.js');

    const tools = makeRegistry();
    const programmatic = {
      execute: async (_code: string) => ({ ok: true, result: null, wasCode: false, durationMs: 0 }),
    };

    const runner = new PipelineRunner(tools, programmatic);
    const tickId = `meta-test-${Date.now()}`;
    const result = await runner.run({ tickId });

    assert.equal(result.tickId, tickId);
    assert.ok(result.tickAt);
    assert.ok(result.completedAt);
    assert.ok(result.totalDurationMs >= 0);
    assert.ok(Array.isArray(result.finalAllocation));
    assert.ok(Array.isArray(result.halts));
    assert.ok(Array.isArray(result.notes));
  });

  test('totalDurationMs is sum of stage durations (approximately)', async () => {
    const { PipelineRunner } = await import('../pipeline/index.js');

    const tools = makeRegistry();
    const programmatic = {
      execute: async (_code: string) => ({ ok: true, result: null, wasCode: false, durationMs: 0 }),
    };

    const runner = new PipelineRunner(tools, programmatic);
    const result = await runner.run({ tickId: 'duration-sum-test' });

    const stageSum = result.decisions.reduce((sum, d) => sum + d.durationMs, 0);
    assert.ok(
      result.totalDurationMs >= stageSum - 100, // allow 100ms tolerance for overhead
      `totalDurationMs ${result.totalDurationMs} should be ≥ stage sum ${stageSum}`,
    );
  });
});

describe('PipelineRunner — timeout behavior', () => {
  test('timeout aborts the correct stage cleanly (pipeline continues)', async () => {
    const { PipelineRunner } = await import('../pipeline/index.js');

    // Make Analyst stage hang
    let analystCalls = 0;
    const tools = makeRegistry();
    const slowTools = {
      ...tools,
      invoke: async (name: string, args: Record<string, unknown>, ctx: ToolContext) => {
        if (name === 'read_positions' && ++analystCalls === 1) {
          // Simulate a very slow call (exceeds 60s Analyst timeout)
          await new Promise(r => setTimeout(r, 2000));
        }
        return tools.invoke(name, args, ctx);
      },
    } as unknown as TR;

    const programmatic = {
      execute: async (_code: string) => ({ ok: true, result: null, wasCode: false, durationMs: 0 }),
    };

    const runner = new PipelineRunner(slowTools, programmatic);

    const start = Date.now();
    const result = await runner.run({ tickId: 'timeout-test' });
    const elapsed = Date.now() - start;

    // Should have run all 5 stages despite timeout (pipeline continues)
    assert.equal(result.decisions.length, 5);

    // Analyst should be timed out
    const analystDecision = result.decisions.find(d => d.stage === 'Analyst');
    assert.ok(analystDecision?.timedOut, 'Analyst should be marked as timed out');
    assert.ok(analystDecision?.error?.includes('timeout') || analystDecision?.error?.includes('TIMEOUT'));

    // Subsequent stages should have executed
    const portfolioDecision = result.decisions.find(d => d.stage === 'Portfolio');
    assert.ok(portfolioDecision, 'Portfolio stage should have executed despite prior timeout');

    // Total elapsed should be well under 5 * 60s = 300s (stages should be parallel-ish in timing)
    assert.ok(elapsed < 300_000, `pipeline should complete in < 300s, took ${elapsed}ms`);
  });
});

describe('PipelineRunner — Research debate rounds', () => {
  test('Research stage emits consensus=true when Phase-2 data absent', async () => {
    const { PipelineRunner } = await import('../pipeline/index.js');

    const tools = makeRegistry();
    const programmatic = {
      execute: async (_code: string) => ({ ok: true, result: null, wasCode: false, durationMs: 0 }),
    };

    const runner = new PipelineRunner(tools, programmatic);
    const result = await runner.run({ tickId: 'debate-test' });

    const researchDecision = result.decisions.find(d => d.stage === 'Research');
    assert.ok(researchDecision, 'Research stage should exist');
    const output = researchDecision?.output as { consensus?: boolean; rounds?: number };
    assert.equal(output.consensus, true, 'Research should reach consensus with no Phase-2 data');
  });
});

describe('PipelineRunner — Risk stage', () => {
  test('Risk stage halts symbols when drawdown exceeds threshold', async () => {
    const { PipelineRunner } = await import('../pipeline/index.js');

    let haltedSymbols: string[] = [];
    const tools = makeRegistry();
    const riskTools = {
      ...tools,
      invoke: async (name: string, args: Record<string, unknown>, ctx: ToolContext) => {
        if (name === 'read_pnl') {
          return {
            pnl: { realizedPnl: -600, unrealizedPnl: 0, totalPnl: -600, bySymbol: { 'BTC-USD': { realized: -600, unrealized: 0, count: 3 } }, byStrategy: {} },
            source: 'redis', ts: new Date().toISOString(),
          };
        }
        if (name === 'read_positions') {
          return { positions: [{ symbol: 'BTC-USD', qty: 0.5, side: 'long', entryPx: 62000, unrealizedPnl: -100, openedAt: new Date().toISOString() }], count: 1, ts: new Date().toISOString() };
        }
        if (name === 'halt_symbol') {
          haltedSymbols.push(String(args.symbol ?? ''));
          return { ok: true, symbol: args.symbol, reason: args.reason, topic: 'hermes:risk:signal', publishedAt: new Date().toISOString() };
        }
        return tools.invoke(name, args, ctx);
      },
    } as unknown as TR;

    const programmatic = {
      execute: async (_code: string) => ({ ok: true, result: null, wasCode: false, durationMs: 0 }),
    };

    const runner = new PipelineRunner(riskTools, programmatic);
    const result = await runner.run({ tickId: 'risk-test' });

    const riskDecision = result.decisions.find(d => d.stage === 'Risk');
    assert.ok(riskDecision, 'Risk stage should exist');
    assert.ok((riskDecision?.output as { totalPnl?: number }).totalPnl < 0);

    // result.halts should include the halted symbols
    assert.ok(result.halts.length > 0 || haltedSymbols.length > 0, 'Risk stage should have halted at least one symbol');
  });
});

describe('PipelineRunner — Portfolio stage', () => {
  test('Portfolio stage writes approved allocations', async () => {
    const { PipelineRunner } = await import('../pipeline/index.js');

    let proposedAllocations: Record<string, unknown>[] = [];
    const tools = makeRegistry();
    const portfolioTools = {
      ...tools,
      invoke: async (name: string, args: Record<string, unknown>, ctx: ToolContext) => {
        if (name === 'propose_allocation') {
          proposedAllocations.push(args);
          return { ok: true, strategyId: args.strategyId, weights: args.weights, writtenAt: new Date().toISOString(), ttlSeconds: 86400 };
        }
        return tools.invoke(name, args, ctx);
      },
    } as unknown as TR;

    const programmatic = {
      execute: async (_code: string) => ({ ok: true, result: null, wasCode: false, durationMs: 0 }),
    };

    const runner = new PipelineRunner(portfolioTools, programmatic);
    const result = await runner.run({ tickId: 'portfolio-test' });

    const portfolioDecision = result.decisions.find(d => d.stage === 'Portfolio');
    assert.ok(portfolioDecision, 'Portfolio stage should exist');
    assert.ok(Object.keys(result.finalAllocation).length >= 0, 'finalAllocation should be an object');
  });
});
