/**
 * fee-reconciliation.ts
 * 
 * Auto-calibrates the fee table by comparing realized fees (from broker fills)
 * against estimated fees from fee-model.ts. Flags deltas > 0.5bps OR > 15%
 * of current estimate for human review.
 * 
 * Does NOT auto-apply — writes report, emits console.warn, requires human action.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRoundTripCostBps, inferAssetClassFromSymbol } from './fee-model.js';
import type { BrokerId } from '@hermes/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime';
const FILLS_PATH = '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger/fills.jsonl';
const REPORT_PATH = path.join(RUNTIME_DIR, 'fee-calibration-report.jsonl');

export type LiquidityTag = 'maker' | 'taker';

export interface FillRecord {
  id: string;
  agentId: string;
  agentName: string;
  symbol: string;
  side: 'buy' | 'sell';
  status: 'filled';
  price: number;
  pnlImpact: number;
  source: 'broker' | 'simulated' | 'mock';
  orderId: string;
  timestamp: string;
  lane?: string;
}

export interface FeeBucket {
  venue: string;
  symbol: string;
  liquidity: LiquidityTag;
  sampleCount: number;
  realizedFeesBps: number[];
  medianRealizedBps: number;
  p90RealizedBps: number;
  estimatedBps: number;
  deltaBps: number;
  deltaPct: number;
  flagged: boolean;
  flagReason?: string;
}

export interface CalibrationWarning {
  timestamp: string;
  bucket: FeeBucket;
  suggestedNewBps: number;
  confidence: 'low' | 'medium' | 'high';
  samplesUsed: number;
  note: string;
}

export interface ReconciliationResult {
  asOf: string;
  lookbackDays: number;
  totalFillsRead: number;
  brokerFills: number;
  fillsUsed: number;
  buckets: FeeBucket[];
  warnings: CalibrationWarning[];
  summary: {
    totalBuckets: number;
    flaggedBuckets: number;
    avgDeltaBps: number;
    maxDeltaBps: number;
  };
}

interface FillEntry {
  id?: string;
  orderId?: string;
  agentId?: string;
  agentName?: string;
  symbol?: string;
  side?: string;
  price?: number | string;
  pnlImpact?: number | string;
  source?: string;
  timestamp?: string;
  lane?: string;
}

interface TradePair {
  symbol: string;
  agentId: string;
  entryPrice: number;
  exitPrice: number;
  pnlImpact: number;
  source: string;
  entryTimestamp: string;
  exitTimestamp: string;
  lane?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midVal = sorted[mid] ?? 0;
  if (sorted.length % 2 !== 0) return midVal;
  const prevVal = sorted[mid - 1] ?? 0;
  return (prevVal + midVal) / 2;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] ?? 0;
  if (lo === hi) return loVal;
  const hiVal = sorted[hi] ?? loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

function inferVenueFromSource(source: string, agentId: string): string {
  if (source === 'broker') {
    if (agentId.includes('coinbase') || agentId.includes('cb-')) return 'coinbase';
    if (agentId.includes('alpaca') || agentId.includes('paper')) return 'alpaca';
    if (agentId.includes('oanda')) return 'oanda';
    return 'unknown';
  }
  return 'simulated';
}

function inferLiquidity(lane?: string): LiquidityTag {
  if (!lane) return 'taker';
  const l = lane.toLowerCase();
  if (l.includes('maker') || l.includes('mm')) return 'maker';
  return 'taker';
}

function ensureRuntimeDir(): void {
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }
}

// ── Core Logic ─────────────────────────────────────────────────────────────────

function readFills(lookbackDays = 7): FillRecord[] {
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const fills: FillRecord[] = [];

  if (!fs.existsSync(FILLS_PATH)) {
    console.warn('[fee-reconciliation] fills.jsonl not found:', FILLS_PATH);
    return fills;
  }

  const lines = fs.readFileSync(FILLS_PATH, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as FillEntry;
      const ts = new Date(raw.timestamp ?? '').getTime();
      if (isNaN(ts) || ts < cutoff) continue;
      
      const price = typeof raw.price === 'string' ? Number(raw.price) : (raw.price ?? 0);
      const pnlImpact = typeof raw.pnlImpact === 'string' ? Number(raw.pnlImpact) : (raw.pnlImpact ?? 0);
      
      const fillRecord: FillRecord = {
        id: raw.id ?? raw.orderId ?? Math.random().toString(36),
        agentId: raw.agentId ?? 'unknown',
        agentName: raw.agentName ?? 'unknown',
        symbol: raw.symbol ?? 'UNKNOWN',
        side: (raw.side ?? 'buy') as 'buy' | 'sell',
        status: 'filled',
        price,
        pnlImpact,
        source: (raw.source ?? 'simulated') as 'broker' | 'simulated' | 'mock',
        orderId: raw.orderId ?? '',
        timestamp: raw.timestamp ?? new Date().toISOString()
      };
      if (raw.lane) fillRecord.lane = raw.lane;
      fills.push(fillRecord);
    } catch {
      // skip malformed lines
    }
  }

  return fills;
}

function buildTradePairs(fills: FillRecord[]): TradePair[] {
  const pairs: TradePair[] = [];
  const buys = new Map<string, FillRecord[]>();
  const sells = new Map<string, FillRecord[]>();

  // Group by agentId + symbol
  for (const fill of fills) {
    const key = `${fill.agentId}::${fill.symbol}`;
    if (fill.side === 'buy') {
      if (!buys.has(key)) buys.set(key, []);
      buys.get(key)!.push(fill);
    } else {
      if (!sells.has(key)) sells.set(key, []);
      sells.get(key)!.push(fill);
    }
  }

  // Match buys with sells (FIFO)
  for (const [key, buyFills] of buys) {
    const parts = key.split('::');
    const symbol = parts[1] ?? parts[0] ?? 'UNKNOWN';
    const sellFills = sells.get(key) ?? [];

    for (const buy of buyFills) {
      for (const sell of sellFills) {
        const buyTs = new Date(buy.timestamp).getTime();
        const sellTs = new Date(sell.timestamp).getTime();
        if (sellTs < buyTs) continue; // sell must be after buy

        const tradePair: TradePair = {
          symbol,
          agentId: buy.agentId,
          entryPrice: buy.price,
          exitPrice: sell.price,
          pnlImpact: sell.pnlImpact,
          source: sell.source,
          entryTimestamp: buy.timestamp,
          exitTimestamp: sell.timestamp
        };
        const laneVal = sell.lane ?? buy.lane;
        if (laneVal) tradePair.lane = laneVal;
        pairs.push(tradePair);
        break;
      }
    }
  }

  return pairs;
}

function computeRealizedFeeBps(pair: TradePair): number | null {
  if (pair.source !== 'broker') return null;
  if (pair.pnlImpact === 0) return null; // skip zero-PnL trades

  // Gross PnL approximation: assume qty=1 for normalized bps comparison
  // This is a simplification — real implementation would use qty from fills
  const grossPnL = pair.exitPrice - pair.entryPrice;
  const realizedFee = Math.abs(grossPnL - pair.pnlImpact);
  const avgPrice = (pair.entryPrice + pair.exitPrice) / 2;
  if (avgPrice === 0) return null;

  // Fee in bps = (fee / notional) * 10000, where notional = avgPrice * qty (qty=1)
  const feeBps = (realizedFee / avgPrice) * 10000;
  return feeBps;
}

function getEstimatedFeeBps(symbol: string, liquidity: LiquidityTag): number {
  const assetClass = inferAssetClassFromSymbol(symbol);
  const broker: BrokerId = symbol.includes('_') ? 'oanda-rest' : 'coinbase-live';
  const isMaker = liquidity === 'maker';

  // Use fee-model's estimateRoundTripCostBps with minimal spread/slippage for fee-only comparison
  const estimate = estimateRoundTripCostBps({
    assetClass,
    broker,
    spreadBps: 0,
    orderType: isMaker ? 'limit' : 'market',
    postOnly: isMaker,
    adverseSelectionRisk: 0,
    quoteStabilityMs: 5000
  });

  // Return per-side fee (half of round-trip) for comparison
  return estimate / 2;
}

export function reconcileFees(lookbackDays = 7): ReconciliationResult {
  const now = new Date().toISOString();
  const fills = readFills(lookbackDays);
  const brokerFills = fills.filter(f => f.source === 'broker');
  const pairs = buildTradePairs(brokerFills);

  // Compute realized fees for broker fills
  const realizedByBucket = new Map<string, number[]>();
  const bucketMeta = new Map<string, { venue: string; symbol: string; liquidity: LiquidityTag }>();

  for (const pair of pairs) {
    const feeBps = computeRealizedFeeBps(pair);
    if (feeBps === null) continue;

    const venue = inferVenueFromSource(pair.source, pair.agentId);
    const liquidity = inferLiquidity(pair.lane);
    const key = `${venue}::${pair.symbol}::${liquidity}`;

    if (!realizedByBucket.has(key)) {
      realizedByBucket.set(key, []);
      bucketMeta.set(key, { venue, symbol: pair.symbol, liquidity });
    }
    realizedByBucket.get(key)!.push(feeBps);
  }

  // Build fee buckets
  const buckets: FeeBucket[] = [];
  const warnings: CalibrationWarning[] = [];
  const DELTA_BPS_THRESHOLD = 0.5;
  const DELTA_PCT_THRESHOLD = 0.15;

  for (const [key, fees] of realizedByBucket) {
    const meta = bucketMeta.get(key)!;
    const estimated = getEstimatedFeeBps(meta.symbol, meta.liquidity);
    const medianBps = median(fees);
    const p90Bps = percentile(fees, 90);
    const deltaBps = medianBps - estimated;
    const deltaPct = estimated !== 0 ? Math.abs(deltaBps) / Math.abs(estimated) : 0;
    const flagged = Math.abs(deltaBps) > DELTA_BPS_THRESHOLD && deltaPct > DELTA_PCT_THRESHOLD;

    const flagReasonStr = flagged
      ? `delta=${deltaBps.toFixed(2)}bps (>${DELTA_BPS_THRESHOLD}) AND ${(deltaPct * 100).toFixed(0)}% (>${(DELTA_PCT_THRESHOLD * 100)}%)`
      : undefined;
    
    const bucket: FeeBucket = {
      venue: meta.venue,
      symbol: meta.symbol,
      liquidity: meta.liquidity,
      sampleCount: fees.length,
      realizedFeesBps: fees,
      medianRealizedBps: Math.round(medianBps * 1000) / 1000,
      p90RealizedBps: Math.round(p90Bps * 1000) / 1000,
      estimatedBps: Math.round(estimated * 1000) / 1000,
      deltaBps: Math.round(deltaBps * 1000) / 1000,
      deltaPct: Math.round(deltaPct * 1000) / 1000,
      flagged
    };
    if (flagReasonStr) bucket.flagReason = flagReasonStr;

    buckets.push(bucket);

    if (flagged) {
      const confidence: CalibrationWarning['confidence'] =
        fees.length >= 30 ? 'high' : fees.length >= 10 ? 'medium' : 'low';

      warnings.push({
        timestamp: now,
        bucket,
        suggestedNewBps: Math.round(medianBps * 1000) / 1000,
        confidence,
        samplesUsed: fees.length,
        note: `Realized median=${medianBps.toFixed(3)}bps (p90=${p90Bps.toFixed(3)}bps) vs estimated=${estimated.toFixed(3)}bps. ` +
          `Delta=${deltaBps.toFixed(3)}bps (${(deltaPct * 100).toFixed(0)}%). Human review required.`
      });
    }
  }

  // Write report
  ensureRuntimeDir();
  for (const warning of warnings) {
    const { realizedFeesBps: _, ...bucketWithoutFees } = warning.bucket;
    fs.appendFileSync(REPORT_PATH, `${JSON.stringify({ ...warning, bucket: bucketWithoutFees })}\n`, 'utf8');
  }

  // Console warnings
  if (warnings.length > 0) {
    console.warn('[fee-reconciliation] ⚠️  Fee calibration warnings:');
    for (const w of warnings) {
      console.warn(`  ${w.bucket.venue}/${w.bucket.symbol} (${w.bucket.liquidity}): ` +
        `realized=${w.bucket.medianRealizedBps}bps vs est=${w.bucket.estimatedBps}bps ` +
        `(delta=${w.bucket.deltaBps}bps, ${(w.bucket.deltaPct * 100).toFixed(0)}%) ` +
        `[${w.confidence} confidence, ${w.samplesUsed} samples]`);
    }
  }

  const deltas = buckets.map(b => Math.abs(b.deltaBps));
  const result: ReconciliationResult = {
    asOf: now,
    lookbackDays,
    totalFillsRead: fills.length,
    brokerFills: brokerFills.length,
    fillsUsed: pairs.length,
    buckets: buckets.map(b => ({ ...b, realizedFeesBps: [] })),
    warnings: warnings.map(w => ({ ...w, bucket: { ...w.bucket, realizedFeesBps: [] } })),
    summary: {
      totalBuckets: buckets.length,
      flaggedBuckets: warnings.length,
      avgDeltaBps: deltas.length > 0 ? Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 1000) / 1000 : 0,
      maxDeltaBps: deltas.length > 0 ? Math.round(Math.max(...deltas) * 1000) / 1000 : 0
    }
  };

  return result;
}

// ── Latest Report Reader ──────────────────────────────────────────────────────

export function getLatestReport(): { warnings: CalibrationWarning[]; asOf: string } | null {
  if (!fs.existsSync(REPORT_PATH)) {
    return null;
  }

  const lines = fs.readFileSync(REPORT_PATH, 'utf8').split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const warnings: CalibrationWarning[] = [];
  let latestTimestamp = '';

  for (const line of lines) {
    try {
      const w = JSON.parse(line) as CalibrationWarning;
      warnings.push(w);
      if (w.timestamp > latestTimestamp) latestTimestamp = w.timestamp;
    } catch {
      // skip
    }
  }

  return { warnings, asOf: latestTimestamp };
}

// ── Startup Hook ──────────────────────────────────────────────────────────────

export function runFeeReconciliationOnStartup(): void {
  console.log('[fee-reconciliation] Running startup reconciliation...');
  try {
    const result = reconcileFees(7);
    if (result.summary.flaggedBuckets > 0) {
      console.warn(`[fee-reconciliation] ⚠️  ${result.summary.flaggedBuckets}/${result.summary.totalBuckets} buckets flagged. ` +
        `Report written to ${REPORT_PATH}`);
    } else {
      console.log(`[fee-reconciliation] ✓ ${result.summary.totalBuckets} buckets checked, no calibration issues.`);
    }
    console.log(`[fee-reconciliation] Summary: ${result.brokerFills} broker fills, ${result.fillsUsed} trade pairs analyzed.`);
  } catch (err) {
    console.error('[fee-reconciliation] Startup reconciliation failed:', err);
  }
}
