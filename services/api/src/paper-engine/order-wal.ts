// @ts-nocheck
/**
 * Order Write-Ahead Log (WAL)
 *
 * Every order submission/fill/rejection is written to PostgreSQL BEFORE being acted upon.
 * On crash, replay from the last checkpoint to recover state.
 * Uses a buffered batch flush every 5 seconds to amortize DB round-trips.
 */

import { db } from '@hermes/infra';

const WAL_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5000;

interface WalEntry {
  id: string;
  tick: number;
  timestamp: string;
  symbol: string;
  broker: string;
  agentId: string;
  side: string;
  orderType: string;
  notional: number;
  quantity: number;
  strategy: string;
  mode: string;
  thesis: string;
  idempotencyKey: string | null;
  status: string;
  filledQty: number;
  avgFillPrice: number;
  rejectionReason: string | null;
  submittedAt: string | null;
  filledAt: string | null;
  latencyMs: number | null;
  source: string;
}

let writeBuffer: WalEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ulid(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ts}${rand}`;
}

export async function walAppend(entry: Omit<WalEntry, 'id'>): Promise<void> {
  const id = ulid();
  writeBuffer.push({ id, ...entry });
  if (writeBuffer.length >= WAL_BATCH_SIZE) {
    await walFlush();
  }
}

export async function walFlush(): Promise<void> {
  if (writeBuffer.length === 0) return;
  const batch = writeBuffer.splice(0, writeBuffer.length);
  const pool = db();

  const cols = [
    'id','tick','timestamp','symbol','broker','agentId','side','orderType',
    'notional','quantity','strategy','mode','thesis','idempotencyKey',
    'status','filledQty','avgFillPrice','rejectionReason',
    'submittedAt','filledAt','latencyMs','source'
  ].join(',');

  const values: unknown[] = [];
  const ph: string[] = [];
  let i = 0;

  for (const e of batch) {
    const base = ++i;
    ph.push(`($${base},$${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+15},$${base+16},$${base+17},$${base+18},$${base+19},$${base+20},$${base+21})`);
    values.push(
      e.id, e.tick, e.timestamp, e.symbol, e.broker, e.agentId,
      e.side, e.orderType, e.notional, e.quantity, e.strategy, e.mode,
      e.thesis, e.idempotencyKey, e.status, e.filledQty, e.avgFillPrice,
      e.rejectionReason, e.submittedAt, e.filledAt, e.latencyMs, e.source
    );
    i += 22;
  }

  try {
    await pool.query(
      `INSERT INTO "OrderWalEntry" (${cols}) VALUES ${ph.join(',')}`,
      values
    );
  } catch (err) {
    console.error('[order-wal] flush error:', err instanceof Error ? err.message : String(err));
    writeBuffer.unshift(...batch);
  }
}

export function startWalFlushTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(() => {
    walFlush().catch(err => console.error('[wal] timer flush error', err));
  }, FLUSH_INTERVAL_MS);
}

export async function replayWal(fromTick: number): Promise<WalEntry[]> {
  const pool = db();
  const result = await pool.query(
    `SELECT * FROM "OrderWalEntry" WHERE tick >= $1 ORDER BY tick ASC LIMIT 10000`,
    [fromTick]
  );
  return result.rows as WalEntry[];
}

export async function getLastWalTick(): Promise<number> {
  const pool = db();
  try {
    const result = await pool.query(
      `SELECT tick FROM "OrderWalEntry" ORDER BY tick DESC LIMIT 1`
    );
    return result.rows.length > 0 ? Number(result.rows[0].tick) : 0;
  } catch {
    return 0;
  }
}
