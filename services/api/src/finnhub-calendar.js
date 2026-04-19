import { readEnv } from './news-intel-parser.js';
const FINNHUB_EARNINGS_URL = 'https://finnhub.io/api/v1/calendar/earnings';
async function fetchWithTimeout(input, timeoutMs = 8000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(input, { signal: controller.signal });
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * Fetch upcoming earnings events from Finnhub.
 * @param lookaheadDays Number of days ahead to fetch (from today)
 * @returns Array of EarningsEvent objects
 */
export async function fetchUpcomingEarnings(lookaheadDays) {
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
        const payload = await response.json();
        const calendar = payload.earningsCalendar ?? [];
        return calendar
            .filter((item) => typeof item.symbol === 'string' && typeof item.date === 'string')
            .map((item) => ({
            symbol: item.symbol.toUpperCase(),
            date: item.date,
            hour: normalizeHour(item.hour ?? ''),
        }));
    }
    catch (err) {
        console.warn('[finnhub-calendar] fetch failed:', err instanceof Error ? err.message : String(err));
        return [];
    }
}
/**
 * Normalize Finnhub hour string to our canonical form.
 * Finnhub returns: "bmo" (before market open), "amc" (after market close),
 * "dmh" (during market hours), or "" for unknown.
 */
function normalizeHour(hour) {
    if (hour === 'bmo' || hour === 'amc' || hour === 'dmh')
        return hour;
    return '';
}
