/**
 * Insider Radar
 *
 * Fetches and processes corporate insider trade data (SEC Form 4) and
 * congressional trading data (Senate/House) to identify clusters of conviction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pickModel } from './lib/llm-router.js';
import { logOllamaCall } from './services/ollama-activity.js';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ENV_PATH = path.resolve(MODULE_DIR, '../../../.env');
const RUNTIME_DIR = path.resolve(MODULE_DIR, '../.runtime/insider-radar');
const SNAPSHOT_PATH = path.join(RUNTIME_DIR, 'snapshot.json');
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';
const POLL_MS = 3_600_000; // Hourly (insider data moves slower than news)
const MAX_AGE_DAYS = 30;
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
    trades = [];
    signals = [];
    pollTimer = null;
    env = {};
    constructor() {
        this.env = this.loadEnv();
        this.loadSnapshot();
    }
    async start() {
        console.log('[insider-radar] Starting service...');
        await this.poll();
        this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    }
    stop() {
        if (this.pollTimer)
            clearInterval(this.pollTimer);
    }
    getSnapshot() {
        return {
            timestamp: new Date().toISOString(),
            signals: this.signals,
            trades: this.trades
        };
    }
    /** Get insider signal for a specific symbol. Returns null if no signal. */
    getSignal(symbol) {
        // Normalize: insider data uses stock tickers (NVDA), agents use NVDA or NVDA-like
        const normalized = symbol.replace(/-USD$/, '').replace(/_USD$/, '').toUpperCase();
        return this.signals.find((s) => s.symbol.toUpperCase() === normalized) ?? null;
    }
    /** Get the strongest bullish signal across all symbols with conviction > threshold */
    getTopBullishSignal(minConviction = 0.6) {
        return this.signals
            .filter((s) => s.direction === 'bullish' && s.convictionScore >= minConviction)
            .sort((a, b) => b.convictionScore - a.convictionScore)[0] ?? null;
    }
    async poll() {
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
        }
        catch (error) {
            console.error('[insider-radar] Poll failed:', error);
        }
    }
    async fetchFmpInsider() {
        const apiKey = this.env['FMP_API_KEY'];
        if (!apiKey)
            return [];
        try {
            const url = `https://financialmodelingprep.com/stable/insider-trading/latest?apikey=${apiKey}`;
            const response = await fetchWithTimeout(url);
            if (!response.ok)
                return [];
            const data = await response.json();
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
                source: 'form4'
            })).filter(t => !!t.symbol);
        }
        catch {
            return [];
        }
    }
    async fetchFmpSenate() {
        const apiKey = this.env['FMP_API_KEY'];
        if (!apiKey)
            return [];
        try {
            const url = `https://financialmodelingprep.com/api/v4/senate-trading?limit=100&apikey=${apiKey}`;
            const response = await fetchWithTimeout(url);
            if (!response.ok)
                return [];
            const data = await response.json();
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
                source: 'senate'
            })).filter(t => !!t.symbol);
        }
        catch {
            return [];
        }
    }
    async fetchFmpHouse() {
        const apiKey = this.env['FMP_API_KEY'];
        if (!apiKey)
            return [];
        try {
            const url = `https://financialmodelingprep.com/api/v4/house-trading?limit=100&apikey=${apiKey}`;
            const response = await fetchWithTimeout(url);
            if (!response.ok)
                return [];
            const data = await response.json();
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
                source: 'house'
            })).filter(t => !!t.symbol);
        }
        catch {
            return [];
        }
    }
    async fetchApifyCongressional() {
        const apiKey = this.env['APIFY_API_KEY'];
        if (!apiKey)
            return [];
        try {
            // Fetching from the last successful dataset of the congress-stock-tracker actor
            const actorId = 'ryanclinton~congress-stock-tracker';
            const url = `https://api.apify.com/v2/acts/${actorId}/runs/last/dataset/items?token=${apiKey}&clean=1`;
            const response = await fetchWithTimeout(url);
            if (!response.ok)
                return [];
            const data = await response.json();
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
                source: (item.chamber === 'Senate' ? 'senate' : 'house')
            })).filter(t => !!t.symbol);
        }
        catch (error) {
            console.error('[insider-radar] Apify fetch failed:', error);
            return [];
        }
    }
    mergeTrades(existing, incoming) {
        const map = new Map();
        const all = [...existing, ...incoming];
        // Sort by reporting date so latest wins in the map
        all.sort((a, b) => new Date(a.reportingDate).getTime() - new Date(b.reportingDate).getTime());
        for (const t of all) {
            // Use more specific ID to handle multiple filings by same member on same day
            const id = `${t.symbol}-${t.filerName}-${t.transactionDate}-${t.source}-${t.transactionType}-${t.totalValue}`;
            map.set(id, t);
        }
        const merged = Array.from(map.values());
        const cutoff = Date.now() - (MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
        return merged.filter(t => new Date(t.reportingDate).getTime() > cutoff)
            .sort((a, b) => new Date(b.reportingDate).getTime() - new Date(a.reportingDate).getTime());
    }
    computeSignals(trades) {
        const bySymbol = {};
        for (const t of trades) {
            if (!bySymbol[t.symbol])
                bySymbol[t.symbol] = [];
            const symTrades = bySymbol[t.symbol];
            if (symTrades) {
                symTrades.push(t);
            }
        }
        const signals = [];
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
                }
                else {
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
            if (Math.abs(netValue) > 1_000_000)
                score += 0.4;
            else if (Math.abs(netValue) > 100_000)
                score += 0.2;
            if (buyCount + sellCount >= 3)
                score += 0.3; // Cluster
            if (highConvictionFiler)
                score += 0.3;
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
    async enrichSignalsWithAI() {
        // Use free Ollama model for signal enrichment instead of expensive Claude
        const candidates = this.signals.filter(s => s.convictionScore >= 0.3 && s.direction !== 'neutral');
        for (const signal of candidates) {
            try {
                const tradesPrompt = signal.recentTrades.map(t => `- ${t.filerName} (${t.officerTitle}): ${t.transactionType} $${Math.round(t.totalValue).toLocaleString()} on ${t.transactionDate}`).join('\n');
                const enrichPrompt = `Analyze these insider/political filings for ${signal.symbol}. Return 1 sentence: "convictionReason" explaining if noteworthy or routine. Include "sentiment" score 0-1 at end.\n${tradesPrompt}`;
                const cfg = pickModel("financial-narrow");
                logOllamaCall({ source: 'insider-radar', model: cfg.model, prompt: enrichPrompt, status: 'started' });
                const ollamaStart = Date.now();
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
                const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: cfg.model,
                        messages: [{ role: 'user', content: enrichPrompt }],
                        max_tokens: 150,
                        temperature: 0.3,
                    }),
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                if (resp.ok) {
                    const data = await resp.json();
                    const content = data.choices?.[0]?.message?.content ?? '';
                    signal.convictionReason = content.trim().split('\n')[0];
                    if (content.toLowerCase().includes('high conviction') || content.toLowerCase().includes('noteworthy')) {
                        signal.convictionScore = Math.min(signal.convictionScore + 0.1, 1);
                    }
                    logOllamaCall({
                        source: 'insider-radar',
                        model: cfg.model,
                        prompt: enrichPrompt,
                        responseSummary: content.slice(0, 80),
                        latencyMs: Date.now() - ollamaStart,
                        status: 'complete',
                    });
                }
                else {
                    logOllamaCall({
                        source: 'insider-radar',
                        model: cfg.model,
                        prompt: enrichPrompt,
                        latencyMs: Date.now() - ollamaStart,
                        status: 'error',
                        errorPreview: `HTTP ${resp.status}`,
                    });
                }
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                const errPrompt = `Analyze insider filings for ${signal?.symbol ?? 'unknown'}.`;
                logOllamaCall({
                    source: 'insider-radar',
                    model: 'finance-llama',
                    prompt: errPrompt,
                    latencyMs: 0,
                    status: 'error',
                    errorPreview: errMsg.slice(0, 120),
                });
                console.log(`[insider-radar] Ollama enrich skip for ${signal?.symbol ?? '?'}: ${errMsg.slice(0, 50)}`);
            }
        }
    }
    parseValueRange(range) {
        if (!range)
            return 0;
        // House/Senate amounts are ranges like "$1,001 - $15,000"
        const cleaned = range.replace(/[$,]/g, '');
        const parts = cleaned.split('-').map(p => parseFloat(p.trim()));
        const p0 = parts[0] ?? 0;
        const p1 = parts[1] ?? 0;
        if (parts.length === 2)
            return (p0 + p1) / 2;
        if (parts.length === 1)
            return p0;
        return 0;
    }
    loadEnv() {
        if (!fs.existsSync(PROJECT_ENV_PATH))
            return {};
        const content = fs.readFileSync(PROJECT_ENV_PATH, 'utf8');
        const env = {};
        for (const line of content.split('\n')) {
            const [key, ...rest] = line.split('=');
            if (key && rest.length > 0)
                env[key.trim()] = rest.join('=').trim();
        }
        return env;
    }
    saveSnapshot() {
        try {
            fs.mkdirSync(RUNTIME_DIR, { recursive: true });
            fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(this.getSnapshot(), null, 2), 'utf8');
        }
        catch { }
    }
    loadSnapshot() {
        try {
            if (!fs.existsSync(SNAPSHOT_PATH))
                return;
            const data = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
            this.trades = data.trades || [];
            this.signals = data.signals || [];
        }
        catch { }
    }
}
let insiderRadar;
export function getInsiderRadar() {
    if (!insiderRadar) {
        insiderRadar = new InsiderRadar();
        insiderRadar.start();
    }
    return insiderRadar;
}
async function fetchWithTimeout(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        return res;
    }
    finally {
        clearTimeout(timeout);
    }
}
