/**
 * Trading Economics Calendar Fetcher
 * Fetches high-importance macro events (FOMC, NFP, CPI, GDP, ECB, BOE).
 *
 * Endpoint: GET https://api.tradingeconomics.com/calendar?c={client:secret}
 * Schema: each event has importance 1-3 (3 = high), country, date, title, actual, forecast, previous.
 * Rate limit: free tier = 500 calls/month → poll at most every 2 h, cache aggressively.
 */

import { readEnv } from './news-intel-parser.js';

export interface MacroEvent {
  id: string;
  country: string;
  event: string;       // raw title from TE
  importance: 1 | 2 | 3;
  scheduledAt: string; // ISO datetime UTC
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  /** Symbols affected by this event */
  affectedSymbols: string[];
}

export interface MacroEmbargo {
  symbol: string;
  blocked: boolean;
  reason: string;
  activeUntil: string | null;
  kind: 'macro';
}

// ── Asset-class mapping ──────────────────────────────────────────────────────
const ALL_RISK_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'PAXG-USD'];

function resolveAffectedSymbols(event: string, country: string): string[] {
  const title = event.toLowerCase();
  const c = country.toUpperCase();

  if (/\b(fomc|federal reserve|interest rate|fed rate|fed decision)\b/.test(title)) {
    // FOMC / Fed rate → USD + broad risk
    return ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'PAXG-USD', 'SPY', 'QQQ', 'DXY'];
  }
  if (/\b(non-farm payrolls|nfp|unemployment|jobs report)\b/.test(title)) {
    return ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'PAXG-USD', 'SPY', 'QQQ', 'DXY'];
  }
  if (/\b(cpi|inflation|consumer price|core cpi|pce|ppi|producer price)\b/.test(title)) {
    return ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'PAXG-USD', 'TLT', 'SPY', 'QQQ', 'DXY'];
  }
  if (/\b(gdp|gross domestic)\b/.test(title)) {
    if (c === 'UNITED STATES') return ['DXY', 'BTC-USD', 'SPY', 'QQQ'];
    if (c === 'EURO AREA') return ['EURUSD', 'BTC-USD', 'SPY'];
    if (c === 'CHINA') return ['CNYUSD', 'BTC-USD', 'SPY', 'QQQ'];
    if (c === 'UNITED KINGDOM') return ['GBPUSD', 'BTC-USD', 'SPY'];
    if (c === 'JAPAN') return ['JPYUSD', 'BTC-USD', 'SPY'];
    return ['BTC-USD', 'SPY'];
  }
  if (/\b(ecb|european central|euro rate)\b/.test(title)) {
    return ['EURUSD', 'BTC-USD', 'ETH-USD', 'SPY'];
  }
  if (/\b(boe|bank of england|british rate)\b/.test(title)) {
    return ['GBPUSD', 'BTC-USD', 'ETH-USD', 'SPY'];
  }
  if (/\b(boe|boc|bank of canada|boc rate)\b/.test(title)) {
    return ['CADUSD', 'BTC-USD', 'SPY'];
  }
  if (/\b(pmi|ism|manufacturing|retail sales|consumer confidence|trade balance)\b/.test(title)) {
    // Major-country releases still move broad risk
    if (c === 'UNITED STATES') return ['DXY', 'BTC-USD', 'SPY', 'QQQ'];
    return ['BTC-USD', 'SPY'];
  }
  // Default: include only the crypto basket for obscure high-impact releases
  return ALL_RISK_SYMBOLS;
}

// ── TE API response shape ────────────────────────────────────────────────────
interface TERawEvent {
  Country?: string;
  Date?: string;
  Title?: string;
  Importance?: number;
  Actual?: string | null;
  Forecast?: string | null;
  Previous?: string | null;
  Category?: string;
}

// ── HTTP helper (shared timeout) ────────────────────────────────────────────
async function fetchWithTimeout(input: string | URL, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all HIGH-importance (importance === 3) macro events for the next 7 days.
 * Returns an empty array if TRADING_ECONOMICS_API_KEY is absent or fetch fails.
 */
export async function fetchUpcomingMacroEvents(): Promise<MacroEvent[]> {
  const apiKey = readEnv(['TRADING_ECONOMICS_API_KEY']);
  if (!apiKey) {
    console.warn('[trading-economics] TRADING_ECONOMICS_API_KEY not set — skipping TE poll');
    return [];
  }

  // Build date window: today → +7 days (YYYY-MM-DD)
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  const url = `https://api.tradingeconomics.com/calendar?c=${encodeURIComponent(apiKey)}&from=${from}&to=${to}`;
  try {
    const response = await fetchWithTimeout(url, 5_000);
    if (!response.ok) {
      console.warn(`[trading-economics] HTTP ${response.status}`);
      return [];
    }

    const payload = await response.json() as TERawEvent[] | { message?: string };
    if (!Array.isArray(payload)) {
      console.warn('[trading-economics] unexpected payload shape');
      return [];
    }

    return payload
      .filter((item): item is TERawEvent =>
        item.Importance === 3 &&
        typeof item.Date === 'string' &&
        typeof item.Title === 'string'
      )
      .map((item) => {
        const scheduledAt = item.Date ?? '';
        const affectedSymbols = resolveAffectedSymbols(item.Title ?? '', item.Country ?? '');
        return {
          id: `te:${scheduledAt}:${(item.Title ?? '').slice(0, 40).replace(/\s+/g, '-')}`,
          country: item.Country ?? '',
          event: item.Title ?? '',
          importance: 3 as const,
          scheduledAt,
          actual: item.Actual ?? null,
          forecast: item.Forecast ?? null,
          previous: item.Previous ?? null,
          affectedSymbols
        };
      });
  } catch (err) {
    console.warn('[trading-economics] fetch failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Returns true if a symbol is in the embargo window for any given macro event.
 * Pre-embargo: 60 min before scheduledAt.
 * Post-embargo: 30 min after scheduledAt.
 */
export function checkMacroEmbargo(
  symbol: string,
  macroEvents: MacroEvent[],
  nowMs = Date.now()
): MacroEmbargo {
  const PRE_EMBARGO_MS = 60 * 60 * 1_000;  // 60 min
  const POST_EMBARGO_MS = 30 * 60 * 1_000; // 30 min

  for (const event of macroEvents) {
    const eventMs = Date.parse(event.scheduledAt);
    if (!Number.isFinite(eventMs)) continue;
    if (!event.affectedSymbols.includes(symbol)) continue;

    const embargoStart = eventMs - PRE_EMBARGO_MS;
    const embargoEnd = eventMs + POST_EMBARGO_MS;

    if (nowMs >= embargoStart && nowMs <= embargoEnd) {
      return {
        symbol,
        blocked: true,
        reason: `macro embargo: ${event.event} (TE, ${event.country})`,
        activeUntil: new Date(embargoEnd).toISOString(),
        kind: 'macro'
      };
    }
  }

  return { symbol, blocked: false, reason: '', activeUntil: null, kind: 'macro' };
}
