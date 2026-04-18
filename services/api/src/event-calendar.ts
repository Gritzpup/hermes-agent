/**
 * Event calendar and embargo windows.
 *
 * Current scope:
 * - upcoming earnings for tracked equities via FMP stable API
 * - active macro embargo when news-intel reports critical macro risk
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNewsIntel } from './news-intel.js';
import { fetchUpcomingEarnings, type EarningsEvent } from './finnhub-calendar.js';
import { fetchUpcomingMacroEvents, checkMacroEmbargo, type MacroEvent } from './trading-economics-calendar.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ENV_PATH = path.resolve(MODULE_DIR, '../../../.env');
const RUNTIME_DIR = path.resolve(MODULE_DIR, '../.runtime/event-calendar');
const SNAPSHOT_PATH = path.join(RUNTIME_DIR, 'snapshot.json');
const POLL_MS = Number(process.env.EVENT_CALENDAR_POLL_MS ?? 3_600_000);
const EARNINGS_LOOKAHEAD_DAYS = Number(process.env.EARNINGS_LOOKAHEAD_DAYS ?? 10);
const EARNINGS_PRE_EMBARGO_HOURS = Number(process.env.EARNINGS_PRE_EMBARGO_HOURS ?? 24);
const EARNINGS_POST_EMBARGO_HOURS = Number(process.env.EARNINGS_POST_EMBARGO_HOURS ?? 4);

const TRACKED_SYMBOLS = (process.env.EVENT_CALENDAR_SYMBOLS ?? 'NVDA,SPY,QQQ')
  .split(',')
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);

// Free economic calendar from Forex Factory (no auth required)
const ECONOMIC_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const ECONOMIC_POLL_MS = Number(process.env.ECONOMIC_CALENDAR_POLL_MS ?? 3_600_000); // 1 hour
// Embargo windows for high-impact economic events
const ECONOMIC_PRE_EMBARGO_MIN = 30;  // 30 minutes before release
const ECONOMIC_POST_EMBARGO_MIN = 15; // 15 minutes after release
// High-impact events that affect all risk assets
const HIGH_IMPACT_KEYWORDS = ['nfp', 'non-farm', 'cpi', 'fomc', 'fed', 'interest rate', 'gdp', 'pce', 'ppi', 'retail sales', 'unemployment'];

// Trading Economics polling (500 calls/month free tier → max every 2 h)
const TE_POLL_MS = Number(process.env.TE_POLL_MS ?? 7_200_000);
const TE_LOOKAHEAD_DAYS = 7;

// Finnhub earnings polling
const FINNHUB_POLL_MS = 3_600_000; // 1 hour
const FINNHUB_LOOKAHEAD_DAYS = 14;
const FINNHUB_PRE_EMBARGO_HOURS = 2;
const FINNHUB_POST_EMBARGO_HOURS = 4;

export interface CalendarEvent {
  id: string;
  symbol: string;
  kind: 'earnings' | 'macro' | 'economic';
  title: string;
  eventAt: string;
  embargoStartsAt: string;
  embargoEndsAt: string;
  severity: 'info' | 'warning' | 'critical';
  source: string;
}

export interface EventEmbargo {
  symbol: string;
  blocked: boolean;
  reason: string;
  activeUntil: string | null;
  kind: 'earnings' | 'macro' | 'economic' | 'none';
}

export interface EventCalendarSnapshot {
  timestamp: string;
  events: CalendarEvent[];
  activeEmbargoes: EventEmbargo[];
  missingKeys: string[];
  upcomingMacro: MacroEvent[];
}

const ENV_CACHE = loadProjectEnv();

function loadProjectEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    if (!fs.existsSync(PROJECT_ENV_PATH)) return values;
    for (const rawLine of fs.readFileSync(PROJECT_ENV_PATH, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in values)) values[key] = value;
    }
  } catch {
    // Ignore local env failures.
  }
  return values;
}

async function fetchWithTimeout(input: string | URL, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function readEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name] ?? ENV_CACHE[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export class EventCalendar {
  private timer: NodeJS.Timeout | null = null;
  private economicTimer: NodeJS.Timeout | null = null;
  private finnhubTimer: NodeJS.Timeout | null = null;
  private teTimer: NodeJS.Timeout | null = null;
  private refreshInFlight = false;
  private economicRefreshInFlight = false;
  private finnhubRefreshInFlight = false;
  private teRefreshInFlight = false;
  private events: CalendarEvent[] = [];
  private economicEvents: CalendarEvent[] = [];
  private finnhubEarnings: EarningsEvent[] = [];
  private teEvents: MacroEvent[] = [];

  start(): void {
    if (this.timer) return;
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    this.loadPersisted();
    void this.refresh();
    void this.refreshEconomicCalendar();
    void this.refreshFinnhubEarnings();
    void this.refreshTE();
    this.timer = setInterval(() => { void this.refresh(); }, POLL_MS);
    this.economicTimer = setInterval(() => { void this.refreshEconomicCalendar(); }, ECONOMIC_POLL_MS);
    this.finnhubTimer = setInterval(() => { void this.refreshFinnhubEarnings(); }, FINNHUB_POLL_MS);
    this.teTimer = setInterval(() => { void this.refreshTE(); }, TE_POLL_MS);
    console.log('[event-calendar] started (earnings + economic calendar + Finnhub + Trading Economics)');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.economicTimer) { clearInterval(this.economicTimer); this.economicTimer = null; }
    if (this.finnhubTimer) { clearInterval(this.finnhubTimer); this.finnhubTimer = null; }
    if (this.teTimer) { clearInterval(this.teTimer); this.teTimer = null; }
  }

  getSnapshot(): EventCalendarSnapshot {
    const allEvents = [...this.events, ...this.economicEvents];
    const activeEmbargoes = unique(['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'PAXG-USD', ...TRACKED_SYMBOLS])
      .map((symbol) => this.getEmbargo(symbol))
      .filter((embargo): embargo is EventEmbargo => embargo.blocked);
    const missingKeys = this.detectMissingKeys();
    if (missingKeys.length > 0) {
      console.warn(`[event-calendar] degraded — missing API keys: ${missingKeys.join(', ')}`);
    }
    if (allEvents.length === 0) {
      console.warn(`[event-calendar] no events found for tracked symbols (${TRACKED_SYMBOLS.join(',')}). Check TRACKED_SYMBOLS and earnings windows.`);
    }
    return {
      timestamp: new Date().toISOString(),
      events: allEvents.sort((a, b) => a.eventAt.localeCompare(b.eventAt)),
      activeEmbargoes,
      missingKeys,
      upcomingMacro: this.teEvents
    };
  }

  private detectMissingKeys(): string[] {
    const missing: string[] = [];
    if (!readEnv(['FMP_API_KEY', 'FINANCIAL_MODELING_PREP_API_KEY'])) missing.push('FMP_API_KEY');
    if (!readEnv(['FINNHUB_API_KEY'])) missing.push('FINNHUB_API_KEY');
    if (!readEnv(['TRADING_ECONOMICS_API_KEY'])) missing.push('TRADING_ECONOMICS_API_KEY');
    return missing;
  }

  getEmbargo(symbol: string): EventEmbargo {
    const now = Date.now();
    // Fix #18: Re-enable macro embargo for crypto — protects from CPI/FOMC whipsaws
    if (symbol.endsWith('-USD') && !symbol.includes('_')) {
      try {
        const macroSignal = getNewsIntel().getMacroSignal();
        if (macroSignal.veto) {
          return { symbol, blocked: true, reason: `Macro embargo: ${macroSignal.reasons[0] ?? 'critical macro event'}`, activeUntil: new Date(now + 30 * 60 * 1000).toISOString(), kind: 'macro' };
        }
      } catch { /* news-intel not ready */ }
    }

    // Check Trading Economics macro embargo (60 min pre, 30 min post)
    const teEmbargo = checkMacroEmbargo(symbol, this.teEvents, now);
    if (teEmbargo.blocked) return teEmbargo;

    // Check Finnhub earnings embargo: 2h pre or 4h post
    const normalizedSymbol = symbol.replace('-USD$', '').replace('_USD$', '').toUpperCase();
    const finnhubEmbargo = this.checkFinnhubEarningsEmbargo(normalizedSymbol, now);
    if (finnhubEmbargo.blocked) return finnhubEmbargo;

    const allEvents = [...this.events, ...this.economicEvents];
    const activeEvent = allEvents.find((event) =>
      event.symbol === symbol &&
      Date.parse(event.embargoStartsAt) <= now &&
      Date.parse(event.embargoEndsAt) >= now
    );

    if (!activeEvent) {
      return {
        symbol,
        blocked: false,
        reason: '',
        activeUntil: null,
        kind: 'none'
      };
    }

    return {
      symbol,
      blocked: true,
      reason: `${activeEvent.kind} embargo: ${activeEvent.title}`,
      activeUntil: activeEvent.embargoEndsAt,
      kind: activeEvent.kind
    };
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      const apiKey = readEnv(['FMP_API_KEY', 'FINANCIAL_MODELING_PREP_API_KEY']);
      if (!apiKey) {
        console.warn('[event-calendar] FMP_API_KEY not set — cannot fetch earnings');
        return;
      }

      const from = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.now() + EARNINGS_LOOKAHEAD_DAYS * 86_400_000).toISOString().slice(0, 10);
      try {
        const url = new URL('https://financialmodelingprep.com/stable/earnings-calendar');
        url.searchParams.set('from', from);
        url.searchParams.set('to', to);
        url.searchParams.set('apikey', apiKey);
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json() as Array<{
          symbol?: string;
          date?: string;
          time?: string;
        }>;
        const nextEvents = payload
          .filter((item) => typeof item.symbol === 'string' && TRACKED_SYMBOLS.includes(item.symbol.toUpperCase()))
          .map((item) => toCalendarEvent(item))
          .filter((item): item is CalendarEvent => item !== null);
        if (nextEvents.length === 0) {
          console.warn(`[event-calendar] FMP returned ${payload.length} events but none match tracked symbols: ${TRACKED_SYMBOLS.join(', ')}`);
        }
        this.events = nextEvents;
        this.persist();
      } catch (error) {
        console.warn('[event-calendar] FMP refresh failed:', error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  /**
   * Polls the free Forex Factory economic calendar for high-impact events
   * (NFP, CPI, FOMC, etc.) and creates embargo windows around them.
   * High-impact USD events apply to all risk assets.
   */
  private async refreshEconomicCalendar(): Promise<void> {
    if (this.economicRefreshInFlight) return;
    this.economicRefreshInFlight = true;
    try {
      const response = await fetchWithTimeout(ECONOMIC_CALENDAR_URL, 8_000);
      if (!response.ok) {
        console.warn(`[event-calendar] economic calendar HTTP ${response.status}`);
        return;
      }
      const payload = await response.json() as Array<{
        title?: string;
        country?: string;
        date?: string;
        impact?: string;
        forecast?: string;
        previous?: string;
      }>;
      if (!Array.isArray(payload)) return;

      const now = Date.now();
      const nextEvents: CalendarEvent[] = [];

      for (const item of payload) {
        if (!item.title || !item.date || item.impact !== 'High') continue;
        const titleLower = item.title.toLowerCase();
        const isHighImpact = HIGH_IMPACT_KEYWORDS.some((kw) => titleLower.includes(kw));
        if (!isHighImpact) continue;

        const eventAtMs = Date.parse(item.date);
        if (!Number.isFinite(eventAtMs)) continue;
        // Only keep future events or events within the post-embargo window
        if (eventAtMs + ECONOMIC_POST_EMBARGO_MIN * 60_000 < now) continue;

        const eventAt = new Date(eventAtMs).toISOString();
        const embargoStartsAt = new Date(eventAtMs - ECONOMIC_PRE_EMBARGO_MIN * 60_000).toISOString();
        const embargoEndsAt = new Date(eventAtMs + ECONOMIC_POST_EMBARGO_MIN * 60_000).toISOString();

        // High-impact USD events create embargoes for all risk assets
        const affectedSymbols = isRiskAsset('SPY')
          ? ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'PAXG-USD', ...TRACKED_SYMBOLS]
          : TRACKED_SYMBOLS;

        for (const symbol of unique(affectedSymbols)) {
          nextEvents.push({
            id: `economic:${symbol}:${eventAt}:${titleLower.slice(0, 30)}`,
            symbol,
            kind: 'economic',
            title: `${item.title} (${item.country ?? 'USD'})`,
            eventAt,
            embargoStartsAt,
            embargoEndsAt,
            severity: 'critical',
            source: 'forex-factory'
          });
        }
      }

      this.economicEvents = nextEvents;
      if (nextEvents.length > 0) {
        console.log(`[event-calendar] Loaded ${nextEvents.length} high-impact economic events`);
      }
      this.persist();
    } catch (error) {
      console.warn('[event-calendar] economic calendar refresh failed', error);
    } finally {
      this.economicRefreshInFlight = false;
    }
  }

  /**
   * Polls Finnhub earnings calendar and caches results.
   * Called on start and then every FINNHUB_POLL_MS.
   */
  private async refreshFinnhubEarnings(): Promise<void> {
    if (this.finnhubRefreshInFlight) return;
    this.finnhubRefreshInFlight = true;
    try {
      const earnings = await fetchUpcomingEarnings(FINNHUB_LOOKAHEAD_DAYS);
      this.finnhubEarnings = earnings;
      if (earnings.length > 0) {
        console.log(`[event-calendar] Loaded ${earnings.length} Finnhub earnings events`);
      } else {
        console.warn(`[event-calendar] Finnhub returned 0 earnings for the next ${FINNHUB_LOOKAHEAD_DAYS} days`);
      }
    } catch (error) {
      console.warn('[event-calendar] Finnhub earnings refresh failed:', error instanceof Error ? error.message : String(error));
    } finally {
      this.finnhubRefreshInFlight = false;
    }
  }

  /**
   * Polls Trading Economics for high-importance macro events and caches results.
   * TE free tier = 500 calls/month → poll at most every 2 h.
   */
  private async refreshTE(): Promise<void> {
    if (this.teRefreshInFlight) return;
    this.teRefreshInFlight = true;
    try {
      const events = await fetchUpcomingMacroEvents();
      this.teEvents = events;
      if (events.length > 0) {
        console.log(`[event-calendar] Loaded ${events.length} Trading Economics macro events`);
      }
    } catch (error) {
      console.warn('[event-calendar] Trading Economics refresh failed:', error instanceof Error ? error.message : String(error));
    } finally {
      this.teRefreshInFlight = false;
    }
  }

  /**
   * Checks if symbol has a Finnhub earnings event within embargo window.
   * Embargo: 2h before earnings to 4h after earnings.
   */
  private checkFinnhubEarningsEmbargo(symbol: string, nowMs: number): EventEmbargo {
    for (const event of this.finnhubEarnings) {
      if (event.symbol.toUpperCase() !== symbol) continue;
      const eventMs = Date.parse(event.date);
      if (!Number.isFinite(eventMs)) continue;
      const preStart = eventMs - FINNHUB_PRE_EMBARGO_HOURS * 3_600_000;
      const postEnd = eventMs + FINNHUB_POST_EMBARGO_HOURS * 3_600_000;
      if (nowMs >= preStart && nowMs <= postEnd) {
        return {
          symbol,
          blocked: true,
          reason: `earnings embargo (Finnhub)`,
          activeUntil: new Date(postEnd).toISOString(),
          kind: 'earnings'
        };
      }
    }
    return { symbol, blocked: false, reason: '', activeUntil: null, kind: 'none' };
  }

  private persist(): void {
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(this.getSnapshot(), null, 2), 'utf8');
    } catch {
      // Ignore persistence failure.
    }
  }

  private loadPersisted(): void {
    try {
      if (!fs.existsSync(SNAPSHOT_PATH)) return;
      const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as Partial<EventCalendarSnapshot>;
      this.events = Array.isArray(parsed.events) ? parsed.events as CalendarEvent[] : [];
    } catch {
      // Ignore persisted snapshot failures.
    }
  }
}

function toCalendarEvent(item: { symbol?: string; date?: string; time?: string }): CalendarEvent | null {
  const symbol = item.symbol?.toUpperCase();
  if (!symbol || !item.date) return null;
  const timeText = typeof item.time === 'string' && item.time.trim() ? item.time.trim() : '16:00';
  const eventAt = normalizeEventDate(item.date, timeText);
  if (!eventAt) return null;
  const eventAtMs = Date.parse(eventAt);
  return {
    id: `earnings:${symbol}:${eventAt}`,
    symbol,
    kind: 'earnings',
    title: `${symbol} earnings window`,
    eventAt,
    embargoStartsAt: new Date(eventAtMs - EARNINGS_PRE_EMBARGO_HOURS * 3_600_000).toISOString(),
    embargoEndsAt: new Date(eventAtMs + EARNINGS_POST_EMBARGO_HOURS * 3_600_000).toISOString(),
    severity: 'warning',
    source: 'fmp-stable'
  };
}

function normalizeEventDate(date: string, timeText: string): string | null {
  const safeTime = /^\d{1,2}:\d{2}$/.test(timeText) ? `${timeText}:00` : '16:00:00';
  const parsed = Date.parse(`${date}T${safeTime}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isRiskAsset(symbol: string): boolean {
  return symbol.endsWith('-USD') || ['SPY', 'QQQ', 'NVDA'].includes(symbol);
}

let calendar: EventCalendar | undefined;

export function getEventCalendar(): EventCalendar {
  if (!calendar) {
    calendar = new EventCalendar();
    calendar.start();
  }
  return calendar;
}
