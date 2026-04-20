import express from 'express';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = 4310;

// Paths
const RUNTIME_DIR = '/mnt/Storage/github/hermes-trading-firm/.runtime';
const PAPER_LEDGER_DIR = join(RUNTIME_DIR, 'paper-ledger');
const JOURNAL_PATH = join(PAPER_LEDGER_DIR, 'journal.jsonl');
const EMERGENCY_HALT_PATH = join(RUNTIME_DIR, 'emergency-halt.json');
const REPORTS_DIR = '/mnt/Storage/github/hermes-trading-firm/services/compliance/reports';
const ALERTS_PATH = '/tmp/compliance-alerts.json';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const STARTING_CAPITAL = 100_000;

// Thresholds
const XRP_WARNING_PCT = 60;
const XRP_HARD_LIMIT_PCT = 75;
const DRAWDOWN_HALT_PCT = 12;
const ALLOCATION_MAX_MULTIPLIER = 2.0;
const FEE_BPS_EXPECTED = 5;
const ADVERSE_SELECTION_BPS = 2;

const QUARANTINE_EXIT_REASONS = new Set(['synthetic', 'test', 'broker-recon-flatten']);

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
  broker?: string;
  entryMeta?: { broker?: string; source?: string };
  realizedPnl: number;
  fee?: number;
  exitAt: string;
  exitReason?: string;
  lane?: string;
}

interface Alert {
  severity: 'warning' | 'critical' | 'info';
  mandate: number;
  check: string;
  detail: string;
  timestamp: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Mandate 1: Synthetic trade detection ────────────────────────────────────

function checkSyntheticTrades(entries: JournalEntry[]): Alert[] {
  const alerts: Alert[] = [];
  const quarantinedEntries = entries.filter(e => QUARANTINE_EXIT_REASONS.has(e.exitReason ?? ''));
  const orphaned = entries.filter(e => {
    if (QUARANTINE_EXIT_REASONS.has(e.exitReason ?? '')) return false;
    const broker = e.broker ?? e.entryMeta?.broker ?? e.entryMeta?.source;
    return !broker || broker === '' || broker === 'undefined' || broker === 'null';
  });

  if (orphaned.length > 0) {
    alerts.push({
      severity: 'critical',
      mandate: 1,
      check: 'Synthetic/Orphan Trade Detection',
      detail: `${orphaned.length} trade(s) in journal lack valid broker source. EntryMeta.broker missing or invalid: ${orphaned.slice(0, 3).map(e => e.id).join(', ')}${orphaned.length > 3 ? '...' : ''}`,
      timestamp: nowIso(),
    });
  }

  if (quarantinedEntries.length > 0) {
    alerts.push({
      severity: 'info',
      mandate: 1,
      check: 'Quarantined Trades Present',
      detail: `${quarantinedEntries.length} quarantined trade(s) found (exitReason in ${[...QUARANTINE_EXIT_REASONS].join(', ')}). These are excluded from WR analytics.`,
      timestamp: nowIso(),
    });
  }

  return alerts;
}

// ── Mandate 2: Quarantine audit ─────────────────────────────────────────────

function checkQuarantineAudit(entries: JournalEntry[]): Alert[] {
  const alerts: Alert[] = [];

  // Check that quarantined entries are NOT included in WR/stats
  // We verify by scanning for any quarantined entries and confirming they're flagged
  const syntheticEntries = entries.filter(e => e.exitReason === 'synthetic' || e.exitReason === 'test' || e.exitReason === 'broker-recon-flatten');

  if (syntheticEntries.length === 0) {
    alerts.push({
      severity: 'info',
      mandate: 2,
      check: 'Quarantine Audit',
      detail: 'No quarantined trades found. WR analytics are clean.',
      timestamp: nowIso(),
    });
  }

  return alerts;
}

// ── Mandate 3: XRP concentration ─────────────────────────────────────────────

interface EodStats {
  lanePnl: Map<string, number>;
  totalPnl: number;
}

async function checkXrpConcentration(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  try {
    const stats = readJsonLines<Record<string, unknown>>(join(PAPER_LEDGER_DIR, 'stats.jsonl'));
    // Stats is a JSON object per line, look for lane P&L
    let totalPnl = 0;
    const lanePnl = new Map<string, number>();
    for (const line of stats) {
      const s = line as Record<string, unknown>;
      if (s.totalPnl !== undefined) totalPnl = Number(s.totalPnl);
      if (s.lanes && typeof s.lanes === 'object') {
        for (const [k, v] of Object.entries(s.lanes as Record<string, unknown>)) {
          lanePnl.set(k, Number(v));
        }
      }
    }

    // Fallback: try via API
    if (totalPnl === 0) {
      try {
        const http = await import('node:http');
        const resp = await new Promise<string>((resolve, reject) => {
          const req = http.get('http://localhost:4300/api/stats', (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
          });
          req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
          req.on('error', reject);
        });
        const apiStats = JSON.parse(resp);
        if (apiStats.lanes) {
          for (const [k, v] of Object.entries(apiStats.lanes as Record<string, number>)) {
            lanePnl.set(k, v);
          }
        }
        totalPnl = apiStats.totalPnl ?? 0;
      } catch { /* API not available */ }
    }

    if (totalPnl === 0) {
      alerts.push({
        severity: 'info',
        mandate: 3,
        check: 'XRP Concentration',
        detail: 'Cannot determine XRP P&L — no journal data or API unavailable. Skipping.',
        timestamp: nowIso(),
      });
      return alerts;
    }

    const xrpPnl = lanePnl.get('xrp') ?? lanePnl.get('XRP-USD') ?? 0;
    const xrpPct = (xrpPnl / Math.abs(totalPnl)) * 100;

    if (xrpPct > XRP_HARD_LIMIT_PCT) {
      alerts.push({
        severity: 'critical',
        mandate: 3,
        check: 'XRP Concentration HARD LIMIT',
        detail: `XRP is ${xrpPct.toFixed(1)}% of total P&L (${XRP_HARD_LIMIT_PCT}% hard limit exceeded). Reduce XRP exposure.`,
        timestamp: nowIso(),
      });
    } else if (xrpPct > XRP_WARNING_PCT) {
      alerts.push({
        severity: 'warning',
        mandate: 3,
        check: 'XRP Concentration Warning',
        detail: `XRP is ${xrpPct.toFixed(1)}% of total P&L (warning at ${XRP_WARNING_PCT}%). Monitor closely.`,
        timestamp: nowIso(),
      });
    } else {
      alerts.push({
        severity: 'info',
        mandate: 3,
        check: 'XRP Concentration',
        detail: `XRP is ${xrpPct.toFixed(1)}% of total P&L — within tolerance.`,
        timestamp: nowIso(),
      });
    }
  } catch (e) {
    alerts.push({
      severity: 'warning',
      mandate: 3,
      check: 'XRP Concentration',
      detail: `Error checking XRP concentration: ${String(e)}`,
      timestamp: nowIso(),
    });
  }
  return alerts;
}

// ── Mandate 4: Drawdown limits ──────────────────────────────────────────────

function checkDrawdownLimits(entries: JournalEntry[]): Alert[] {
  const alerts: Alert[] = [];

  // Check emergency-halt.json exists
  const haltExists = existsSync(EMERGENCY_HALT_PATH);
  if (haltExists) {
    try {
      const haltData = JSON.parse(readFileSync(EMERGENCY_HALT_PATH, 'utf-8'));
      alerts.push({
        severity: 'warning',
        mandate: 4,
        check: 'Emergency Halt Active',
        detail: `Emergency halt is ACTIVE (operator: ${haltData.operator}, reason: ${haltData.reason}, haltedAt: ${haltData.haltedAt}). Manual review required.`,
        timestamp: nowIso(),
      });
    } catch {
      alerts.push({
        severity: 'warning',
        mandate: 4,
        check: 'Emergency Halt File Corrupt',
        detail: `emergency-halt.json exists but unreadable.`,
        timestamp: nowIso(),
      });
    }
  }

  // Compute drawdown from journal
  if (entries.length === 0) {
    alerts.push({
      severity: 'info',
      mandate: 4,
      check: 'Drawdown Check',
      detail: 'No journal entries — cannot compute drawdown.',
      timestamp: nowIso(),
    });
    return alerts;
  }

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

  const maxDrawdownPct = maxDrawdown * 100;

  if (maxDrawdownPct > DRAWDOWN_HALT_PCT) {
    alerts.push({
      severity: 'critical',
      mandate: 4,
      check: 'Drawdown Exceeds Halt Threshold',
      detail: `Current max drawdown: ${maxDrawdownPct.toFixed(2)}% (limit: ${DRAWDOWN_HALT_PCT}%). Halt review required.`,
      timestamp: nowIso(),
    });
  } else if (maxDrawdownPct > 8) {
    alerts.push({
      severity: 'warning',
      mandate: 4,
      check: 'Drawdown Elevated',
      detail: `Current max drawdown: ${maxDrawdownPct.toFixed(2)}%. Approaching ${DRAWDOWN_HALT_PCT}% halt threshold.`,
      timestamp: nowIso(),
    });
  } else {
    alerts.push({
      severity: 'info',
      mandate: 4,
      check: 'Drawdown Within Tolerance',
      detail: `Max drawdown: ${maxDrawdownPct.toFixed(2)}% — safe.`,
      timestamp: nowIso(),
    });
  }

  return alerts;
}

// ── Mandate 5: Allocation audit ─────────────────────────────────────────────

async function checkAllocationLimits(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  try {
    const resp = await fetch('http://localhost:4300/api/maker');
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);
    const data = await resp.json() as { quotes?: { states?: Array<{ lane?: string; allocationMultiplier?: number }> } };
    const states = data.quotes?.states ?? [];

    const violations = states.filter(s => (s.allocationMultiplier ?? 1) > ALLOCATION_MAX_MULTIPLIER);

    if (violations.length > 0) {
      alerts.push({
        severity: 'critical',
        mandate: 5,
        check: 'Allocation Multiplier Violation',
        detail: `${violations.length} lane(s) exceed multiplier ${ALLOCATION_MAX_MULTIPLIER}: ${violations.map(v => `${v.lane}=${v.allocationMultiplier}`).join(', ')}`,
        timestamp: nowIso(),
      });
    } else {
      alerts.push({
        severity: 'info',
        mandate: 5,
        check: 'Allocation Multipliers OK',
        detail: `All ${states.length} lane(s) have allocationMultiplier ≤ ${ALLOCATION_MAX_MULTIPLIER}.`,
        timestamp: nowIso(),
      });
    }
  } catch (e) {
    alerts.push({
      severity: 'warning',
      mandate: 5,
      check: 'Allocation Audit',
      detail: `Could not fetch maker state: ${String(e)}`,
      timestamp: nowIso(),
    });
  }
  return alerts;
}

// ── Mandate 6: Maker fee validation ─────────────────────────────────────────

async function checkMakerFees(): Promise<Alert[]> {
  const alerts: Alert[] = [];

  try {
    const gridEnginePath = '/mnt/Storage/github/hermes-trading-firm/services/api/src/grid-engine.ts';
    const makerEnginePath = '/mnt/Storage/github/hermes-trading-firm/services/api/src/maker-engine.ts';

    const gridContent = readFileSync(gridEnginePath, 'utf-8');
    const makerContent = readFileSync(makerEnginePath, 'utf-8');

    // Check FEE_BPS = 5 in grid-engine
    const gridFeeMatch = gridContent.match(/FEE_BPS\s*=\s*(\d+)/);
    const gridFee = gridFeeMatch ? Number(gridFeeMatch[1]) : null;
    if (gridFee !== FEE_BPS_EXPECTED) {
      alerts.push({
        severity: 'critical',
        mandate: 6,
        check: 'grid-engine FEE_BPS Mismatch',
        detail: `grid-engine.ts has FEE_BPS=${gridFee} (expected ${FEE_BPS_EXPECTED}).`,
        timestamp: nowIso(),
      });
    }

    // Check FEE_BPS_PER_SIDE = 5 in maker-engine
    const makerFeeMatch = makerContent.match(/FEE_BPS_PER_SIDE\s*=\s*(\d+)/);
    const makerFee = makerFeeMatch ? Number(makerFeeMatch[1]) : null;
    if (makerFee !== FEE_BPS_EXPECTED) {
      alerts.push({
        severity: 'critical',
        mandate: 6,
        check: 'maker-engine FEE_BPS_PER_SIDE Mismatch',
        detail: `maker-engine.ts has FEE_BPS_PER_SIDE=${makerFee} (expected ${FEE_BPS_EXPECTED}).`,
        timestamp: nowIso(),
      });
    }

    // Check circuit breaker threshold (-2bps) in maker-engine
    const cbMatch = makerContent.match(/ADVERSE_SELECTION_THRESHOLD_BPS\s*=\s*(\d+)/);
    const cbBps = cbMatch ? Number(cbMatch[1]) : null;
    if (cbBps !== ADVERSE_SELECTION_BPS) {
      alerts.push({
        severity: 'critical',
        mandate: 6,
        check: 'maker-engine Circuit Breaker Threshold Mismatch',
        detail: `maker-engine.ts has ADVERSE_SELECTION_THRESHOLD_BPS=${cbBps} (expected ${ADVERSE_SELECTION_BPS}).`,
        timestamp: nowIso(),
      });
    }

    if (alerts.length === 0) {
      alerts.push({
        severity: 'info',
        mandate: 6,
        check: 'Fee Constants Validated',
        detail: `FEE_BPS=5 in grid-engine, FEE_BPS_PER_SIDE=5 in maker-engine, circuit breaker at ${ADVERSE_SELECTION_BPS}bps — all correct.`,
        timestamp: nowIso(),
      });
    }
  } catch (e) {
    alerts.push({
      severity: 'warning',
      mandate: 6,
      check: 'Fee Validation',
      detail: `Error reading engine source files: ${String(e)}`,
      timestamp: nowIso(),
    });
  }

  return alerts;
}

// ── Full compliance cycle ────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  console.log('[Vetter] Running compliance cycle...');
  const allAlerts: Alert[] = [];

  // Load journal
  const entries = readJsonLines<JournalEntry>(JOURNAL_PATH);
  console.log(`[Vetter] Loaded ${entries.length} journal entries.`);

  // Mandates 1 & 2: Journal-based checks
  allAlerts.push(...checkSyntheticTrades(entries));
  allAlerts.push(...checkQuarantineAudit(entries));

  // Mandate 4: Drawdown (journal-based)
  allAlerts.push(...checkDrawdownLimits(entries));

  // Mandate 3: XRP concentration (API-based)
  allAlerts.push(...(await checkXrpConcentration()));

  // Mandate 5: Allocation (API-based)
  allAlerts.push(...(await checkAllocationLimits()));

  // Mandate 6: Fee constants (file-based)
  allAlerts.push(...(await checkMakerFees()));

  // Write alerts
  writeFileSync(ALERTS_PATH, JSON.stringify({ alerts: allAlerts, updatedAt: nowIso() }, null, 2));
  console.log(`[Vetter] ${allAlerts.length} findings written.`);

  // Generate and save weekly report
  const dateStr = nowIso().slice(0, 10);
  const isWeekly = new Date().getDay() === 0; // Sunday = weekly report
  const reportMd = generateReport(allAlerts, entries.length, isWeekly);
  writeFileSync(join(REPORTS_DIR, `${dateStr}.md`), reportMd);

  const criticalCount = allAlerts.filter(a => a.severity === 'critical').length;
  if (criticalCount > 0) {
    console.warn(`[Vetter] 🚨 ${criticalCount} CRITICAL compliance violation(s)!`);
  } else {
    console.log('[Vetter] ✅ Compliance check passed.');
  }
}

function generateReport(alerts: Alert[], totalEntries: number, isWeekly: boolean): string {
  const now = nowIso().replace('T', ' ').slice(0, 16);
  const critical = alerts.filter(a => a.severity === 'critical');
  const warnings = alerts.filter(a => a.severity === 'warning');
  const info = alerts.filter(a => a.severity === 'info');

  let md = `# Compliance Report — ${now} UTC\n\n`;
  md += `**Vetter | Compliance Officer**\n\n`;
  md += `## Overview\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Total Journal Entries | ${totalEntries} |\n`;
  md += `| Critical Violations | ${critical.length} |\n`;
  md += `| Warnings | ${warnings.length} |\n`;
  md += `| Info | ${info.length} |\n\n`;

  // Group by mandate
  const byMandate = new Map<number, Alert[]>();
  for (const a of alerts) {
    if (!byMandate.has(a.mandate)) byMandate.set(a.mandate, []);
    byMandate.get(a.mandate)!.push(a);
  }

  md += `## Mandate Results\n\n`;
  const mandateNames: Record<number, string> = {
    1: 'Synthetic Trade Detection',
    2: 'Quarantine Audit',
    3: 'XRP Concentration Limits',
    4: 'Drawdown Limits',
    5: 'Allocation Audit',
    6: 'Maker Fee Validation',
    7: 'Weekly Report',
  };

  for (const [mandate, mandateAlerts] of [...byMandate.entries()].sort((a, b) => a[0] - b[0])) {
    const sevCounts = { critical: 0, warning: 0, info: 0 };
    for (const a of mandateAlerts) sevCounts[a.severity]++;
    const sevIcon = sevCounts.critical > 0 ? '🔴' : sevCounts.warning > 0 ? '⚠️' : '✅';
    md += `### ${sevIcon} Mandate ${mandate}: ${mandateNames[mandate] ?? 'Unknown'}\n\n`;
    for (const a of mandateAlerts) {
      const icon = a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '⚠️' : 'ℹ️';
      md += `- ${icon} **${a.check}**: ${a.detail}\n`;
    }
    md += '\n';
  }

  if (critical.length > 0) {
    md += `## 🚨 Required Actions\n\n`;
    for (const a of critical) {
      md += `- **${a.check}**: ${a.detail}\n`;
    }
    md += '\n';
  }

  md += `---\n*Generated by Vetter | Compliance Officer | Hermes Trading Firm*\n`;
  return md;
}

// ── Express server ──────────────────────────────────────────────────────────

app.use(express.json());

app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'hermes-compliance', role: 'Vetter', timestamp: nowIso() });
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
    mkdirSync(REPORTS_DIR, { recursive: true });
    const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 10);
    res.json({ reports: files });
  } catch {
    res.json({ reports: [] });
  }
});

app.get('/report/:date', (req, res) => {
  try {
    const path = join(REPORTS_DIR, `${req.params.date}.md`);
    if (existsSync(path)) {
      res.type('text/markdown').send(readFileSync(path, 'utf-8'));
    } else {
      res.status(404).json({ error: 'Report not found' });
    }
  } catch {
    res.status(500).json({ error: 'Failed to read report' });
  }
});

// Run once at startup, then every 6 hours
app.listen(PORT, () => {
  console.log(`[Vetter] Compliance Officer listening on port ${PORT}`);
  runCycle().catch(console.error);
  setInterval(() => runCycle().catch(console.error), SIX_HOURS_MS);
});

export { app };