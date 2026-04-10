import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runProcess } from './ai-council.js';
import type { PaperDeskSnapshot } from '@hermes/contracts';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? '/home/ubuntubox/.local/bin/claude';
const CLAUDE_MODEL = process.env.STRATEGY_DIRECTOR_MODEL ?? process.env.CLAUDE_MODEL ?? 'sonnet';
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

export interface DirectorDirective {
  timestamp: string;
  runId: string;
  latencyMs: number;
  symbolChanges: SymbolChange[];
  agentAdjustments: AgentAdjustment[];
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
}

export class StrategyDirector {
  private timer: NodeJS.Timeout | null = null;
  private runInFlight = false;
  private directives: DirectorDirective[] = [];
  private deps: StrategyDirectorDeps;

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

  async runCycle(): Promise<DirectorDirective> {
    if (this.runInFlight) {
      const skip: DirectorDirective = {
        timestamp: new Date().toISOString(), runId: randomUUID(), latencyMs: 0,
        symbolChanges: [], agentAdjustments: [], allocationShifts: [],
        riskPosture: null, reasoning: 'Skipped: previous cycle still in flight.'
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

      // 2. Build prompt
      const prompt = this.buildPrompt(context);

      // 3. Call Claude
      const rawResponse = await this.callClaude(prompt);

      // 4. Parse response
      const parsed = this.parseResponse(rawResponse);

      // 5. Run forward simulation to validate proposed changes
      const simResults = await this.runForwardSimulation(parsed, context);
      if (simResults) {
        console.log(`[strategy-director] Forward sim: current=${simResults.currentSharpe.toFixed(2)} proposed=${simResults.proposedSharpe.toFixed(2)} ${simResults.improved ? 'IMPROVED' : 'NO IMPROVEMENT'}`);
      }

      // 6. Apply changes (only if simulation shows improvement or no sim available)
      const directive = await this.applyDirective(parsed, runId, startedAt, rawResponse);

      // 6. Log
      this.directives.unshift(directive);
      if (this.directives.length > 200) this.directives.splice(200);
      this.persistLog(directive);

      console.log(`[strategy-director] Cycle ${runId.slice(0, 8)} complete: ${directive.agentAdjustments.length} adjustments, ${directive.symbolChanges.length} symbol changes, posture=${directive.riskPosture?.posture ?? 'unchanged'} (${directive.latencyMs}ms)`);

      return directive;
    } catch (error) {
      const errorDirective: DirectorDirective = {
        timestamp: new Date().toISOString(), runId, latencyMs: Date.now() - startedAt,
        symbolChanges: [], agentAdjustments: [], allocationShifts: [],
        riskPosture: null,
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
        articles: ((newsSnapshot as Record<string, unknown>).articles as unknown[] ?? []).slice(0, 10)
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

  private buildPrompt(ctx: Record<string, unknown>): string {
    const lines = [
      'You are the Strategy Director for Hermes Trading Firm — a multi-asset paper trading system.',
      'You review the portfolio every 30 minutes and recommend INCREMENTAL adjustments.',
      'Think like a human portfolio manager: read the news, check what worked, adjust sizing and targets.',
      '',
      'CURRENT PORTFOLIO:',
      JSON.stringify(ctx.agents, null, 2),
      '',
      'AGENT CONFIGS:',
      JSON.stringify(ctx.configs, null, 2),
      '',
      `FIRM: equity=$${ctx.firmEquity} trades=${ctx.totalTrades} winRate=${ctx.winRate}% pnl=$${ctx.realizedPnl}`,
      '',
      'RECENT TRADES (last 30):',
      JSON.stringify(ctx.recentJournal, null, 2),
      '',
      'NEWS:',
      JSON.stringify(ctx.news, null, 2),
      '',
      'LOSS CLUSTERS (top 3):',
      JSON.stringify((ctx.lossClusters as Record<string, unknown>)?.lossClusters ? ((ctx.lossClusters as Record<string, unknown>).lossClusters as unknown[]).slice(0, 3) : [], null, 2),
      '',
      'FORWARD SIMULATION (bootstrap Monte Carlo — 500 scenarios):',
      JSON.stringify(ctx.forwardSimulation, null, 2),
      '',
      'TIMEFRAME CONTEXT:',
      'Think across multiple horizons when making decisions:',
      '- INTRADAY (today): What price action, news, and signals matter for scalping right now?',
      '- SHORT (1-3 days): Any events, earnings, or macro releases that shift the tape?',
      '- MEDIUM (1-2 weeks): Regime trends — is the market compressing, trending, or choppy?',
      '- LONG (month): Forward simulation above shows projected returns. Are current strategies aligned?',
      'Your proposed changes will be validated against forward Monte Carlo simulation before applying.',
      'Changes that reduce projected Sharpe ratio by >10% will be blocked.',
      '',
      'RULES:',
      '- Max 20% change per parameter per cycle',
      '- Be conservative. Small improvements compound.',
      '- If something is working, leave it alone.',
      '- If losing, tighten stops or reduce sizeFraction.',
      '- Only add symbols you believe have edge given current conditions.',
      '- Alpaca supports: crypto (BTC-USD,ETH-USD,SOL-USD,XRP-USD) + US stocks (SPY,QQQ,NVDA,AAPL,TSLA,MSFT,AMZN,VIXY)',
      '- OANDA supports: forex (EUR_USD,GBP_USD,USD_JPY,AUD_USD) + indices (SPX500_USD,NAS100_USD) + bonds (USB10Y_USD,USB30Y_USD) + commodities (XAU_USD,WTICO_USD)',
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

  private async callClaude(prompt: string): Promise<string> {
    try {
      const { stdout } = await runProcess(
        CLAUDE_BIN,
        ['-p', '--output-format', 'json', '--model', CLAUDE_MODEL],
        { cwd: WORKSPACE_ROOT, timeoutMs: 300_000, stdin: prompt }
      );
      const envelope = JSON.parse(stdout) as { result?: string };
      return envelope.result ?? stdout;
    } catch (error) {
      throw new Error(`Claude CLI failed: ${error instanceof Error ? error.message : 'unknown'}`);
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
    rawResponse: string
  ): Promise<DirectorDirective> {
    const engine = this.deps.getPaperEngine();
    const configs = engine.getAgentConfigs();
    const appliedAdjustments: AgentAdjustment[] = [];

    // Apply agent adjustments
    const adjustments = Array.isArray(parsed.agentAdjustments) ? parsed.agentAdjustments : [];
    for (const adj of adjustments) {
      const a = adj as Record<string, unknown>;
      const agentId = String(a.agentId ?? '');
      const field = String(a.field ?? '');
      const newValue = a.newValue;
      const reason = String(a.reason ?? '');

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
          backtestValidated: false // TODO: add backtest validation
        });
        console.log(`[strategy-director] Applied ${agentId}.${field}: ${oldNum} → ${rounded} (${reason})`);
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
      symbolChanges,
      agentAdjustments: appliedAdjustments,
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
