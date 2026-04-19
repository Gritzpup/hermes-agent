/**
 * Twelve Data — universal price backup.
 *
 * Called only when primary sources (Alpaca / OANDA) return no quote for a symbol.
 * GET https://api.twelvedata.com/price?symbol=<s>&apikey=<key>
 * Caches responses for 30s.  Budget-aware: stops calling after 700 daily calls,
 * resuming at the next UTC midnight reset.
 */
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY ?? '';
const TWELVEDATA_URL = 'https://api.twelvedata.com/price';
const CACHE_TTL_MS = 30_000;
const DAILY_CALL_LIMIT = 700;
let dailyCallCount = 0;
let dailyResetAt = getUtcMidnight(); // ms timestamp of today's midnight UTC
let cache = new Map();
function getUtcMidnight() {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
function resetIfNewDay() {
    const midnight = getUtcMidnight();
    if (midnight > dailyResetAt) {
        dailyCallCount = 0;
        dailyResetAt = midnight;
        cache.clear();
    }
}
async function fetchWithTimeout(url, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Returns the latest price and timestamp for `symbol`, or null if:
 *   - API key is missing
 *   - Budget (700 daily calls) is exhausted
 *   - Network / API error
 *
 * Results are cached for 30s.
 */
export async function getTwelveDataQuote(symbol) {
    if (!TWELVEDATA_API_KEY)
        return null;
    resetIfNewDay();
    // Check cache first
    const cached = cache.get(symbol);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return { price: cached.price, ts: cached.ts };
    }
    // Budget check
    if (dailyCallCount >= DAILY_CALL_LIMIT) {
        return null;
    }
    dailyCallCount++;
    try {
        const url = `${TWELVEDATA_URL}?symbol=${encodeURIComponent(symbol)}&apikey=${TWELVEDATA_API_KEY}`;
        const response = await fetchWithTimeout(url);
        if (!response.ok)
            return null;
        const data = await response.json();
        if (!data.price)
            return null;
        const price = Number(data.price);
        if (!Number.isFinite(price) || price <= 0)
            return null;
        const ts = Date.now();
        cache.set(symbol, { price, ts });
        return { price, ts };
    }
    catch {
        return null;
    }
}
