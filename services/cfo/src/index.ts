import express from 'express';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';

const app = express();
const PORT = 4309;

// Paths
const LEDGER_DIR = '/mnt/Storage/github/hermes-trading-firm/.runtime/paper-ledger';
const JOURNAL_PATH = `${LEDGER_DIR}/journal.jsonl`;
const REPORTS_DIR = '/mnt/Storage/github/hermes-trading-firm/services/cfo/reports';
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
    const wrHistory: number[] = [];

    for (const e of laneEntries) {
      totalPnl += e.realizedPnl;
      totalFees += e.fee ?? 0;
      grossProfit += Math.max(0, e.realizedPnl);
      if (e.realizedPnl > 0) wins++;
      else if (e.realizedPnl < 0) losses++;

      const day = e.exitAt.split('T')[0];
      days.add(day);
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + e.realizedPnl);

      // Rolling 3-day WR
      const last3 = laneEntries.filter(x => x.exitAt.split('T')[0] === day || false);
      // simpler: just track same-day WR for today
    }

    // Per-day P&L for drawdown
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

    // 3-day rolling WR
    const dayEntries: Map<string, { wins: number; total: number }> = new Map();
    for (const e of laneEntries) {
      const day = e.exitAt.split('T')[0];
      if (!dayEntries.has(day)) dayEntries.set(day, { wins: 0, total: 0 });
      const d = dayEntries.get(day)!;
      d.total++;
      if (e.realizedPnl > 0) d.wins++;
    }
    // last 3 days WR
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
      wrHistory,
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

  // Firm drawdown
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

function buildAlerts(firm: ReturnType<typeof computeFirmMetrics>, metrics: LaneMetrics[]): Alert[] {
  const alerts: Alert[] = [];
  const now = new Date().toISOString();

  // Firm drawdown
  if (firm.firmDrawdownPct > 8) {
    alerts.push({
      severity: 'critical',
      metric: 'Firm Drawdown',
      value: `${firm.firmDrawdownPct.toFixed(2)}%`,
      recommendation: 'HALT all lane expansion. Consider reducing exposure across all strategies.',
      timestamp: now,
    });
  }

  // Per-lane 5% daily loss
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

  // WR <52% for 3 consecutive days
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

  // Fee >20% of gross
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

  // Avg ≤$0.50/trade
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
  console.log('[CFO] Running analysis cycle...');
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
    const alerts = buildAlerts(firm, metrics);
    const posRecs = positionSizingRecs(metrics);

    // Save alerts
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(ALERTS_PATH, JSON.stringify({ alerts, updatedAt: new Date().toISOString() }, null, 2));
    console.log(`[CFO] ${alerts.length} alerts written.`);

    // Save report
    const dateStr = new Date().toISOString().slice(0, 10);
    const reportMd = generateMarkdownReport(firm, alerts, posRecs);
    const reportPath = `${REPORTS_DIR}/${dateStr}-report.md`;
    writeFileSync(reportPath, reportMd);
    console.log(`[CFO] Report written: ${reportPath}`);

    if (alerts.some(a => a.severity === 'critical')) console.warn('[CFO] 🚨 Critical alerts detected!');
  } catch (e) {
    console.error('[CFO] Cycle error:', e);
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

// ── startup ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[CFO] Arithmetic listening on port ${PORT}`);
  // Run first cycle immediately, then every 6 hours
  runCycle().catch(console.error);
  setInterval(() => runCycle().catch(console.error), 6 * 60 * 60 * 1000);
});

export { app };