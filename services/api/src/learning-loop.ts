/**
 * Self-Learning Loop
 * 
 * Monitors paper trading performance and triggers evolutionary optimization
 * when agents underperform. Promotes winning genomes into live paper configs.
 * 
 * Loop cadence:
 *  - Every REVIEW_INTERVAL_MS: check agent performance
 *  - If an agent has enough trades and is underperforming: trigger evolution
 *  - If evolution finds a better genome: hot-swap the agent's config
 *  - Log all decisions for auditability
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BacktestAgentConfig, BacktestResult, StrategyGenome } from '@hermes/contracts';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEARNING_LOG_PATH = process.env.LEARNING_LOG_PATH ?? path.resolve(MODULE_DIR, '../.runtime/paper-ledger/learning-log.jsonl');
const BACKTEST_URL = process.env.BACKTEST_URL ?? 'http://127.0.0.1:4305';
const REVIEW_INTERVAL_MS = Number(process.env.LEARNING_REVIEW_MS ?? 600_000); // 10 minutes
const MIN_TRADES_FOR_REVIEW = Number(process.env.LEARNING_MIN_TRADES ?? 5);
const UNDERPERFORM_PF_THRESHOLD = 0.9;
const UNDERPERFORM_WINRATE_THRESHOLD = 40;
const EVOLUTION_POPULATION = 15;
const EVOLUTION_GENERATIONS = 3;
const LOOKBACK_HOURS = 48;

interface AgentPerformance {
  agentId: string;
  agentName: string;
  symbol: string;
  style: string;
  trades: number;
  wins: number;
  realizedPnl: number;
  profitFactor: number;
  winRate: number;
  currentConfig: AgentConfigSnapshot;
}

interface AgentConfigSnapshot {
  targetBps: number;
  stopBps: number;
  maxHoldTicks: number;
  cooldownTicks: number;
  sizeFraction: number;
  spreadLimitBps: number;
  style: string;
}

interface LearningDecision {
  timestamp: string;
  agentId: string;
  agentName: string;
  symbol: string;
  action: 'hold' | 'evolve' | 'promote' | 'skip';
  reason: string;
  currentPF: number;
  currentWinRate: number;
  trades: number;
  oldConfig?: AgentConfigSnapshot | undefined;
  newConfig?: AgentConfigSnapshot | undefined;
  backtestResult?: { sharpeRatio: number; profitFactor: number; winRate: number; totalReturnPct: number } | undefined;
}

type GetAgentPerformanceFn = () => AgentPerformance[];
type ApplyNewConfigFn = (agentId: string, config: AgentConfigSnapshot) => boolean;

export class LearningLoop {
  private timer: NodeJS.Timeout | null = null;
  private evolving = false;
  private reviewInFlight = false;
  private getPerformance: GetAgentPerformanceFn;
  private applyConfig: ApplyNewConfigFn;
  private lastEvolutionByAgent = new Map<string, number>();

  constructor(getPerformance: GetAgentPerformanceFn, applyConfig: ApplyNewConfigFn) {
    this.getPerformance = getPerformance;
    this.applyConfig = applyConfig;
  }

  start(): void {
    if (this.timer) return;
    console.log(`[learning-loop] Starting self-learning loop (review every ${REVIEW_INTERVAL_MS / 1000}s, min ${MIN_TRADES_FOR_REVIEW} trades)`);
    this.timer = setInterval(() => {
      void this.review();
    }, REVIEW_INTERVAL_MS);
    // First review after 60s
    setTimeout(() => { void this.review(); }, 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLog(limit = 50): LearningDecision[] {
    try {
      if (!fs.existsSync(LEARNING_LOG_PATH)) return [];
      return fs.readFileSync(LEARNING_LOG_PATH, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LearningDecision)
        .slice(-limit);
    } catch {
      return [];
    }
  }

  private async review(): Promise<void> {
    if (this.evolving || this.reviewInFlight) return;
    this.reviewInFlight = true;

    try {
      const agents = this.getPerformance();
      for (const agent of agents) {
        if (this.evolving) break;
        await this.reviewAgent(agent);
      }
    } finally {
      this.reviewInFlight = false;
    }
  }

  private async reviewAgent(agent: AgentPerformance): Promise<void> {
    if (this.evolving) return;

    const now = Date.now();
    const lastEvo = this.lastEvolutionByAgent.get(agent.agentId) ?? 0;
    const cooldownMs = 30 * 60 * 1000; // 30 min between evolution runs per agent

    // Skip if not enough trades
    if (agent.trades < MIN_TRADES_FOR_REVIEW) {
      this.log({
        timestamp: new Date().toISOString(),
        agentId: agent.agentId,
        agentName: agent.agentName,
        symbol: agent.symbol,
        action: 'skip',
        reason: `Only ${agent.trades}/${MIN_TRADES_FOR_REVIEW} trades. Need more data.`,
        currentPF: agent.profitFactor,
        currentWinRate: agent.winRate,
        trades: agent.trades
      });
      return;
    }

    // Skip if recently evolved
    if (now - lastEvo < cooldownMs) {
      return;
    }

    // Check if performing well
    if (agent.profitFactor >= 1.2 && agent.winRate >= 50) {
      this.log({
        timestamp: new Date().toISOString(),
        agentId: agent.agentId,
        agentName: agent.agentName,
        symbol: agent.symbol,
        action: 'hold',
        reason: `Performing well. PF=${agent.profitFactor.toFixed(2)}, Win=${agent.winRate.toFixed(1)}%.`,
        currentPF: agent.profitFactor,
        currentWinRate: agent.winRate,
        trades: agent.trades
      });
      return;
    }

    // Underperforming — trigger evolution
    if (agent.profitFactor < UNDERPERFORM_PF_THRESHOLD || agent.winRate < UNDERPERFORM_WINRATE_THRESHOLD) {
      await this.evolveAgent(agent);
      return;
    }

    // Marginal — log but don't evolve yet
    this.log({
      timestamp: new Date().toISOString(),
      agentId: agent.agentId,
      agentName: agent.agentName,
      symbol: agent.symbol,
      action: 'hold',
      reason: `Marginal performance. PF=${agent.profitFactor.toFixed(2)}, Win=${agent.winRate.toFixed(1)}%. Watching.`,
      currentPF: agent.profitFactor,
      currentWinRate: agent.winRate,
      trades: agent.trades
    });
  }

  private async evolveAgent(agent: AgentPerformance): Promise<void> {
    this.evolving = true;
    this.lastEvolutionByAgent.set(agent.agentId, Date.now());

    console.log(`[learning-loop] ${agent.agentName}: Underperforming (PF=${agent.profitFactor.toFixed(2)}, Win=${agent.winRate.toFixed(1)}%). Starting evolution...`);

    try {
      // Generate candidate configs
      const candidates = this.generateCandidates(agent);
      const endDate = new Date().toISOString();
      const startDate = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

      // Backtest each candidate
      let bestResult: BacktestResult | null = null;
      let bestConfig: AgentConfigSnapshot | null = null;

      for (const candidate of candidates) {
        try {
          const result = await this.runBacktest(candidate, agent.symbol, startDate, endDate);
          if (result && result.profitFactor > (bestResult?.profitFactor ?? 0)) {
            bestResult = result;
            bestConfig = candidate;
          }
        } catch {
          // Skip failed backtests
        }
      }

      // Also backtest current config for comparison
      const currentResult = await this.runBacktest(agent.currentConfig, agent.symbol, startDate, endDate).catch(() => null);
      const currentPF = currentResult?.profitFactor ?? agent.profitFactor;

      // Promote if the best candidate beats current by meaningful margin
      if (bestResult && bestConfig && bestResult.profitFactor > currentPF * 1.15 && bestResult.profitFactor > 1.0) {
        // GUARDRAIL: never let evolution change approval thresholds or critical trading params to extreme values
        const safeConfig = { ...bestConfig };
        if (safeConfig.sizeFraction < 0.01) safeConfig.sizeFraction = 0.01;
        if (safeConfig.sizeFraction > 0.15) safeConfig.sizeFraction = 0.15;
        if (safeConfig.stopBps < 3) safeConfig.stopBps = 3;
        if (safeConfig.targetBps < 3) safeConfig.targetBps = 3;
        if (safeConfig.maxHoldTicks < 5) safeConfig.maxHoldTicks = 5;

        // HALF-KELLY GUARDRAIL: compute Kelly from agent's live performance and don't let evolution go below half-Kelly
        if (agent.trades >= 10 && agent.winRate > 0 && agent.profitFactor > 0) {
          const winRate = agent.winRate / 100;
          const lossRate = 1 - winRate;
          const R = agent.profitFactor; // avg win / avg loss
          const kellyRaw = (winRate * R - lossRate) / R;
          const halfKelly = Math.max(0.01, Math.min(0.15, kellyRaw / 2));
          if (safeConfig.sizeFraction < halfKelly * 0.6) {
            console.log(`[learning-loop] ${agent.agentName}: Kelly guardrail — evolved size ${safeConfig.sizeFraction.toFixed(3)} < 60% of half-Kelly ${halfKelly.toFixed(3)}, clamping up`);
            safeConfig.sizeFraction = Number(halfKelly.toFixed(3));
          }
        }

        const applied = this.applyConfig(agent.agentId, safeConfig);
        this.log({
          timestamp: new Date().toISOString(),
          agentId: agent.agentId,
          agentName: agent.agentName,
          symbol: agent.symbol,
          action: 'promote',
          reason: `Evolved config beats current (PF ${bestResult.profitFactor.toFixed(2)} vs ${currentPF.toFixed(2)}). ${applied ? 'Applied' : 'Failed to apply'}.`,
          currentPF: agent.profitFactor,
          currentWinRate: agent.winRate,
          trades: agent.trades,
          oldConfig: agent.currentConfig,
          newConfig: safeConfig,
          backtestResult: {
            sharpeRatio: bestResult.sharpeRatio,
            profitFactor: bestResult.profitFactor,
            winRate: bestResult.winRate,
            totalReturnPct: bestResult.totalReturnPct
          }
        });
        console.log(`[learning-loop] ${agent.agentName}: PROMOTED new config. PF ${currentPF.toFixed(2)} → ${bestResult.profitFactor.toFixed(2)}`);
        console.log(`[learning-loop] ${agent.agentName}: OLD target=${agent.currentConfig.targetBps} stop=${agent.currentConfig.stopBps} hold=${agent.currentConfig.maxHoldTicks} size=${agent.currentConfig.sizeFraction}`);
        console.log(`[learning-loop] ${agent.agentName}: NEW target=${safeConfig.targetBps} stop=${safeConfig.stopBps} hold=${safeConfig.maxHoldTicks} size=${safeConfig.sizeFraction}`);
      } else {
        this.log({
          timestamp: new Date().toISOString(),
          agentId: agent.agentId,
          agentName: agent.agentName,
          symbol: agent.symbol,
          action: 'evolve',
          reason: `Evolution did not find a clearly better config. Best candidate PF=${bestResult?.profitFactor.toFixed(2) ?? '?'} vs current PF=${currentPF.toFixed(2)}.`,
          currentPF: agent.profitFactor,
          currentWinRate: agent.winRate,
          trades: agent.trades,
          backtestResult: bestResult ? {
            sharpeRatio: bestResult.sharpeRatio,
            profitFactor: bestResult.profitFactor,
            winRate: bestResult.winRate,
            totalReturnPct: bestResult.totalReturnPct
          } : undefined
        });
        console.log(`[learning-loop] ${agent.agentName}: Evolution complete, no promotion. Best PF=${bestResult?.profitFactor.toFixed(2) ?? '?'}`);
      }
    } catch (error) {
      console.error(`[learning-loop] Evolution failed for ${agent.agentName}:`, error);
    } finally {
      this.evolving = false;
    }
  }

  private generateCandidates(agent: AgentPerformance): AgentConfigSnapshot[] {
    const base = agent.currentConfig;
    const candidates: AgentConfigSnapshot[] = [];
    const styles: Array<'momentum' | 'mean-reversion' | 'breakout'> = ['momentum', 'mean-reversion', 'breakout'];

    // Systematic variations of current config
    for (const targetMult of [0.7, 0.85, 1.0, 1.2, 1.5]) {
      for (const stopMult of [0.7, 1.0, 1.3]) {
        for (const holdMult of [0.8, 1.0, 1.5]) {
          candidates.push({
            ...base,
            targetBps: Math.round(base.targetBps * targetMult),
            stopBps: Math.round(base.stopBps * stopMult),
            maxHoldTicks: Math.round(base.maxHoldTicks * holdMult)
          });
        }
      }
    }

    // Try different styles with current params
    for (const style of styles) {
      if (style !== base.style) {
        candidates.push({ ...base, style });
      }
    }

    // Compute Half-Kelly anchor for sizing mutations (if enough data)
    let kellyAnchor = 0.06; // default center if insufficient data
    if (agent.trades >= 10 && agent.winRate > 0 && agent.profitFactor > 0) {
      const winRate = agent.winRate / 100;
      const lossRate = 1 - winRate;
      const R = agent.profitFactor;
      const kellyRaw = (winRate * R - lossRate) / R;
      kellyAnchor = Math.max(0.02, Math.min(0.12, kellyRaw / 2));
    }

    // Random mutations — sizeFraction anchored around Half-Kelly with +-50% jitter
    for (let i = 0; i < EVOLUTION_POPULATION; i++) {
      const sizeJitter = kellyAnchor * (0.5 + Math.random()); // 50% to 150% of Kelly
      candidates.push({
        style: styles[Math.floor(Math.random() * styles.length)]!,
        targetBps: Math.round(30 + Math.random() * 170),
        stopBps: Math.round(20 + Math.random() * 100),
        maxHoldTicks: Math.round(10 + Math.random() * 80),
        cooldownTicks: Math.round(3 + Math.random() * 10),
        sizeFraction: Number(Math.max(0.01, Math.min(0.15, sizeJitter)).toFixed(3)),
        spreadLimitBps: Number((2 + Math.random() * 5).toFixed(1))
      });
    }

    return candidates;
  }

  private async runBacktest(config: AgentConfigSnapshot, symbol: string, startDate: string, endDate: string): Promise<BacktestResult | null> {
    const agentConfig: BacktestAgentConfig = {
      style: config.style as BacktestAgentConfig['style'],
      targetBps: config.targetBps,
      stopBps: config.stopBps,
      maxHoldTicks: config.maxHoldTicks,
      cooldownTicks: config.cooldownTicks,
      sizeFraction: config.sizeFraction,
      spreadLimitBps: config.spreadLimitBps
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${BACKTEST_URL}/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentConfig, symbol, startDate, endDate }),
        signal: controller.signal
      });

      if (!response.ok) return null;
      return await response.json() as BacktestResult;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private log(decision: LearningDecision): void {
    try {
      const dir = path.dirname(LEARNING_LOG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(LEARNING_LOG_PATH, `${JSON.stringify(decision)}\n`, 'utf8');
      this.maybeRotateLog();
    } catch {
      // Non-critical
    }
  }

  /** Rotate learning-log.jsonl when it exceeds 5 MB. Keeps one .bak backup. */
  private maybeRotateLog(): void {
    try {
      const stat = fs.statSync(LEARNING_LOG_PATH);
      if (stat.size > 5 * 1024 * 1024) {
        const bakPath = `${LEARNING_LOG_PATH}.bak`;
        fs.renameSync(LEARNING_LOG_PATH, bakPath);
        // Start a fresh file — next append creates it
        console.log(`[learning-loop] Rotated learning-log.jsonl (${(stat.size / 1024 / 1024).toFixed(1)} MB -> .bak)`);
      }
    } catch {
      // Rotation is best-effort
    }
  }
}
