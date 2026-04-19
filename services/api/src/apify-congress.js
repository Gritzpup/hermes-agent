/**
 * Apify Congressional Trades — polls congressional stock disclosure actor.
 *
 * Attempts to find a suitable Apify actor via the API.
 * Falls back to TODO CONGRESS_ACTOR_ID and returns [] if none is found.
 * Polls every 4 hours.
 * Env: APIFY_TOKEN
 */
const POLL_MS = 4 * 60 * 60 * 1000; // 4 hours
let pollTimer = null;
let lastTrades = [];
let resolvedActorId = null;
// TODO: Replace with your Apify actor ID for congressional trades once deployed.
// The act lookup below will auto-discover one if available.
let CONGRESS_ACTOR_ID = ''; // set dynamically after act lookup
async function fetchWithTimeout(url, timeoutMs = 15_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
async function discoverActor() {
    const token = process.env.APIFY_TOKEN;
    if (!token)
        return null;
    try {
        // List user's actors to find a congress/stock-related actor
        const resp = await fetchWithTimeout('https://api.apify.com/v2/acts?my=false', 8000);
        if (!resp.ok)
            return null;
        const data = await resp.json();
        const items = data.items ?? [];
        // Prefer actors whose name contains 'congress' or 'stock' (case-insensitive)
        const found = items.find((a) => a.name.toLowerCase().includes('congress') ||
            a.name.toLowerCase().includes('stock tracker') ||
            a.name.toLowerCase().includes('congress-stock'));
        if (found) {
            console.log(`[apify-congress] Discovered actor: ${found.id} (${found.name})`);
            return found.id;
        }
        return null;
    }
    catch {
        return null;
    }
}
async function pollOnce() {
    // Lazily resolve actor ID on first poll
    if (CONGRESS_ACTOR_ID === '' && resolvedActorId === null) {
        resolvedActorId = await discoverActor();
        if (resolvedActorId)
            CONGRESS_ACTOR_ID = resolvedActorId;
    }
    if (!CONGRESS_ACTOR_ID) {
        // No actor found — return empty; user must set CONGRESS_ACTOR_ID manually
        return;
    }
    const token = process.env.APIFY_TOKEN;
    if (!token)
        return;
    try {
        // Fetch last completed dataset from the actor
        const runResp = await fetchWithTimeout(`https://api.apify.com/v2/acts/${CONGRESS_ACTOR_ID}/runs/last/dataset/items?token=${token}&clean=1`);
        if (!runResp.ok)
            return;
        const items = await runResp.json();
        const trades = [];
        for (const item of items) {
            const symbol = item.symbol ?? item.ticker;
            if (!symbol)
                continue;
            const member = item.member ?? item.representative ?? item.senator ?? '';
            const txDate = item.transactionDate ?? '';
            const filedDate = item.disclosureDate ?? item.filedDate ?? new Date().toISOString().split('T')[0];
            const rawType = item.type ?? item.transactionType ?? '';
            const isPurchase = rawType.toLowerCase().includes('purchase') || rawType.toLowerCase().includes('buy');
            let valueUsd = 0;
            const rawVal = item.amount ?? item.value ?? '';
            // Parse "$50,000 - $100,000" style ranges — take midpoint
            const nums = [...rawVal.matchAll(/[\d,]+/g)].map((m) => Number(m[0].replace(/,/g, '')));
            if (nums.length >= 2) {
                valueUsd = (nums[0] + nums[nums.length - 1]) / 2;
            }
            else if (nums.length === 1) {
                valueUsd = nums[0];
            }
            trades.push({
                symbol: symbol.toUpperCase(),
                member,
                chamber: (item.chamber ?? '').toLowerCase() === 'senate' ? 'senate' : 'house',
                transactionDate: txDate,
                filedDate,
                type: isPurchase ? 'purchase' : 'sale',
                valueUsd,
                assetDescription: item.assetDescription ?? '',
            });
        }
        lastTrades = trades;
        if (trades.length > 0) {
            console.log(`[apify-congress] Fetched ${trades.length} congressional filings`);
        }
    }
    catch (e) {
        console.warn('[apify-congress] Fetch failed:', e);
    }
}
export function startApifyCongress() {
    if (pollTimer)
        return;
    pollTimer = setInterval(() => { void pollOnce(); }, POLL_MS);
    void pollOnce();
}
export function stopApifyCongress() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}
/**
 * Returns all congressional trades fetched in the last poll cycle.
 */
export function getCongressionalTrades() {
    return lastTrades;
}
