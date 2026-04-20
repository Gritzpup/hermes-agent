/**
 * Hermes Daily Diary Service
 * 
 * Autonomous journaling and reflection agent for the trading firm.
 * Runs as a Tilt-managed service — no cron jobs, continuous background process.
 * 
 * Responsibilities:
 * - Capture firm state snapshots every 30 minutes
 * - Record events, decisions, and learnings to daily journal
 * - Deep reflection cycle every 6 hours
 * - Generate action items from pattern detection
 * - Maintain weekly/monthly review archives
 */

import axios from 'axios';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

const API_URL = process.env.HERMES_API_URL ?? 'http://localhost:4300';
const EOD_URL = process.env.HERMES_EOD_URL ?? 'http://localhost:4305';
const WORKSPACE = process.env.DIARY_WORKSPACE ?? '/home/ubuntubox/.openclaw/workspace';

// ── Config ───────────────────────────────────────────────────────────────────
const SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;     // 30 minutes
const REFLECTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const PORT = 4306;
const SERVICE_NAME = 'hermes-daily-diary';

// ── Types ────────────────────────────────────────────────────────────────────
interface FirmSnapshot {
  timestamp: string;
  pnl: number;
  trades: number;
  wr: number;
  xrpConcentration: number;
  regime: string;
  alerts: string[];
  makerStatus: Record<string, string>;
  gridPnL: number;
  makerPnL: number;
  gridWr: number;
  makerWr: number;
}

interface DiaryEntry {
  timestamp: string;
  kind: 'snapshot' | 'reflection' | 'decision' | 'incident' | 'learning';
  snapshot?: FirmSnapshot;
  text?: string;
  tags: string[];
}

interface ActionItem {
  id: string;
  text: string;
  created: string;
  status: 'open' | 'done' | 'deferred';
  source: string;
}

interface Reflection {
  timestamp: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  summary: string;
  wins: string[];
  losses: string[];
  patterns: string[];
  actionItems: ActionItem[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// Use America/New_York timezone (firm operates in EDT/EST)
function getNYDateStr(d: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(d); // YYYY-MM-DD in NY time
}

function getHourStr(d: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return formatter.format(d).replace(',', '').replace(' ', ' ');
}

function getDateStr(d: Date = new Date()): string {
  return getNYDateStr(d);
}

function diaryDir(): string {
  const dir = join(WORKSPACE, 'diary', getDateStr().slice(0, 7));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dailyFile(): string {
  return join(diaryDir(), `${getDateStr()}-hermes-trading-firm.md`);
}

function snapshotsFile(): string {
  return join(diaryDir(), `${getDateStr()}-snapshots.jsonl`);
}

function actionsFile(): string {
  return join(WORKSPACE, 'diary', 'action-items.json');
}

function getLastReflections(limit = 3): Reflection[] {
  const reflections: Reflection[] = [];
  const base = join(WORKSPACE, 'diary');
  if (!existsSync(base)) return reflections;
  
  // Check last 7 days
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dir = join(base, getDateStr(d).slice(0, 7));
    const file = join(dir, `reflection-${getDateStr(d)}.json`);
    if (existsSync(file)) {
      try {
        const content = readFileSync(file, 'utf-8');
        reflections.push(...JSON.parse(content));
      } catch {}
    }
  }
  return reflections.slice(-limit);
}

function loadActionItems(): ActionItem[] {
  const file = actionsFile();
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

function saveActionItems(items: ActionItem[]): void {
  const dir = join(WORKSPACE, 'diary');
  mkdirSync(dir, { recursive: true });
  writeFileSync(actionsFile(), JSON.stringify(items, null, 2));
}

// ── Firm Data Fetching ────────────────────────────────────────────────────────
async function fetchFirmSnapshot(): Promise<FirmSnapshot> {
  let pnl = 0, trades = 0, wr = 0, xrpConc = 0, regime = 'unknown';
  let alerts: string[] = [];
  let gridPnL = 0, makerPnL = 0, gridWr = 0, makerWr = 0;
  const makerStatus: Record<string, string> = {};

  try {
    const stats = await axios.get(`${EOD_URL}/stats`, { timeout: 5000 });
    const d = stats.data;
    pnl = d.totalPnl ?? 0;
    trades = d.totalTrades ?? 0;
    wr = d.totalWr ?? 0;
    xrpConc = d.xrpConcentration ?? 0;
    regime = d.currentRegime ?? 'unknown';
    alerts = d.alerts ?? [];
    gridPnL = d.lanes?.grid?.pnl ?? 0;
    makerPnL = d.lanes?.maker?.pnl ?? 0;
    gridWr = d.lanes?.grid?.wr ?? 0;
    makerWr = d.lanes?.maker?.wr ?? 0;
  } catch (e) {
    console.log(`[${SERVICE_NAME}] EOD fetch failed: ${e}`);
  }

  try {
    const maker = await axios.get(`${API_URL}/api/maker`, { timeout: 5000 });
    const states = maker.data?.quotes?.states ?? [];
    for (const s of states) {
      makerStatus[s.symbol] = `${s.mode} — ${(s.reason ?? '?').slice(0, 50)}`;
    }
  } catch {}

  return {
    timestamp: new Date().toISOString(),
    pnl, trades, wr, xrpConcentration: xrpConc, regime, alerts,
    makerStatus, gridPnL, makerPnL, gridWr, makerWr
  };
}

// ── Journaling ────────────────────────────────────────────────────────────────
function appendSnapshot(snapshot: FirmSnapshot): void {
  const file = snapshotsFile();
  appendFileSync(file, JSON.stringify(snapshot) + '\n');
  console.log(`[${SERVICE_NAME}] Snapshot saved: P&L $${snapshot.pnl.toFixed(2)} | ${snapshot.trades} trades | WR ${snapshot.wr}%`);
}

function detectChanges(prev: FirmSnapshot | null, curr: FirmSnapshot): string[] {
  const changes: string[] = [];
  if (!prev) return changes;

  if (curr.pnl < prev.pnl - 5) changes.push(`P&L dropped $${(prev.pnl - curr.pnl).toFixed(2)} (was $${prev.pnl.toFixed(2)})`);
  if (curr.alerts.length > prev.alerts.length) {
    const newAlerts = curr.alerts.filter(a => !prev.alerts.includes(a));
    for (const a of newAlerts) changes.push(`NEW ALERT: ${a}`);
  }
  if (curr.makerStatus !== prev.makerStatus) {
    for (const [sym, status] of Object.entries(curr.makerStatus)) {
      if (prev.makerStatus[sym] !== status) {
        changes.push(`Maker ${sym} changed: ${status}`);
      }
    }
  }
  if (curr.regime !== prev.regime) changes.push(`Regime change: ${prev.regime} → ${curr.regime}`);
  if (curr.xrpConcentration > 80 && prev.xrpConcentration <= 80) changes.push(`XRP concentration CRITICAL: ${curr.xrpConcentration}%`);
  
  return changes;
}

function generateReflection(prevSnapshot: FirmSnapshot | null, currSnapshot: FirmSnapshot): Reflection {
  const periodHours = prevSnapshot
    ? (new Date(currSnapshot.timestamp).getTime() - new Date(prevSnapshot.timestamp).getTime()) / 3_600_000
    : 6;
  
  const wins: string[] = [];
  const losses: string[] = [];
  const patterns: string[] = [];
  const actionItems: ActionItem[] = [];

  const pnlDelta = currSnapshot.pnl - (prevSnapshot?.pnl ?? 0);
  const tradeDelta = currSnapshot.trades - (prevSnapshot?.trades ?? 0);

  if (pnlDelta > 10) wins.push(`P&L gained $${pnlDelta.toFixed(2)} in last ${periodHours.toFixed(1)}h`);
  if (pnlDelta < -5) losses.push(`P&L lost $${Math.abs(pnlDelta).toFixed(2)} in last ${periodHours.toFixed(1)}h`);
  if (currSnapshot.wr >= 55) wins.push(`Win rate ${currSnapshot.wr}% above 55% threshold`);
  if (currSnapshot.wr < 50 && currSnapshot.trades > 10) losses.push(`Win rate ${currSnapshot.wr}% below 50% with ${currSnapshot.trades} trades`);

  // Pattern detection
  if (currSnapshot.makerWr === 0 && currSnapshot.makerPnL < 0) {
    patterns.push('Maker lane is underwater — spread guard is correctly blocking but lane is structurally challenged');
  }
  if (currSnapshot.xrpConcentration > 80) {
    patterns.push(`XRP is ${currSnapshot.xrpConcentration}% of P&L — concentration risk elevated`);
  }
  if (currSnapshot.makerStatus['BTC-USD']?.includes('taker-watch')) {
    patterns.push('BTC spread too thin — maker correctly blocked. Market condition, not a bug.');
  }
  if (currSnapshot.alerts.some(a => a.includes('CRITICAL'))) {
    const critical = currSnapshot.alerts.filter(a => a.includes('CRITICAL'));
    patterns.push(`Critical alerts active: ${critical.join('; ')}`);
  }

  // Action items
  if (currSnapshot.makerWr === 0 && currSnapshot.makerPnL < -5) {
    actionItems.push({
      id: `maker-rebuild-${Date.now()}`,
      text: 'Review maker lane economics — avg $0.68/trade loss. Either fix or disable.',
      created: new Date().toISOString(),
      status: 'open',
      source: 'diary-reflection'
    });
  }
  if (currSnapshot.xrpConcentration > 80) {
    actionItems.push({
      id: `xrp-conc-${Date.now()}`,
      text: `XRP concentration at ${currSnapshot.xrpConcentration}% — consider adding non-XRP grid pairs`,
      created: new Date().toISOString(),
      status: 'open',
      source: 'diary-reflection'
    });
  }
  if (currSnapshot.wr < 50 && currSnapshot.trades > 20) {
    actionItems.push({
      id: `wr-alert-${Date.now()}`,
      text: `Win rate ${currSnapshot.wr}% below 50% with ${currSnapshot.trades} trades — investigate`,
      created: new Date().toISOString(),
      status: 'open',
      source: 'diary-reflection'
    });
  }

  const summary = `Period ${periodHours.toFixed(1)}h: P&L ${pnlDelta >= 0 ? '+' : ''}$${pnlDelta.toFixed(2)}, trades +${tradeDelta}, WR ${currSnapshot.wr}%, XRP ${currSnapshot.xrpConcentration}% conc, regime ${currSnapshot.regime}`;

  return {
    timestamp: new Date().toISOString(),
    periodStart: prevSnapshot?.timestamp ?? new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    periodEnd: currSnapshot.timestamp,
    periodLabel: `Reflection ${getHourStr(new Date(prevSnapshot?.timestamp ?? Date.now() - 6 * 3600 * 1000))} — ${getHourStr()}`,
    summary,
    wins,
    losses,
    patterns,
    actionItems
  };
}

function saveReflection(reflection: Reflection): void {
  const dir = join(WORKSPACE, 'diary', 'reflections');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${getDateStr()}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(reflection, null, 2));

  // Also update action items
  const existing = loadActionItems();
  const existingIds = new Set(existing.map(a => a.id));
  for (const item of reflection.actionItems) {
    if (!existingIds.has(item.id)) {
      existing.push(item);
    }
  }
  saveActionItems(existing);

  console.log(`[${SERVICE_NAME}] Reflection saved: ${reflection.summary}`);
  if (reflection.wins.length) console.log(`  Wins: ${reflection.wins.join(', ')}`);
  if (reflection.losses.length) console.log(`  Losses: ${reflection.losses.join(', ')}`);
  if (reflection.patterns.length) console.log(`  Patterns: ${reflection.patterns.join(', ')}`);
  if (reflection.actionItems.length) console.log(`  New action items: ${reflection.actionItems.length}`);
}

function updateDailyMarkdown(snapshot: FirmSnapshot, changes: string[]): void {
  const file = dailyFile();
  const hour = new Date().getHours();
  
  let content = '';
  if (existsSync(file)) {
    content = readFileSync(file, 'utf-8');
  } else {
    content = `# 📔 Hermes Trading Firm — Daily Log ${getDateStr()}\n\n---\n\n## Morning (${getDateStr()})\n\n---\n## Afternoon\n\n---\n## Evening\n\n---\n## Action Items\n- [ ] \n`;
  }

  // Append to appropriate section
  const section = hour < 12 ? '## Morning' : hour < 17 ? '## Afternoon' : '## Evening';
  const entryTime = getHourStr();
  
  let entry = `\n### ${entryTime}\n`;
  entry += `| Metric | Value |\n|--------|-------|\n`;
  entry += `| P&L | $${snapshot.pnl.toFixed(2)} |\n`;
  entry += `| Trades | ${snapshot.trades} |\n`;
  entry += `| Win Rate | ${snapshot.wr}% |\n`;
  entry += `| XRP Conc. | ${snapshot.xrpConcentration}% |\n`;
  entry += `| Regime | ${snapshot.regime} |\n`;
  entry += `| Grid P&L | $${snapshot.gridPnL.toFixed(2)} (${snapshot.gridWr}% WR) |\n`;
  entry += `| Maker P&L | $${snapshot.makerPnL.toFixed(2)} (${snapshot.makerWr}% WR) |\n`;
  
  if (snapshot.alerts.length) {
    entry += `\n**Alerts:** ${snapshot.alerts.map(a => `⚠️ ${a}`).join(' | ')}\n`;
  }
  if (changes.length) {
    entry += `\n**Changes:** ${changes.map(c => `• ${c}`).join(' | ')}\n`;
  }
  
  // Insert before the Action Items section
  const insertIdx = content.lastIndexOf('## Action Items');
  if (insertIdx !== -1) {
    content = content.slice(0, insertIdx) + entry + '\n' + content.slice(insertIdx);
  }
  
  writeFileSync(file, content);
}

// ── Main Loop ────────────────────────────────────────────────────────────────
let lastSnapshot: FirmSnapshot | null = null;
let lastReflectionMs = Date.now();
let running = true;

async function tick(): Promise<void> {
  try {
    const snapshot = await fetchFirmSnapshot();
    const changes = detectChanges(lastSnapshot, snapshot);
    
    // Always save snapshot
    appendSnapshot(snapshot);
    updateDailyMarkdown(snapshot, changes);
    
    // Check if it's time for a deep reflection
    const now = Date.now();
    if (now - lastReflectionMs >= REFLECTION_INTERVAL_MS) {
      const reflection = generateReflection(lastSnapshot, snapshot);
      saveReflection(reflection);
      lastReflectionMs = now;
    }
    
    lastSnapshot = snapshot;
  } catch (e) {
    console.error(`[${SERVICE_NAME}] Tick error: ${e}`);
  }
}

async function main(): Promise<void> {
  console.log(`[${SERVICE_NAME}] Starting — diary service for Hermes Trading Firm`);
  console.log(`[${SERVICE_NAME}] Workspace: ${WORKSPACE}`);
  console.log(`[${SERVICE_NAME}] Snapshot every ${SNAPSHOT_INTERVAL_MS / 60 / 1000}min, reflection every ${REFLECTION_INTERVAL_MS / 60 / 60 / 1000}h`);
  
  // Create workspace diary directory
  mkdirSync(join(WORKSPACE, 'diary'), { recursive: true });
  
  // Run immediately on startup
  await tick();
  
  // Then on interval
  const interval = setInterval(async () => {
    if (!running) return;
    await tick();
  }, SNAPSHOT_INTERVAL_MS);
  
  // HTTP health/status endpoint
  const http = await import('http');
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: SERVICE_NAME, status: 'healthy', uptime: process.uptime() }));
    } else if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const actions = loadActionItems();
      const lastReflections = getLastReflections(1);
      res.end(JSON.stringify({
        service: SERVICE_NAME,
        lastSnapshot,
        openActionItems: actions.filter(a => a.status === 'open').length,
        lastReflection: lastReflections[0]?.summary ?? null,
        nextReflectionInMs: Math.max(0, REFLECTION_INTERVAL_MS - (Date.now() - lastReflectionMs))
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  server.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] HTTP server on port ${PORT}`);
  });
  
  process.on('SIGTERM', () => {
    running = false;
    clearInterval(interval);
    server.close();
    process.exit(0);
  });
}

main().catch(console.error);
