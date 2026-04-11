/**
 * News Intelligence
 *
 * Aggregates multiple news APIs into symbol-level and macro-level trade filters.
 * Focus is precision, not volume: severe or contradictory news should block trading.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ENV_PATH = path.resolve(MODULE_DIR, '../../../.env');
const RUNTIME_DIR = path.resolve(MODULE_DIR, '../.runtime/news-intel');
const SNAPSHOT_PATH = path.join(RUNTIME_DIR, 'snapshot.json');
const POLL_MS = Number(process.env.NEWS_INTEL_POLL_MS ?? 1_200_000); // 20 min
const MAX_AGE_HOURS = Number(process.env.NEWS_INTEL_MAX_AGE_HOURS ?? 36);
const MAX_ARTICLES = Number(process.env.NEWS_INTEL_MAX_ARTICLES ?? 120);

type BiasLabel = 'left' | 'center' | 'right' | 'unknown';
type Topic = 'macro' | 'regulation' | 'earnings' | 'etf' | 'exchange' | 'hack' | 'legal' | 'rates' | 'inflation' | 'general';
type SignalDirection = 'bullish' | 'bearish' | 'neutral';
type SignalSeverity = 'info' | 'warning' | 'critical';

interface ProviderState {
  provider: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  fetchedArticles: number;
  consecutiveFailures: number;
  disabledUntil: string | null;
}

interface SourceProfile {
  trust: number; // 0..1
  bias: BiasLabel;
  biasScore: number; // -1..1
}

export interface NormalizedNewsArticle {
  id: string;
  provider: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  domain: string;
  publishedAt: string;
  sentiment: number;
  trust: number;
  bias: BiasLabel;
  biasScore: number;
  topics: Topic[];
  symbols: string[];
  severity: SignalSeverity;
  macro: boolean;
}

export interface NewsSignal {
  symbol: string;
  direction: SignalDirection;
  confidence: number;
  score: number;
  severity: SignalSeverity;
  veto: boolean;
  reasons: string[];
  articleCount: number;
  contradictory: boolean;
}

export interface NewsIntelSnapshot {
  timestamp: string;
  providers: ProviderState[];
  macroSignal: NewsSignal;
  symbolSignals: NewsSignal[];
  articles: NormalizedNewsArticle[];
}

const ENV_CACHE = loadProjectEnv();
const TRACKED_SYMBOLS = (process.env.NEWS_INTEL_SYMBOLS ?? 'BTC-USD,ETH-USD,SOL-USD,XRP-USD,PAXG-USD,SPY,QQQ,NVDA,EUR_USD,GBP_USD,USD_JPY')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const SEARCH_TERMS = [
  'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'ripple', 'xrp', 'paxg', 'gold',
  'nvidia', 'nvda', 'nasdaq', 'qqq', 's&p 500', 'spy', 'euro', 'eurusd', 'gbpusd', 'usdjpy',
  'fed', 'fomc', 'powell', 'cpi', 'inflation', 'rates', 'etf', 'sec', 'coinbase', 'crypto'
];

const SOURCE_PROFILES: Record<string, SourceProfile> = {
  'reuters.com': { trust: 0.98, bias: 'center', biasScore: 0 },
  'bloomberg.com': { trust: 0.97, bias: 'center', biasScore: 0 },
  'wsj.com': { trust: 0.93, bias: 'center', biasScore: 0.15 },
  'cnbc.com': { trust: 0.88, bias: 'center', biasScore: 0.05 },
  'marketwatch.com': { trust: 0.82, bias: 'center', biasScore: 0.05 },
  'finance.yahoo.com': { trust: 0.78, bias: 'center', biasScore: 0 },
  'seekingalpha.com': { trust: 0.72, bias: 'center', biasScore: 0.05 },
  'benzinga.com': { trust: 0.7, bias: 'center', biasScore: 0 },
  'coindesk.com': { trust: 0.87, bias: 'center', biasScore: 0 },
  'cointelegraph.com': { trust: 0.71, bias: 'center', biasScore: 0 },
  'decrypt.co': { trust: 0.75, bias: 'center', biasScore: 0 },
  'sec.gov': { trust: 1, bias: 'center', biasScore: 0 },
  'federalreserve.gov': { trust: 1, bias: 'center', biasScore: 0 },
  'zerohedge.com': { trust: 0.3, bias: 'right', biasScore: 0.9 },
  'foxbusiness.com': { trust: 0.55, bias: 'right', biasScore: 0.65 },
  'cnn.com': { trust: 0.55, bias: 'left', biasScore: -0.65 },
  'nytimes.com': { trust: 0.75, bias: 'left', biasScore: -0.45 }
};

async function fetchWithTimeout(input: string | URL, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function loadProjectEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    if (!fs.existsSync(PROJECT_ENV_PATH)) return values;
    const raw = fs.readFileSync(PROJECT_ENV_PATH, 'utf8');
    for (const lineRaw of raw.split('\n')) {
      const line = lineRaw.trim();
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
    // Ignore local env read failure.
  }
  return values;
}

function readEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name] ?? ENV_CACHE[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'unknown';
  }
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ageHours(publishedAt: string): number {
  const parsed = Date.parse(publishedAt);
  if (!Number.isFinite(parsed)) return 999;
  return (Date.now() - parsed) / 3_600_000;
}

function freshnessWeight(publishedAt: string): number {
  const age = ageHours(publishedAt);
  if (age <= 1) return 1.2;
  if (age <= 4) return 1.0;
  if (age <= 12) return 0.8;
  if (age <= 24) return 0.55;
  if (age <= MAX_AGE_HOURS) return 0.3;
  return 0.1;
}

function profileForDomain(domain: string): SourceProfile {
  return SOURCE_PROFILES[domain] ?? { trust: 0.62, bias: 'unknown', biasScore: 0 };
}

function profileForSource(source: string, domain: string): SourceProfile {
  const normalized = source.trim().toLowerCase();
  if (normalized.includes('reuters')) return SOURCE_PROFILES['reuters.com']!;
  if (normalized.includes('bloomberg')) return SOURCE_PROFILES['bloomberg.com']!;
  if (normalized.includes('cnbc')) return SOURCE_PROFILES['cnbc.com']!;
  if (normalized.includes('wall street journal') || normalized.includes('wsj')) return SOURCE_PROFILES['wsj.com']!;
  if (normalized.includes('coindesk')) return SOURCE_PROFILES['coindesk.com']!;
  if (normalized.includes('cointelegraph')) return SOURCE_PROFILES['cointelegraph.com']!;
  if (normalized.includes('yahoo')) return SOURCE_PROFILES['finance.yahoo.com']!;
  return profileForDomain(domain);
}

function inferSentiment(text: string): number {
  const normalized = text.toLowerCase();
  const positive = [
    'approval', 'approved', 'surge', 'beat', 'beats', 'bullish', 'rally', 'rebound', 'soar',
    'record inflow', 'inflows', 'partnership', 'upgrade', 'strong demand', 'higher'
  ];
  const negative = [
    'hack', 'exploit', 'lawsuit', 'investigation', 'rejected', 'ban', 'warning', 'downgrade',
    'miss', 'misses', 'selloff', 'liquidation', 'outflow', 'outflows', 'fraud', 'breach', 'lower'
  ];
  let score = 0;
  for (const token of positive) if (normalized.includes(token)) score += 0.18;
  for (const token of negative) if (normalized.includes(token)) score -= 0.22;
  return clamp(score, -1, 1);
}

function detectTopics(text: string): Topic[] {
  const normalized = text.toLowerCase();
  const topics: Topic[] = [];
  if (/(cpi|powell|fomc|fed|treasury|bond yield|payroll|nfp|macro|central bank)/.test(normalized)) topics.push('macro', 'rates');
  if (/(inflation|ppi|cpi|deflation)/.test(normalized)) topics.push('inflation');
  if (/(sec|lawsuit|court|regulator|regulation|approval|etf|rejection|ban)/.test(normalized)) topics.push('regulation', 'legal');
  if (/(etf|fund flow|spot bitcoin etf)/.test(normalized)) topics.push('etf');
  if (/(earnings|guidance|eps|revenue|transcript)/.test(normalized)) topics.push('earnings');
  if (/(coinbase|binance|exchange|listing|delisting|outage)/.test(normalized)) topics.push('exchange');
  if (/(hack|exploit|breach|stolen|wallet drain|attack)/.test(normalized)) topics.push('hack');
  if (topics.length === 0) topics.push('general');
  return unique(topics);
}

function extractSymbols(text: string): string[] {
  const normalized = text.toLowerCase();
  const matches: string[] = [];
  const rules: Array<[string, RegExp]> = [
    ['BTC-USD', /(bitcoin|\bbtc\b|spot bitcoin etf)/],
    ['ETH-USD', /(ethereum|\beth\b)/],
    ['SOL-USD', /(solana|\bsol\b)/],
    ['XRP-USD', /(\bxrp\b|ripple)/],
    ['PAXG-USD', /(paxg|tokenized gold|gold)/],
    ['NVDA', /(nvidia|\bnvda\b)/],
    ['QQQ', /(\bqqq\b|nasdaq 100|nasdaq)/],
    ['SPY', /(\bspy\b|s&p 500|sp500|equities)/],
    ['EUR_USD', /(eur\/usd|eurusd|euro\b)/],
    ['GBP_USD', /(gbp\/usd|gbpusd|sterling|british pound)/],
    ['USD_JPY', /(usd\/jpy|usdjpy|yen)/]
  ];
  for (const [symbol, regex] of rules) {
    if (regex.test(normalized)) matches.push(symbol);
  }
  return unique(matches);
}

function classifySeverity(text: string, sentiment: number): SignalSeverity {
  const normalized = text.toLowerCase();
  if (/(hack|exploit|breach|bankruptcy|fraud|sec sues|lawsuit|\bban(s|ned|ning)?\b|rejected etf|delisting|exchange outage)/.test(normalized)) return 'critical';
  if (/(cpi|fomc|powell|earnings|guidance|investigation|liquidation|outflow)/.test(normalized)) return 'warning';
  if (Math.abs(sentiment) >= 0.45) return 'warning';
  return 'info';
}

function normalizeArticle(input: {
  id?: string | number | undefined;
  provider: string;
  title?: string | undefined;
  summary?: string | undefined;
  url?: string | undefined;
  source?: string | undefined;
  publishedAt?: string | number | undefined;
  sentiment?: number | undefined;
  symbols?: string[] | undefined;
}): NormalizedNewsArticle | null {
  const title = (input.title ?? '').trim();
  const summary = (input.summary ?? '').trim();
  const url = (input.url ?? '').trim();
  if (!title || !url) return null;

  const publishedAt = typeof input.publishedAt === 'number'
    ? new Date(input.publishedAt * 1000).toISOString()
    : (() => {
        const parsed = Date.parse(String(input.publishedAt ?? ''));
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
      })();
  if (ageHours(publishedAt) > MAX_AGE_HOURS) return null;

  const text = `${title} ${summary}`.trim();
  const domain = domainFromUrl(url);
  const source = input.source?.trim() || domain;
  const profile = profileForSource(source, domain);
  const sentiment = clamp(typeof input.sentiment === 'number' && Number.isFinite(input.sentiment) ? input.sentiment : inferSentiment(text), -1, 1);
  const topics = detectTopics(text);
  const symbols = unique([...(input.symbols ?? []), ...extractSymbols(text)]);
  const macro = topics.includes('macro') || topics.includes('rates') || topics.includes('inflation');
  const severity = classifySeverity(text, sentiment);

  return {
    id: `${input.provider}:${String(input.id ?? url)}`,
    provider: input.provider,
    title,
    summary,
    url,
    source,
    domain,
    publishedAt,
    sentiment: round(sentiment, 3),
    trust: profile.trust,
    bias: profile.bias,
    biasScore: profile.biasScore,
    topics,
    symbols,
    severity,
    macro
  };
}

export class NewsIntelligence {
  private timer: NodeJS.Timeout | null = null;
  private refreshInFlight = false;
  private articles: NormalizedNewsArticle[] = [];
  private providers = new Map<string, ProviderState>();

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

  start(): void {
    if (this.timer) return;
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    this.loadPersisted();
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, POLL_MS);
    console.log(`[news-intel] started (poll every ${Math.round(POLL_MS / 60_000)} min)`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot(limit = 60): NewsIntelSnapshot {
    const articles = [...this.articles]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, limit);
    const symbolSignals = TRACKED_SYMBOLS.map((symbol) => this.computeSignal(symbol));
    return {
      timestamp: new Date().toISOString(),
      providers: Array.from(this.providers.values()),
      macroSignal: this.computeMacroSignal(),
      symbolSignals,
      articles
    };
  }

  getSignal(symbol: string): NewsSignal {
    return this.computeSignal(symbol);
  }

  getMacroSignal(): NewsSignal {
    return this.computeMacroSignal();
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return;
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

    const merged: NormalizedNewsArticle[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') merged.push(...result.value);
    }

    const deduped = dedupeArticles(merged)
      .filter((article) => article.symbols.length > 0 || article.macro)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, MAX_ARTICLES);

      if (deduped.length > 0) {
        this.articles = deduped;
        this.persist();
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async fetchMarketaux(): Promise<NormalizedNewsArticle[]> {
    const apiKey = readEnv(['MARKETAUX_API_KEY']);
    return this.fetchProvider('marketaux', Boolean(apiKey), async () => {
      const url = new URL('https://api.marketaux.com/v1/news/all');
      url.searchParams.set('api_token', apiKey);
      url.searchParams.set('language', 'en');
      url.searchParams.set('limit', '10');
      url.searchParams.set('group_similar', 'false');
      url.searchParams.set('must_have_entities', 'true');
      url.searchParams.set('search', SEARCH_TERMS.join(' OR '));
      const response = await fetchWithTimeout(url);
      const payload = await response.json() as {
        data?: Array<{
          uuid?: string;
          title?: string;
          description?: string;
          snippet?: string;
          url?: string;
          source?: string;
          published_at?: string;
          entities?: Array<{ symbol?: string; sentiment_score?: number }>;
        }>;
      };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        .filter((item): item is NormalizedNewsArticle => item !== null);
    });
  }

  private async fetchAlphaVantage(): Promise<NormalizedNewsArticle[]> {
    const apiKey = readEnv(['ALPHA_VANTAGE_API_KEY']);
    return this.fetchProvider('alpha-vantage', Boolean(apiKey), async () => {
      const url = new URL('https://www.alphavantage.co/query');
      url.searchParams.set('function', 'NEWS_SENTIMENT');
      url.searchParams.set('tickers', 'CRYPTO:BTC,CRYPTO:ETH,NVDA,SPY,QQQ');
      url.searchParams.set('limit', '10');
      url.searchParams.set('apikey', apiKey);
      const response = await fetchWithTimeout(url);
      const payload = await response.json() as {
        feed?: Array<{
          title?: string;
          summary?: string;
          url?: string;
          source?: string;
          time_published?: string;
          overall_sentiment_score?: string;
          ticker_sentiment?: Array<{ ticker?: string }>;
        }>;
      };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        .filter((item): item is NormalizedNewsArticle => item !== null);
    });
  }

  private async fetchFinnhub(): Promise<NormalizedNewsArticle[]> {
    const apiKey = readEnv(['FINNHUB_API_KEY']);
    return this.fetchProvider('finnhub', Boolean(apiKey), async () => {
      const url = new URL('https://finnhub.io/api/v1/news');
      url.searchParams.set('category', 'general');
      url.searchParams.set('token', apiKey);
      const response = await fetchWithTimeout(url);
      const payload = await response.json() as Array<{
        id?: number;
        headline?: string;
        summary?: string;
        url?: string;
        source?: string;
        datetime?: number;
      }>;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        .filter((item): item is NormalizedNewsArticle => item !== null);
    });
  }

  private async fetchFmp(): Promise<NormalizedNewsArticle[]> {
    const apiKey = readEnv(['FMP_API_KEY', 'FINANCIAL_MODELING_PREP_API_KEY']);
    return this.fetchProvider('fmp', Boolean(apiKey), async () => {
      const url = new URL('https://financialmodelingprep.com/api/v3/stock_news');
      url.searchParams.set('limit', '10');
      url.searchParams.set('apikey', apiKey);
      const response = await fetchWithTimeout(url);
      const payload = await response.json() as Array<{
        title?: string;
        text?: string;
        url?: string;
        site?: string;
        publishedDate?: string;
        symbol?: string;
      }>;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        .filter((item): item is NormalizedNewsArticle => item !== null);
    });
  }

  private async fetchTheNewsApi(): Promise<NormalizedNewsArticle[]> {
    const apiKey = readEnv(['THENEWSAPI_API_KEY']);
    return this.fetchProvider('thenewsapi', Boolean(apiKey), async () => {
      const url = new URL('https://api.thenewsapi.com/v1/news/all');
      url.searchParams.set('api_token', apiKey);
      url.searchParams.set('language', 'en');
      url.searchParams.set('limit', '10');
      url.searchParams.set('search', SEARCH_TERMS.join(' OR '));
      const response = await fetchWithTimeout(url);
      const payload = await response.json() as {
        data?: Array<{
          uuid?: string;
          title?: string;
          description?: string;
          url?: string;
          source?: string;
          published_at?: string;
        }>;
      };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        .filter((item): item is NormalizedNewsArticle => item !== null);
    });
  }

  private async fetchNewsApi(): Promise<NormalizedNewsArticle[]> {
    const apiKey = readEnv(['NEWSAPI_API_KEY']);
    return this.fetchProvider('newsapi', Boolean(apiKey), async () => {
      const url = new URL('https://newsapi.org/v2/everything');
      url.searchParams.set('q', '(bitcoin OR ethereum OR solana OR ripple OR nvidia OR fed OR inflation OR cpi OR etf)');
      url.searchParams.set('language', 'en');
      url.searchParams.set('pageSize', '10');
      url.searchParams.set('sortBy', 'publishedAt');
      url.searchParams.set('apiKey', apiKey);
      const response = await fetchWithTimeout(url);
      const payload = await response.json() as {
        articles?: Array<{
          title?: string;
          description?: string;
          url?: string;
          publishedAt?: string;
          source?: { name?: string };
        }>;
      };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        .filter((item): item is NormalizedNewsArticle => item !== null);
    });
  }

  private async fetchCoinDeskRss(): Promise<NormalizedNewsArticle[]> {
    return this.fetchProvider('coindesk-rss', true, async () => {
      const response = await fetchWithTimeout('https://www.coindesk.com/arc/outboundfeeds/rss/');
      const raw = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        .filter((item): item is NormalizedNewsArticle => item !== null);
    });
  }

  /** CoinTelegraph RSS — free, no auth, high-quality crypto news */
  private async fetchCointelegraphRss(): Promise<NormalizedNewsArticle[]> {
    return this.fetchProvider('cointelegraph-rss', true, async () => {
      const response = await fetchWithTimeout('https://cointelegraph.com/rss');
      const raw = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        .filter((item): item is NormalizedNewsArticle => item !== null);
    });
  }

  /** Reddit r/CryptoCurrency RSS — free, no auth, retail sentiment pulse */
  private async fetchRedditCryptoRss(): Promise<NormalizedNewsArticle[]> {
    return this.fetchProvider('reddit-crypto-rss', true, async () => {
      const response = await fetchWithTimeout('https://www.reddit.com/r/CryptoCurrency/hot/.rss?limit=10', 8000);
      const raw = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        .filter((item): item is NormalizedNewsArticle => item !== null);
    });
  }

  private async fetchProvider(provider: string, enabled: boolean, fn: () => Promise<NormalizedNewsArticle[]>): Promise<NormalizedNewsArticle[]> {
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
    }
    if (!enabled) return [];
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
    } catch (error) {
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
      return [];
    }
  }

  private computeSignal(symbol: string): NewsSignal {
    const articles = this.articles.filter((article) => article.symbols.includes(symbol) || (article.macro && isRiskAsset(symbol)));
    return buildSignal(symbol, articles, this.computeMacroSignal());
  }

  private computeMacroSignal(): NewsSignal {
    const articles = this.articles.filter((article) => article.macro);
    return buildSignal('__macro__', articles, null);
  }

  private persist(): void {
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(this.getSnapshot(), null, 2));
    } catch {
      // Ignore persistence failure.
    }
  }

  private loadPersisted(): void {
    try {
      if (!fs.existsSync(SNAPSHOT_PATH)) return;
      const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
      const snapshot = JSON.parse(raw) as Partial<NewsIntelSnapshot>;
      this.articles = Array.isArray(snapshot.articles) ? snapshot.articles as NormalizedNewsArticle[] : [];
      const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
      for (const provider of providers) {
        if (!provider || typeof provider !== 'object') continue;
        const name = (provider as { provider?: string }).provider;
        if (!name) continue;
        const current = provider as Partial<ProviderState>;
        this.providers.set(name, {
          provider: name,
          enabled: current.enabled ?? false,
          lastSuccessAt: current.lastSuccessAt ?? null,
          lastAttemptAt: current.lastAttemptAt ?? null,
          lastError: current.lastError ?? null,
          fetchedArticles: Number.isFinite(current.fetchedArticles ?? NaN) ? (current.fetchedArticles as number) : 0,
          consecutiveFailures: Number.isFinite(current.consecutiveFailures ?? NaN) ? (current.consecutiveFailures as number) : 0,
          disabledUntil: current.disabledUntil ?? null
        });
      }
    } catch {
      // Ignore persisted snapshot failures.
    }
  }
}

function dedupeArticles(articles: NormalizedNewsArticle[]): NormalizedNewsArticle[] {
  const seen = new Set<string>();
  const deduped: NormalizedNewsArticle[] = [];
  for (const article of articles) {
    const key = `${article.domain}|${article.title.toLowerCase().replace(/\W+/g, ' ').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(article);
  }
  return deduped;
}

function mapEntitySymbol(raw: string): string {
  const value = raw.trim().toUpperCase();
  switch (value) {
    case 'BTC':
    case 'BTCUSD':
    case 'CRYPTO:BTC':
      return 'BTC-USD';
    case 'ETH':
    case 'ETHUSD':
    case 'CRYPTO:ETH':
      return 'ETH-USD';
    case 'SOL':
    case 'SOLUSD':
      return 'SOL-USD';
    case 'XRP':
    case 'XRPUSD':
      return 'XRP-USD';
    case 'PAXG':
      return 'PAXG-USD';
    case 'EURUSD':
    case 'FOREX:EURUSD':
      return 'EUR_USD';
    case 'GBPUSD':
    case 'FOREX:GBPUSD':
      return 'GBP_USD';
    case 'USDJPY':
    case 'FOREX:USDJPY':
      return 'USD_JPY';
    default:
      return value;
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseAlphaTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?/);
  if (!match) return value;
  const [, y, m, d, hh = '00', mm = '00', ss = '00'] = match;
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
}

function buildSignal(symbol: string, articles: NormalizedNewsArticle[], macroSignal: NewsSignal | null): NewsSignal {
  const recent = articles
    .filter((article) => ageHours(article.publishedAt) <= MAX_AGE_HOURS)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  if (recent.length === 0) {
    return {
      symbol,
      direction: 'neutral',
      confidence: 0,
      score: 0,
      severity: 'info',
      veto: false,
      reasons: [],
      articleCount: 0,
      contradictory: false
    };
  }

  const weightedScore = recent.reduce((sum, article) => {
    const severityMultiplier = article.severity === 'critical' ? 1.4 : article.severity === 'warning' ? 1.15 : 1;
    return sum + article.sentiment * article.trust * freshnessWeight(article.publishedAt) * severityMultiplier;
  }, 0);

  const bullishCount = recent.filter((article) => article.sentiment > 0.15).length;
  const bearishCount = recent.filter((article) => article.sentiment < -0.15).length;
  const contradictory = bullishCount > 0 && bearishCount > 0;

  let direction: SignalDirection = 'neutral';
  if (weightedScore >= 0.45) direction = 'bullish';
  else if (weightedScore <= -0.45) direction = 'bearish';

  const severity: SignalSeverity = recent.some((article) => article.severity === 'critical')
    ? 'critical'
    : recent.some((article) => article.severity === 'warning')
      ? 'warning'
      : 'info';

  const recentCriticalNegativeCount = recent.filter((article) => article.severity === 'critical' && article.sentiment < -0.2 && ageHours(article.publishedAt) <= 4).length;
  const recentCriticalNegative = recentCriticalNegativeCount >= 2;
  const confidence = clamp(Math.round(Math.min(100, Math.abs(weightedScore) * 55 + recent.length * 6 + (severity === 'critical' ? 18 : severity === 'warning' ? 8 : 0))), 0, 100);
  const macroSpecificVeto = symbol === '__macro__' && severity === 'critical' && confidence >= 85 && weightedScore < -0.4;
  const macroRisk = macroSignal?.veto ?? false;
  const veto = recentCriticalNegative || macroSpecificVeto || (macroRisk && isRiskAsset(symbol));
  const reasons = recent.slice(0, 3).map((article) => `${article.source}: ${article.title}`);

  return {
    symbol,
    direction,
    confidence,
    score: round(weightedScore, 3),
    severity,
    veto,
    reasons,
    articleCount: recent.length,
    contradictory
  };
}

function isRiskAsset(symbol: string): boolean {
  return symbol.endsWith('-USD') || ['SPY', 'QQQ', 'NVDA'].includes(symbol);
}

let newsIntel: NewsIntelligence | undefined;

export function getNewsIntel(): NewsIntelligence {
  if (!newsIntel) {
    newsIntel = new NewsIntelligence();
    newsIntel.start();
  }
  return newsIntel;
}
