import { Redis } from 'ioredis';
import pg from 'pg';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

export const redis = new Redis(redisUrl, {
  lazyConnect: false,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on('error', (err) => console.error('[infra] Redis error', err));
redis.on('reconnecting', () => console.warn('[infra] Redis reconnecting'));

export const TOPICS = {
  MARKET_TICK: 'hermes:market:tick',
  ORDER_REQUEST: 'hermes:order:request',
  ORDER_STATUS: 'hermes:order:status',
  RISK_SIGNAL: 'hermes:risk:signal',
  WHALE_TRANSFER: 'hermes:onchain:whale',
  REGIME_UPDATE: 'hermes:strategy:regime',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

const { Pool } = pg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/hermes',
  max: Number(process.env.DB_POOL_MAX ?? 10),
});
