import { readEnv } from './news-intel-parser.js';

/**
 * Finnhub Earnings Calendar
 * Fetches upcoming earnings events from Finnhub API.
 * Endpoint: GET https://finnhub.io/api/v1/calendar/earnings
 */

export interface EarningsEvent {
  symbol: string;
  date: string;     // ISO date (YYYY-MM-DD)
  hour: 'bmo' | 'amc' | 'dmh' | '';  // before market open / after close / during market hours / unknown
}

const FINNHUB_EARNINGS_URL = 'https://finnhub.io/api/v1/calendar/earnings';

async function fetchWithTimeout(input: string | URL, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch upcoming earnings events from Finnhub.
 * @param lookaheadDays Number of days ahead to fetch (from today)
 * @returns Array of EarningsEvent objects
 */
export async function fetchUpcomingEarnings(lookaheadDays: number): Promise<EarningsEvent[]> {
  const apiKey = readEnv(['FINNHUB_API_KEY']);
  if (!apiKey) {
    console.warn('[finnhub-calendar] FINNHUB_API_KEY not set');
    return [];
  }

  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + lookaheadDays * 86_400_000).toISOString().slice(0, 10);

  try {
    const url = `${FINNHUB_EARNINGS_URL}?from=${from}&to=${to}&token=${apiKey}`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      console.warn(`[finnhub-calendar] HTTP ${response.status}`);
      return [];
    }

    const payload = await response.json() as {
      earningsCalendar?: Array<{
        symbol?: string;
        date?: string;
        hour?: string;
      }>;
    };

    const calendar = payload.earningsCalendar ?? [];
    return calendar
      .filter((item): item is { symbol: string; date: string; hour: string } =>
        typeof item.symbol === 'string' && typeof item.date === 'string')
      .map((item) => ({
        symbol: item.symbol.toUpperCase(),
        date: item.date,
        hour: normalizeHour(item.hour ?? ''),
      }));
  } catch (err) {
    console.warn('[finnhub-calendar] fetch failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Normalize Finnhub hour string to our canonical form.
 * Finnhub returns: "bmo" (before market open), "amc" (after market close),
 * "dmh" (during market hours), or "" for unknown.
 */
function normalizeHour(hour: string): EarningsEvent['hour'] {
  if (hour === 'bmo' || hour === 'amc' || hour === 'dmh') return hour;
  return '';
}
