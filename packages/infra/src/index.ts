import { Redis } from 'ioredis';
import pg from 'pg';

// ── Redis singleton ──────────────────────────────────────────────────────────
let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/hermes/infra';
    _redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableReadyCheck: true,
    });
    _redis.on('error', (err) => console.error('[infra][redis] error', err));
    _redis.on('reconnecting', () => console.warn('[infra][redis] reconnecting'));
  }
  return _redis;
}

// Named export — preferred (import { redis } from '@hermes/infra')
export const redis = getRedis();

// Default export for consumers that do import redis from '@hermes/infra'
export default getRedis();

// ── PostgreSQL pool ───────────────────────────────────────────────────────────
let _pool: pg.Pool | null = null;
export function db(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5433),
      user: process.env.DB_USER ?? 'hermes',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_NAME ?? 'hermes_trading_firm',
      max: Number(process.env.DB_POOL_MAX ?? 10),
    });
    _pool.on('error', (err) => console.error('[infra][pg] unexpected error', err));
  }
  return _pool;
}

export const TOPICS = {
  MARKET_TICK: 'hermes:market:tick',
  ORDER_REQUEST: 'hermes:order:request',
  ORDER_STATUS: 'hermes:order:status',
  RISK_SIGNAL: 'hermes:risk:signal',
  WHALE_TRANSFER: 'hermes:onchain:whale',
  REGIME_UPDATE: 'hermes:strategy:regime',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];
