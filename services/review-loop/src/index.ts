import './load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import type { ExecutionReport, PromotionStage, StrategyReview, TradeJournalEntry } from '@hermes/contracts';
import { QUARANTINED_EXIT_REASONS } from '@hermes/contracts';
import { logger, setupErrorEmitter } from '@hermes/logger';
setupErrorEmitter(logger);

const app = express();
const port = Number(process.env.PORT ?? 4304);

interface CooDirective {
  timestamp: string;
  type: string;
  text?: string;
  strategy?: string;
  reason?: string;
}

interface CooCache {
  data: CooDirective[];
  fetchedAt: number;
}

let cooCache: CooCache | null = null;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PAPER_LEDGER_DIR = process.env.PAPER_LEDGER_DIR ?? path.resolve(MODULE_DIR, '../../api/.runtime/paper-ledger');
const BROKER_LEDGER_DIR = process.env.BROKER_ROUTER_RUNTIME_DIR ?? path.resolve(MODULE_DIR, '../../broker-router/.runtime/broker-router');
const INCLUDE_LEGACY_PAPER_JOURNAL = process.env.HERMES_INCLUDE_LEGACY_PAPER_JOURNAL !== 'false';
const PAPER_JOURNAL_PATH = path.join(PAPER_LEDGER_DIR, 'journal.jsonl');
const EVENT_LOG_PATH = path.join(PAPER_LEDGER_DIR, 'events.jsonl');
const BROKER_EXECUTION_PATH = path.join(BROKER_LEDGER_DIR, 'executions.jsonl');

app.use(cors());

app.get('/health', (_req, res) => {
  const journalEntries = buildJournal();
  const executionEntries = readJsonLines<ExecutionReport>(BROKER_EXECUTION_PATH);
  res.json({
    service: 'review-loop',
    status: journalEntries.length + executionEntries.length > 0 ? 'healthy' : 'warning',
    timestamp: new Date().toISOString(),
    journalEntries: journalEntries.length,
    executionEntries: executionEntries.length,
    cooDirectiveCount: cooCache?.data?.length ?? 'unknown'
  });
});

app.get('/reviews', (_req, res) => {
  res.json(buildReviews());
});

app.get('/journal', (_req, res) => {
  res.json(buildJournal());
});

app.get('/clusters', async (_req, res) => {
  res.json(await buildClusters());
});

app.get('/coo-summary', async (_req, res) => {
  const now = Date.now();
  if (cooCache && now - cooCache.fetchedAt < 30_000) {
    return res.json(formatCooSummary(cooCache.data, cooCache.fetchedAt));
  }

  try {
    const response = await fetch('http://127.0.0.1:4300/api/coo/directives', {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      return res.status(502).json({ error: `COO service returned ${response.status}` });
    }
    const directives: CooDirective[] = await response.json();
    cooCache = { data: directives, fetchedAt: now };
    res.json(formatCooSummary(directives, now));
  } catch (err) {
    console.error('[review-loop] failed to fetch COO directives:', err);
    res.status(503).json({ error: 'Failed to fetch COO directives' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`[review-loop] listening on http://0.0.0.0:${port}`);
});

function buildReviews(): StrategyReview[] {
  const journalEntries = buildJournal();
  const groups = new Map<string, TradeJournalEntry[]>();

  for (const entry of journalEntries) {
    const strategy = entry.strategy;
    const items = groups.get(strategy) ?? [];
    items.push(entry);
    groups.set(strategy, items);
  }

  const windowMs = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  return Array.from(groups.entries())
    .map(([strategy, entries]) => {
      const recentEntries = entries.filter((entry) => {
        const exitedAt = Date.parse(entry.exitAt);
        return Number.isFinite(exitedAt) && (now - exitedAt) <= windowMs;
      });
      const statsEntries = recentEntries.length > 0 ? recentEntries : entries;
      const pnl30d = round(recentEntries.reduce((sum, entry) => sum + entry.realizedPnl, 0), 2);
      const wins = recentEntries.filter((entry) => entry.realizedPnl > 0).length;
      const winRate = recentEntries.length > 0 ? (wins / recentEntries.length) * 100 : 0;
      const expectancy = recentEntries.length > 0 ? recentEntries.reduce((sum, entry) => sum + entry.realizedPnl, 0) / recentEntries.length : 0;
      const latest = statsEntries
        .map((entry) => Date.parse(entry.exitAt))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => right - left)[0];

      const stage: PromotionStage = strategy.toLowerCase().includes('coinbase') ? 'shadow-live' : 'paper';

      return {
        id: slugify(strategy),
        strategy,
        stage,
        pnl30d,
        winRate: round(winRate, 1),
        expectancy: round(expectancy, 2),
        recommendation: buildRecommendation(pnl30d, winRate, expectancy),
        proposedChanges: buildProposedChanges(pnl30d, winRate, expectancy),
        updatedAt: latest ? new Date(latest).toISOString() : new Date().toISOString()
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function buildJournal(): TradeJournalEntry[] {
  // Paper and simulated strategy journals are included by default because they now carry real Hermes strategy diagnostics.
  // Phase H2: Filter out synthetic/reconciliation entries to avoid KPI pollution.
  const paperEntries = INCLUDE_LEGACY_PAPER_JOURNAL
    ? readJsonLines<TradeJournalEntry>(PAPER_JOURNAL_PATH)
      .filter((entry) => !QUARANTINED_EXIT_REASONS.has(entry.exitReason))
    : [];
  const brokerExecutions = readJsonLines<ExecutionReport>(BROKER_EXECUTION_PATH)
    .filter((execution) => execution.status === 'filled')
    .map<TradeJournalEntry>((execution) => ({
      id: `broker-journal-${execution.id}`,
      symbol: execution.symbol,
      broker: execution.broker,
      strategy: `${execution.broker} routed execution`,
      strategyId: `broker-${execution.broker}`,
      lane: 'scalping',
      thesis: execution.message,
      entryAt: execution.timestamp,
      entryTimestamp: execution.timestamp,
      exitAt: execution.timestamp,
      realizedPnl: 0,
      realizedPnlPct: 0,
      slippageBps: execution.slippageBps,
      spreadBps: 0,
      latencyMs: execution.latencyMs,
      aiComment: 'Execution routed through broker-router. Strategy review needs broker-side fill reconciliation to attach realized PnL.',
      exitReason: execution.message,
      verdict: 'scratch'
    }));

  return [...paperEntries, ...brokerExecutions]
    .map((entry) => normalizeJournalEntry(entry))
    .sort((left, right) => Date.parse(right.exitAt) - Date.parse(left.exitAt));
}

function normalizeJournalEntry(entry: TradeJournalEntry): TradeJournalEntry {
  const strategyLower = entry.strategy.toLowerCase();
  const inferredLane = entry.lane
    ?? (strategyLower.includes('grid') ? 'grid'
      : strategyLower.includes('pair') ? 'pairs'
      : strategyLower.includes('maker') ? 'maker'
      : 'scalping');
  const inferredRegime = entry.regime
    ?? (inferredLane === 'grid' ? 'grid-chop'
      : inferredLane === 'pairs' ? 'mean-reverting-compression'
      : inferredLane === 'maker' ? 'maker-liquidity-provision'
      : 'unknown-regime');

  return {
    ...entry,
    lane: inferredLane,
    entryTimestamp: entry.entryTimestamp ?? entry.entryAt,
    regime: inferredRegime,
    assetClass: entry.assetClass ?? inferAssetClassFromSymbol(entry.symbol),
    newsBias: entry.newsBias ?? 'neutral',
    orderFlowBias: entry.orderFlowBias ?? 'neutral',
    embargoed: entry.embargoed ?? false
  };
}

async function buildClusters() {
  const journalEntries = buildJournal();
  const { eventCounts, recentRollbacks } = await summarizeEventLog(EVENT_LOG_PATH);
  const losses = journalEntries.filter((entry) => entry.realizedPnl < 0);
  const byPattern = new Map<string, TradeJournalEntry[]>();

  for (const entry of losses) {
    const assetClassBucket = entry.assetClass ?? inferAssetClassFromSymbol(entry.symbol);
    const spreadBucket = entry.spreadBps >= 5 ? 'wide-spread' : entry.spreadBps >= 2 ? 'medium-spread' : 'tight-spread';
    const latencyBucket = entry.latencyMs !== undefined
      ? entry.latencyMs >= 2_000 ? 'slow-latency' : entry.latencyMs >= 500 ? 'medium-latency' : 'fast-latency'
      : 'unknown-latency';
    const regimeBucket = entry.entryRegime ?? entry.regime ?? 'unknown-regime';
    const newsBucket = entry.entryNewsBias ?? entry.newsBias ?? 'unknown-news';
    const flowBucket = entry.entryOrderFlowBias ?? entry.orderFlowBias ?? 'unknown-flow';
    const embargoBucket = (entry.entryEmbargoed ?? entry.embargoed) ? 'embargoed' : 'clear';
    const key = `${entry.symbol}|${assetClassBucket}|${entry.exitReason}|${spreadBucket}|${latencyBucket}|${regimeBucket}|${newsBucket}|${flowBucket}|${embargoBucket}`;
    const items = byPattern.get(key) ?? [];
    items.push(entry);
    byPattern.set(key, items);
  }

  const lossClusters = Array.from(byPattern.entries())
    .map(([key, entries]) => {
      const [symbol, assetClass, exitReason, spreadBucket, latencyBucket, regimeBucket, newsBucket, flowBucket, embargoBucket] = key.split('|');
      const totalLoss = entries.reduce((sum, entry) => sum + entry.realizedPnl, 0);
      const avgLoss = totalLoss / Math.max(entries.length, 1);
      return {
        symbol,
        assetClass,
        exitReason,
        spreadBucket,
        latencyBucket,
        regimeBucket,
        newsBucket,
        flowBucket,
        embargoBucket,
        occurrences: entries.length,
        totalLoss: round(totalLoss, 2),
        avgLoss: round(avgLoss, 2),
        examples: entries.slice(0, 3).map((entry) => ({
          id: entry.id,
          strategy: entry.strategy,
          assetClass: entry.assetClass ?? inferAssetClassFromSymbol(entry.symbol),
          aiComment: entry.aiComment,
          realizedPnl: entry.realizedPnl,
          spreadBps: entry.spreadBps,
          latencyMs: entry.latencyMs,
          regime: entry.regime,
          newsBias: entry.newsBias,
          orderFlowBias: entry.orderFlowBias,
          entryRegime: entry.entryRegime,
          entryNewsBias: entry.entryNewsBias,
          entryOrderFlowBias: entry.entryOrderFlowBias,
          exitAt: entry.exitAt
        }))
      };
    })
    .sort((left, right) => left.totalLoss - right.totalLoss);

  const diagnostics = {
    regimes: bucketCounts(losses.map((entry) => entry.entryRegime ?? entry.regime ?? 'unknown-regime')),
    assetClasses: bucketCounts(losses.map((entry) => entry.assetClass ?? inferAssetClassFromSymbol(entry.symbol))),
    newsStates: bucketCounts(losses.map((entry) => entry.entryNewsBias ?? entry.newsBias ?? 'unknown-news')),
    orderFlowStates: bucketCounts(losses.map((entry) => entry.entryOrderFlowBias ?? entry.orderFlowBias ?? 'unknown-flow')),
    embargoStates: bucketCounts(losses.map((entry) => (entry.entryEmbargoed ?? entry.embargoed) ? 'embargoed' : 'clear')),
    lanes: bucketCounts(losses.map((entry) => entry.lane ?? 'unknown-lane'))
  };

  return {
    asOf: new Date().toISOString(),
    totalJournalEntries: journalEntries.length,
    totalLosses: losses.length,
    lossClusters,
    diagnostics,
    eventCounts,
    recentRollbacks
  };
}

function buildRecommendation(pnl30d: number, winRate: number, expectancy: number): string {
  if (pnl30d > 0 && winRate >= 55 && expectancy > 0) {
    return 'Keep trading this lane, but only with measured spread/slippage and strict caps.';
  }
  if (pnl30d > 0 && expectancy > 0) {
    return 'Profitable but still fragile. Increase sample size before promotion.';
  }
  return 'Do not promote. Tighten entry quality and review the last losing cluster.';
}

function buildProposedChanges(pnl30d: number, winRate: number, expectancy: number): string[] {
  if (pnl30d <= 0 || expectancy <= 0) {
    return [
      'Reduce size until expectancy turns positive again.',
      'Audit the last five exits for spread and latency failures.',
      'Require a higher confidence threshold before submitting the next order.'
    ];
  }

  if (winRate < 55) {
    return [
      'Keep size flat and demand cleaner tape alignment.',
      'Do not widen stops to compensate for weak entries.',
      'Collect more trades before changing the strategy baseline.'
    ];
  }

  return [
    'Hold current sizing until live slippage is measured.',
    'Promote only after broker-side reconciliation is stable.',
    'Continue journaling every exit and reviewing outlier trades.'
  ];
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function inferAssetClassFromSymbol(symbol: string): 'equity' | 'crypto' | 'commodity-proxy' | 'forex' | 'bond' | 'commodity' {
  const normalized = symbol.toUpperCase();
  if (normalized.endsWith('-USD')) {
    const base = normalized.split('-')[0] ?? '';
    if (['BTC', 'ETH', 'SOL', 'XRP'].includes(base)) return 'crypto';
    if (base === 'PAXG') return 'commodity-proxy';
    if (base === 'BCO' || base === 'WTICO') return 'commodity';
    return 'commodity-proxy';
  }
  if (normalized.includes('_')) {
    if (normalized.startsWith('USB')) return 'bond';
    if (normalized.startsWith('BCO') || normalized.startsWith('WTICO')) return 'commodity';
    return 'forex';
  }
  return 'equity';
}

function readJsonLines<T>(filePath: string): T[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    console.error('[review-loop] failed to read ledger', filePath, error);
    return [];
  }
}

async function summarizeEventLog(filePath: string): Promise<{
  eventCounts: Record<string, number>;
  recentRollbacks: Record<string, unknown>[];
}> {
  const eventCounts: Record<string, number> = {};
  const recentRollbacks: Record<string, unknown>[] = [];
  const ROLLBACK_LIMIT = 20;

  if (!fs.existsSync(filePath)) {
    return { eventCounts, recentRollbacks };
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const raw of rl) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = typeof event.type === 'string' ? event.type : 'unknown';
      eventCounts[type] = (eventCounts[type] ?? 0) + 1;
      if (type === 'config-rollback') {
        recentRollbacks.push(event);
        if (recentRollbacks.length > ROLLBACK_LIMIT) {
          recentRollbacks.shift();
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return { eventCounts, recentRollbacks };
}

async function readJsonLinesStreaming<T>(filePath: string): Promise<T[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const results: T[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  for await (const raw of rl) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

function bucketCounts(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function formatCooSummary(directives: CooDirective[], fetchedAt: number) {
  const recent = directives.slice(0, 20);
  const byType: Record<string, number> = {};
  for (const d of directives) {
    byType[d.type] = (byType[d.type] ?? 0) + 1;
  }
  return {
    lastFetchedAt: new Date(fetchedAt).toISOString(),
    totalDirectives: directives.length,
    recent,
    byType
  };
}
