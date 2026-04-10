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

export interface CalendarEvent {
  id: string;
  symbol: string;
  kind: 'earnings' | 'macro';
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
  kind: 'earnings' | 'macro' | 'none';
}

export interface EventCalendarSnapshot {
  timestamp: string;
  events: CalendarEvent[];
  activeEmbargoes: EventEmbargo[];
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
  private refreshInFlight = false;
  private events: CalendarEvent[] = [];

  start(): void {
    if (this.timer) return;
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    this.loadPersisted();
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, POLL_MS);
    console.log('[event-calendar] started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot(): EventCalendarSnapshot {
    const activeEmbargoes = unique(['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'PAXG-USD', ...TRACKED_SYMBOLS])
      .map((symbol) => this.getEmbargo(symbol))
      .filter((embargo): embargo is EventEmbargo => embargo.blocked);
    return {
      timestamp: new Date().toISOString(),
      events: [...this.events].sort((a, b) => a.eventAt.localeCompare(b.eventAt)),
      activeEmbargoes
    };
  }

  getEmbargo(symbol: string): EventEmbargo {
    const now = Date.now();
    // Macro embargo disabled during paper trading — agents need to trade to collect data.
    // Re-enable for live trading by uncommenting the block below.
    // const macroSignal = getNewsIntel().getMacroSignal();
    // if (macroSignal.veto && isRiskAsset(symbol)) {
    //   return { symbol, blocked: true, reason: `Macro embargo: ...`, activeUntil: ..., kind: 'macro' };
    // }

    const activeEvent = this.events.find((event) =>
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
      if (!apiKey) return;

      const from = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.now() + EARNINGS_LOOKAHEAD_DAYS * 86_400_000).toISOString().slice(0, 10);
      try {
        const url = new URL('https://financialmodelingprep.com/stable/earnings-calendar');
        url.searchParams.set('from', from);
        url.searchParams.set('to', to);
        url.searchParams.set('apikey', apiKey);
        const response = await fetchWithTimeout(url);
        const payload = await response.json() as Array<{
          symbol?: string;
          date?: string;
          time?: string;
        }>;
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const nextEvents = payload
          .filter((item) => typeof item.symbol === 'string' && TRACKED_SYMBOLS.includes(item.symbol.toUpperCase()))
          .map((item) => toCalendarEvent(item))
          .filter((item): item is CalendarEvent => item !== null);
        this.events = nextEvents;
        this.persist();
      } catch (error) {
        console.warn('[event-calendar] refresh failed', error);
      }
    } finally {
      this.refreshInFlight = false;
    }
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
