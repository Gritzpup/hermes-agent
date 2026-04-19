/**
 * News Intelligence
 *
 * Aggregates multiple news APIs into symbol-level and macro-level trade filters.
 * Focus is precision, not volume: severe or contradictory news should block trading.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout, readEnv, decodeXml, extractTag, normalizeArticle, dedupeArticles, mapEntitySymbol, average, parseAlphaTimestamp, SEARCH_TERMS, MAX_AGE_HOURS, } from './news-intel-parser.js';
import { buildSignal, isRiskAsset } from './news-intel-signals.js';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(MODULE_DIR, '../.runtime/news-intel');
const SNAPSHOT_PATH = path.join(RUNTIME_DIR, 'snapshot.json');
const POLL_MS = Number(process.env.NEWS_INTEL_POLL_MS ?? 1_200_000); // 20 min
const MAX_ARTICLES = Number(process.env.NEWS_INTEL_MAX_ARTICLES ?? 120);
const TRACKED_SYMBOLS = (process.env.NEWS_INTEL_SYMBOLS ?? 'BTC-USD,ETH-USD,SOL-USD,XRP-USD,PAXG-USD,SPY,QQQ,NVDA,EUR_USD,GBP_USD,USD_JPY')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
export class NewsIntelligence {
    timer = null;
    refreshInFlight = false;
    articles = [];
    providers = new Map();
    constructor() {
        for (const provider of ['marketaux', 'alpha-vantage', 'finnhub', 'fmp', 'thenewsapi', 'newsapi', 'coindesk-rss', 'cointelegraph-rss', 'reddit-crypto-rss']) {
            this.providers.set(provider, {
                provider,
                enabled: false,
                lastSuccessAt: null,
                lastAttemptAt: null,
                lastError: null,
                fetchedArticles: 0,
                consecutiveFailures: 0,
                disabledUntil: null
            });
        }
    }
    start() {
        if (this.timer)
            return;
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        this.loadPersisted();
        void this.refresh();
        this.timer = setInterval(() => { void this.refresh(); }, POLL_MS);
        console.log(`[news-intel] started (poll every ${Math.round(POLL_MS / 60_000)} min)`);
    }
    stop() {
        if (!this.timer)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    getSnapshot(limit = 60) {
        const articles = [...this.articles]
            .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
            .slice(0, limit);
        const symbolSignals = TRACKED_SYMBOLS.map((symbol) => this.computeSignal(symbol));
        const missingKeys = this.detectMissingKeys();
        if (missingKeys.length > 0) {
            console.warn(`[news-intel] degraded — missing API keys: ${missingKeys.join(', ')}`);
        }
        return {
            timestamp: new Date().toISOString(),
            providers: Array.from(this.providers.values()),
            macroSignal: this.computeMacroSignal(),
            symbolSignals,
            articles,
            items: articles,
            missingKeys
        };
    }
    detectMissingKeys() {
        const missing = [];
        if (!readEnv(['MARKETAUX_API_KEY']))
            missing.push('MARKETAUX_API_KEY');
        if (!readEnv(['ALPHA_VANTAGE_API_KEY']))
            missing.push('ALPHA_VANTAGE_API_KEY');
        if (!readEnv(['FINNHUB_API_KEY']))
            missing.push('FINNHUB_API_KEY');
        if (!readEnv(['FMP_API_KEY', 'FINANCIAL_MODELING_PREP_API_KEY']))
            missing.push('FMP_API_KEY');
        if (!readEnv(['THENEWSAPI_API_KEY']))
            missing.push('THENEWSAPI_API_KEY');
        if (!readEnv(['NEWSAPI_KEY']))
            missing.push('NEWSAPI_KEY');
        return missing;
    }
    getSignal(symbol) {
        return this.computeSignal(symbol);
    }
    getMacroSignal() {
        return this.computeMacroSignal();
    }
    async refresh() {
        if (this.refreshInFlight)
            return;
        this.refreshInFlight = true;
        try {
            const results = await Promise.allSettled([
                this.fetchMarketaux(),
                this.fetchAlphaVantage(),
                this.fetchFinnhub(),
                this.fetchFmp(),
                this.fetchTheNewsApi(),
                this.fetchNewsApi(),
                this.fetchCoinDeskRss(),
                this.fetchCointelegraphRss(),
                this.fetchRedditCryptoRss()
            ]);
            const merged = [];
            for (const result of results) {
                if (result.status === 'fulfilled')
                    merged.push(...result.value);
            }
            const deduped = dedupeArticles(merged)
                .filter((article) => article.symbols.length > 0 || article.macro)
                .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
                .slice(0, MAX_ARTICLES);
            if (deduped.length > 0) {
                this.articles = deduped;
                this.persist();
            }
        }
        finally {
            this.refreshInFlight = false;
        }
    }
    async fetchMarketaux() {
        const apiKey = readEnv(['MARKETAUX_API_KEY']);
        return this.fetchProvider('marketaux', Boolean(apiKey), async () => {
            const url = new URL('https://api.marketaux.com/v1/news/all');
            url.searchParams.set('api_token', apiKey);
            url.searchParams.set('language', 'en');
            url.searchParams.set('limit', '10');
            url.searchParams.set('group_similar', 'false');
            url.searchParams.set('must_have_entities', 'true');
            url.searchParams.set('search', SEARCH_TERMS.join(' OR '));
            // Filter to recent articles — Marketaux free plan returns oldest-first without this.
            const since = new Date(Date.now() - MAX_AGE_HOURS * 3_600_000).toISOString();
            url.searchParams.set('published_after', since);
            const response = await fetchWithTimeout(url);
            const payload = await response.json();
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            return (payload.data ?? [])
                .map((item) => normalizeArticle({
                id: item.uuid,
                provider: 'marketaux',
                title: item.title,
                summary: item.description ?? item.snippet,
                url: item.url,
                source: item.source,
                publishedAt: item.published_at,
                sentiment: average((item.entities ?? []).map((entity) => Number(entity.sentiment_score ?? 0))),
                symbols: (item.entities ?? []).map((entity) => mapEntitySymbol(entity.symbol ?? ''))
            }))
                .filter((item) => item !== null);
        });
    }
    async fetchAlphaVantage() {
        const apiKey = readEnv(['ALPHA_VANTAGE_API_KEY']);
        return this.fetchProvider('alpha-vantage', Boolean(apiKey), async () => {
            const url = new URL('https://www.alphavantage.co/query');
            url.searchParams.set('function', 'NEWS_SENTIMENT');
            url.searchParams.set('tickers', 'CRYPTO:BTC,CRYPTO:ETH,NVDA,SPY,QQQ');
            url.searchParams.set('limit', '10');
            url.searchParams.set('apikey', apiKey);
            const response = await fetchWithTimeout(url);
            const payload = await response.json();
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            return (payload.feed ?? [])
                .map((item, index) => normalizeArticle({
                id: item.url ?? `${index}`,
                provider: 'alpha-vantage',
                title: item.title,
                summary: item.summary,
                url: item.url,
                source: item.source,
                publishedAt: parseAlphaTimestamp(item.time_published),
                sentiment: Number(item.overall_sentiment_score ?? 0),
                symbols: (item.ticker_sentiment ?? []).map((entry) => mapEntitySymbol(entry.ticker ?? ''))
            }))
                .filter((item) => item !== null);
        });
    }
    async fetchFinnhub() {
        const apiKey = readEnv(['FINNHUB_API_KEY']);
        return this.fetchProvider('finnhub', Boolean(apiKey), async () => {
            const url = new URL('https://finnhub.io/api/v1/news');
            url.searchParams.set('category', 'general');
            url.searchParams.set('token', apiKey);
            const response = await fetchWithTimeout(url);
            const payload = await response.json();
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            return payload
                .map((item) => normalizeArticle({
                id: item.id,
                provider: 'finnhub',
                title: item.headline,
                summary: item.summary,
                url: item.url,
                source: item.source,
                publishedAt: item.datetime
            }))
                .filter((item) => item !== null);
        });
    }
    async fetchFmp() {
        const apiKey = readEnv(['FMP_API_KEY', 'FINANCIAL_MODELING_PREP_API_KEY']);
        return this.fetchProvider('fmp', Boolean(apiKey), async () => {
            const url = new URL('https://financialmodelingprep.com/api/v3/stock_news');
            url.searchParams.set('limit', '10');
            url.searchParams.set('apikey', apiKey);
            const response = await fetchWithTimeout(url);
            const payload = await response.json();
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            return payload
                .map((item, index) => normalizeArticle({
                id: `${index}:${item.url ?? item.title ?? ''}`,
                provider: 'fmp',
                title: item.title,
                summary: item.text,
                url: item.url,
                source: item.site,
                publishedAt: item.publishedDate,
                symbols: item.symbol ? [mapEntitySymbol(item.symbol)] : []
            }))
                .filter((item) => item !== null);
        });
    }
    async fetchTheNewsApi() {
        const apiKey = readEnv(['THENEWSAPI_API_KEY']);
        return this.fetchProvider('thenewsapi', Boolean(apiKey), async () => {
            const url = new URL('https://api.thenewsapi.com/v1/news/all');
            url.searchParams.set('api_token', apiKey);
            url.searchParams.set('language', 'en');
            url.searchParams.set('limit', '10');
            url.searchParams.set('search', SEARCH_TERMS.join(' OR '));
            // Align with MAX_AGE_HOURS so old articles don't get silently dropped.
            const since = new Date(Date.now() - MAX_AGE_HOURS * 3_600_000).toISOString().slice(0, 10);
            url.searchParams.set('published_after', since);
            const response = await fetchWithTimeout(url);
            const payload = await response.json();
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            return (payload.data ?? [])
                .map((item) => normalizeArticle({
                id: item.uuid,
                provider: 'thenewsapi',
                title: item.title,
                summary: item.description,
                url: item.url,
                source: item.source,
                publishedAt: item.published_at
            }))
                .filter((item) => item !== null);
        });
    }
    async fetchNewsApi() {
        const apiKey = readEnv(['NEWSAPI_KEY']);
        return this.fetchProvider('newsapi', Boolean(apiKey), async () => {
            const url = new URL('https://newsapi.org/v2/everything');
            url.searchParams.set('q', '(bitcoin OR ethereum OR solana OR ripple OR nvidia OR fed OR inflation OR cpi OR etf)');
            url.searchParams.set('language', 'en');
            url.searchParams.set('pageSize', '10');
            url.searchParams.set('sortBy', 'publishedAt');
            // Filter to recent window so old articles don't exhaust the 100/day quota.
            const since = new Date(Date.now() - MAX_AGE_HOURS * 3_600_000).toISOString().slice(0, 10);
            url.searchParams.set('from', since);
            url.searchParams.set('apiKey', apiKey);
            const response = await fetchWithTimeout(url);
            const payload = await response.json();
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            return (payload.articles ?? [])
                .map((item, index) => normalizeArticle({
                id: `${index}:${item.url ?? item.title ?? ''}`,
                provider: 'newsapi',
                title: item.title,
                summary: item.description,
                url: item.url,
                source: item.source?.name,
                publishedAt: item.publishedAt
            }))
                .filter((item) => item !== null);
        });
    }
    async fetchCoinDeskRss() {
        return this.fetchProvider('coindesk-rss', true, async () => {
            const response = await fetchWithTimeout('https://www.coindesk.com/arc/outboundfeeds/rss/');
            const raw = await response.text();
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            const items = Array.from(raw.matchAll(/<item>([\s\S]*?)<\/item>/g)).slice(0, 15);
            return items
                .map((match, index) => {
                const block = match[1] ?? '';
                return normalizeArticle({
                    id: `coindesk-${index}`,
                    provider: 'coindesk-rss',
                    title: decodeXml(extractTag(block, 'title')),
                    summary: decodeXml(extractTag(block, 'description')),
                    url: decodeXml(extractTag(block, 'link')),
                    source: 'CoinDesk',
                    publishedAt: extractTag(block, 'pubDate')
                });
            })
                .filter((item) => item !== null);
        });
    }
    /** CoinTelegraph RSS — free, no auth, high-quality crypto news */
    async fetchCointelegraphRss() {
        return this.fetchProvider('cointelegraph-rss', true, async () => {
            const response = await fetchWithTimeout('https://cointelegraph.com/rss');
            const raw = await response.text();
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            const items = Array.from(raw.matchAll(/<item>([\s\S]*?)<\/item>/g)).slice(0, 15);
            return items
                .map((match, index) => {
                const block = match[1] ?? '';
                return normalizeArticle({
                    id: `cointelegraph-${index}`,
                    provider: 'cointelegraph-rss',
                    title: decodeXml(extractTag(block, 'title')),
                    summary: decodeXml(extractTag(block, 'description')),
                    url: decodeXml(extractTag(block, 'link')),
                    source: 'CoinTelegraph',
                    publishedAt: extractTag(block, 'pubDate')
                });
            })
                .filter((item) => item !== null);
        });
    }
    /** Reddit r/CryptoCurrency RSS — free, no auth, retail sentiment pulse */
    async fetchRedditCryptoRss() {
        return this.fetchProvider('reddit-crypto-rss', true, async () => {
            const response = await fetchWithTimeout('https://www.reddit.com/r/CryptoCurrency/hot/.rss?limit=10', 8000);
            const raw = await response.text();
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            const entries = Array.from(raw.matchAll(/<entry>([\s\S]*?)<\/entry>/g)).slice(0, 10);
            return entries
                .map((match, index) => {
                const block = match[1] ?? '';
                const title = decodeXml(extractTag(block, 'title'));
                // Reddit Atom uses <updated> not <pubDate>
                const published = extractTag(block, 'updated') || extractTag(block, 'published');
                const link = block.match(/href="([^"]+)"/)?.[1] ?? '';
                return normalizeArticle({
                    id: `reddit-crypto-${index}`,
                    provider: 'reddit-crypto-rss',
                    title,
                    summary: title,
                    url: link,
                    source: 'Reddit r/CryptoCurrency',
                    publishedAt: published
                });
            })
                .filter((item) => item !== null);
        });
    }
    async fetchProvider(provider, enabled, fn) {
        const state = this.providers.get(provider);
        const now = Date.now();
        if (state) {
            state.enabled = enabled;
            state.lastAttemptAt = new Date(now).toISOString();
            if (state.disabledUntil && Date.parse(state.disabledUntil) > now) {
                state.enabled = false;
                state.lastError = `Provider cooldown until ${state.disabledUntil}.`;
                state.fetchedArticles = 0;
                return [];
            }
            // Respect free-tier rate limits: max 100 req/day → min 15 min between polls.
            const freeTierLimitMs = 15 * 60 * 1000;
            if (state.lastSuccessAt && (now - Date.parse(state.lastSuccessAt)) < freeTierLimitMs) {
                return []; // silently skip; not yet time for next poll
            }
        }
        if (!enabled)
            return [];
        try {
            const articles = await fn();
            if (state) {
                state.lastSuccessAt = new Date().toISOString();
                state.lastError = null;
                state.fetchedArticles = articles.length;
                state.consecutiveFailures = 0;
                state.disabledUntil = null;
            }
            return articles;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'unknown error';
            if (state) {
                state.lastError = message;
                state.fetchedArticles = 0;
                state.consecutiveFailures = Number.isFinite(state.consecutiveFailures) ? state.consecutiveFailures + 1 : 1;
                const authLike = /(?:401|403|unauthor|forbidden|invalid token|invalid_api_token)/i.test(message);
                if (authLike || state.consecutiveFailures >= 3) {
                    const cooldownMs = authLike ? 24 * 60 * 60 * 1000 : Math.min(state.consecutiveFailures * 15 * 60 * 1000, 6 * 60 * 60 * 1000);
                    state.disabledUntil = new Date(now + cooldownMs).toISOString();
                    state.enabled = false;
                }
            }
            console.warn(`[news-intel] ${provider} fetch failed: ${message}`);
            return [];
        }
    }
    computeSignal(symbol) {
        const articles = this.articles.filter((article) => article.symbols.includes(symbol) || (article.macro && isRiskAsset(symbol)));
        return buildSignal(symbol, articles, this.computeMacroSignal());
    }
    computeMacroSignal() {
        const articles = this.articles.filter((article) => article.macro);
        return buildSignal('__macro__', articles, null);
    }
    persist() {
        try {
            fs.mkdirSync(RUNTIME_DIR, { recursive: true });
            fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(this.getSnapshot(), null, 2));
        }
        catch {
            // Ignore persistence failure.
        }
    }
    loadPersisted() {
        try {
            if (!fs.existsSync(SNAPSHOT_PATH))
                return;
            const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
            const snapshot = JSON.parse(raw);
            this.articles = Array.isArray(snapshot.articles) ? snapshot.articles : [];
            const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
            for (const provider of providers) {
                if (!provider || typeof provider !== 'object')
                    continue;
                const name = provider.provider;
                if (!name)
                    continue;
                const current = provider;
                this.providers.set(name, {
                    provider: name,
                    enabled: current.enabled ?? false,
                    lastSuccessAt: current.lastSuccessAt ?? null,
                    lastAttemptAt: current.lastAttemptAt ?? null,
                    lastError: current.lastError ?? null,
                    fetchedArticles: Number.isFinite(current.fetchedArticles ?? NaN) ? current.fetchedArticles : 0,
                    consecutiveFailures: Number.isFinite(current.consecutiveFailures ?? NaN) ? current.consecutiveFailures : 0,
                    disabledUntil: current.disabledUntil ?? null
                });
            }
        }
        catch {
            // Ignore persisted snapshot failures.
        }
    }
}
let newsIntel;
export function getNewsIntel() {
    if (!newsIntel) {
        newsIntel = new NewsIntelligence();
        newsIntel.start();
    }
    return newsIntel;
}
