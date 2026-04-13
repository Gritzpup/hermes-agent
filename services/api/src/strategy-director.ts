import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runProcess } from './ai-council.js';
import { pushLog } from './services/live-log.js';
import { getHistoricalContext } from './historical-context.js';
import { redis, TOPICS } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { PaperDeskSnapshot, CrossAssetSignal } from '@hermes/contracts';
import type {
  MarketRegime,
} from './strategy-playbook.js';
import { buildDirectorPrompt, parseDirectorResponse } from './strategy-director-prompts.js';
import { detectRegimeFromContext, applyPlaybookToAgents, applyDirectiveFromParsed } from './strategy-director-apply.js';


const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? '/home/ubuntubox/.local/bin/claude';
const CLAUDE_MODEL = process.env.STRATEGY_DIRECTOR_MODEL ?? process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';
const GEMINI_BIN = process.env.GEMINI_BIN ?? '/home/ubuntubox/.npm-global/bin/gemini';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const INTERVAL_MS = Number(process.env.STRATEGY_DIRECTOR_INTERVAL_MS ?? 1_800_000); // 30 min
const BACKTEST_URL = process.env.BACKTEST_URL ?? 'http://127.0.0.1:4305';
const STRATEGY_LAB_URL = process.env.STRATEGY_LAB_URL ?? 'http://127.0.0.1:4306';
const BROKER_ROUTER_URL = process.env.BROKER_ROUTER_URL ?? 'http://127.0.0.1:4303';
const REVIEW_LOOP_URL = process.env.REVIEW_LOOP_URL ?? 'http://127.0.0.1:4304';
const LOG_PATH = path.resolve(MODULE_DIR, '../../.runtime/paper-ledger/strategy-director-log.jsonl');

type BrokerId = 'alpaca-paper' | 'coinbase-live' | 'oanda-rest';

export interface AgentAdjustment {
  agentId: string;
  field: string;
  oldValue: number | string;
  newValue: number | string;
  reason: string;
  backtestValidated: boolean;
}

export interface SymbolChange {
  action: 'add' | 'remove' | 'watch';
  symbol: string;
  broker: string;
  assetClass: string;
  reason: string;
}

export interface AllocationShift {
  assetClass: string;
  newMultiplier: number;
  reason: string;
}

export interface RiskPosture {
  posture: 'aggressive' | 'normal' | 'defensive' | 'halt';
  reason: string;
}

/** Tracks when the playbook template was switched for an agent */
export interface PlaybookApplication {
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

export interface PaperEngineInterface {
  getSnapshot(): PaperDeskSnapshot;
  getAgentConfigs(): Array<{ agentId: string; config: any; deployment: any; [k: string]: any }>;
  getJournal(): Array<any>;
  applyAgentConfig(agentId: string, config: any): boolean;
}

interface IntelInterface {
  getSnapshot(...args: any[]): any;
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
    // HFT: Use Redis Pub/Sub for global signals instead of local bus
    const subscriber = redis.duplicate();
    subscriber.subscribe(TOPICS.RISK_SIGNAL, (err?: Error | null) => {
      if (err) logger.error({ err }, 'Failed to subscribe to Risk Signals');
    });

    const emergencySignals = new Set(['volatility-spike', 'risk-off', 'correlation-break']);
    subscriber.on('message', (channel: string, message: string) => {
      if (channel !== TOPICS.RISK_SIGNAL) return;
      try {
        const signal = JSON.parse(message) as CrossAssetSignal;
        if (!emergencySignals.has(signal.type)) return;
        
        const now = Date.now();
        const cooldownMs = 300_000; // 5-min cooldown between emergency cycles
        if (now - this.lastEmergencyCycleAt < cooldownMs) return;
        
        this.lastEmergencyCycleAt = now;
        logger.warn({ signal }, `EMERGENCY: ${signal.type} on ${signal.symbol} — triggering immediate regime reassessment`);
        void this.runCycle();
      } catch (err) {
        logger.error({ err }, 'Failed to parse Redis risk signal');
      }
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
      if (regime !== this.lastDetectedRegime && this.lastDetectedRegime !== 'unknown') {
        const historicalCtx = getHistoricalContext();
        const fngTrend = historicalCtx.getFngTrend();
        historicalCtx.recordRegimeChange(
          regime,
          this.lastDetectedRegime,
          `Strategy Director cycle ${runId.slice(0, 8)}`,
          fngTrend?.current ?? null,
          (context.market as Record<string, unknown>)?.btcPrice as number ?? null
        );
      }
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
      pushLog('director', `Cycle complete: regime=${regime} posture=${directive.riskPosture?.posture ?? 'unchanged'} | ${playbookApplications.length} playbooks ${directive.agentAdjustments.length} fine-tunes (${directive.latencyMs}ms)`);
      pushLog('director', `Reasoning: ${directive.reasoning?.slice(0, 200) ?? 'none'}`);
      for (const adj of directive.agentAdjustments.slice(0, 5)) {
        pushLog('director', `fine-tune ${adj.agentId}.${adj.field}: ${adj.oldValue} → ${adj.newValue}`);
      }

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

    // Fetch broker accounts, loss clusters, and forward simulation in parallel
    const [brokerResp, clusterResp, simResp] = await Promise.allSettled([
      (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        const resp = await fetch(`${BROKER_ROUTER_URL}/account`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error('broker non-ok');
        return await resp.json() as Record<string, unknown>;
      })(),
      (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        const resp = await fetch(`${REVIEW_LOOP_URL}/clusters`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error('clusters non-ok');
        return await resp.json() as Record<string, unknown>;
      })(),
      (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        const resp = await fetch(`${BACKTEST_URL}/quarter-outlook`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error('sim non-ok');
        return await resp.json() as Record<string, unknown>;
      })()
    ]);
    const brokerData = brokerResp.status === 'fulfilled' ? brokerResp.value : null;
    const clusters = clusterResp.status === 'fulfilled' ? clusterResp.value : null;
    const simulations = simResp.status === 'fulfilled' ? simResp.value : null;

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
    return buildDirectorPrompt(ctx, regime, playbookApplications);
  }

  /**
   * Detect the firm-wide regime from context gathered in gatherContext().
   * Uses the aggregated market + news + signal-bus data to call detectFirmRegime().
   */
  private detectRegime(ctx: Record<string, unknown>): MarketRegime {
    return detectRegimeFromContext(ctx);
  }

  /**
   * Apply the strategy playbook to all agents based on the current regime.
   * Only switches an agent if its template has changed from what it's currently running.
   * Bypasses the 20% clamp — playbook switches are intentional full overrides.
   */
  private applyPlaybook(
    regime: MarketRegime,
    _ctx: Record<string, unknown>
  ): PlaybookApplication[] {
    return applyPlaybookToAgents(regime, this.deps.getPaperEngine(), this.agentTemplateMap);
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
          ['-m', GEMINI_MODEL, '--output-format', 'json', '-p', '-'],
          { cwd: WORKSPACE_ROOT, timeoutMs: 300_000, stdin: prompt }
        );
        
        const envelope = JSON.parse(stdout) as { result?: string, error?: string };
        return envelope.result ?? stdout;
      } catch (fallbackError) {
        throw new Error(`All providers failed. Gemini fallback error: ${fallbackError instanceof Error ? fallbackError.message : 'unknown'}`);
      }
    }
  }

  private parseResponse(raw: string): Record<string, unknown> {
    return parseDirectorResponse(raw);
  }

  private async applyDirective(
    parsed: Record<string, unknown>,
    runId: string,
    startedAt: number,
    regime: MarketRegime,
    playbookApplications: PlaybookApplication[]
  ): Promise<DirectorDirective> {
    return applyDirectiveFromParsed(parsed, runId, startedAt, regime, playbookApplications, this.deps.getPaperEngine());
  }

  private async runForwardSimulation(
    proposed: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<{ currentSharpe: number; proposedSharpe: number; improved: boolean } | null> {
    // Build a map of agentId -> current config fields for defensive-change comparison
    const engine = this.deps.getPaperEngine();
    const currentConfigMap = new Map<string, Record<string, unknown>>();
    for (const agentConfig of engine.getAgentConfigs()) {
      currentConfigMap.set(agentConfig.agentId, agentConfig.config as Record<string, unknown>);
    }

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
        const agentId = String(a.agentId ?? '');
        const field = String(a.field ?? '');
        const newVal = Number(a.newValue ?? 0);
        // Compare proposed sizeFraction against the agent's actual current value
        const currentAgentConfig = currentConfigMap.get(agentId);
        const currentVal = currentAgentConfig ? Number(currentAgentConfig[field] ?? 0) : 0;
        return field === 'sizeFraction' && newVal < currentVal && newVal < 0.03;
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
