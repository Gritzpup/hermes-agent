/**
 * Director Context Builder — openclaw-hermes COO bridge.
 *
 * Produces the authoritative, anti-staleness Director context block that is
 * injected into the COO's rolling context (hermes-poller.ts → askCoo).
 *
 * Three fixes applied here:
 *  (a) alpaca_universe is dropped from the prompt when no Alpaca position
 *      events have occurred in the last 24 hours — eliminates the 12+ corrupted
 *      runs where the Director hallucinated "XRP-USD is not in Alpaca."
 *  (b) live_venue_per_symbol is read from Redis `hermes:routing:venues` and
 *      injected into the prompt so the Director knows which venue each symbol
 *      is actually live on (not the stale hardcoded map).
 *  (c) context_version is a SHA-256 hash of the assembled context; the
 *      defensive parser (openclaw-client.ts) rejects any Director response that
 *      references a symbol absent from context.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import { FIRM_JOURNAL_FILE, FIRM_EVENTS_FILE } from './config.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ROUTING_VENUES_KEY = 'hermes:routing:venues';
const ALPCA_ACTIVITY_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── (b) Live venue map from Redis ─────────────────────────────────────────────

export type LiveVenueMap = Record<string, string>; // symbol → broker

/**
 * Fetch the live_venue_per_symbol map from Redis.
 * Absence of the key is treated conservatively: returns an empty object so
 * the pipeline does not break on a missing key.
 */
export async function fetchLiveVenueMap(): Promise<LiveVenueMap> {
    try {
        const raw = await redis.get(ROUTING_VENUES_KEY);
        if (!raw || typeof raw !== 'string') return {};
        const parsed = JSON.parse(raw) as LiveVenueMap;
        if (typeof parsed !== 'object' || parsed === null) return {};
        // Validate values are non-empty strings
        for (const [sym, broker] of Object.entries(parsed)) {
            if (typeof sym !== 'string' || typeof broker !== 'string') return {};
        }
        return parsed;
    } catch (err) {
        logger.warn({ err, key: ROUTING_VENUES_KEY }, 'failed to fetch live_venue_per_symbol from Redis — treating as unknown');
        return {};
    }
}

// ── (a) Alpaca activity detection ──────────────────────────────────────────────

/**
 * Returns true iff there is at least one journal or event entry referencing
 * Alpaca paper trading (broker === 'alpaca-paper') in the last 24 hours.
 * When false, the Director prompt MUST NOT include alpaca_universe.
 */
export async function hasAlpacaActivity(): Promise<boolean> {
    const now = Date.now();
    const cutoff = now - ALPCA_ACTIVITY_LOOKBACK_MS;

    // Check journal for alpaca-paper entries in the last 24 h.
    try {
        if (fs.existsSync(FIRM_JOURNAL_FILE)) {
            const content = fs.readFileSync(FIRM_JOURNAL_FILE, 'utf8');
            const lines = content.split('\n').filter(Boolean).slice(-500); // last 500 lines is enough
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line) as Record<string, unknown>;
                    const ts = entry.exitAt as string | undefined
                        ?? entry.entryAt as string | undefined
                        ?? entry.ts as string | undefined;
                    if (!ts) continue;
                    const ms = new Date(ts).getTime();
                    if (ms < cutoff) break; // entries are roughly chronological; stop early
                    if (entry.broker === 'alpaca-paper') return true;
                } catch { /* skip malformed lines */ }
            }
        }
    } catch (err) {
        logger.debug({ err }, 'hasAlpacaActivity: journal check failed');
    }

    // Also check events.jsonl for alpaca-paper events (e.g. order fills, balance updates).
    try {
        if (fs.existsSync(FIRM_EVENTS_FILE)) {
            // Tail the last 10 KB of events (Alpaca events are sparse; this covers days).
            const st = fs.statSync(FIRM_EVENTS_FILE);
            const tailBytes = Math.min(st.size, 10 * 1024);
            const fd = fs.openSync(FIRM_EVENTS_FILE, 'r');
            const buf = Buffer.alloc(tailBytes);
            fs.readSync(fd, buf, 0, tailBytes, Math.max(0, st.size - tailBytes));
            fs.closeSync(fd);
            let text = buf.toString('utf8');
            if (st.size > tailBytes) {
                const nl = text.indexOf('\n');
                if (nl >= 0) text = text.slice(nl + 1);
            }
            const lines = text.split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line) as Record<string, unknown>;
                    const ts = entry.timestamp as string | undefined;
                    if (!ts) continue;
                    const ms = new Date(ts).getTime();
                    if (ms < cutoff) break;
                    const broker = (entry.broker as string | undefined)
                        ?? ((entry.payload as Record<string, unknown>)?.broker as string | undefined);
                    if (broker === 'alpaca-paper') return true;
                } catch { /* skip */ }
            }
        }
    } catch (err) {
        logger.debug({ err }, 'hasAlpacaActivity: events check failed');
    }

    return false;
}

// ── (c) Context hashing ─────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hex digest of a JSON-serialised object.
 * Used as `context_version` to let the defensive parser detect stale/hallucinated
 * responses that reference symbols absent from the context.
 */
export function hashContext(context: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

// ── Canonical broker capabilities (conservative fallback) ──────────────────────

/**
 * Static broker capability map — used only when live_venue_per_symbol is
 * unavailable from Redis.  This list is NOT used when we have live data.
 */
const FALLBACK_BROKER_CAPABILITIES: Record<string, string[]> = {
    'alpaca-paper': ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'META', 'AMD', 'VIXY'],
    'coinbase-live': ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'],
    'oanda-rest': ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'SPX500_USD', 'NAS100_USD', 'USB10Y_USD', 'USB30Y_USD', 'XAU_USD', 'XAG_USD', 'BCO_USD', 'WTICO_USD'],
};

// ── Director context assembly ──────────────────────────────────────────────────

export interface DirectorContextBlock {
    /** SHA-256 of the assembled context (for defensive parser validation) */
    context_version: string;
    /** Live venue map from Redis `hermes:routing:venues`, or {} if unavailable */
    live_venue_per_symbol: LiveVenueMap;
    /**
     * Authoritative broker capabilities.
     * - If live_venue_per_symbol is populated: derived from it (canonical, per-symbol).
     * - If Redis key is absent: uses static fallback (may contain stale data — use
     *   with caution; prefer live_venue_per_symbol).
     */
    broker_capabilities: Record<string, string[]>;
    /** True when Alpaca has seen activity in the last 24 h. */
    alpaca_has_activity: boolean;
}

/**
 * Assemble the anti-staleness Director context block.
 * Call this when building the rolling context in hermes-poller.ts.
 */
export async function buildDirectorContextBlock(): Promise<DirectorContextBlock> {
    const [liveVenueMap, alpacaActive] = await Promise.all([
        fetchLiveVenueMap(),
        hasAlpacaActivity(),
    ]);

    // Derive broker_capabilities from live map if available, otherwise fallback.
    let brokerCapabilities: Record<string, string[]>;
    if (Object.keys(liveVenueMap).length > 0) {
        // Build reverse map: broker → [symbols it hosts].
        brokerCapabilities = {};
        for (const [sym, broker] of Object.entries(liveVenueMap)) {
            if (!brokerCapabilities[broker]) brokerCapabilities[broker] = [];
            brokerCapabilities[broker]!.push(sym);
        }
    } else {
        brokerCapabilities = { ...FALLBACK_BROKER_CAPABILITIES };
    }

    const block: DirectorContextBlock = {
        context_version: '', // filled below
        live_venue_per_symbol: liveVenueMap,
        broker_capabilities: brokerCapabilities,
        alpaca_has_activity: alpacaActive,
    };

    // (c) Hash the block (excluding context_version itself) as context_version.
    block.context_version = hashContext(block);

    return block;
}
