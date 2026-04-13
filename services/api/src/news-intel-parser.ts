// @ts-nocheck
/**
 * News Intelligence — Article parsing, normalization, and source profiling.
 * Extracted from news-intel.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ENV_PATH = path.resolve(MODULE_DIR, '../../../.env');

export const MAX_AGE_HOURS = Number(process.env.NEWS_INTEL_MAX_AGE_HOURS ?? 36);

export type BiasLabel = 'left' | 'center' | 'right' | 'unknown';
export type Topic = 'macro' | 'regulation' | 'earnings' | 'etf' | 'exchange' | 'hack' | 'legal' | 'rates' | 'inflation' | 'general';
export type SignalSeverity = 'info' | 'warning' | 'critical';

export interface SourceProfile {
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

export const ENV_CACHE = loadProjectEnv();

export const SEARCH_TERMS = [
  'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'ripple', 'xrp', 'paxg', 'gold',
  'nvidia', 'nvda', 'nasdaq', 'qqq', 's&p 500', 'spy', 'euro', 'eurusd', 'gbpusd', 'usdjpy',
  'fed', 'fomc', 'powell', 'cpi', 'inflation', 'rates', 'etf', 'sec', 'coinbase', 'crypto'
];

export const SOURCE_PROFILES: Record<string, SourceProfile> = {
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

export async function fetchWithTimeout(input: string | URL, timeoutMs = 5_000): Promise<Response> {
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

export function readEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name] ?? ENV_CACHE[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'unknown';
  }
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function ageHours(publishedAt: string): number {
  const parsed = Date.parse(publishedAt);
  if (!Number.isFinite(parsed)) return 999;
  return (Date.now() - parsed) / 3_600_000;
}

export function freshnessWeight(publishedAt: string): number {
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

export function extractSymbols(text: string): string[] {
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

export function normalizeArticle(input: {
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

export function dedupeArticles(articles: NormalizedNewsArticle[]): NormalizedNewsArticle[] {
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

export function mapEntitySymbol(raw: string): string {
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

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function parseAlphaTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?/);
  if (!match) return value;
  const [, y, m, d, hh = '00', mm = '00', ss = '00'] = match;
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
}
