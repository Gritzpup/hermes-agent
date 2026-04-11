import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runProcess } from './ai-council.js';
import { getSignalBus } from './signal-bus.js';
import type { PaperDeskSnapshot, CrossAssetSignal } from '@hermes/contracts';
import {
  detectFirmRegime,
  getBestTemplate,
  type MarketRegime,
  type StrategyTemplate,
} from './strategy-playbook.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? '/home/ubuntubox/.local/bin/claude';
const CLAUDE_MODEL = process.env.STRATEGY_DIRECTOR_MODEL ?? process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';
const GEMINI_BIN = process.env.GEMINI_BIN ?? '/home/ubuntubox/.npm-global/bin/gemini';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview';
const INTERVAL_MS = Number(process.env.STRATEGY_DIRECTOR_INTERVAL_MS ?? 1_800_000); // 30 min
const BACKTEST_URL = process.env.BACKTEST_URL ?? 'http://127.0.0.1:4305';
const STRATEGY_LAB_URL = process.env.STRATEGY_LAB_URL ?? 'http://127.0.0.1:4306';
const BROKER_ROUTER_URL = process.env.BROKER_ROUTER_URL ?? 'http://127.0.0.1:4303';
const REVIEW_LOOP_URL = process.env.REVIEW_LOOP_URL ?? 'http://127.0.0.1:4304';
const LOG_PATH = path.resolve(MODULE_DIR, '../../.runtime/paper-ledger/strategy-director-log.jsonl');

type BrokerId = 'alpaca-paper' | 'coinbase-live' | 'oanda-rest';

interface AgentAdjustment {
  agentId: string;
  field: string;
  oldValue: number | string;
  newValue: number | string;
  reason: string;
  backtestValidated: boolean;
}

interface SymbolChange {
  action: 'add' | 'remove' | 'watch';
  symbol: string;
  broker: string;
  assetClass: string;
  reason: string;
}

interface AllocationShift {
  assetClass: string;
  newMultiplier: number;
  reason: string;
}

interface RiskPosture {
  posture: 'aggressive' | 'normal' | 'defensive' | 'halt';
  reason: string;
}

/** Tracks when the playbook template was switched for an agent */
interface PlaybookApplication {
  agentId: string;
  templateId: string;
  templateName: string;
  regime: MarketRegime;
  fieldsApplied: string[];
  reason: string;
}

export interface DirectorDirective {
  timestamp: string;
  runId: string;
  latencyMs: number;
  detectedRegime: MarketRegime;
  symbolChanges: SymbolChange[];
  agentAdjustments: AgentAdjustment[];
  playbookApplications: PlaybookApplication[];
  allocationShifts: AllocationShift[];
  riskPosture: RiskPosture | null;
  reasoning: string;
  error?: string;
}

interface PaperEngineInterface {
  getSnapshot(): PaperDeskSnapshot;
  getAgentConfigs(): Array<{ agentId: string; config: Record<string, unknown>; deployment: Record<string, unknown> }>;
  getJournal(): Array<Record<string, unknown>>;
  applyAgentConfig(agentId: string, config: Record<string, unknown>): boolean;
}

interface IntelInterface {
  getSnapshot(): Record<string, unknown>;
}

export interface StrategyDirectorDeps {
  getPaperEngine: () => PaperEngineInterface;
  getNewsIntel: () => IntelInterface;
  getMarketIntel: () => IntelInterface;
  getInsiderRadar: () => IntelInterface;
}

export class StrategyDirector {
  private timer: NodeJS.Timeout | null = null;
  private runInFlight = false;
  private directives: DirectorDirective[] = [];
  private deps: StrategyDirectorDeps;
  /** Tracks the last confirmed firm-wide regime across cycles */
  private lastDetectedRegime: MarketRegime = 'unknown';
  /** Tracks which playbook template each agent is currently running */
  private agentTemplateMap = new Map<string, string>(); // agentId -> templateId
  /** Cooldown to prevent emergency cycles from firing too often */
  private lastEmergencyCycleAt = 0;

  constructor(deps: StrategyDirectorDeps) {
    this.deps = deps;
    this.loadLog();
  }

  start(): void {
    if (this.timer) return;
    console.log(`[strategy-director] Starting (review every ${INTERVAL_MS / 60_000}min)`);
    // First run after 2 minutes warmup
    setTimeout(() => { void this.runCycle(); }, 120_000);
    this.timer = setInterval(() => { void this.runCycle(); }, INTERVAL_MS);

    // Listen for critical signals that warrant immediate regime reassessment
    const signalBus = getSignalBus();
    const emergencySignals = new Set(['volatility-spike', 'risk-off', 'correlation-break']);
    signalBus.onSignal((signal: CrossAssetSignal) => {
      if (!emergencySignals.has(signal.type)) return;
      const now = Date.now();
      const cooldownMs = 300_000; // 5-min cooldown between emergency cycles
      if (now - this.lastEmergencyCycleAt < cooldownMs) return;
      this.lastEmergencyCycleAt = now;
      console.log(`[strategy-director] EMERGENCY: ${signal.type} on ${signal.symbol} — triggering immediate regime reassessment`);
      void this.runCycle();
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getLog(limit = 50): DirectorDirective[] {
    return this.directives.slice(0, Math.min(limit, 200));
  }

  getLatest(): DirectorDirective | null {
    return this.directives[0] ?? null;
  }

  /** Returns the current regime and which playbook template each agent is running */
  getRegimeSnapshot(): {
    regime: MarketRegime;
    agentTemplates: Array<{ agentId: string; templateId: string }>;
    lastUpdated: string | null;
  } {
    return {
      regime: this.lastDetectedRegime,
      agentTemplates: Array.from(this.agentTemplateMap.entries()).map(([agentId, templateId]) => ({ agentId, templateId })),
      lastUpdated: this.directives[0]?.timestamp ?? null,
    };
  }

  async runCycle(): Promise<DirectorDirective> {
    if (this.runInFlight) {
      const skip: DirectorDirective = {
        timestamp: new Date().toISOString(), runId: randomUUID(), latencyMs: 0,
        detectedRegime: this.lastDetectedRegime,
        symbolChanges: [], agentAdjustments: [], playbookApplications: [],
        allocationShifts: [], riskPosture: null,
        reasoning: 'Skipped: previous cycle still in flight.'
      };
      return skip;
    }

    this.runInFlight = true;
    const startedAt = Date.now();
    const runId = randomUUID();

    try {
      console.log(`[strategy-director] Starting cycle ${runId.slice(0, 8)}`);

      // 1. Gather all context
      const context = await this.gatherContext();

      // 2. Detect firm-wide regime from aggregated signals
      const regime = this.detectRegime(context);
      this.lastDetectedRegime = regime;
      console.log(`[strategy-director] Detected regime: ${regime}`);

      // 3. Apply playbook templates to agents whose regime has changed
      const playbookApplications = this.applyPlaybook(regime, context);
      if (playbookApplications.length > 0) {
        console.log(`[strategy-director] Playbook: applied ${playbookApplications.length} template switches for regime '${regime}'`);
      }

      // 4. Build prompt for Claude (includes regime + playbook context)
      const prompt = this.buildPrompt(context, regime, playbookApplications);

      // 3. Ask AI to provide agent adjustments and risk shifts
      const rawAiResponse = await this.evaluateWithFallback(prompt);

      // 6. Parse response
      const parsed = this.parseResponse(rawAiResponse);

      // 7. Run forward simulation to validate proposed changes
      const simResults = await this.runForwardSimulation(parsed, context);
      if (simResults) {
        console.log(`[strategy-director] Forward sim: current=${simResults.currentSharpe.toFixed(2)} proposed=${simResults.proposedSharpe.toFixed(2)} ${simResults.improved ? 'IMPROVED' : 'NO IMPROVEMENT'}`);
      }

      // 8. Apply Claude's incremental adjustments on top of the playbook switch
      const directive = await this.applyDirective(parsed, runId, startedAt, regime, playbookApplications);

      // 9. Log
      this.directives.unshift(directive);
      if (this.directives.length > 200) this.directives.splice(200);
      this.persistLog(directive);

      console.log(`[strategy-director] Cycle ${runId.slice(0, 8)} complete: regime=${regime}, ${playbookApplications.length} playbook switches, ${directive.agentAdjustments.length} fine-tune adjustments, posture=${directive.riskPosture?.posture ?? 'unchanged'} (${directive.latencyMs}ms)`);

      return directive;
    } catch (error) {
      const errorDirective: DirectorDirective = {
        timestamp: new Date().toISOString(), runId, latencyMs: Date.now() - startedAt,
        detectedRegime: this.lastDetectedRegime,
        symbolChanges: [], agentAdjustments: [], playbookApplications: [],
        allocationShifts: [], riskPosture: null,
        reasoning: `Error: ${error instanceof Error ? error.message : 'unknown'}`,
        error: error instanceof Error ? error.message : 'unknown'
      };
      this.directives.unshift(errorDirective);
      this.persistLog(errorDirective);
      console.error(`[strategy-director] Cycle ${runId.slice(0, 8)} failed:`, error instanceof Error ? error.message : error);
      return errorDirective;
    } finally {
      this.runInFlight = false;
    }
  }

  private async gatherContext(): Promise<Record<string, unknown>> {
    const engine = this.deps.getPaperEngine();
    const desk = engine.getSnapshot();
    const configs = engine.getAgentConfigs();
    const journal = engine.getJournal();
    const newsSnapshot = this.deps.getNewsIntel().getSnapshot();
    const insiderSnapshot = this.deps.getInsiderRadar().getSnapshot();
    const marketSnapshot = this.deps.getMarketIntel().getSnapshot();

    // Fetch broker accounts
    let brokerData: Record<string, unknown> | null = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const resp = await fetch(`${BROKER_ROUTER_URL}/account`, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) brokerData = await resp.json() as Record<string, unknown>;
    } catch { /* best effort */ }

    // Fetch loss clusters
    let clusters: Record<string, unknown> | null = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const resp = await fetch(`${REVIEW_LOOP_URL}/clusters`, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) clusters = await resp.json() as Record<string, unknown>;
    } catch { /* best effort */ }

    // Fetch forward simulation at multiple timeframes
    let simulations: Record<string, unknown> | null = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const resp = await fetch(`${BACKTEST_URL}/quarter-outlook`, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) simulations = await resp.json() as Record<string, unknown>;
    } catch { /* best effort */ }

    return {
      agents: desk.agents.map((a) => ({
        id: (a as unknown as Record<string, unknown>).id ?? '',
        name: a.name,
        symbol: (a as unknown as Record<string, unknown>).lastSymbol ?? '',
        broker: a.broker,
        status: a.status,
        trades: a.totalTrades,
        winRate: a.winRate,
        pnl: a.realizedPnl,
        equity: a.equity,
        openPositions: a.openPositions
      })),
      configs: configs.slice(0, 20).map((c) => ({
        agentId: c.agentId,
        symbol: (c.config as Record<string, unknown>).symbol,
        style: (c.config as Record<string, unknown>).style,
        targetBps: (c.config as Record<string, unknown>).targetBps,
        stopBps: (c.config as Record<string, unknown>).stopBps,
        maxHoldTicks: (c.config as Record<string, unknown>).maxHoldTicks,
        sizeFraction: (c.config as Record<string, unknown>).sizeFraction,
      })),
      recentJournal: journal.slice(0, 10).map((j: Record<string, unknown>) => ({
        symbol: j.symbol, verdict: j.verdict, realizedPnl: j.realizedPnl,
        regime: j.regime, newsBias: j.newsBias, holdTicks: j.holdTicks
      })),
      firmEquity: desk.totalEquity,
      totalTrades: desk.totalTrades,
      winRate: desk.winRate,
      realizedPnl: desk.realizedPnl,
      news: {
        macroSignal: (newsSnapshot as Record<string, unknown>).macroSignal,
        articles: ((newsSnapshot as Record<string, unknown>).articles as unknown[] ?? []).slice(0, 10),
        insiderSignals: (insiderSnapshot as Record<string, unknown>).signals,
      },
      market: marketSnapshot,
      brokerAccounts: brokerData,
      lossClusters: clusters,
      forwardSimulation: simulations ? {
        overall: (simulations as Record<string, unknown>).overall,
        classSummaries: ((simulations as Record<string, unknown>).classSummaries as unknown[] ?? []).slice(0, 5)
      } : null,
      asOf: new Date().toISOString()
    };
  }

  private buildPrompt(
    ctx: Record<string, unknown>,
    regime: MarketRegime,
    playbookApplications: PlaybookApplication[]
  ): string {
    const playbookSummary = playbookApplications.length > 0
      ? `PLAYBOOK SWITCHES ALREADY APPLIED THIS CYCLE:\n${playbookApplications.map((p) =>
          `  - ${p.agentId}: switched to template '${p.templateName}' (${p.regime}) — ${p.reason}`
        ).join('\n')}`
      : 'PLAYBOOK: No template switches this cycle (regime unchanged or params already aligned).';

    const lines = [
      'You are the Strategy Director for Hermes Trading Firm — a multi-asset paper trading system.',
      'You review the portfolio every 30 minutes. The Strategy Playbook has already been applied (see below).',
      'Your job is to make INCREMENTAL FINE-TUNING adjustments on top of the playbook, based on news and performance.',
      '',
      `DETECTED FIRM-WIDE REGIME: ${regime.toUpperCase()}`,
      '',
      playbookSummary,
      '',
      'REGIME GUIDANCE:',
      regime === 'compression'
        ? 'COMPRESSION ACTIVE: BTC momentum is near zero, flat short-term returns. Agents have been switched to mean-reversion / grid templates with smaller size and extended cooldowns. Do NOT suggest momentum or breakout strategies. Suggest going to near-zero size if scores remain near zero.'
        : regime === 'trending-up'
        ? 'TRENDING UP: Momentum is the correct approach. Agents have been switched to dual-momentum templates. Increase sizeFraction for agents with high win rates. Use wider targets.'
        : regime === 'trending-down'
        ? 'TRENDING DOWN: Be defensive. Agents are in reduced-size mean-reversion mode. Suggest reducing size further if vol is increasing.'
        : regime === 'volatile'
        ? 'VOLATILE: Wide stops, small size, mean-reversion at extremes only. Do not suggest momentum.'
        : regime === 'panic'
        ? 'PANIC: Survival mode. Suggest halt or near-zero size across all agents. No new entries.'
        : regime === 'news-driven'
        ? 'NEWS-DRIVEN: Embargo may be active. Suggest extended cooldowns and reduced size until news resolves.'
        : 'UNKNOWN REGIME: Be conservative. Suggest reducing size and waiting for clearer signals.',
      '',
      'CURRENT PORTFOLIO:',
      JSON.stringify(ctx.agents, null, 2),
      '',
      'AGENT CONFIGS (after playbook application):',
      JSON.stringify(ctx.configs, null, 2),
      '',
      `FIRM: equity=$${ctx.firmEquity} trades=${ctx.totalTrades} winRate=${ctx.winRate}% pnl=$${ctx.realizedPnl}`,
      '',
      'RECENT TRADES (last 10):',
      JSON.stringify(ctx.recentJournal, null, 2),
      '',
      'TECHNICAL INDICATORS (from MarketIntel composite signals):',
      JSON.stringify(
        ((ctx.market as Record<string, unknown>)?.compositeSignal as Array<Record<string, unknown>> ?? [])
          .slice(0, 8)
          .map((s) => ({
            symbol: s.symbol,
            direction: s.direction,
            confidence: s.confidence,
            rsi2: s.rsi2 ?? 'n/a',
            stochastic: s.stochastic ?? 'n/a',
            obiWeighted: s.obiWeighted ?? 'n/a',
            reasons: ((s.reasons as string[]) ?? []).slice(0, 3),
          })),
        null, 2
      ),
      '',
      'NEWS & INSIDER RADAR:',
      JSON.stringify(ctx.news, null, 2),
      '',
      'LOSS CLUSTERS (top 3):',
      JSON.stringify((ctx.lossClusters as Record<string, unknown>)?.lossClusters ? ((ctx.lossClusters as Record<string, unknown>).lossClusters as unknown[]).slice(0, 3) : [], null, 2),
      '',
      'FORWARD SIMULATION (bootstrap Monte Carlo — 500 scenarios):',
      JSON.stringify(ctx.forwardSimulation, null, 2),
      '',
      'RULES:',
      '- The playbook already switched styles. Do NOT re-apply style changes — only fine-tune targetBps/stopBps/sizeFraction/cooldownTicks/spreadLimitBps.',
      '- Max 20% change per parameter per cycle.',
      '- Be conservative. Small improvements compound.',
      '- If a metric is near zero and the agent is in compression, reduce sizeFraction to 0.01-0.02 to park it.',
      '- If something is working, leave it alone.',
      '- Only add symbols you believe have edge given the current regime.',
      '- Alpaca supports: crypto (BTC-USD,ETH-USD,SOL-USD,XRP-USD) + US stocks (SPY,QQQ,NVDA,AAPL,TSLA,MSFT,AMZN,VIXY)',
      '- OANDA supports: forex (EUR_USD,GBP_USD,USD_JPY,AUD_USD) + indices (SPX500_USD,NAS100_USD) + bonds (USB10Y_USD,USB30Y_USD) + commodities (XAU_USD,XAG_USD,BCO_USD,WTICO_USD)',
      '- TECHNICAL INDICATORS: RSI(2) < 10 = extreme oversold (high-prob bounce), > 90 = extreme overbought. Stochastic K/D crossover confirms entries. Weighted OBI > 0.3 = strong bid pressure. Use these to validate or override regime assumptions.',
      '- If RSI(2) is extreme on multiple assets, the regime detection may be lagging — flag it in reasoning.',
      '- Half-Kelly sizing is active: agents dynamically size based on rolling 30-trade win rate. Do NOT set sizeFraction below 0.01 unless halting.',
      '- INSIDER TRADING / COPY SLEEVE: Use "insiderSignals" to identify high-conviction moves. The "convictionReason" (derived by AI) explains the significance.',
      '  - If a signal is BULLISH and "convictionScore" > 0.7, add/update the "Shadow-Insider-Bot" agent to copy that symbol with significantly higher sizeFactor.',
      '  - If "convictionReason" mentions "Tax Sell" or "Routine", ignore the signal.',
      '  - If a BEARISH cluster is detected with "convictionScore" > 0.8, suggest a "defensive" riskPosture and downsize trend-following longs.',
      '  - WEIGHT: Heavily prioritize the AI-generated "convictionReason" over raw volume.',
      '',
      'Return ONLY valid JSON with this schema:',
      '{',
      '  "symbolChanges": [{"action":"add|remove|watch","symbol":"string","broker":"alpaca-paper|oanda-rest","assetClass":"string","reason":"string"}],',
      '  "agentAdjustments": [{"agentId":"string","field":"targetBps|stopBps|maxHoldTicks|cooldownTicks|sizeFraction|spreadLimitBps","newValue":number,"reason":"string"}],',
      '  "allocationShifts": [{"assetClass":"string","newMultiplier":number,"reason":"string"}],',
      '  "riskPosture": {"posture":"aggressive|normal|defensive|halt","reason":"string"},',
      '  "reasoning": "overall analysis summary"',
      '}',
      'No markdown. No code fences. JSON only.'
    ];
    return lines.join('\n');
  }

  /**
   * Detect the firm-wide regime from context gathered in gatherContext().
   * Uses the aggregated market + news + signal-bus data to call detectFirmRegime().
   */
  private detectRegime(ctx: Record<string, unknown>): MarketRegime {
    try {
      const market = ctx.market as Record<string, unknown> | null;
      const news = ctx.news as Record<string, unknown> | null;
      const configs = ctx.configs as Array<Record<string, unknown>> | null ?? [];

      // Extract per-symbol regimes from recent journal
      const journal = ctx.recentJournal as Array<Record<string, unknown>> | null ?? [];
      const symbolRegimes: Record<string, string> = {};
      for (const entry of journal) {
        const sym = String(entry.symbol ?? '');
        const regime = String(entry.regime ?? 'unknown');
        if (sym) symbolRegimes[sym] = regime;
      }

      // Extract Bollinger squeeze state from market intel if present
      const marketSnap = market as Record<string, unknown> | null;
      const bollingerList = (marketSnap?.bollinger as Array<Record<string, unknown>>) ?? [];
      const bollingerSqueeze: Record<string, boolean> = {};
      for (const bb of bollingerList) {
        const sym = String(bb.symbol ?? '');
        if (sym) bollingerSqueeze[sym] = Boolean(bb.squeeze);
      }

      // Fear & Greed from news snapshot
      const fngRaw = (marketSnap?.fearGreed as Record<string, unknown> | null);
      const fearGreedValue: number | null = fngRaw?.value !== undefined ? Number(fngRaw.value) : null;

      // News / embargo veto from news snapshot
      const macroSignal = news?.macroSignal as Record<string, unknown> | null;
      const macroVetoActive = Boolean(macroSignal?.veto);
      const newsEmbargoActive = Boolean(macroSignal?.embargoed ?? macroSignal?.veto);

      // Estimate avg volatility from agent configs (sizeFraction as proxy — smaller = more defensive)
      // Better: use market data's volatility fields if available
      const avgVolatility = (() => {
        const volValues = (bollingerList as Array<Record<string, unknown>>).map((b) => {
          const bw = Number(b.bandwidth ?? 0);
          const mid = Number(b.middle ?? 1);
          return mid > 0 ? bw / mid : 0;
        });
        return volValues.length > 0
          ? volValues.reduce((s, v) => s + v, 0) / volValues.length
          : 0;
      })();

      // Estimate avgRecentMove from journal entries
      const avgRecentMove = (() => {
        const pnls = journal.map((j) => Math.abs(Number(j.realizedPnl ?? 0)));
        return pnls.length > 0
          ? pnls.reduce((s, v) => s + v, 0) / pnls.length / 100 // rough proxy
          : 0;
      })();

      // Risk-off: check lossClusters context or news macro
      const lossClusters = (ctx.lossClusters as Record<string, unknown> | null);
      const riskOffActive = Boolean(lossClusters?.riskOff ?? (macroVetoActive && fearGreedValue !== null && fearGreedValue < 25));

      return detectFirmRegime({
        symbolRegimes,
        bollingerSqueeze,
        fearGreedValue,
        riskOffActive,
        newsEmbargoActive,
        macroVetoActive,
        avgVolatility,
        avgRecentMove,
      });
    } catch {
      return 'unknown';
    }
  }

  /**
   * Apply the strategy playbook to all agents based on the current regime.
   * Only switches an agent if its template has changed from what it's currently running.
   * Bypasses the 20% clamp — playbook switches are intentional full overrides.
   */
  private applyPlaybook(
    regime: MarketRegime,
    ctx: Record<string, unknown>
  ): PlaybookApplication[] {
    if (regime === 'unknown') return [];

    const engine = this.deps.getPaperEngine();
    const configs = engine.getAgentConfigs();
    const applications: PlaybookApplication[] = [];

    for (const agentConfig of configs) {
      const agentId = agentConfig.agentId;
      const config = agentConfig.config as Record<string, unknown>;
      const assetClass = String(config.assetClass ?? (config.broker === 'oanda-rest' ? 'forex' : 'crypto')) as 'crypto' | 'equity' | 'forex' | 'bond' | 'commodity';

      // Pick the best template for this regime + asset class
      const template = getBestTemplate(regime, assetClass);
      if (!template) continue;

      // Check if this agent is already running this template
      const currentTemplateId = this.agentTemplateMap.get(agentId);
      if (currentTemplateId === template.id) continue; // already on this template, skip

      // Apply the template config override to the paper engine
      const overrideConfig: Record<string, unknown> = {
        style: template.style,
        targetBps: template.targetBps,
        stopBps: template.stopBps,
        maxHoldTicks: template.maxHoldTicks,
        cooldownTicks: template.cooldownTicks,
        sizeFraction: template.sizeFraction,
        spreadLimitBps: template.spreadLimitBps,
      };

      const applied = engine.applyAgentConfig(agentId, overrideConfig);
      if (!applied) continue;

      // Record the switch
      this.agentTemplateMap.set(agentId, template.id);
      const fieldsApplied = Object.keys(overrideConfig);
      applications.push({
        agentId,
        templateId: template.id,
        templateName: template.name,
        regime,
        fieldsApplied,
        reason: template.rationale,
      });

      console.log(`[strategy-director] Playbook: ${agentId} → '${template.name}' (${regime}) — ${template.rationale.slice(0, 80)}`);
    }

    return applications;
  }

  private async evaluateWithFallback(prompt: string): Promise<string> {
    try {
      const { stdout } = await runProcess(
        CLAUDE_BIN,
        ['-p', '--output-format', 'json', '--model', CLAUDE_MODEL],
        { cwd: WORKSPACE_ROOT, timeoutMs: 300_000, stdin: prompt }
      );
      
      const envelope = JSON.parse(stdout) as { result?: string, error?: string };
      const output = envelope.result ?? stdout;
      
      // Claude's CLI wraps rate limit errors in JSON but doesn't necessarily exit with 1
      if (/hit your limit|rate.?limit|429|overloaded/i.test(output)) {
        throw new Error(`Claude rate-limited: ${output}`);
      }
      return output;
      
    } catch (error) {
      console.log(`[strategy-director] Claude failed, falling back to Gemini: ${error instanceof Error ? error.message : 'unknown'}`);
      
      // Fallback to Gemini Flash
      try {
        const { stdout } = await runProcess(
          GEMINI_BIN,
          ['-m', GEMINI_MODEL, '-p', '-'],
          { cwd: WORKSPACE_ROOT, timeoutMs: 300_000, stdin: prompt }
        );
        return stdout;
      } catch (fallbackError) {
        throw new Error(`All providers failed. Gemini fallback error: ${fallbackError instanceof Error ? fallbackError.message : 'unknown'}`);
      }
    }
  }

  private parseResponse(raw: string): Record<string, unknown> {
    // Try to extract JSON from Claude's response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in Claude response');
    }
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  }

  private async applyDirective(
    parsed: Record<string, unknown>,
    runId: string,
    startedAt: number,
    regime: MarketRegime,
    playbookApplications: PlaybookApplication[]
  ): Promise<DirectorDirective> {
    const engine = this.deps.getPaperEngine();
    const configs = engine.getAgentConfigs();
    const appliedAdjustments: AgentAdjustment[] = [];

    // Apply agent adjustments (incremental fine-tuning on top of playbook)
    const adjustments = Array.isArray(parsed.agentAdjustments) ? parsed.agentAdjustments : [];
    for (const adj of adjustments) {
      const a = adj as Record<string, unknown>;
      const agentId = String(a.agentId ?? '');
      const field = String(a.field ?? '');
      const newValue = a.newValue;
      const reason = String(a.reason ?? '');

      // Block style overrides from Claude — playbook owns style switching
      if (field === 'style') {
        console.log(`[strategy-director] Blocked style override from Claude for ${agentId} — playbook owns style switching`);
        continue;
      }

      const current = configs.find((c) => c.agentId === agentId);
      if (!current) continue;

      const oldValue = (current.config as Record<string, unknown>)[field];
      if (oldValue === undefined || newValue === undefined) continue;

      // Clamp to 20% max change
      const oldNum = Number(oldValue);
      const newNum = Number(newValue);
      if (!Number.isFinite(oldNum) || !Number.isFinite(newNum)) continue;

      const maxDelta = Math.abs(oldNum) * 0.2;
      const clamped = Math.max(oldNum - maxDelta, Math.min(oldNum + maxDelta, newNum));
      const rounded = Math.round(clamped * 100) / 100;

      if (Math.abs(rounded - oldNum) < 0.001) continue; // no meaningful change

      const applied = engine.applyAgentConfig(agentId, { [field]: rounded });
      if (applied) {
        appliedAdjustments.push({
          agentId, field,
          oldValue: oldNum,
          newValue: rounded,
          reason,
          backtestValidated: false
        });
        console.log(`[strategy-director] Fine-tune: ${agentId}.${field}: ${oldNum} → ${rounded} (${reason})`);
      }
    }

    // Parse other fields
    const symbolChanges = (Array.isArray(parsed.symbolChanges) ? parsed.symbolChanges : []).map((s) => {
      const sc = s as Record<string, unknown>;
      return {
        action: String(sc.action ?? 'watch') as 'add' | 'remove' | 'watch',
        symbol: String(sc.symbol ?? ''),
        broker: String(sc.broker ?? ''),
        assetClass: String(sc.assetClass ?? ''),
        reason: String(sc.reason ?? '')
      };
    });

    const allocationShifts = (Array.isArray(parsed.allocationShifts) ? parsed.allocationShifts : []).map((a) => {
      const as_ = a as Record<string, unknown>;
      return {
        assetClass: String(as_.assetClass ?? ''),
        newMultiplier: Number(as_.newMultiplier ?? 1),
        reason: String(as_.reason ?? '')
      };
    });

    const rp = parsed.riskPosture as Record<string, unknown> | null;
    const riskPosture: RiskPosture | null = rp ? {
      posture: String(rp.posture ?? 'normal') as RiskPosture['posture'],
      reason: String(rp.reason ?? '')
    } : null;

    // Log symbol change recommendations
    for (const sc of symbolChanges) {
      console.log(`[strategy-director] Symbol recommendation: ${sc.action} ${sc.symbol} on ${sc.broker} (${sc.reason})`);
    }

    if (riskPosture && riskPosture.posture !== 'normal') {
      console.log(`[strategy-director] Risk posture: ${riskPosture.posture} (${riskPosture.reason})`);
    }

    return {
      timestamp: new Date().toISOString(),
      runId,
      latencyMs: Date.now() - startedAt,
      detectedRegime: regime,
      symbolChanges,
      agentAdjustments: appliedAdjustments,
      playbookApplications,
      allocationShifts,
      riskPosture,
      reasoning: String(parsed.reasoning ?? '')
    };
  }

  private async runForwardSimulation(
    proposed: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<{ currentSharpe: number; proposedSharpe: number; improved: boolean } | null> {
    try {
      // Run quarter outlook simulation with current configs as baseline
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const resp = await fetch(`${BACKTEST_URL}/quarter-outlook`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) return null;

      const outlook = await resp.json() as Record<string, unknown>;
      const overall = outlook.overall as Record<string, unknown> | undefined;
      if (!overall) return null;

      const lastQ = overall.lastQuarter as Record<string, unknown> | undefined;
      const nextQ = overall.nextQuarter as Record<string, unknown> | undefined;
      if (!lastQ || !nextQ) return null;

      const currentSharpe = Number(lastQ.strategyReturnPct ?? 0) / Math.max(Number(lastQ.strategyMaxDrawdownPct ?? 1), 0.1);
      const nextMedian = Number(nextQ.strategyMedianReturnPct ?? 0);
      const nextDD = Number(nextQ.strategyP25ReturnPct ?? -1);
      const proposedSharpe = nextMedian / Math.max(Math.abs(nextDD), 0.1);

      // If proposed adjustments move toward higher projected sharpe, approve
      const adjustments = Array.isArray(proposed.agentAdjustments) ? proposed.agentAdjustments : [];
      const hasDefensiveChanges = adjustments.some((a: Record<string, unknown>) => {
        const field = String(a.field ?? '');
        const newVal = Number(a.newValue ?? 0);
        const oldVal = Number(context.agents ? 0 : 0); // simplified
        return field === 'sizeFraction' && newVal < 0.03; // reducing to very small
      });

      const improved = proposedSharpe >= currentSharpe * 0.9 || hasDefensiveChanges;

      return { currentSharpe, proposedSharpe, improved };
    } catch {
      return null; // simulation unavailable, proceed anyway
    }
  }

  private persistLog(directive: DirectorDirective): void {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, `${JSON.stringify(directive)}\n`, 'utf8');
    } catch {
      // best effort
    }
  }

  private loadLog(): void {
    try {
      if (!fs.existsSync(LOG_PATH)) return;
      const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
      this.directives = lines.map((line) => JSON.parse(line) as DirectorDirective).reverse().slice(0, 200);
    } catch {
      // ignore
    }
  }
}
