import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runProcess } from './ai-council.js';
import { pushLog } from './services/live-log.js';
import { getHistoricalContext } from './historical-context.js';
import { redis, TOPICS } from '@hermes/infra';
import { logger } from '@hermes/logger';
import { pickModel } from './lib/llm-router.js';
import { logOllamaCall } from './services/ollama-activity.js';
import type { PaperDeskSnapshot, CrossAssetSignal } from '@hermes/contracts';
import type {
  MarketRegime,
} from './strategy-playbook.js';
export type { MarketRegime } from './strategy-playbook.js';
import { buildDirectorPrompt, parseDirectorResponse } from './strategy-director-prompts.js';
import { detectRegimeFromContext, applyPlaybookToAgents, applyDirectiveFromParsed, validateDirectiveViaBacktest } from './strategy-director-apply.js';


const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? '/home/ubuntubox/.local/bin/claude';
const CLAUDE_MODEL = process.env.STRATEGY_DIRECTOR_MODEL ?? process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';
const GEMINI_BIN = process.env.GEMINI_BIN ?? '/home/ubuntubox/.npm-global/bin/gemini';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
// Tier 1 (Gemini) → Tier 2 (MiniMax M2.7) fallback chain for strategy-director
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io';
const MINIMAX_KEY = process.env.MINIMAX_KEY ?? '';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7';
const INTERVAL_MS = Number(process.env.STRATEGY_DIRECTOR_INTERVAL_MS ?? 1_800_000); // 30 min
const STRATEGY_DIRECTOR_TIMEOUT_MS = Number(process.env.STRATEGY_DIRECTOR_TIMEOUT_MS ?? 180_000); // 180s timeout for slow providers
const USE_OLLAMA_FIRST = process.env.STRATEGY_DIRECTOR_OLLAMA_FIRST !== '0'; // use free Ollama first
// Dedicated Ollama URL for strategy-director (defaults to local for speed, override for remote)
const STRATEGY_DIRECTOR_OLLAMA_URL = process.env.STRATEGY_DIRECTOR_OLLAMA_URL ?? 'http://localhost:11434/v1';
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
  emitTerminal?: (pane: string, msg: unknown) => void;
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

      // Announce regime to the trading engine via Redis pub/sub so capital-manager
      // can throttle lane allocation without a direct import dependency.
      await redis.publish(TOPICS.REGIME_UPDATE, JSON.stringify({
        regime,
        timestamp: new Date().toISOString(),
        runId,
      }));

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

    // Fetch broker accounts, loss clusters, forward simulation, pnl attribution, + COO directives in parallel
    const [brokerResp, clusterResp, simResp, pnlResp, cooResp] = await Promise.allSettled([
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
      })(),
      // COO directive (2026-04-20): authoritative P&L per strategy from journal, not in-memory agents.
      // The in-memory desk.agents[].realizedPnl resets on API restart and drifts from the journal.
      // Fetching /api/pnl-attribution gives us the journal-aggregated byStrategy view.
      (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        const resp = await fetch('http://127.0.0.1:4300/api/pnl-attribution', { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error('pnl-attribution non-ok');
        return await resp.json() as Record<string, unknown>;
      })(),
      // COO feedback-loop: pull recent COO directives so the director respects pause/amplify/
      // directive decisions. Without this, the openclaw-hermes bridge emits directives into
      // the void — nothing consumes them. (Gap #3 from the 2026-04-20 feedback loop audit.)
      (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        const resp = await fetch('http://127.0.0.1:4300/api/coo/directives', { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error('coo directives non-ok');
        return await resp.json() as Array<Record<string, unknown>>;
      })()
    ]);
    const brokerData = brokerResp.status === 'fulfilled' ? brokerResp.value : null;
    const clusters = clusterResp.status === 'fulfilled' ? clusterResp.value : null;
    const simulations = simResp.status === 'fulfilled' ? simResp.value : null;
    const pnlAttribution = pnlResp.status === 'fulfilled' ? pnlResp.value : null;
    const cooDirectivesRaw = cooResp.status === 'fulfilled' ? cooResp.value : [];
    const cooDirectives = Array.isArray(cooDirectivesRaw) ? cooDirectivesRaw : [];

    // Materialize COO overrides as explicit guardrails the LLM MUST respect.
    // - coo-pause-strategy → strategy should not be amplified/retained
    // - coo-amplify-strategy → strategy should not be removed/down-sized
    const cooPausedStrategies = new Set<string>();
    const cooAmplifiedStrategies = new Set<string>();
    const recentDirectiveText: string[] = [];
    // Only the most recent 20 directives, most-recent first
    for (const d of cooDirectives.slice(-20).reverse()) {
      const t = String(d.type ?? '');
      if (t === 'coo-pause-strategy' && typeof d.strategy === 'string') cooPausedStrategies.add(d.strategy);
      if (t === 'coo-amplify-strategy' && typeof d.strategy === 'string') cooAmplifiedStrategies.add(d.strategy);
      if (t === 'coo-directive' || t === 'coo-note') {
        const txt = typeof d.text === 'string' ? d.text : '';
        if (txt) recentDirectiveText.push(`[${String(d.timestamp ?? '').slice(0, 19)}] ${txt.slice(0, 400)}`);
      }
    }

    // Build a lookup from byStrategy so we can override stale agent.pnl / agent.trades / agent.winRate
    // with journal-authoritative numbers when the director reasons over per-agent data.
    const byStrategyMap = new Map<string, Record<string, unknown>>();
    const byStrat = pnlAttribution ? ((pnlAttribution as Record<string, unknown>).byStrategy as Array<Record<string, unknown>> | undefined) : undefined;
    if (Array.isArray(byStrat)) {
      for (const row of byStrat) {
        const k = String(row.key ?? '');
        if (k) byStrategyMap.set(k, row);
      }
    }

    return {
      agents: desk.agents.map((a) => {
        // COO fix: prefer journal-authoritative pnl/trades/winRate when agent id matches
        // a byStrategy key in /api/pnl-attribution. Falls back to in-memory values otherwise.
        const agentId = String((a as unknown as Record<string, unknown>).id ?? '');
        const authoritative = byStrategyMap.get(agentId);
        const trades = authoritative ? Number(authoritative.count) : a.totalTrades;
        const winRate = authoritative ? Number(authoritative.winRate) : a.winRate;
        const pnl = authoritative ? Number(authoritative.pnl) : a.realizedPnl;
        return {
          id: agentId,
          name: a.name,
          symbol: (a as unknown as Record<string, unknown>).lastSymbol ?? '',
          broker: a.broker,
          status: a.status,
          trades,
          winRate,
          pnl,
          pnlSource: authoritative ? 'journal' : 'in-memory',
          equity: a.equity,
          openPositions: a.openPositions
        };
      }),
      pnlAttribution: pnlAttribution ?? null,
      cooOverrides: {
        pausedStrategies: Array.from(cooPausedStrategies),
        amplifiedStrategies: Array.from(cooAmplifiedStrategies),
        recentDirectives: recentDirectiveText.slice(0, 10),
        totalDirectives: cooDirectives.length,
      },
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

  /**
   * Tiered evaluation with 3-provider fallback chain:
   *   Tier 0: Claude (primary, highest quality)
   *   Tier 1: Gemini Flash (fast, cheap)
   *   Tier 2: MiniMax M2.7 (ultra-fast, ~$0.05/1M tokens, confirmed working)
   *
   * Claude is tried first (best reasoning for strategy). On rate-limit or failure,
   * Gemini is used. On Gemini failure, MiniMax M2.7 takes over with its reasoning
   * model for strategy synthesis. This saves ~$15-25/day vs Claude-only.
   * Now uses Ollama first (free), then falls back to cloud models.
   */
  private async evaluateWithFallback(prompt: string): Promise<string> {
    // --- Tier 0: Ollama (free) - try first if enabled ---
    // Uses STRATEGY_DIRECTOR_OLLAMA_URL (default: localhost for speed) and a JSON-safe model
    if (USE_OLLAMA_FIRST) {
      const ollamaStart = Date.now();
      const ollamaPrompt = `${prompt}\n\nRespond with JSON only.`;
      const sdModel = process.env.STRATEGY_DIRECTOR_OLLAMA_MODEL ?? 'hermes3:8b';
      const sdOllamaUrl = STRATEGY_DIRECTOR_OLLAMA_URL;
      try {
        logOllamaCall({ source: 'strategy-director', model: sdModel, prompt: ollamaPrompt, status: 'started' });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000); // 120s for Ollama on LAN
        const resp = await fetch(`${sdOllamaUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: sdModel,
            messages: [{ role: 'user', content: ollamaPrompt }],
            max_tokens: 2048,
            temperature: 0.3,
            format: 'json', // enforce clean JSON output
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (resp.ok) {
          const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
          const content = (data.choices?.[0]?.message?.content ?? '').trim();
          // Validate JSON before accepting — some models echo their name instead of answering
          let parsedValid = false;
          if (content && content !== '{}') {
            try {
              JSON.parse(content);
              parsedValid = true;
            } catch {
              parsedValid = false;
            }
          }
          if (parsedValid) {
            console.log(`[strategy-director] Ollama (${sdModel}) served strategy analysis.`);
            logOllamaCall({
              source: 'strategy-director',
              model: sdModel,
              prompt: ollamaPrompt,
              responseSummary: content.slice(0, 80),
              latencyMs: Date.now() - ollamaStart,
              status: 'complete',
            });
            return content;
          } else {
            console.log(`[strategy-director] Ollama returned non-JSON (${content.slice(0, 40)}), falling back...`);
            logOllamaCall({
              source: 'strategy-director',
              model: sdModel,
              prompt: ollamaPrompt,
              latencyMs: Date.now() - ollamaStart,
              status: 'error',
              errorPreview: `non-JSON: ${content.slice(0, 80)}`,
            });
          }
        } else {
          logOllamaCall({
            source: 'strategy-director',
            model: sdModel,
            prompt: ollamaPrompt,
            latencyMs: Date.now() - ollamaStart,
            status: 'error',
            errorPreview: `HTTP ${resp.status}`,
          });
        }
      } catch (ollamaErr) {
        const errMsg = ollamaErr instanceof Error ? ollamaErr.message : String(ollamaErr);
        console.log(`[strategy-director] Ollama failed (${errMsg.slice(0, 60)}), falling back to cloud...`);
        logOllamaCall({
          source: 'strategy-director',
          model: pickModel("financial-reasoning").model,
          prompt: ollamaPrompt,
          latencyMs: Date.now() - ollamaStart,
          status: 'error',
          errorPreview: errMsg.slice(0, 120),
        });
      }
    }

    // --- Tier 1: Claude primary (reduced timeout from 5min to 45s) ---
    // Skip entirely if STRATEGY_DIRECTOR_SKIP_CLAUDE=1 — Claude CLI has been
    // consistently returning non-JSON envelope on this host and we fall through
    // to Gemini/MiniMax anyway, so this avoids wasted latency.
    if (process.env.STRATEGY_DIRECTOR_SKIP_CLAUDE !== '1') {
      try {
        const { stdout } = await runProcess(
          CLAUDE_BIN,
          ['-p', '--output-format', 'json', '--model', CLAUDE_MODEL],
          { cwd: WORKSPACE_ROOT, timeoutMs: STRATEGY_DIRECTOR_TIMEOUT_MS, stdin: prompt }
        );

        const envelope = JSON.parse(stdout) as { result?: string, error?: string };
        const output = envelope.result ?? stdout;

        if (/hit your limit|rate.?limit|429|overloaded/i.test(output)) {
          throw new Error(`Claude rate-limited: ${output}`);
        }
        return output;

      } catch (primaryError) {
        console.log(`[strategy-director] Claude failed (${primaryError instanceof Error ? primaryError.message.slice(0, 60) : 'unknown'}), falling back to Gemini...`);
      }
    } else {
      console.log(`[strategy-director] Claude skipped (STRATEGY_DIRECTOR_SKIP_CLAUDE=1), going straight to Gemini...`);
    }

    // --- Tier 2: Gemini Flash fallback (reduced timeout from 5min to 45s) ---
    try {
      const { stdout } = await runProcess(
        GEMINI_BIN,
        ['-m', GEMINI_MODEL, '--output-format', 'json', '-p', '-'],
        { cwd: WORKSPACE_ROOT, timeoutMs: STRATEGY_DIRECTOR_TIMEOUT_MS, stdin: prompt }
      );

      const envelope = JSON.parse(stdout) as { result?: string, error?: string };
      console.log('[strategy-director] Gemini Flash served as fallback.');
      return envelope.result ?? stdout;
    } catch (geminiError) {
      console.log(`[strategy-director] Gemini failed (${geminiError instanceof Error ? geminiError.message.slice(0, 60) : 'unknown'}), falling back to MiniMax...`);
    }

    // --- Tier 3: MiniMax M2.7 fallback — DISABLED by production default ---
    // MiniMax is reserved exclusively for the COO bridge (agent:main:explicit:bridge).
    // Running strategy-director on MiniMax simultaneously saturates the single available
    // instance, causing the COO to hang. Set STRATEGY_DIRECTOR_SKIP_MINIMAX=0 to re-enable.
    if (MINIMAX_KEY && process.env.STRATEGY_DIRECTOR_SKIP_MINIMAX !== '1') {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);

        const resp = await fetch(`${MINIMAX_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${MINIMAX_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: MINIMAX_MODEL,
            messages: [
              {
                role: 'user',
                content: `${prompt}\n\nRespond with JSON only.`
              }
            ],
            max_tokens: 2048,
            temperature: 0.3
          }),
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (!resp.ok) {
          throw new Error(`MiniMax API ${resp.status}`);
        }

        const data = await resp.json() as {
          choices?: Array<{ message?: { content?: string } }>
        };
        const raw = data.choices?.[0]?.message?.content ?? '{}';
        console.log('[strategy-director] MiniMax M2.7 served as final fallback.');
        return raw;
      } catch (minimaxError) {
        console.log(`[strategy-director] MiniMax failed: ${minimaxError instanceof Error ? minimaxError.message.slice(0, 60) : 'unknown'}`);
      }
    } else {
      console.log('[strategy-director] MINIMAX_KEY not set, skipping MiniMax fallback.');
    }

    // Last resort: throw
    throw new Error('All providers failed for strategy-director.');
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
    // Gate: validate directive via backtest before applying
    const engine = this.deps.getPaperEngine();
    const validation = await validateDirectiveViaBacktest(parsed, engine);
    if (!validation.pass) {
      console.log(`[strategy-director] ⛔ Directive REJECTED — ${validation.reason}`);
      console.log(`[strategy-director]   baseline: Sharpe=${validation.baseline?.sharpe?.toFixed(2)}, DD=${validation.baseline?.maxDrawdown?.toFixed(1)}%, WR=${validation.baseline?.winRate?.toFixed(1)}%`);
      if (validation.backtest) {
        console.log(`[strategy-director]   candidate: Sharpe=${validation.backtest.sharpe?.toFixed(2)}, DD=${validation.backtest.maxDrawdown?.toFixed(1)}%, WR=${validation.backtest.winRate?.toFixed(1)}%`);
      }
      // Emit rejection to strategy-director terminal pane
      this.deps.emitTerminal?.('strategy-director', {
        type: 'directive-rejected',
        reason: validation.reason,
        baseline: validation.baseline,
        candidate: validation.backtest,
        timestamp: new Date().toISOString(),
      });
      // Return empty directive (no changes applied)
      return {
        timestamp: new Date().toISOString(),
        runId,
        latencyMs: Date.now() - startedAt,
        detectedRegime: regime,
        symbolChanges: [],
        agentAdjustments: [],
        playbookApplications,
        allocationShifts: [],
        riskPosture: null,
        reasoning: `REJECTED: ${validation.reason}`
      };
    }
    if (validation.reason !== 'backtest-unavailable') {
      console.log(`[strategy-director] ✅ Directive validated: ${validation.reason}`);
    }
    return applyDirectiveFromParsed(parsed, runId, startedAt, regime, playbookApplications, engine);
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
      // Restore last regime + template map from the most recent persisted directive
      // so dashboard doesn't show regime:unknown after every api restart.
      const latest = this.directives[0];
      if (latest?.detectedRegime && latest.detectedRegime !== 'unknown') {
        this.lastDetectedRegime = latest.detectedRegime;
        for (const app of latest.playbookApplications ?? []) {
          this.agentTemplateMap.set(app.agentId, app.templateId);
        }
        console.log(`[strategy-director] Restored prior state: regime=${latest.detectedRegime}, ${latest.playbookApplications?.length ?? 0} template bindings (cycled ${new Date(latest.timestamp).toISOString()})`);
      }
    } catch {
      // ignore
    }
  }
}
