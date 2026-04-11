/**
 * Insider Radar
 * 
 * Fetches and processes corporate insider trade data (SEC Form 4) and 
 * congressional trading data (Senate/House) to identify clusters of conviction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ENV_PATH = path.resolve(MODULE_DIR, '../../../.env');
const RUNTIME_DIR = path.resolve(MODULE_DIR, '../.runtime/insider-radar');
const SNAPSHOT_PATH = path.join(RUNTIME_DIR, 'snapshot.json');

const POLL_MS = 3_600_000; // Hourly (insider data moves slower than news)
const MAX_AGE_DAYS = 30;

export interface InsiderTrade {
  symbol: string;
  filerName: string;
  transactionDate: string;
  reportingDate: string;
  transactionType: string;
  securitiesTransacted: number;
  price: number;
  totalValue: number;
  officerTitle?: string;
  description?: string;
  source: 'form4' | 'senate' | 'house';
}

export interface InsiderSignal {
  symbol: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  convictionScore: number; // 0..1
  isCluster: boolean;
  totalValue: number;
  tradeCount: number;
  recentTrades: InsiderTrade[];
  summary: string;
  convictionReason?: string | undefined;
}

export interface InsiderRadarSnapshot {
  timestamp: string;
  signals: InsiderSignal[];
  trades: InsiderTrade[];
}

const TRACKED_SYMBOLS = (process.env.NEWS_INTEL_SYMBOLS ?? 'BTC-USD,ETH-USD,SOL-USD,XRP-USD,PAXG-USD,SPY,QQQ,NVDA,EUR_USD,GBP_USD,USD_JPY')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// specific high-performer politicians to track
const HIGH_CONVICTION_FILERS = [
  'PELOSI', 
  'TUERCK', 
  'GOTTHEIMER', 
  'MCCAUL',
  'KHANNA'
];

export class InsiderRadar {
  private trades: InsiderTrade[] = [];
  private signals: InsiderSignal[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private env: Record<string, string> = {};

  constructor() {
    this.env = this.loadEnv();
    this.loadSnapshot();
  }

  public async start(): Promise<void> {
    console.log('[insider-radar] Starting service...');
    await this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
  }

  public stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  public getSnapshot(): InsiderRadarSnapshot {
    return {
      timestamp: new Date().toISOString(),
      signals: this.signals,
      trades: this.trades
    };
  }

  private async poll(): Promise<void> {
    try {
      console.log('[insider-radar] Polling for new filings...');
      const fmpTrades = await this.fetchFmpInsider();
      const senateTrades = await this.fetchFmpSenate();
      const houseTrades = await this.fetchFmpHouse();
      const apifyTrades = await this.fetchApifyCongressional();

      const allNew = [...fmpTrades, ...senateTrades, ...houseTrades, ...apifyTrades];
      
      // Update local storage
      this.trades = this.mergeTrades(this.trades, allNew);
      
      // Compute signals
      this.signals = this.computeSignals(this.trades);
      
      // Perform AI Sentiment Analysis on significant signals
      await this.enrichSignalsWithAI();
      
      this.saveSnapshot();
      console.log(`[insider-radar] Polled successfully. Total signals: ${this.signals.length}`);
    } catch (error) {
      console.error('[insider-radar] Poll failed:', error);
    }
  }

  private async fetchFmpInsider(): Promise<InsiderTrade[]> {
    const apiKey = this.env['FMP_API_KEY'];
    if (!apiKey) return [];

    try {
      const url = `https://financialmodelingprep.com/stable/insider-trading/latest?apikey=${apiKey}`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) return [];
      
      const data = await response.json() as any[];
      return data.map(item => ({
        symbol: item.symbol,
        filerName: item.reportingName,
        transactionDate: item.transactionDate,
        reportingDate: item.filingDate || item.reportingDate,
        transactionType: item.transactionType || (item.acquisitionOrDisposition === 'A' ? 'P-Purchase' : 'S-Sale'),
        securitiesTransacted: item.securitiesTransacted,
        price: item.price,
        totalValue: item.securitiesTransacted * item.price,
        officerTitle: item.typeOfOwner || item.officerTitle,
        source: 'form4' as const
      })).filter(t => !!t.symbol);
    } catch {
      return [];
    }
  }

  private async fetchFmpSenate(): Promise<InsiderTrade[]> {
    const apiKey = this.env['FMP_API_KEY'];
    if (!apiKey) return [];

    try {
      const url = `https://financialmodelingprep.com/api/v4/senate-trading?limit=100&apikey=${apiKey}`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) return [];
      
      const data = await response.json() as any[];
      return data.map(item => ({
        symbol: item.symbol,
        filerName: item.firstName + ' ' + item.lastName,
        transactionDate: item.transactionDate,
        reportingDate: item.disclosureDate,
        transactionType: item.type === 'Purchase' ? 'P-Purchase' : 'S-Sale',
        securitiesTransacted: 0, 
        price: 0,
        totalValue: this.parseValueRange(item.amount),
        description: item.description,
        source: 'senate' as const
      })).filter(t => !!t.symbol);
    } catch {
      return [];
    }
  }

  private async fetchFmpHouse(): Promise<InsiderTrade[]> {
    const apiKey = this.env['FMP_API_KEY'];
    if (!apiKey) return [];

    try {
      const url = `https://financialmodelingprep.com/api/v4/house-trading?limit=100&apikey=${apiKey}`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) return [];
      
      const data = await response.json() as any[];
      return data.map(item => ({
        symbol: item.symbol,
        filerName: item.representative,
        transactionDate: item.transactionDate,
        reportingDate: item.disclosureDate,
        transactionType: item.type === 'Purchase' ? 'P-Purchase' : 'S-Sale',
        securitiesTransacted: 0,
        price: 0,
        totalValue: this.parseValueRange(item.amount),
        description: item.description,
        source: 'house' as const
      })).filter(t => !!t.symbol);
    } catch {
      return [];
    }
  }

  private async fetchApifyCongressional(): Promise<InsiderTrade[]> {
    const apiKey = this.env['APIFY_API_KEY'];
    if (!apiKey) return [];

    try {
      // Fetching from the last successful dataset of the congress-stock-tracker actor
      const actorId = 'ryanclinton~congress-stock-tracker';
      const url = `https://api.apify.com/v2/acts/${actorId}/runs/last/dataset/items?token=${apiKey}&clean=1`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) return [];
      
      const data = await response.json() as any[];
      return data.map(item => ({
        symbol: item.symbol || item.ticker,
        filerName: item.member || item.representative || item.senator,
        transactionDate: item.transactionDate || item.date,
        reportingDate: item.disclosureDate || item.filedDate || new Date().toISOString(),
        transactionType: (item.type || item.transactionType || '').includes('Purchase') ? 'P-Purchase' : 'S-Sale',
        securitiesTransacted: 0,
        price: 0,
        totalValue: this.parseValueRange(item.amount || item.value || ''),
        description: item.assetDescription || item.description,
        source: (item.chamber === 'Senate' ? 'senate' : 'house') as any
      })).filter(t => !!t.symbol);
    } catch (error) {
      console.error('[insider-radar] Apify fetch failed:', error);
      return [];
    }
  }

  private mergeTrades(existing: InsiderTrade[], incoming: InsiderTrade[]): InsiderTrade[] {
    const map = new Map<string, InsiderTrade>();
    const all = [...existing, ...incoming];
    
    // Sort by reporting date so latest wins in the map
    all.sort((a,b) => new Date(a.reportingDate).getTime() - new Date(b.reportingDate).getTime());
    
    for (const t of all) {
      // Use more specific ID to handle multiple filings by same member on same day
      const id = `${t.symbol}-${t.filerName}-${t.transactionDate}-${t.source}-${t.transactionType}-${t.totalValue}`;
      map.set(id, t);
    }

    const merged = Array.from(map.values());
    const cutoff = Date.now() - (MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    return merged.filter(t => new Date(t.reportingDate).getTime() > cutoff)
      .sort((a,b) => new Date(b.reportingDate).getTime() - new Date(a.reportingDate).getTime());
  }

  private computeSignals(trades: InsiderTrade[]): InsiderSignal[] {
    const bySymbol: Record<string, InsiderTrade[]> = {};
    for (const t of trades) {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
      const symTrades = bySymbol[t.symbol];
      if (symTrades) {
        symTrades.push(t);
      }
    }

    const signals: InsiderSignal[] = [];
    for (const [symbol, symTrades] of Object.entries(bySymbol)) {
      let netValue = 0;
      let buyCount = 0;
      let sellCount = 0;
      let highConvictionFiler = false;

      for (const t of symTrades) {
        const isBuy = t.transactionType.includes('Purchase') || t.transactionType.includes('Buy') || t.transactionType === 'P';
        if (isBuy) {
          netValue += t.totalValue;
          buyCount++;
        } else {
          netValue -= t.totalValue;
          sellCount++;
        }
        
        if (HIGH_CONVICTION_FILERS.some(f => t.filerName.toUpperCase().includes(f))) {
          highConvictionFiler = true;
        }
      }

      const direction = netValue > 0 ? 'bullish' : netValue < 0 ? 'bearish' : 'neutral';
      
      // Intensity logic
      let score = 0;
      if (Math.abs(netValue) > 1_000_000) score += 0.4;
      else if (Math.abs(netValue) > 100_000) score += 0.2;
      
      if (buyCount + sellCount >= 3) score += 0.3; // Cluster
      if (highConvictionFiler) score += 0.3;
      
      const isCluster = (buyCount + sellCount) >= 2;
      const isTracked = TRACKED_SYMBOLS.includes(symbol);

      signals.push({
        symbol,
        direction,
        // UNCAP: Removed 0.3 cap for non-tracked symbols to allow Shadow-Insider-Bot copying.
        // Base score is weighted slightly higher if tracked, but clusters can still reach high scores.
        convictionScore: isTracked ? Math.min(score, 1) : Math.min(score * 0.8, 1),
        isCluster,
        totalValue: Math.abs(netValue),
        tradeCount: buyCount + sellCount,
        recentTrades: symTrades.slice(0, 5),
        summary: `${isCluster ? 'CLUSTER: ' : ''}${buyCount} buys, ${sellCount} sales by ${highConvictionFiler ? 'high-conviction ' : ''}insiders/policymakers. Total absolute volume: $${Math.round(Math.abs(netValue)).toLocaleString()}.`
      });
    }

    return signals.sort((a, b) => b.convictionScore - a.convictionScore);
  }

  private async enrichSignalsWithAI(): Promise<void> {
    const claudeBin = this.env['CLAUDE_BIN'] || '/home/ubuntubox/.local/bin/claude';
    
    // Only enrich bullish/bearish signals with high scores or clusters
    const candidates = this.signals.filter(s => s.convictionScore >= 0.3 && s.direction !== 'neutral');
    
    for (const signal of candidates) {
      try {
        const tradesPrompt = signal.recentTrades.map(t => 
          `- ${t.filerName} (${t.officerTitle}): ${t.transactionType} $${Math.round(t.totalValue).toLocaleString()} on ${t.transactionDate}`
        ).join('\n');

        const prompt = `Analyze these recent insider/political filings for ${signal.symbol}:\n${tradesPrompt}\n\nTask: Determine if these represent high-conviction moves or routine activity (tax sells, options exercises, etc). Return a 1-sentence "convictionReason" explaining why this is noteworthy or ignorable. Focus on clusters and high-ranking officials. End with a "sentiment" score 0-1.`;

        const result = spawnSync(claudeBin, [prompt], { encoding: 'utf8' });
        if (result.stdout) {
          signal.convictionReason = result.stdout.trim().split('\n')[0];
          // Optionally adjust score based on AI intuition
          if (result.stdout.toLowerCase().includes('high conviction') || result.stdout.toLowerCase().includes('noteworthy')) {
            signal.convictionScore = Math.min(signal.convictionScore + 0.1, 1);
          }
        }
      } catch (err) {
        console.error(`[insider-radar] AI enrich fail for ${signal.symbol}:`, err);
      }
    }
  }

  private parseValueRange(range: string): number {
    if (!range) return 0;
    // House/Senate amounts are ranges like "$1,001 - $15,000"
    const cleaned = range.replace(/[$,]/g, '');
    const parts = cleaned.split('-').map(p => parseFloat(p.trim()));
    const p0 = parts[0] ?? 0;
    const p1 = parts[1] ?? 0;
    if (parts.length === 2) return (p0 + p1) / 2;
    if (parts.length === 1) return p0;
    return 0;
  }

  private loadEnv(): Record<string, string> {
    if (!fs.existsSync(PROJECT_ENV_PATH)) return {};
    const content = fs.readFileSync(PROJECT_ENV_PATH, 'utf8');
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const [key, ...rest] = line.split('=');
      if (key && rest.length > 0) env[key.trim()] = rest.join('=').trim();
    }
    return env;
  }

  private saveSnapshot(): void {
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(this.getSnapshot(), null, 2), 'utf8');
    } catch {}
  }

  private loadSnapshot(): void {
    try {
      if (!fs.existsSync(SNAPSHOT_PATH)) return;
      const data = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as InsiderRadarSnapshot;
      this.trades = data.trades || [];
      this.signals = data.signals || [];
    } catch {}
  }
}

let insiderRadar: InsiderRadar | undefined;

export function getInsiderRadar(): InsiderRadar {
  if (!insiderRadar) {
    insiderRadar = new InsiderRadar();
    insiderRadar.start();
  }
  return insiderRadar;
}

async function fetchWithTimeout(url: string, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}
