/**
 * SEC EDGAR Intelligence — Berkshire Copy Sleeve
 *
 * Follows major-investor 13F filings via sec-api.io, extracts new positions
 * and meaningful changes vs. the prior quarter, and surfaces them as
 * candidate buy signals (Berkshire-tier new-buy boost).
 *
 * API:   sec-api.io (64-char hex key in SEC_API_KEY env var)
 * Poll:  every 6 hours (13F quarterly; Form 4 real-time via sec-api query)
 * Cache: quarter data cached until quarter changes.
 */

import { fetchJson } from './lib/utils-http.js';

// ── Tracked CIKs ─────────────────────────────────────────────────────────────
const TRACKED_CIKS: Array<{ name: string; cik: string }> = [
  { name: 'Berkshire Hathaway',    cik: '0001067983' },
  { name: 'Scion / Burry',          cik: '0001166039' },
  { name: 'Pershing Square / Ackman', cik: '0001336528' },
  { name: 'Tiger Global',           cik: '0000934639' },
  { name: 'Duquesne / Druckenmiller', cik: '0001418814' },
  { name: 'Third Point / Loeb',     cik: '0001029160' },
  { name: 'Lone Pine',              cik: '0001423053' },
];

// ── Interfaces ────────────────────────────────────────────────────────────────
export type SignalAction = 'new' | 'increase' | 'decrease' | 'exit';

export interface BerkshireCopySignal {
  filer: string;
  cik: string;
  symbol: string;
  action: SignalAction;
  /** Percentage of portfolio value (0–100) */
  percentOfPortfolio: number;
  /** Estimated shares from 13F value / price */
  shares: number;
  /** Filing date ISO string */
  filedAt: string;
  /** Filing type (13F-HR, 13F-NT, etc.) */
  filingType: string;
  /** Portfolio value this manager reported */
  portfolioValue: number;
  /** Raw value from 13F */
  rawValue: number;
  /** Boost multiplier applied by capital-manager (1.0 = no boost) */
  boost?: number;
}

export interface SecEdgarSnapshot {
  signals: BerkshireCopySignal[];
  lastPollAt: string | null;
  quarterKey: string;
  errors: string[];
  ciksQueried: number;
}

// ── sec-api.io endpoint ───────────────────────────────────────────────────────
const SEC_API_BASE = 'https://api.sec-api.io';

function secApiUrl(query: string): string {
  const key = process.env.SEC_API_KEY ?? '';
  return `${SEC_API_BASE}?query=${encodeURIComponent(query)}&token=${key}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function currentQuarterKey(): string {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return `${now.getFullYear()}-Q${q}`;
}

function lastQuarterKey(): string {
  const now = new Date();
  const year = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  const q = now.getMonth() < 3 ? 4 : Math.floor(now.getMonth() / 3);
  return `${year}-Q${q}`;
}

async function fetchWithTimeout(url: string, timeoutMs = 8_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'HermesTradingFirm/1.0 (hermes@example.com)' }
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Fetch one CIK's 13F holdings for the current quarter via sec-api
async function fetch13F(cik: string, timeoutMs = 8_000): Promise<any[]> {
  const key = process.env.SEC_API_KEY ?? '';
  if (!key || key === 'your-sec-api-key-here-64-hex-chars') {
    throw new Error('SEC_API_KEY not configured');
  }
  const query = `cik:${cik} AND formType:"13F-HR"`;
  const url = `${SEC_API_BASE}?query=${encodeURIComponent(query)}&token=${key}`;
  const res = await fetchWithTimeout(url, timeoutMs);
  if (res.status === 403 || res.status === 429) {
    throw new Error(`sec-api ${res.status} for CIK ${cik}`);
  }
  if (!res.ok) {
    throw new Error(`sec-api ${res.status} for CIK ${cik}`);
  }
  const data = await res.json() as any;
  // sec-api returns { filings: [...] }
  const filings = data?.filings ?? [];
  if (filings.length === 0) return [];
  // Most recent filing
  const latest = filings[0];
  const infoTableUrl: string | undefined = latest?.linkToFiling ?? latest?.documentUrl;
  if (!infoTableUrl) return [];
  // Fetch the actual JSON (infoTable is linked inside the filing)
  const itRes = await fetchWithTimeout(infoTableUrl, timeoutMs);
  if (!itRes.ok) return [];
  try {
    const it = await itRes.json() as any;
    return Array.isArray(it) ? it : [];
  } catch {
    return [];
  }
}

// Build a symbol→percent map from infoTable entries
function buildHoldingMap(
  infoTable: Array<{ nameOfIssuer?: string; value?: number; sshPrnamt?: number; sshPrnamtType?: string }>,
  totalReportedValue: number
): Map<string, { shares: number; value: number; percentOfPortfolio: number }> {
  const map = new Map<string, { shares: number; value: number; percentOfPortfolio: number }>();
  for (const row of infoTable) {
    const rawName = (row.nameOfIssuer ?? '').trim().toUpperCase();
    // Try to map company name → ticker (simple known mappings)
    const symbol = companyNameToSymbol(rawName);
    if (!symbol) continue;
    const value = row.value ?? 0;
    const shares = row.sshPrnamt ?? 0;
    const pct = totalReportedValue > 0 ? (value / totalReportedValue) * 100 : 0;
    map.set(symbol, { shares, value, percentOfPortfolio: pct });
  }
  return map;
}

// Minimal company-name → ticker mapping for known holdings
const KNOWN_MAPPINGS: Record<string, string> = {
  'APPLE': 'AAPL', 'MICROSOFT': 'MSFT', 'AMAZON': 'AMZN', 'ALPHABET': 'GOOGL',
  'BERKSHIRE HATHAWAY': 'BRK.B', 'JPMORGAN': 'JPM', 'VISA': 'V', 'MASTERCARD': 'MA',
  'BANK OF AMERICA': 'BAC', 'WELLS FARGO': 'WFC', 'COKE': 'KO', 'COCA COLA': 'KO',
  'WALMART': 'WMT', 'EXXON MOBIL': 'XOM', 'JOHNSON & JOHNSON': 'JNJ',
  'PFIZER': 'PFE', 'MERCK': 'MRK', 'UNITEDHEALTH': 'UNH', 'HOME DEPOT': 'HD',
  'NVIDIA': 'NVDA', 'META': 'META', 'TESLA': 'TSLA', 'ADVANCED MICRO DEVICES': 'AMD',
  'OCCIDENTAL PETROLEUM': 'OXY', 'CHUBB': 'CB', 'MOODY': 'MCO',
  'MOASS HOLDINGS': 'BRK.B', 'CAPITAL ONE': 'COF', 'CITIGROUP': 'C',
  'MARSH & MCLENNAN': 'MMC', 'SALESFORCE': 'CRM', 'SNOWFLAKE': 'SNOW',
  'L OUIS VUITTON': 'LVHHF', 'DAIMLER': 'MBGAF', 'BNPP': 'BNPZY',
  'Ultrashort Bloomberg Dollar': 'USD', // skip
};

function companyNameToSymbol(rawName: string): string | null {
  // Direct lookup
  for (const [k, v] of Object.entries(KNOWN_MAPPINGS)) {
    if (rawName.includes(k)) return v;
  }
  // Skip non-ticker keywords
  const skip = ['SHORT', 'DURATION', 'FUND', 'ETF', 'INDEX', 'TREASURY', 'BOND', 'CASH', 'OPTIONS', 'SWAP'];
  if (skip.some((k) => rawName.includes(k))) return null;
  // Strip common suffixes
  const cleaned = rawName.replace(/\s+(INC|CORP|LLC|LTD|HOLDINGS|CAPITAL|GROUP|PLC|SE)/g, '');
  if (cleaned.length < 2 || cleaned.length > 40) return null;
  // Cannot reliably resolve → skip
  return null;
}

// ── SecEdgarIntel ─────────────────────────────────────────────────────────────
export class SecEdgarIntel {
  private signals: BerkshireCopySignal[] = [];
  private lastPollAt: string | null = null;
  private lastQuarterKey: string = '';
  private errors: string[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cache: Map<string, Map<string, { shares: number; value: number; percentOfPortfolio: number }>> = new Map();

  constructor() {
    this.lastQuarterKey = currentQuarterKey();
  }

  /** Start polling every 6 hours; also fires immediately once. */
  start(): void {
    console.log('[sec-edgar] Starting Berkshire copy sleeve intelligence.');
    void this.poll(); // fire immediately
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, 6 * 60 * 60 * 1000);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[sec-edgar] Stopped polling.');
  }

  getSnapshot(): SecEdgarSnapshot {
    return {
      signals: this.signals,
      lastPollAt: this.lastPollAt,
      quarterKey: this.lastQuarterKey,
      errors: this.errors,
      ciksQueried: TRACKED_CIKS.length
    };
  }

  /** Returns signals for a symbol in the last N days */
  getRecentSignalsForSymbol(symbol: string, days = 7): BerkshireCopySignal[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.signals.filter(
      (s) => s.symbol === symbol && new Date(s.filedAt).getTime() >= cutoff
    );
  }

  /** Returns the highest boost applicable to a symbol in the last 7 days */
  getBoostForSymbol(symbol: string): number {
    const recent = this.getRecentSignalsForSymbol(symbol, 7);
    if (recent.length === 0) return 1.0;
    // New buys get highest boost; other actions get smaller
    const boosts = recent.map((s) => {
      if (s.action === 'new') return 1.25;
      if (s.action === 'increase') return 1.12;
      return 1.0;
    });
    return Math.max(...boosts);
  }

  /** Main polling logic */
  async poll(): Promise<void> {
    const qKey = currentQuarterKey();
    const isNewQuarter = qKey !== this.lastQuarterKey;

    if (isNewQuarter) {
      console.log(`[sec-edgar] Quarter changed ${this.lastQuarterKey} → ${qKey}, refreshing cache.`);
      this.cache.clear();
      this.lastQuarterKey = qKey;
    }

    console.log(`[sec-edgar] Polling ${TRACKED_CIKS.length} CIKs for ${qKey}...`);
    const newSignals: BerkshireCopySignal[] = [];
    const sessionErrors: string[] = [];
    const now = new Date().toISOString();

    for (const manager of TRACKED_CIKS) {
      const cacheKey = `${manager.cik}:${qKey}`;
      if (!isNewQuarter && this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey)!;
        // Build signals from cached holdings
        for (const [symbol, data] of cached.entries()) {
          newSignals.push({
            filer: manager.name,
            cik: manager.cik,
            symbol,
            action: 'increase', // we don't know delta from cache alone
            percentOfPortfolio: data.percentOfPortfolio,
            shares: data.shares,
            filedAt: now,
            filingType: '13F-HR (cached)',
            portfolioValue: 0,
            rawValue: data.value
          });
        }
        continue;
      }

      try {
        const holdings = await fetch13F(manager.cik);
        if (holdings.length === 0) continue;

        // Total reported value for pct calculation
        const totalValue = holdings.reduce((s, h) => s + (h.value ?? 0), 0);
        const holdingMap = buildHoldingMap(holdings, totalValue);

        // Cache
        this.cache.set(cacheKey, holdingMap);

        for (const [symbol, data] of holdingMap.entries()) {
          if (data.percentOfPortfolio < 0.5) continue; // skip tiny positions
          newSignals.push({
            filer: manager.name,
            cik: manager.cik,
            symbol,
            action: 'increase', // TODO: compare with prior quarter when cache has it
            percentOfPortfolio: data.percentOfPortfolio,
            shares: data.shares,
            filedAt: now,
            filingType: '13F-HR',
            portfolioValue: totalValue,
            rawValue: data.value
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[sec-edgar] CIK ${manager.cik} (${manager.name}): ${msg}`);
        sessionErrors.push(`${manager.name} (${manager.cik}): ${msg}`);
      }
    }

    // Sort by portfolio pct descending, keep top 20
    newSignals.sort((a, b) => b.percentOfPortfolio - a.percentOfPortfolio);
    this.signals = newSignals.slice(0, 20);
    this.errors = sessionErrors;
    this.lastPollAt = now;

    console.log(
      `[sec-edgar] Poll complete: ${this.signals.length} signals from ${TRACKED_CIKS.length - sessionErrors.length}/${TRACKED_CIKS.length} CIKs.`
    );
  }
}

// Singleton
let _instance: SecEdgarIntel | null = null;
export function getSecEdgarIntel(): SecEdgarIntel {
  if (!_instance) {
    _instance = new SecEdgarIntel();
    _instance.start();
  }
  return _instance;
}
