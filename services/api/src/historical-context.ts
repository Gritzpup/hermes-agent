/**
 * Historical Context Store
 *
 * Persists macro economic data (FRED), regime change history, and news sentiment
 * so agents can learn "what happened last time conditions looked like this."
 *
 * Storage: JSON files in .runtime/historical-context/
 * Sources:
 *   - FRED API (free, key required): CPI, Fed Funds Rate, Unemployment, GDP, PCE
 *   - Internal: regime changes, trade outcomes by regime, Fear & Greed history
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(MODULE_DIR, '../.runtime/historical-context');
const MACRO_PATH = path.join(STORE_DIR, 'macro-indicators.json');
const REGIME_PATH = path.join(STORE_DIR, 'regime-history.json');
const FNG_HISTORY_PATH = path.join(STORE_DIR, 'fng-history.json');

// Load .env if FRED_API_KEY not in process.env
function loadFredKey(): string {
  if (process.env.FRED_API_KEY) return process.env.FRED_API_KEY;
  try {
    const envPath = path.resolve(MODULE_DIR, '../../../.env');
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^FRED_API_KEY\s*=\s*(.+)/);
      if (match) return match[1]!.trim().replace(/^['"]|['"]$/g, '');
    }
  } catch { /* .env not found */ }
  return '';
}

const FRED_API_KEY = loadFredKey();
const FRED_BASE_URL = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_POLL_MS = 6 * 60 * 60 * 1000; // 6 hours (FRED data updates slowly)
const FNG_POLL_MS = 30 * 60 * 1000; // 30 min

// Key macro indicators from FRED
const FRED_SERIES: Record<string, string> = {
  'CPIAUCSL': 'CPI (All Urban Consumers)',
  'FEDFUNDS': 'Federal Funds Rate',
  'UNRATE': 'Unemployment Rate',
  'GDP': 'Gross Domestic Product',
  'PCEPI': 'PCE Price Index',
  'T10Y2Y': '10Y-2Y Treasury Spread (recession indicator)',
  'VIXCLS': 'VIX Close',
};

export interface MacroObservation {
  seriesId: string;
  name: string;
  date: string;
  value: number;
  fetchedAt: string;
}

export interface RegimeEvent {
  timestamp: string;
  regime: string;
  previousRegime: string;
  trigger: string; // what caused the change
  fngAtChange: number | null;
  btcPriceAtChange: number | null;
}

export interface FngDataPoint {
  timestamp: string;
  value: number;
  label: string;
}

export interface HistoricalContextSnapshot {
  macroIndicators: MacroObservation[];
  regimeHistory: RegimeEvent[];
  fngHistory: FngDataPoint[];
  lastMacroUpdate: string | null;
  summary: string;
}

export class HistoricalContextStore {
  private macroIndicators: MacroObservation[] = [];
  private regimeHistory: RegimeEvent[] = [];
  private fngHistory: FngDataPoint[] = [];
  private fredTimer: NodeJS.Timeout | null = null;
  private fngTimer: NodeJS.Timeout | null = null;
  private lastMacroUpdate: string | null = null;

  constructor() {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    this.load();
  }

  start(): void {
    console.log(`[historical-context] Starting (FRED every ${FRED_POLL_MS / 3600000}h, F&G every ${FNG_POLL_MS / 60000}min)`);
    // FRED: poll slowly
    if (FRED_API_KEY) {
      setTimeout(() => { void this.pollFRED(); }, 10_000);
      this.fredTimer = setInterval(() => { void this.pollFRED(); }, FRED_POLL_MS);
    } else {
      console.log('[historical-context] No FRED_API_KEY — macro indicators disabled');
    }
    // F&G history: poll faster
    setTimeout(() => { void this.pollFearGreedHistory(); }, 5_000);
    this.fngTimer = setInterval(() => { void this.pollFearGreedHistory(); }, FNG_POLL_MS);
  }

  stop(): void {
    if (this.fredTimer) { clearInterval(this.fredTimer); this.fredTimer = null; }
    if (this.fngTimer) { clearInterval(this.fngTimer); this.fngTimer = null; }
  }

  /** Record a regime change for future pattern matching */
  recordRegimeChange(regime: string, previousRegime: string, trigger: string, fng: number | null, btcPrice: number | null): void {
    this.regimeHistory.push({
      timestamp: new Date().toISOString(),
      regime,
      previousRegime,
      trigger,
      fngAtChange: fng,
      btcPriceAtChange: btcPrice
    });
    // Keep last 500 regime changes
    if (this.regimeHistory.length > 500) this.regimeHistory.splice(0, this.regimeHistory.length - 500);
    this.persist();
  }

  /** Get context summary for Strategy Director prompts */
  getSnapshot(): HistoricalContextSnapshot {
    return {
      macroIndicators: this.macroIndicators,
      regimeHistory: this.regimeHistory.slice(-20),
      fngHistory: this.fngHistory.slice(-30),
      lastMacroUpdate: this.lastMacroUpdate,
      summary: this.buildSummary()
    };
  }

  /** Get the latest value for a FRED series */
  getLatestMacro(seriesId: string): MacroObservation | null {
    return this.macroIndicators
      .filter((o) => o.seriesId === seriesId)
      .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  }

  /** How many times has this regime transition happened before? What was the avg outcome? */
  getRegimeTransitionHistory(from: string, to: string): { count: number; events: RegimeEvent[] } {
    const events = this.regimeHistory.filter((e) => e.previousRegime === from && e.regime === to);
    return { count: events.length, events: events.slice(-5) };
  }

  /** Get Fear & Greed trend: is it rising or falling? */
  getFngTrend(): { current: number; avg7d: number; direction: 'rising' | 'falling' | 'flat' } | null {
    if (this.fngHistory.length < 2) return null;
    const current = this.fngHistory[this.fngHistory.length - 1]!.value;
    const recent = this.fngHistory.slice(-7);
    const avg7d = recent.reduce((s, d) => s + d.value, 0) / recent.length;
    const prev = this.fngHistory.slice(-14, -7);
    const avgPrev = prev.length > 0 ? prev.reduce((s, d) => s + d.value, 0) / prev.length : avg7d;
    const direction = avg7d > avgPrev + 3 ? 'rising' : avg7d < avgPrev - 3 ? 'falling' : 'flat';
    return { current, avg7d: Math.round(avg7d), direction };
  }

  private buildSummary(): string {
    const parts: string[] = [];

    const cpi = this.getLatestMacro('CPIAUCSL');
    if (cpi) parts.push(`CPI: ${cpi.value} (${cpi.date})`);

    const fedRate = this.getLatestMacro('FEDFUNDS');
    if (fedRate) parts.push(`Fed Funds: ${fedRate.value}% (${fedRate.date})`);

    const unemployment = this.getLatestMacro('UNRATE');
    if (unemployment) parts.push(`Unemployment: ${unemployment.value}% (${unemployment.date})`);

    const spread = this.getLatestMacro('T10Y2Y');
    if (spread) parts.push(`10Y-2Y Spread: ${spread.value}% (${spread.date})${spread.value < 0 ? ' [INVERTED - recession signal]' : ''}`);

    const fngTrend = this.getFngTrend();
    if (fngTrend) parts.push(`F&G: ${fngTrend.current} (7d avg ${fngTrend.avg7d}, ${fngTrend.direction})`);

    const recentRegimes = this.regimeHistory.slice(-3);
    if (recentRegimes.length > 0) {
      parts.push(`Recent regimes: ${recentRegimes.map((e) => `${e.previousRegime}→${e.regime}`).join(', ')}`);
    }

    return parts.join(' | ') || 'No historical data available yet.';
  }

  private async pollFRED(): Promise<void> {
    if (!FRED_API_KEY) return;
    console.log('[historical-context] Polling FRED macro indicators...');

    for (const [seriesId, name] of Object.entries(FRED_SERIES)) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const url = `${FRED_BASE_URL}?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=3`;
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) continue;
        const data = await response.json() as { observations?: Array<{ date: string; value: string }> };
        const obs = data.observations?.filter((o) => o.value !== '.');
        if (!obs || obs.length === 0) continue;

        // Store latest 3 observations per series
        for (const o of obs) {
          const existing = this.macroIndicators.find((m) => m.seriesId === seriesId && m.date === o.date);
          if (!existing) {
            this.macroIndicators.push({
              seriesId,
              name,
              date: o.date,
              value: parseFloat(o.value),
              fetchedAt: new Date().toISOString()
            });
          }
        }
      } catch {
        // Non-critical
      }
    }

    // Cap total observations
    if (this.macroIndicators.length > 200) {
      this.macroIndicators = this.macroIndicators
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 200);
    }

    this.lastMacroUpdate = new Date().toISOString();
    this.persist();
    console.log(`[historical-context] FRED updated: ${this.macroIndicators.length} observations stored`);
  }

  private async pollFearGreedHistory(): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch('https://api.alternative.me/fng/?limit=30', { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) return;
      const data = await response.json() as { data?: Array<{ value: string; value_classification: string; timestamp: string }> };
      if (!data.data) return;

      this.fngHistory = data.data.map((d) => ({
        timestamp: new Date(parseInt(d.timestamp) * 1000).toISOString(),
        value: parseInt(d.value),
        label: d.value_classification
      })).reverse(); // oldest first

      this.persist();
    } catch {
      // Non-critical
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(MACRO_PATH)) {
        this.macroIndicators = JSON.parse(fs.readFileSync(MACRO_PATH, 'utf8')) as MacroObservation[];
      }
    } catch { /* corrupt file, start fresh */ }
    try {
      if (fs.existsSync(REGIME_PATH)) {
        this.regimeHistory = JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8')) as RegimeEvent[];
      }
    } catch { /* corrupt file, start fresh */ }
    try {
      if (fs.existsSync(FNG_HISTORY_PATH)) {
        this.fngHistory = JSON.parse(fs.readFileSync(FNG_HISTORY_PATH, 'utf8')) as FngDataPoint[];
      }
    } catch { /* corrupt file, start fresh */ }
  }

  private persist(): void {
    try {
      fs.writeFileSync(MACRO_PATH, JSON.stringify(this.macroIndicators, null, 2), 'utf8');
      fs.writeFileSync(REGIME_PATH, JSON.stringify(this.regimeHistory, null, 2), 'utf8');
      fs.writeFileSync(FNG_HISTORY_PATH, JSON.stringify(this.fngHistory, null, 2), 'utf8');
    } catch {
      // Best effort
    }
  }
}

let store: HistoricalContextStore | undefined;

export function getHistoricalContext(): HistoricalContextStore {
  if (!store) {
    store = new HistoricalContextStore();
    store.start();
  }
  return store;
}
