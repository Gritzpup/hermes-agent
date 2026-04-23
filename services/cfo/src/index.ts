import express from 'express';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, setupErrorEmitter } from '@hermes/logger';
setupErrorEmitter(logger);

const app = express();
app.use(express.json());
const PORT = Number(process.env.PORT) || 4309;

// Derive the repo root from this file's location: services/cfo/src → repo root (4x ..)
const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const LEDGER_DIR = process.env.HERMES_LEDGER_DIR
  ?? join(repoRoot, 'services/api/.runtime/paper-ledger');
const JOURNAL_PATH = `${LEDGER_DIR}/journal.jsonl`;
const REPORTS_DIR = process.env.CFO_REPORTS_DIR || './services/cfo/reports';
const ALERTS_PATH = '/tmp/cfo-alerts.json';
const STARTING_CAPITAL = 100_000;

// ── helpers ─────────────────────────────────────────────────────────────────

function readJsonLines<T>(path: string): T[] {
  try {
    if (!existsSync(path)) return [];
    const content = readFileSync(path, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

interface JournalEntry {
  id: string;
  symbol: string;
  broker: string;
  strategy: string;
  lane?: string;
  realizedPnl: number;
  realizedPnlPct: number;
  fee?: number;
  exitAt: string;
  exitReason?: string;
}

interface LaneMetrics {
  lane: string;
  totalPnl: number;
  totalFees: number;
  grossProfit: number;
  grossLoss: number;
  trades: number;
  wins: number;
  losses: number;
  wr: number;
  avgPnlPerTrade: number;
  feePctOfGross: number;
  drawdownPct: number;
  days: Set<string>;
  dailyLossPct: Map<string, number>;
  wrConsecutiveDays: number;
  wrHistory: number[];
  consecutiveLosses: number;
  recentTradeCount24h: number;
  priorTradeCount24h: number;
  symbolCounts: Map<string, number>;
}

function computeLaneMetrics(entries: JournalEntry[]): LaneMetrics[] {
  const byLane = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const lane = e.lane ?? 'unknown';
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane)!.push(e);
  }

  const results: LaneMetrics[] = [];

  for (const [lane, laneEntries] of byLane) {
    laneEntries.sort((a, b) => a.exitAt.localeCompare(b.exitAt));

    let totalPnl = 0;
    let totalFees = 0;
    let grossProfit = 0;
    let wins = 0;
    let losses = 0;
    const days = new Set<string>();
    const dailyPnl = new Map<string, number>();

    for (const e of laneEntries) {
      totalPnl += e.realizedPnl;
      totalFees += e.fee ?? 0;
      grossProfit += Math.max(0, e.realizedPnl);
      if (e.realizedPnl > 0) wins++;
      else if (e.realizedPnl < 0) losses++;

      const day = e.exitAt.split('T')[0];
      days.add(day);
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + e.realizedPnl);
    }

    let peak = STARTING_CAPITAL;
    let maxDrawdown = 0;
    let cumulative = STARTING_CAPITAL;
    const dayPnlSorted = [...dailyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [, pnl] of dayPnlSorted) {
      cumulative += pnl;
      if (cumulative > peak) peak = cumulative;
      const dd = (peak - cumulative) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const dayEntries: Map<string, { wins: number; total: number }> = new Map();
    for (const e of laneEntries) {
      const day = e.exitAt.split('T')[0];
      if (!dayEntries.has(day)) dayEntries.set(day, { wins: 0, total: 0 });
      const d = dayEntries.get(day)!;
      d.total++;
      if (e.realizedPnl > 0) d.wins++;
    }
    const sortedDays = [...dayEntries.keys()].sort().slice(-3);
    let wr3day = 0;
    let wr3total = 0;
    for (const d of sortedDays) {
      const x = dayEntries.get(d)!;
      wr3total += x.total;
      wr3day += x.wins;
    }
    const wr = laneEntries.length > 0 ? (wins / (wins + losses)) * 100 : 0;
    const feePctOfGross = grossProfit > 0 ? (totalFees / grossProfit) * 100 : 0;
    const avgPnlPerTrade = laneEntries.length > 0 ? totalPnl / laneEntries.length : 0;

    results.push({
      lane,
      totalPnl,
      totalFees,
      grossProfit,
      grossLoss: Math.abs(laneEntries.filter(e => e.realizedPnl < 0).reduce((s, e) => s + e.realizedPnl, 0)),
      trades: laneEntries.length,
      wins,
      losses,
      wr,
      avgPnlPerTrade,
      feePctOfGross,
      drawdownPct: maxDrawdown * 100,
      days,
      dailyLossPct: new Map(),
      wrConsecutiveDays: wr3total > 0 ? (wr3day / wr3total) * 100 : 0,
      wrHistory: [],
      consecutiveLosses: 0,
      recentTradeCount24h: 0,
      priorTradeCount24h: 0,
      symbolCounts: new Map(),
    });
  }

  return results;
}

function computeFirmMetrics(entries: JournalEntry[]) {
  const metrics = computeLaneMetrics(entries);
  const totalPnl = metrics.reduce((s, m) => s + m.totalPnl, 0);
  const totalTrades = metrics.reduce((s, m) => s + m.trades, 0);
  const totalWins = metrics.reduce((s, m) => s + m.wins, 0);
  const totalFees = metrics.reduce((s, m) => s + m.totalFees, 0);
  const grossProfit = metrics.reduce((s, m) => s + m.grossProfit, 0);
  const wr = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

  const byDay = new Map<string, number>();
  for (const e of entries) {
    const day = e.exitAt.split('T')[0];
    byDay.set(day, (byDay.get(day) ?? 0) + e.realizedPnl);
  }
  let peak = STARTING_CAPITAL;
  let maxDrawdown = 0;
  let cumulative = STARTING_CAPITAL;
  const sorted = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, pnl] of sorted) {
    cumulative += pnl;
    if (cumulative > peak) peak = cumulative;
    const dd = (peak - cumulative) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    totalPnl,
    totalTrades,
    totalWins,
    totalFees,
    grossProfit,
    firmWr: wr,
    firmDrawdownPct: maxDrawdown * 100,
    metrics,
    nav: STARTING_CAPITAL + totalPnl,
  };
}

// ── alerts ──────────────────────────────────────────────────────────────────

interface Alert {
  severity: 'warning' | 'critical';
  metric: string;
  value: string;
  recommendation: string;
  timestamp: string;
}

// ── Trade frequency helpers (called from runCycle, use raw entries) ──────────

const EVENTS_PATH = `${LEDGER_DIR}/../events.jsonl`;

function isMarketOpen(): boolean {
  const now = new Date();
  const etHour = now.getUTCHours() - 4; // UTC-4 ET
  const etDay = now.getUTCDay();
  if (etDay === 0 || etDay === 6) return false; // weekend
  if (etHour < 9 || etHour >= 16) return false; // pre/post market
  return true;
}

function detectTradeStall(allEntries: JournalEntry[], nowMs: number, HOUR_MS: number): Alert[] {
  const alerts: Alert[] = [];
  const now = new Date().toISOString();

  if (!isMarketOpen()) return alerts; // skip if market closed

  // Find most recent trade
  if (allEntries.length === 0) {
    alerts.push({
      severity: 'warning',
      metric: 'Trade Stall',
      value: '0 trades total',
      recommendation: 'No trades in journal. Firm is completely idle — investigate.',
      timestamp: now,
    });
    return alerts;
  }

  const sortedEntries = [...allEntries].sort((a, b) => b.exitAt.localeCompare(a.exitAt));
  const lastTradeTime = new Date(sortedEntries[0].exitAt).getTime();
  const hoursSinceLastTrade = (nowMs - lastTradeTime) / HOUR_MS;

  if (hoursSinceLastTrade > 4) {
    alerts.push({
      severity: hoursSinceLastTrade > 8 ? 'critical' : 'warning',
      metric: 'Trade Stall',
      value: `${hoursSinceLastTrade.toFixed(1)}h since last trade`,
      recommendation: `No trades for ${hoursSinceLastTrade.toFixed(1)}+ hours during market hours. Check market-data and broker health.`,
      timestamp: now,
    });
  }
  return alerts;
}

function detectVelocityDrop(recentCount: number, priorCount: number): Alert[] {
  const alerts: Alert[] = [];
  const now = new Date().toISOString();

  if (priorCount > 0 && recentCount < priorCount * 0.5) {
    alerts.push({
      severity: 'warning',
      metric: 'Trade Velocity Drop',
      value: `${recentCount} trades (prior 24h: ${priorCount})`,
      recommendation: `Trade count dropped >50% vs prior period. Market conditions may have changed or broker feeds degraded.`,
      timestamp: now,
    });
  }
  return alerts;
}

async function detectWideSpreads(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const now = new Date().toISOString();
  const EVENTS_MS_AGE = 30 * 60 * 1000; // last 30 min of events

  try {
    if (!existsSync(EVENTS_PATH)) return alerts;
    const content = readFileSync(EVENTS_PATH, 'utf-8').trim();
    if (!content) return alerts;

    const cutoff = Date.now() - EVENTS_MS_AGE;
    const tickEvents: Array<{ spreadBps: number; symbol: string }> = [];

    for (const line of content.split('\n')) {
      try {
        const e = JSON.parse(line);
        if (e.type !== 'tick') continue;
        const ts = new Date(e.timestamp).getTime();
        if (ts < cutoff) continue;
        for (const [sym, data] of Object.entries(e.prices ?? {})) {
          const d = data as { spreadBps?: number };
          if (d.spreadBps !== undefined) {
            tickEvents.push({ spreadBps: d.spreadBps, symbol: sym });
          }
        }
      } catch { /* skip */ }
    }

    // BTC spread check as proxy for market-wide spread
    const btcTicks = tickEvents.filter(t => t.symbol === 'BTC-USD');
    if (btcTicks.length > 0) {
      const avgSpread = btcTicks.reduce((s, t) => s + t.spreadBps, 0) / btcTicks.length;
      if (avgSpread > 15) { // 15 bps = 0.15%
        alerts.push({
          severity: avgSpread > 30 ? 'critical' : 'warning',
          metric: 'Wide Spreads',
          value: `BTC-USD avg ${avgSpread.toFixed(1)} bps`,
          recommendation: avgSpread > 30
            ? `CRITICAL: Spreads at ${avgSpread.toFixed(1)} bps — grid quoting likely uneconomic. Pause until spreads normalize.`
            : `Spreads at ${avgSpread.toFixed(1)} bps — above 15 bps threshold. Monitor grid profitability.`,
          timestamp: now,
        });
      }
    }
  } catch { /* non-fatal */ }

  return alerts;
}

function buildAlerts(firm: ReturnType<typeof computeFirmMetrics>, metrics: LaneMetrics[], allEntries: JournalEntry[], extra?: {
  stallAlerts: Alert[];
  velocityAlerts: Alert[];
  spreadAlerts: Alert[];
}): Alert[] {
  const alerts: Alert[] = [];
  const now = new Date().toISOString();

  if (firm.firmDrawdownPct > 8) {
    alerts.push({
      severity: 'critical',
      metric: 'Firm Drawdown',
      value: `${firm.firmDrawdownPct.toFixed(2)}%`,
      recommendation: 'HALT all lane expansion. Consider reducing exposure across all strategies.',
      timestamp: now,
    });
  }

  for (const m of metrics) {
    if (m.days.size === 0) continue;
    let maxDayLoss = 0;
    for (const [, pnl] of m.dailyLossPct) {
      const dayLossPct = Math.abs(pnl / STARTING_CAPITAL) * 100;
      if (dayLossPct > maxDayLoss) maxDayLoss = dayLossPct;
    }
    if (maxDayLoss > 5) {
      alerts.push({
        severity: 'critical',
        metric: `Lane ${m.lane} Daily Loss`,
        value: `${maxDayLoss.toFixed(2)}%`,
        recommendation: `Reduce ${m.lane} allocation. Hit >5% loss threshold.`,
        timestamp: now,
      });
    }
  }

  for (const m of metrics) {
    if (m.wrConsecutiveDays < 52 && m.trades >= 5) {
      alerts.push({
        severity: 'warning',
        metric: `Lane ${m.lane} Win Rate (3-day)`,
        value: `${m.wrConsecutiveDays.toFixed(1)}%`,
        recommendation: `${m.lane} WR at ${m.wrConsecutiveDays.toFixed(1)}% — below 52% threshold. Review strategy.`,
        timestamp: now,
      });
    }
  }

  for (const m of metrics) {
    if (m.feePctOfGross > 20) {
      alerts.push({
        severity: 'warning',
        metric: `Lane ${m.lane} Fee Ratio`,
        value: `${m.feePctOfGross.toFixed(1)}% of gross profit`,
        recommendation: `Fees consume ${m.feePctOfGross.toFixed(1)}% of gross profit in ${m.lane}. Negotiate better rates or reduce trade frequency.`,
        timestamp: now,
      });
    }
  }

  for (const m of metrics) {
    if (m.trades >= 10 && m.avgPnlPerTrade <= 0.5) {
      alerts.push({
        severity: 'warning',
        metric: `Lane ${m.lane} Avg Per Trade`,
        value: `$${m.avgPnlPerTrade.toFixed(2)}`,
        recommendation: `${m.lane} averages only $${m.avgPnlPerTrade.toFixed(2)}/trade — below $0.50 threshold. Unproductive capital.`,
        timestamp: now,
      });
    }
  }

  // ── NEW: Financial target alerts ─────────────────────────────────────────────

  // ROI target: capital efficiency
  const roiPct = (firm.totalPnl / STARTING_CAPITAL) * 100;
  if (roiPct < 0.5 && firm.totalTrades >= 20) {
    alerts.push({
      severity: 'warning',
      metric: 'ROI Target',
      value: `${roiPct.toFixed(3)}% since inception`,
      recommendation: `Below 0.5% capital efficiency target after ${firm.totalTrades} trades. Consider pausing low-performing lanes.`,
      timestamp: now,
    });
  }

  // Profit factor per lane
  for (const m of metrics) {
    if (m.trades >= 20 && m.grossLoss > 0) {
      const pf = m.grossProfit / m.grossLoss;
      if (pf < 1.3) {
        alerts.push({
          severity: 'warning',
          metric: `Lane ${m.lane} Profit Factor`,
          value: pf.toFixed(2),
          recommendation: `${m.lane} PF=${pf.toFixed(2)} < 1.3 with ${m.trades} trades. Edge is marginal — review.`,
          timestamp: now,
        });
      }
    }
  }

  // Expectancy per lane
  for (const m of metrics) {
    if (m.trades >= 15 && m.avgPnlPerTrade < 1.0) {
      alerts.push({
        severity: 'warning',
        metric: `Lane ${m.lane} Expectancy`,
        value: `$${m.avgPnlPerTrade.toFixed(2)}/trade`,
        recommendation: `${m.lane} expectancy $${m.avgPnlPerTrade.toFixed(2)} < $1.00 target after fees.`,
        timestamp: now,
      });
    }
  }

  // Daily P&L negative
  const today = new Date().toISOString().slice(0, 10);
  for (const [day, pnl] of Object.entries({})) {
    // computed below via firm-level day check
  }
  const firmByDay: Record<string, number> = {};
  for (const e of allEntries) {
    const d = e.exitAt.split('T')[0];
    firmByDay[d] = (firmByDay[d] ?? 0) + e.realizedPnl;
  }
  if (firmByDay[today] < 0) {
    alerts.push({
      severity: 'warning',
      metric: 'Daily P&L',
      value: `$${firmByDay[today].toFixed(2)} today`,
      recommendation: `Firm lost money today. Review current market conditions.`,
      timestamp: now,
    });
  }

  // ── NEW: Symbol concentration ────────────────────────────────────────────────

  // Aggregate symbol counts across ALL entries
  const symbolTotals = new Map<string, number>();
  for (const e of allEntries) {
    const sym = e.symbol;
    symbolTotals.set(sym, (symbolTotals.get(sym) ?? 0) + 1);
  }
  const totalRecent = [...symbolTotals.values()].reduce((s, c) => s + c, 0);
  for (const [sym, count] of symbolTotals) {
    const pct = totalRecent > 0 ? (count / totalRecent) * 100 : 0;
    if (pct > 70) {
      alerts.push({
        severity: pct > 85 ? 'critical' : 'warning',
        metric: 'Symbol Concentration',
        value: `${sym} = ${pct.toFixed(0)}% of ${totalRecent} recent trades`,
        recommendation: pct > 85
          ? `CRITICAL: ${sym} dominates ${pct.toFixed(0)}% of activity. Immediate rebalancing required.`
          : `${sym} at ${pct.toFixed(0)}% concentration — above 70% threshold. Diversify.`,
        timestamp: now,
      });
    }
  }

  // Lane balance: top lane PnL vs firm total
  if (firm.totalPnl > 0) {
    const topLane = metrics.reduce((best, m) => m.totalPnl > (best?.totalPnl ?? 0) ? m : best, metrics[0]);
    if (topLane && (topLane.totalPnl / firm.totalPnl) > 0.80) {
      alerts.push({
        severity: 'warning',
        metric: 'Lane Concentration',
        value: `${topLane.lane} = ${((topLane.totalPnl / firm.totalPnl) * 100).toFixed(0)}% of firm P&L`,
        recommendation: `${topLane.lane} dominates firm P&L. Spread capital across lanes.`,
        timestamp: now,
      });
    }
  }

  // ── NEW: Trend / degradation detection ───────────────────────────────────────

  // Consecutive losses per lane
  for (const m of metrics) {
    if (m.consecutiveLosses >= 4) {
      alerts.push({
        severity: 'warning',
        metric: `Lane ${m.lane} Loss Streak`,
        value: `${m.consecutiveLosses} consecutive losses`,
        recommendation: `${m.lane} has ${m.consecutiveLosses}+ consecutive losses. Consider pausing.`,
        timestamp: now,
      });
    }
  }

  // ── Trade frequency / velocity alerts (from runCycle) ────────────────────
  if (extra?.stallAlerts) alerts.push(...extra.stallAlerts);
  if (extra?.velocityAlerts) alerts.push(...extra.velocityAlerts);
  if (extra?.spreadAlerts) alerts.push(...extra.spreadAlerts);

  return alerts;
}

// ── position sizing ─────────────────────────────────────────────────────────

function positionSizingRecs(metrics: LaneMetrics[]) {
  const recs: { lane: string; currentWr: number; trades: number; recommendation: string }[] = [];

  for (const m of metrics) {
    if (m.trades >= 10 && m.wr < 55) {
      recs.push({
        lane: m.lane,
        currentWr: m.wr,
        trades: m.trades,
        recommendation: `REDUCE allocation. WR=${m.wr.toFixed(1)}% < 55% with ${m.trades} trades. Lower position size.`,
      });
    } else if (m.trades >= 20 && m.wr > 65) {
      recs.push({
        lane: m.lane,
        currentWr: m.wr,
        trades: m.trades,
        recommendation: `INCREASE allocation. WR=${m.wr.toFixed(1)}% > 65% with ${m.trades} trades. Higher position size warranted.`,
      });
    }
  }

  return recs;
}

// ── report generation ────────────────────────────────────────────────────────

function generateMarkdownReport(firm: ReturnType<typeof computeFirmMetrics>, alerts: Alert[], posRecs: ReturnType<typeof positionSizingRecs>): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const alertsCritical = alerts.filter(a => a.severity === 'critical');
  const alertsWarning = alerts.filter(a => a.severity === 'warning');

  let md = `# CFO Report — ${now} UTC\n\n`;
  md += `## Firm Overview\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| NAV | $${firm.nav.toFixed(2)} |\n`;
  md += `| Total P&L | $${firm.totalPnl.toFixed(2)} |\n`;
  md += `| Firm Win Rate | ${firm.firmWr.toFixed(1)}% |\n`;
  md += `| Firm Drawdown | ${firm.firmDrawdownPct.toFixed(2)}% |\n`;
  md += `| Total Trades | ${firm.totalTrades} |\n`;
  md += `| Total Fees | $${firm.totalFees.toFixed(2)} |\n\n`;

  md += `## Lane Breakdown\n\n`;
  md += `| Lane | P&L | Trades | WR% | Avg/Trade | Fees | Fee%Gross | Drawdown |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;
  for (const m of firm.metrics) {
    md += `| ${m.lane} | $${m.totalPnl.toFixed(2)} | ${m.trades} | ${m.wr.toFixed(1)}% | $${m.avgPnlPerTrade.toFixed(2)} | $${m.totalFees.toFixed(2)} | ${m.feePctOfGross.toFixed(1)}% | ${m.drawdownPct.toFixed(2)}% |\n`;
  }

  if (posRecs.length > 0) {
    md += `\n## Position Sizing Recommendations\n\n`;
    for (const r of posRecs) {
      md += `- **${r.lane}**: WR=${r.currentWr.toFixed(1)}% over ${r.trades} trades. ${r.recommendation}\n`;
    }
  }

  if (alertsCritical.length > 0) {
    md += `\n## 🚨 Critical Alerts\n\n`;
    for (const a of alertsCritical) {
      md += `- **[${a.metric}]** ${a.value} — ${a.recommendation}\n`;
    }
  }

  if (alertsWarning.length > 0) {
    md += `\n## ⚠️ Warnings\n\n`;
    for (const a of alertsWarning) {
      md += `- **[${a.metric}]** ${a.value} — ${a.recommendation}\n`;
    }
  }

  if (alerts.length === 0) {
    md += `\n## ✅ All Clear\n\nNo actionable alerts. All metrics within tolerance.\n`;
  }

  md += `\n---\n*Generated by Arithmetic, CFO Agent*\n`;

  return md;
}

// ── cycle ───────────────────────────────────────────────────────────────────

async function runCycle() {
  logger.info('[CFO] Running analysis cycle...');
  try {
    if (!existsSync(JOURNAL_PATH)) {
      console.log('[CFO] No journal.jsonl found — skipping.');
      return;
    }

    const raw = readFileSync(JOURNAL_PATH, 'utf-8').trim();
    if (!raw) {
      console.log('[CFO] Journal empty — skipping.');
      return;
    }

    let entries: JournalEntry[] = [];
    for (const line of raw.split('\n')) {
      try { entries.push(JSON.parse(line)); } catch { /* skip bad lines */ }
    }

    const firm = computeFirmMetrics(entries);
    const metrics = computeLaneMetrics(entries);

    // ── Trade stall detection ───────────────────────────────────────────────
    // Count trades in recent windows from the full entries list
    const nowMs = Date.now();
    const HOUR_MS = 60 * 60 * 1000;
    const recentEntries = entries.filter(e => (nowMs - new Date(e.exitAt).getTime()) < 24 * HOUR_MS);
    const recentTradeCount = recentEntries.length;
    const priorCutoff = nowMs - 48 * HOUR_MS;
    const priorEntries = recentEntries.filter(e => (new Date(e.exitAt).getTime() < priorCutoff));
    const priorTradeCount = priorEntries.length;

    const stallAlerts = detectTradeStall(entries, nowMs, HOUR_MS);
    const velocityAlerts = detectVelocityDrop(recentTradeCount, priorTradeCount);
    const spreadAlerts = await detectWideSpreads();

    const alerts = buildAlerts(firm, metrics, entries, { stallAlerts, velocityAlerts, spreadAlerts });
    const posRecs = positionSizingRecs(metrics);

    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(ALERTS_PATH, JSON.stringify({ alerts, updatedAt: new Date().toISOString() }, null, 2));
    console.log(`[CFO] ${alerts.length} alerts written.`);

    const dateStr = new Date().toISOString().slice(0, 10);
    const reportMd = generateMarkdownReport(firm, alerts, posRecs);
    const reportPath = `${REPORTS_DIR}/${dateStr}-report.md`;
    writeFileSync(reportPath, reportMd);
    console.log(`[CFO] Report written: ${reportPath}`);

    // Push critical alerts to COO bridge immediately
    const critical = alerts.filter(a => a.severity === 'critical');
    if (critical.length > 0) {
      try {
        await fetch('http://localhost:4395/webhook/cfo-alert', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ alerts: critical, timestamp: new Date().toISOString() }),
          signal: AbortSignal.timeout(3000),
        });
      } catch (e) {
        logger.warn('[CFO] Failed to push critical alerts to COO:', e);
      }
    }

    if (critical.length > 0) console.warn('[CFO] 🚨 Critical alerts detected!');
  } catch (e) {
    logger.error('[CFO] Cycle error:', e);
  }
}

// ── Express server ──────────────────────────────────────────────────────────

app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'hermes-cfo', role: 'Arithmetic', timestamp: new Date().toISOString() });
});

app.get('/alerts', (_, res) => {
  try {
    if (existsSync(ALERTS_PATH)) {
      res.json(JSON.parse(readFileSync(ALERTS_PATH, 'utf-8')));
    } else {
      res.json({ alerts: [] });
    }
  } catch {
    res.status(500).json({ error: 'Failed to read alerts' });
  }
});

app.get('/reports', (_, res) => {
  try {
    const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 10);
    res.json({ reports: files });
  } catch {
    res.json({ reports: [] });
  }
});

app.get('/report/:date', (req, res) => {
  try {
    const path = `${REPORTS_DIR}/${req.params.date}-report.md`;
    if (existsSync(path)) {
      res.type('text/markdown').send(readFileSync(path, 'utf-8'));
    } else {
      res.status(404).json({ error: 'Report not found' });
    }
  } catch {
    res.status(500).json({ error: 'Failed to read report' });
  }
});

app.get('/metrics', (_, res) => {
  try {
    if (!existsSync(JOURNAL_PATH)) return res.json({ error: 'No journal' });
    const raw = readFileSync(JOURNAL_PATH, 'utf-8').trim();
    if (!raw) return res.json({ error: 'Journal empty' });
    let entries: JournalEntry[] = [];
    for (const line of raw.split('\n')) { try { entries.push(JSON.parse(line)); } catch { /* skip */ } }
    const firm = computeFirmMetrics(entries);
    res.json(firm);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// COO → CFO request endpoint: the COO can ask for new metrics/analysis
const cooRequests: Array<{ requestType: string; payload: Record<string, unknown>; sentAt: string }> = [];

app.post('/coo-request', (req, res) => {
  try {
    const { requestType, payload, sentAt } = req.body;
    if (!requestType) {
      res.status(400).json({ error: 'requestType required' });
      return;
    }
    cooRequests.push({ requestType, payload: payload ?? {}, sentAt: sentAt ?? new Date().toISOString() });
    console.log(`[CFO] Received COO request: ${requestType}`);
    res.json({ received: true, queueLength: cooRequests.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/coo-requests', (_, res) => {
  res.json({ requests: cooRequests.slice(-20) });
});

// ── startup ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[CFO] Arithmetic listening on port ${PORT}`);
  runCycle().catch(console.error);
  setInterval(() => runCycle().catch(console.error), 5 * 60 * 1000);
});

export { app };
