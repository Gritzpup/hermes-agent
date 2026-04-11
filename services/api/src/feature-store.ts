import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { TradeJournalEntry } from '@hermes/contracts';
import { clamp } from './paper-engine-utils.js';

type FlowBucket = 'bullish' | 'bearish' | 'neutral';
type ConfidenceBucket = 'low' | 'medium' | 'high';
type SpreadBucket = 'tight' | 'medium' | 'wide';
type SqlParam = string | number | bigint | Uint8Array | null;

export interface FeatureStoreTradeRow {
  id: string;
  symbol: string;
  assetClass: string;
  strategyId: string;
  strategy: string;
  lane: string;
  broker: string;
  entryAt: string;
  exitAt: string;
  realizedPnl: number;
  realizedPnlPct: number;
  slippageBps: number;
  spreadBps: number;
  confidencePct: number;
  regime: string;
  newsBias: string;
  orderFlowBias: string;
  macroVeto: boolean;
  embargoed: boolean;
  flowBucket: FlowBucket;
  confidenceBucket: ConfidenceBucket;
  spreadBucket: SpreadBucket;
  expectedNetEdgeBps: number;
  estimatedCostBps: number;
  verdict: string;
  source: string;
  tags: string[];
}

export interface FeatureStorePosteriorRequest {
  strategyId: string;
  strategy: string;
  symbol: string;
  regime: string;
  flowBucket: FlowBucket;
  confidenceBucket: ConfidenceBucket;
  spreadBucket: SpreadBucket;
  lookbackDays?: number;
}

export interface FeatureStorePosteriorSnapshot {
  posterior: number;
  support: number;
  reason: string;
}

export interface FeatureStoreSummary {
  totals: {
    trades: number;
    wins: number;
    losses: number;
    winRatePct: number;
    pnl: number;
  };
  byAssetClass: Array<{ assetClass: string; trades: number; winRatePct: number; pnl: number }>;
  byRegime: Array<{ regime: string; trades: number; winRatePct: number; pnl: number }>;
  byFlow: Array<{ flowBucket: FlowBucket; trades: number; winRatePct: number; pnl: number }>;
}

export interface FeatureStoreQueryFilters {
  symbol?: string;
  assetClass?: string;
  regime?: string;
  flowBucket?: FlowBucket;
  strategyId?: string;
  lookbackDays?: number;
  limit?: number;
}

function normalizeFlowBucket(direction: string): FlowBucket {
  if (direction === 'buy' || direction === 'strong-buy' || direction === 'bullish') return 'bullish';
  if (direction === 'sell' || direction === 'strong-sell' || direction === 'bearish') return 'bearish';
  return 'neutral';
}

function confidenceBucket(confidence: number): ConfidenceBucket {
  if (confidence >= 70) return 'high';
  if (confidence >= 35) return 'medium';
  return 'low';
}

function spreadBucket(spreadBps: number, spreadLimitBps: number): SpreadBucket {
  const ratio = spreadBps / Math.max(spreadLimitBps, 0.1);
  if (ratio <= 0.35) return 'tight';
  if (ratio <= 0.75) return 'medium';
  return 'wide';
}

function toNumber(value: unknown, fallback = 0): number {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function weightedPosterior(
  globalPosterior: number,
  regimePosterior: number,
  symbolPosterior: number,
  contextPosterior: number,
  exactPosterior: number
): number {
  return clamp(
    globalPosterior * 0.15
      + regimePosterior * 0.2
      + symbolPosterior * 0.25
      + contextPosterior * 0.25
      + exactPosterior * 0.15,
    0.05,
    0.98
  );
}

type AggregateRow = { count: number; wins: number; losses: number; expectancy: number };

function aggregateToPosterior(row: AggregateRow, priorWins: number, priorLosses: number): number {
  return (row.wins + priorWins) / Math.max(row.wins + row.losses + priorWins + priorLosses, 1);
}

function cutoffTsMs(lookbackDays: number): number {
  return Date.now() - Math.max(1, lookbackDays) * 86_400_000;
}

export class FeatureStore {
  private readonly db: DatabaseSync;
  private readonly defaultLookbackDays: number;

  constructor(dbPath?: string) {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const runtimeDir = process.env.PAPER_LEDGER_DIR ?? path.resolve(moduleDir, '../.runtime/paper-ledger');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const resolved = dbPath ?? path.join(runtimeDir, 'feature-store.sqlite');
    this.db = new DatabaseSync(resolved);
    this.defaultLookbackDays = toNumber(process.env.FEATURE_STORE_LOOKBACK_DAYS, 180);
    this.bootstrap();
    this.seedFromLegacyJournal(runtimeDir);
  }

  private bootstrap(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;

      CREATE TABLE IF NOT EXISTS trade_features (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        broker TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        strategy TEXT NOT NULL,
        lane TEXT NOT NULL,
        entry_at TEXT NOT NULL,
        entry_ts INTEGER NOT NULL,
        exit_at TEXT NOT NULL,
        exit_ts INTEGER NOT NULL,
        realized_pnl REAL NOT NULL,
        realized_pnl_pct REAL NOT NULL,
        slippage_bps REAL NOT NULL,
        spread_bps REAL NOT NULL,
        latency_ms REAL NOT NULL,
        hold_ticks REAL NOT NULL,
        confidence_pct REAL NOT NULL,
        regime TEXT NOT NULL,
        news_bias TEXT NOT NULL,
        order_flow_bias TEXT NOT NULL,
        macro_veto INTEGER NOT NULL,
        embargoed INTEGER NOT NULL,
        flow_bucket TEXT NOT NULL,
        confidence_bucket TEXT NOT NULL,
        spread_bucket TEXT NOT NULL,
        entry_score REAL NOT NULL,
        expected_net_edge_bps REAL NOT NULL,
        estimated_cost_bps REAL NOT NULL,
        verdict TEXT NOT NULL,
        source TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_trade_features_exit_ts ON trade_features(exit_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_trade_features_symbol ON trade_features(symbol, exit_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_trade_features_regime ON trade_features(regime, exit_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_trade_features_asset ON trade_features(asset_class, exit_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_trade_features_strategy ON trade_features(strategy_id, exit_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_trade_features_context ON trade_features(symbol, regime, flow_bucket, confidence_bucket, spread_bucket, exit_ts DESC);
    `);
  }

  private seedFromLegacyJournal(runtimeDir: string): void {
    const existing = this.db.prepare('SELECT COUNT(*) AS count FROM trade_features').get() as Record<string, unknown> | undefined;
    if (toNumber(existing?.count, 0) > 0) return;

    const journalPath = path.join(runtimeDir, 'journal.jsonl');
    if (!fs.existsSync(journalPath)) return;

    const raw = fs.readFileSync(journalPath, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    this.db.exec('BEGIN TRANSACTION');
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as TradeJournalEntry;
        if (!parsed?.id || !parsed?.symbol || !parsed?.exitAt) continue;
        this.upsertTrade(parsed);
      } catch {
        // ignore malformed legacy lines
      }
    }
    this.db.exec('COMMIT');
  }

  upsertTrade(entry: TradeJournalEntry, spreadLimitBps = 20): void {
    const flow = normalizeFlowBucket(entry.orderFlowBias ?? 'neutral');
    const confidence = confidenceBucket(toNumber(entry.confidencePct, 0));
    const spread = spreadBucket(toNumber(entry.spreadBps, 0), spreadLimitBps);
    const entryTs = Date.parse(entry.entryAt);
    const exitTs = Date.parse(entry.exitAt);
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO trade_features (
        id, symbol, asset_class, broker, strategy_id, strategy, lane, entry_at, entry_ts, exit_at, exit_ts,
        realized_pnl, realized_pnl_pct, slippage_bps, spread_bps, latency_ms, hold_ticks, confidence_pct,
        regime, news_bias, order_flow_bias, macro_veto, embargoed,
        flow_bucket, confidence_bucket, spread_bucket,
        entry_score, expected_net_edge_bps, estimated_cost_bps, verdict, source, tags_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        symbol = excluded.symbol,
        asset_class = excluded.asset_class,
        broker = excluded.broker,
        strategy_id = excluded.strategy_id,
        strategy = excluded.strategy,
        lane = excluded.lane,
        entry_at = excluded.entry_at,
        entry_ts = excluded.entry_ts,
        exit_at = excluded.exit_at,
        exit_ts = excluded.exit_ts,
        realized_pnl = excluded.realized_pnl,
        realized_pnl_pct = excluded.realized_pnl_pct,
        slippage_bps = excluded.slippage_bps,
        spread_bps = excluded.spread_bps,
        latency_ms = excluded.latency_ms,
        hold_ticks = excluded.hold_ticks,
        confidence_pct = excluded.confidence_pct,
        regime = excluded.regime,
        news_bias = excluded.news_bias,
        order_flow_bias = excluded.order_flow_bias,
        macro_veto = excluded.macro_veto,
        embargoed = excluded.embargoed,
        flow_bucket = excluded.flow_bucket,
        confidence_bucket = excluded.confidence_bucket,
        spread_bucket = excluded.spread_bucket,
        entry_score = excluded.entry_score,
        expected_net_edge_bps = excluded.expected_net_edge_bps,
        estimated_cost_bps = excluded.estimated_cost_bps,
        verdict = excluded.verdict,
        source = excluded.source,
        tags_json = excluded.tags_json
    `);

    stmt.run(
      entry.id,
      entry.symbol,
      entry.assetClass ?? 'unknown',
      entry.broker,
      entry.strategyId ?? entry.strategy,
      entry.strategy,
      entry.lane ?? 'scalping',
      entry.entryAt,
      Number.isFinite(entryTs) ? entryTs : now,
      entry.exitAt,
      Number.isFinite(exitTs) ? exitTs : now,
      toNumber(entry.realizedPnl, 0),
      toNumber(entry.realizedPnlPct, 0),
      toNumber(entry.slippageBps, 0),
      toNumber(entry.spreadBps, 0),
      toNumber(entry.latencyMs, 0),
      toNumber(entry.holdTicks, 0),
      toNumber(entry.confidencePct, 0),
      entry.regime ?? 'unknown',
      entry.newsBias ?? 'neutral',
      entry.orderFlowBias ?? 'neutral',
      entry.macroVeto ? 1 : 0,
      entry.embargoed ? 1 : 0,
      flow,
      confidence,
      spread,
      toNumber(entry.entryScore, 0),
      toNumber(entry.expectedNetEdgeBps, 0),
      toNumber(entry.estimatedCostBps, 0),
      entry.verdict,
      entry.source ?? 'simulated',
      JSON.stringify(entry.tags ?? [])
    );
  }

  private aggregate(whereClause: string, params: SqlParam[]): AggregateRow {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
        COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END), 0) AS losses,
        COALESCE(AVG(realized_pnl), 0) AS expectancy
      FROM trade_features
      ${whereClause}
    `).get(...params) as Record<string, unknown> | undefined;

    return {
      count: toNumber(row?.count, 0),
      wins: toNumber(row?.wins, 0),
      losses: toNumber(row?.losses, 0),
      expectancy: toNumber(row?.expectancy, 0)
    };
  }

  getPosteriorSnapshot(params: FeatureStorePosteriorRequest): FeatureStorePosteriorSnapshot {
    const lookbackDays = params.lookbackDays ?? this.defaultLookbackDays;
    const cutoff = cutoffTsMs(lookbackDays);

    const global = this.aggregate('WHERE exit_ts >= ?', [cutoff]);
    if (global.count === 0) {
      return { posterior: 0.5, support: 0, reason: 'Feature store empty.' };
    }

    const exact = this.aggregate(
      'WHERE strategy_id = ? AND exit_ts >= ?',
      [params.strategyId, cutoff]
    );
    const symbol = this.aggregate(
      'WHERE symbol = ? AND exit_ts >= ?',
      [params.symbol, cutoff]
    );
    const context = this.aggregate(
      'WHERE symbol = ? AND regime = ? AND flow_bucket = ? AND confidence_bucket = ? AND spread_bucket = ? AND exit_ts >= ?',
      [params.symbol, params.regime, params.flowBucket, params.confidenceBucket, params.spreadBucket, cutoff]
    );
    const regime = this.aggregate(
      'WHERE regime = ? AND flow_bucket = ? AND exit_ts >= ?',
      [params.regime, params.flowBucket, cutoff]
    );

    const posterior = weightedPosterior(
      aggregateToPosterior(global, 3, 3),
      aggregateToPosterior(regime, 2, 2),
      aggregateToPosterior(symbol, 2, 2),
      aggregateToPosterior(context, 2, 2),
      aggregateToPosterior(exact, 2, 2)
    );

    const support = exact.count + symbol.count + context.count + regime.count;
    return {
      posterior,
      support,
      reason: `sqlite exact ${exact.count}, symbol ${symbol.count}, regime ${regime.count}, context ${context.count}, lookback ${lookbackDays}d`
    };
  }

  getSummary(lookbackDays = this.defaultLookbackDays): FeatureStoreSummary {
    const cutoff = cutoffTsMs(lookbackDays);

    const totalsRow = this.db.prepare(`
      SELECT
        COUNT(*) AS trades,
        COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
        COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END), 0) AS losses,
        COALESCE(SUM(realized_pnl), 0) AS pnl
      FROM trade_features
      WHERE exit_ts >= ?
    `).get(cutoff) as Record<string, unknown> | undefined;

    const trades = toNumber(totalsRow?.trades, 0);
    const wins = toNumber(totalsRow?.wins, 0);
    const losses = toNumber(totalsRow?.losses, 0);
    const pnl = toNumber(totalsRow?.pnl, 0);

    const grouped = (field: 'asset_class' | 'regime' | 'flow_bucket') => this.db.prepare(`
      SELECT
        ${field} AS key,
        COUNT(*) AS trades,
        COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
        COALESCE(SUM(realized_pnl), 0) AS pnl
      FROM trade_features
      WHERE exit_ts >= ?
      GROUP BY ${field}
      ORDER BY trades DESC
      LIMIT 12
    `).all(cutoff) as Array<Record<string, unknown>>;

    const mapGrouped = <T extends string>(rows: Array<Record<string, unknown>>, keyName: string) =>
      rows.map((row) => {
        const rowTrades = toNumber(row.trades, 0);
        const rowWins = toNumber(row.wins, 0);
        return {
          [keyName]: String(row.key ?? 'unknown') as T,
          trades: rowTrades,
          winRatePct: rowTrades > 0 ? (rowWins / rowTrades) * 100 : 0,
          pnl: toNumber(row.pnl, 0)
        };
      });

    return {
      totals: {
        trades,
        wins,
        losses,
        winRatePct: trades > 0 ? (wins / trades) * 100 : 0,
        pnl
      },
      byAssetClass: mapGrouped<string>(grouped('asset_class'), 'assetClass') as FeatureStoreSummary['byAssetClass'],
      byRegime: mapGrouped<string>(grouped('regime'), 'regime') as FeatureStoreSummary['byRegime'],
      byFlow: mapGrouped<FlowBucket>(grouped('flow_bucket'), 'flowBucket') as FeatureStoreSummary['byFlow']
    };
  }

  queryTrades(filters: FeatureStoreQueryFilters): FeatureStoreTradeRow[] {
    const conditions: string[] = [];
    const values: SqlParam[] = [];

    const lookbackDays = filters.lookbackDays ?? this.defaultLookbackDays;
    conditions.push('exit_ts >= ?');
    values.push(cutoffTsMs(lookbackDays));

    if (filters.symbol) {
      conditions.push('symbol = ?');
      values.push(filters.symbol);
    }
    if (filters.assetClass) {
      conditions.push('asset_class = ?');
      values.push(filters.assetClass);
    }
    if (filters.regime) {
      conditions.push('regime = ?');
      values.push(filters.regime);
    }
    if (filters.flowBucket) {
      conditions.push('flow_bucket = ?');
      values.push(filters.flowBucket);
    }
    if (filters.strategyId) {
      conditions.push('strategy_id = ?');
      values.push(filters.strategyId);
    }

    const limit = Math.max(1, Math.min(500, filters.limit ?? 100));
    values.push(limit);

    const rows = this.db.prepare(`
      SELECT
        id, symbol, asset_class, strategy_id, strategy, lane, broker,
        entry_at, exit_at, realized_pnl, realized_pnl_pct, slippage_bps, spread_bps, confidence_pct,
        regime, news_bias, order_flow_bias, macro_veto, embargoed,
        flow_bucket, confidence_bucket, spread_bucket,
        expected_net_edge_bps, estimated_cost_bps, verdict, source, tags_json
      FROM trade_features
      WHERE ${conditions.join(' AND ')}
      ORDER BY exit_ts DESC
      LIMIT ?
    `).all(...values) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      symbol: String(row.symbol),
      assetClass: String(row.asset_class),
      strategyId: String(row.strategy_id),
      strategy: String(row.strategy),
      lane: String(row.lane),
      broker: String(row.broker),
      entryAt: String(row.entry_at),
      exitAt: String(row.exit_at),
      realizedPnl: toNumber(row.realized_pnl, 0),
      realizedPnlPct: toNumber(row.realized_pnl_pct, 0),
      slippageBps: toNumber(row.slippage_bps, 0),
      spreadBps: toNumber(row.spread_bps, 0),
      confidencePct: toNumber(row.confidence_pct, 0),
      regime: String(row.regime),
      newsBias: String(row.news_bias),
      orderFlowBias: String(row.order_flow_bias),
      macroVeto: toNumber(row.macro_veto, 0) === 1,
      embargoed: toNumber(row.embargoed, 0) === 1,
      flowBucket: String(row.flow_bucket) as FlowBucket,
      confidenceBucket: String(row.confidence_bucket) as ConfidenceBucket,
      spreadBucket: String(row.spread_bucket) as SpreadBucket,
      expectedNetEdgeBps: toNumber(row.expected_net_edge_bps, 0),
      estimatedCostBps: toNumber(row.estimated_cost_bps, 0),
      verdict: String(row.verdict),
      source: String(row.source),
      tags: (() => {
        try {
          const parsed = JSON.parse(String(row.tags_json ?? '[]'));
          return Array.isArray(parsed) ? parsed.map((tag) => String(tag)) : [];
        } catch {
          return [];
        }
      })()
    }));
  }
}

let featureStoreSingleton: FeatureStore | null = null;

export function getFeatureStore(): FeatureStore {
  if (!featureStoreSingleton) {
    featureStoreSingleton = new FeatureStore();
  }
  return featureStoreSingleton;
}
