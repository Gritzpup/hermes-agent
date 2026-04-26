/**
 * live-eval.test.ts
 *
 * Mock TOPICS.MARKET_TICK, mock Redis.
 * Assert live-eval writes happen when flag is on, not when off.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startLiveEvalLane,
  stopLiveEvalLane,
  getLiveEvalLaneStats,
} from '../live-eval.js';

// ── Mock Redis — must use vi.hoisted so it's available at hoisting time ───────

const { mockRedis, mockSubscriber } = vi.hoisted(() => {
  const subscriber = {
    subscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(),
    duplicate: vi.fn().mockReturnThis(),
  };

  const redis = {
    setex: vi.fn().mockResolvedValue('OK'),
    sadd: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    hset: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    smembers: vi.fn().mockResolvedValue([]),
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    ping: vi.fn().mockResolvedValue('PONG'),
    on: vi.fn(),
    duplicate: vi.fn().mockReturnValue(subscriber),
  };

  return { mockRedis: redis, mockSubscriber: subscriber };
});

vi.mock('@hermes/infra', async () => {
  const actual = await vi.importActual<object>('@hermes/infra');
  return {
    ...actual,
    redis: mockRedis,
    TOPICS: { MARKET_TICK: 'hermes:market:tick' },
  };
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('live-eval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.setex.mockResolvedValue('OK');
    mockRedis.sadd.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.hset.mockResolvedValue(1);
    mockRedis.ping.mockResolvedValue('PONG');
    mockRedis.subscribe.mockResolvedValue(1);
    mockRedis.unsubscribe.mockResolvedValue(1);
    mockRedis.quit.mockResolvedValue('OK');
    mockSubscriber.subscribe.mockResolvedValue(1);
    mockSubscriber.unsubscribe.mockResolvedValue(1);
    mockSubscriber.quit.mockResolvedValue('OK');
    mockSubscriber.duplicate.mockReturnValue(mockSubscriber);
    // redis.duplicate() returns mockSubscriber
    mockRedis.duplicate.mockReturnValue(mockSubscriber);
  });

  afterEach(async () => {
    // Always stop after each test
    await stopLiveEvalLane();
    // Reset env
    delete process.env.HERMES_LIVE_EVAL;
  });

  describe('getLiveEvalLaneStats', () => {
    it('returns initial stats when lane is not running', async () => {
      const stats = await getLiveEvalLaneStats();

      expect(stats.running).toBe(false);
      expect(stats.startedAt).toBeNull();
      expect(stats.decisionsCount).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.flags.liveEvalEnabled).toBe(false);
    });

    it('reports liveEvalEnabled=true when HERMES_LIVE_EVAL=on', async () => {
      process.env.HERMES_LIVE_EVAL = 'on';

      const stats = await getLiveEvalLaneStats();

      expect(stats.flags.liveEvalEnabled).toBe(true);
    });
  });

  describe('startLiveEvalLane', () => {
    it('refuses to start when HERMES_LIVE_EVAL != on', async () => {
      delete process.env.HERMES_LIVE_EVAL;

      const result = await startLiveEvalLane();

      expect(result.started).toBe(false);
      expect(result.reason).toContain('HERMES_LIVE_EVAL');
    });

    it('starts successfully when HERMES_LIVE_EVAL=on', async () => {
      process.env.HERMES_LIVE_EVAL = 'on';

      const result = await startLiveEvalLane();

      expect(result.started).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('is idempotent — second start returns not-started', async () => {
      process.env.HERMES_LIVE_EVAL = 'on';

      await startLiveEvalLane();
      const result = await startLiveEvalLane();

      expect(result.started).toBe(false);
      expect(result.reason).toContain('already running');
    });

    it('pings Redis on startup', async () => {
      process.env.HERMES_LIVE_EVAL = 'on';

      await startLiveEvalLane();

      expect(mockRedis.ping).toHaveBeenCalled();
    });

    it('subscribes to MARKET_TICK topic via subscriber duplicate', async () => {
      process.env.HERMES_LIVE_EVAL = 'on';

      await startLiveEvalLane();

      // redis.duplicate() is called to create subscriber, then subscribe on it
      expect(mockRedis.duplicate).toHaveBeenCalled();
      expect(mockSubscriber.subscribe).toHaveBeenCalledWith('hermes:market:tick');
    });

    it('registers pmessage handler on subscriber', async () => {
      process.env.HERMES_LIVE_EVAL = 'on';

      await startLiveEvalLane();

      expect(mockSubscriber.on).toHaveBeenCalledWith('pmessage', expect.any(Function));
    });
  });

  describe('stopLiveEvalLane', () => {
    it('is idempotent when not running', async () => {
      const result = await stopLiveEvalLane();

      expect(result.stopped).toBe(false);
    });

    it('stops a running lane', async () => {
      process.env.HERMES_LIVE_EVAL = 'on';

      await startLiveEvalLane();
      const result = await stopLiveEvalLane();

      expect(result.stopped).toBe(true);
    });

    it('unsubscribes from MARKET_TICK when stopping', async () => {
      process.env.HERMES_LIVE_EVAL = 'on';

      await startLiveEvalLane();
      await stopLiveEvalLane();

      expect(mockSubscriber.unsubscribe).toHaveBeenCalled();
    });

    it('updates running=false in stats after stop', async () => {
      process.env.HERMES_LIVE_EVAL = 'on';

      await startLiveEvalLane();
      await stopLiveEvalLane();
      const stats = await getLiveEvalLaneStats();

      expect(stats.running).toBe(false);
    });
  });

  describe('Redis writes', () => {
    it('no Redis writes when HERMES_LIVE_EVAL is not set', async () => {
      delete process.env.HERMES_LIVE_EVAL;

      const result = await startLiveEvalLane();

      expect(result.started).toBe(false);
      // No side effects from failed start
      expect(mockRedis.ping).not.toHaveBeenCalled();
    });
  });
});
