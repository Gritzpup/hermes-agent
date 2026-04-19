import fs from 'node:fs';
import path from 'node:path';
import type { AiCouncilDecision, AiCouncilTrace, AiDecisionAction, AiProviderDecision } from '@hermes/contracts';
import { pushLog } from './services/live-log.js';

import {
  ClaudeCliProvider, CodexCliProvider, GeminiCliProvider,
  PiCliProvider, OllamaCliProvider, Ollama2CliProvider,
  buildRulesDecision, setCouncilRef,
} from './ai-council-cli.js';
import { makeCouncilDecisionKey } from './ai-council-prompts.js';
import { getMetaLabelModel, MetaLabelModel } from './services/meta-label-model.js';

// Re-export so strategy-director.ts (and others) can keep importing from here
export { runProcess } from './ai-council-cli.js';
export type { RateAwareProvider } from './ai-council-cli.js';
export type { CouncilRole } from './ai-council-prompts.js';

import type { RateAwareProvider } from './ai-council-cli.js';

const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';
const CODEX_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.2';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const CACHE_MS = Number(process.env.AI_COUNCIL_CACHE_MS ?? 300_000); // 5 min default
const ESCALATE_TO_CLOUD_THRESHOLD = Number(process.env.ESCALATE_TO_CLOUD_THRESHOLD ?? 45); // confidence below this escalates to cloud models
const CLOUD_SKIP_ON_CONSENSUS = process.env.CLOUD_SKIP_ON_CONSENSUS !== '0'; // skip cloud if Ollama agrees
const CLOUD_SKIP_CONSENSUS_FLOOR = Number(process.env.CLOUD_SKIP_CONSENSUS_FLOOR ?? 55); // avg Ollama confidence needed to skip cloud
const TRACE_LOG_PATH = process.env.AI_COUNCIL_TRACE_LOG_PATH ?? path.resolve(WORKSPACE_ROOT, 'services/api/.runtime/paper-ledger/ai-council-traces.jsonl');
const ENABLED = process.env.AI_COUNCIL_ENABLED !== '0';

export interface AiTradeCandidate {
  agentId: string;
  agentName: string;
  symbol: string;
  style: string;
  score: number;
  shortReturnPct: number;
  mediumReturnPct: number;
  lastPrice: number;
  spreadBps: number;
  liquidityScore: number;
  focus: string;
  newsSummary?: string | undefined;
  macroSummary?: string | undefined;
}

interface CachedDecision {
  key: string;
  expiresAt: number;
  decision: AiCouncilDecision;
  candidate: AiTradeCandidate;
}

export interface AiCouncilStatus {
  enabled: boolean;
  queued: number;
  inFlight: boolean;
  recentDecisions: number;
  latestDecision: AiCouncilDecision | null;
}

// --------------- Council ---------------

export class AiCouncil {
  private readonly decisions = new Map<string, CachedDecision>();
  private readonly queue: string[] = [];
  private claudeProvider: RateAwareProvider;
  private codexProvider: RateAwareProvider;
  private geminiProvider: RateAwareProvider;
  private piProvider: RateAwareProvider;
  private ollamaProvider: RateAwareProvider;
  private ollama2Provider: RateAwareProvider;
  private metaLabelProvider: MetaLabelModel;
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private lastRealDecision: AiCouncilDecision | null = null;
  // Fix E — degraded tracking: count rules-provider votes across recent decisions
  private readonly _recentPanelSnapshots: Array<{ rulesCount: number; total: number }> = [];
  private static readonly _DEGRADED_WINDOW = 10;
  private static readonly _DEGRADED_THRESHOLD = 0.4;

  constructor() {
    this.claudeProvider = new ClaudeCliProvider();
    this.codexProvider = new CodexCliProvider();
    this.geminiProvider = new GeminiCliProvider();
    this.piProvider = new PiCliProvider();
    this.ollamaProvider = new OllamaCliProvider();
    this.ollama2Provider = new Ollama2CliProvider();
    this.metaLabelProvider = getMetaLabelModel();
    // Lazy-load the model on startup (will auto-reload every 60 min)
    void this.metaLabelProvider.load();
    this.metaLabelProvider.startAutoReload();

    console.log(`[ai-council] ready. Claude=${CLAUDE_MODEL} Codex=${CODEX_MODEL} Gemini=${GEMINI_MODEL} Ollama=hermes3+qwen3.5 MetaLabel=${this.metaLabelProvider.isReady() ? 'trained' : 'untrained'} Enabled=${ENABLED}`);

    if (ENABLED) {
      this.timer = setInterval(() => {
        void this.drain();
      }, 750);
    }
  }

  requestDecision(candidate: AiTradeCandidate): AiCouncilDecision {
    const key = this.makeKey(candidate);
    this.pruneCache();
    const cached = this.decisions.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.decision;
    }

    if (!ENABLED) {
      const fallback = this.buildRulesFallback(candidate, 'AI council disabled. Rules approved the setup.');
      this.decisions.set(key, { key, expiresAt: Date.now() + CACHE_MS, decision: fallback, candidate });
      return fallback;
    }

    // Start with an immediate rules decision so the dashboard has a vote to show,
    // then queue async AI evaluation to upgrade it when providers respond.
    const immediate = this.buildRulesFallback(candidate, 'Rules decision (AI council evaluating in background).');
    this.decisions.set(key, { key, expiresAt: Date.now() + CACHE_MS, decision: immediate, candidate });
    if (!this.queue.includes(key)) {
      this.queue.push(key);
    }
    return immediate;
  }

  getRecentDecisions(limit = 8): AiCouncilDecision[] {
    this.pruneCache();
    const cached = Array.from(this.decisions.values())
      .sort((left, right) => right.decision.timestamp.localeCompare(left.decision.timestamp))
      .slice(0, limit)
      .map((entry) => entry.decision);
    // Always include the last real AI decision so terminals show actual votes
    if (this.lastRealDecision && !cached.some((d) => d.id === this.lastRealDecision!.id)) {
      cached.unshift(this.lastRealDecision);
    }
    return cached.slice(0, limit);
  }

  getStatus(): AiCouncilStatus {
    const recentDecisions = this.getRecentDecisions(8);
    return {
      enabled: ENABLED,
      queued: this.queue.length,
      inFlight: this.inFlight,
      recentDecisions: recentDecisions.length,
      latestDecision: recentDecisions[0] ?? null
    };
  }

  getTraces(limit = 50): AiCouncilTrace[] {
    try {
      if (!fs.existsSync(TRACE_LOG_PATH)) {
        return [];
      }
      return fs.readFileSync(TRACE_LOG_PATH, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as AiCouncilTrace)
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  private logQueue = Promise.resolve();

  public recordTrace(trace: AiCouncilTrace): void {
    pushLog(`council:${trace.role}`, `${trace.symbol} ${trace.parsedAction ?? trace.status} ${trace.parsedConfidence ?? 0}% — ${(trace.parsedThesis ?? '').slice(0, 100)}`);

    this.logQueue = this.logQueue.then(async () => {
      try {
        if (!fs.existsSync(path.dirname(TRACE_LOG_PATH))) fs.mkdirSync(path.dirname(TRACE_LOG_PATH), { recursive: true });
        await fs.promises.appendFile(TRACE_LOG_PATH, `${JSON.stringify(trace)}\n`, 'utf8');
      } catch {
        // trace persistence is best-effort
      }
    });
  }

  private pruneCache(): void {
    const now = Date.now();
    for (const [key, cached] of this.decisions.entries()) {
      if (cached.expiresAt <= now) {
        this.decisions.delete(key);
      }
    }
    const maxEntries = 200;
    if (this.decisions.size <= maxEntries) {
      return;
    }
    const ordered = Array.from(this.decisions.entries())
      .sort((left, right) => right[1].decision.timestamp.localeCompare(left[1].decision.timestamp));
    for (const [key] of ordered.slice(maxEntries)) {
      this.decisions.delete(key);
    }
  }

  /** Pick the best available provider for a role, rotating on rate-limit. */
  private pickProvider(preferred: RateAwareProvider): RateAwareProvider {
    if (!preferred.isRateLimited()) return preferred;

    // Local Ollama models (hermes3 fast, qwen3.5 final fallback) as free fallback when cloud providers are rate-limited
    const pool = [this.claudeProvider, this.codexProvider, this.geminiProvider, this.piProvider, this.ollamaProvider, this.ollama2Provider];
    const available = pool.filter((provider) => !provider.isRateLimited());
    if (available.length > 0) {
      const pick = available[Math.floor(Math.random() * available.length)]!;
      // Rate-limited, rotating silently
      return pick;
    }

    return preferred;
  }

  private isFallbackTrigger(value: string): boolean {
    return /rate.?limit|429|too many|overloaded|capacity|unavailable|timeout|enoent|not found|refused|failed to reach/i.test(value);
  }

  private async evaluateWithRotation(preferred: RateAwareProvider, candidate: AiTradeCandidate, decisionId: string): Promise<AiProviderDecision> {
    // Tiered fallback chain:
    // Claude/Codex rate-limited → Gemini → Ollama(hermes3 fast, 15s) → Ollama2(qwen3.5 final, 60s)
    const pool = preferred.getRole() === 'gemini'
      ? [preferred, this.claudeProvider, this.ollamaProvider, this.ollama2Provider]
      : [preferred, this.geminiProvider, this.ollamaProvider, this.ollama2Provider];

    for (const provider of pool) {
      if (provider.isRateLimited()) {
        continue;
      }
      try {
        const result = await provider.evaluate(candidate, decisionId);

        // If the provider returned a 'rules' decision (local fallback),
        // it means the AI itself was unreachable or failed.
        // We should try the next AI provider in the pool before accepting the rules result.
        if (result.provider === 'rules' && this.isFallbackTrigger(result.riskNote + ' ' + result.thesis)) {
          // Provider unavailable, trying next
          continue;
        }

        return result;
      } catch (error) {
        // Critical error, trying next provider
        continue;
      }
    }

    // Last resort: try Gemini ignoring its rate-limit flag (if it was the intended fallback), then rules
    try {
      if (preferred.getRole() !== 'gemini') {
        const lastGasp = await this.geminiProvider.evaluate(candidate, decisionId);
        if (lastGasp.provider !== 'rules') return lastGasp;
      }
      return buildRulesDecision(candidate, 'All providers failed or returned unavailability results.');
    } catch {
      return buildRulesDecision(candidate, 'All providers failed including Gemini last-gasp.');
    }
  }

  /** Fix E — update degraded flag on decision output when rules-fallback rate > 40% in last N. */
  private updateDegradedFlag(decision: AiCouncilDecision): void {
    const panel = decision.panel ?? (decision.primary ? [decision.primary] : []);
    const rulesCount = panel.filter((v) => v.provider === 'rules').length;
    const total = panel.length || 1;
    this._recentPanelSnapshots.push({ rulesCount, total });
    if (this._recentPanelSnapshots.length > AiCouncil._DEGRADED_WINDOW) {
      this._recentPanelSnapshots.shift();
    }
    const totalRules = this._recentPanelSnapshots.reduce((s, snap) => s + snap.rulesCount, 0);
    const totalVotes = this._recentPanelSnapshots.reduce((s, snap) => s + snap.total, 0);
    decision.councilDegraded = totalVotes > 0 && totalRules / totalVotes > AiCouncil._DEGRADED_THRESHOLD;
  }

  /**
   * Ollama gatekeeper pattern: call free Ollama models first.
   * Only escalate to expensive cloud models if confidence is low or Ollama disagrees.
   * This saves ~80% on API costs while maintaining quality decisions.
   */
  private async drain(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) return;

    const key = this.queue.shift();
    if (!key) return;

    const cached = this.decisions.get(key);
    if (!cached) return;

    console.log(`[ai-council] draining ${key.slice(0, 8)}...`);
    this.inFlight = true;
    cached.decision = {
      ...cached.decision,
      status: 'evaluating',
      reason: 'AI council is reviewing the candidate now.',
      timestamp: new Date().toISOString()
    };

    try {
      // Step 1: Call Ollama models first (free, fast)
      const [ollamaResultRaw, ollama2ResultRaw, piResultRaw, metaLabelResultRaw] = await Promise.allSettled([
        this.evaluateWithRotation(this.ollamaProvider, cached.candidate, key),
        this.evaluateWithRotation(this.ollama2Provider, cached.candidate, key),
        this.evaluateWithRotation(this.piProvider, cached.candidate, key),
        this.metaLabelProvider.isReady()
          ? this.metaLabelProvider.evaluate(cached.candidate, key)
          : Promise.resolve(buildRulesDecision(cached.candidate, 'meta-label model not trained yet')),
      ]);
      const ollamaResult: AiProviderDecision = ollamaResultRaw.status === 'fulfilled' 
        ? ollamaResultRaw.value : buildRulesDecision(cached.candidate, 'Ollama hermes3 failed');
      const ollama2Result: AiProviderDecision = ollama2ResultRaw.status === 'fulfilled'
        ? ollama2ResultRaw.value : buildRulesDecision(cached.candidate, 'Ollama qwen3.5 failed');
      const piResult: AiProviderDecision = piResultRaw.status === 'fulfilled'
        ? piResultRaw.value : buildRulesDecision(cached.candidate, 'Pi failed');
      const metaLabelResult: AiProviderDecision = metaLabelResultRaw.status === 'fulfilled'
        ? metaLabelResultRaw.value : buildRulesDecision(cached.candidate, 'Meta-label evaluation failed');

      cached.decision.panel = [piResult, ollamaResult, ollama2Result, metaLabelResult];

      // Step 2: Check if we can skip cloud models (Ollama gatekeeper logic)
      const ollamaAvg = (ollamaResult.confidence + ollama2Result.confidence) / 2;
      const ollamaAgree = ollamaResult.action === ollama2Result.action;
      const ollamaStrong = ollamaAvg >= ESCALATE_TO_CLOUD_THRESHOLD && ollamaAgree;

      // Skip cloud if Ollama has strong consensus and we have decent confidence
      if (CLOUD_SKIP_ON_CONSENSUS && ollamaStrong && ollamaAvg >= CLOUD_SKIP_CONSENSUS_FLOOR) {
        const final = this.combineLocalOnly(piResult, ollamaResult, ollama2Result, cached.candidate);
        cached.decision = {
          id: key, symbol: cached.candidate.symbol, agentId: cached.candidate.agentId,
          agentName: cached.candidate.agentName, status: 'complete', finalAction: final.finalAction,
          reason: `[skipped cloud] ${final.reason}`, timestamp: new Date().toISOString(),
          primary: ollamaResult, challenger: ollama2Result, panel: [piResult, ollamaResult, ollama2Result]
        };
        cached.expiresAt = Date.now() + CACHE_MS;
        this.lastRealDecision = cached.decision;
        this.updateDegradedFlag(cached.decision);
        console.log(`[ai-council] drain complete: ${final.finalAction} (ollama-only, skipped cloud)`);
        this.inFlight = false;
        return;
      }

      // Step 3: Call cloud models (only if Ollama wasn't decisive)
      const [primaryRaw, challengerRaw, tertiaryRaw] = await Promise.allSettled([
        this.evaluateWithRotation(this.claudeProvider, cached.candidate, key),
        this.evaluateWithRotation(this.codexProvider, cached.candidate, key),
        this.evaluateWithRotation(this.geminiProvider, cached.candidate, key),
      ]);
      const primary: AiProviderDecision = primaryRaw.status === 'fulfilled'
        ? primaryRaw.value : buildRulesDecision(cached.candidate, 'Claude failed');
      const challenger: AiProviderDecision = challengerRaw.status === 'fulfilled'
        ? challengerRaw.value : buildRulesDecision(cached.candidate, 'Codex failed');
      const tertiary: AiProviderDecision = tertiaryRaw.status === 'fulfilled'
        ? tertiaryRaw.value : buildRulesDecision(cached.candidate, 'Gemini failed');

      let final = this.combineSeven(primary, challenger, tertiary, piResult, ollamaResult, ollama2Result, metaLabelResult, cached.candidate);

      // FIX 1: MetaLabel independent veto — if ML predicts reject at ≥70% confidence,
      // force rejection regardless of cloud consensus (ML was trained on hermes's own outcomes).
      if (
        this.metaLabelProvider.isReady() &&
        metaLabelResult.action === 'reject' &&
        metaLabelResult.confidence >= 70
      ) {
        final = {
          finalAction: 'reject',
          reason: `MetaLabel veto: setup historically unprofitable at ${metaLabelResult.confidence}% confidence. ${final.reason}`,
        };
      }

      cached.decision = {
        id: key, symbol: cached.candidate.symbol, agentId: cached.candidate.agentId,
        agentName: cached.candidate.agentName, status: 'complete', finalAction: final.finalAction,
        reason: final.reason, timestamp: new Date().toISOString(),
        primary, challenger, panel: [primary, challenger, tertiary, piResult, ollamaResult, ollama2Result, metaLabelResult]
      };
      cached.expiresAt = Date.now() + CACHE_MS;
      this.lastRealDecision = cached.decision;
      this.updateDegradedFlag(cached.decision);
      console.log(`[ai-council] drain complete: ${final.finalAction} (${final.reason.slice(0, 60)})`);
    } catch (error) {
      console.error(`[ai-council] drain error:`, error instanceof Error ? error.message : error);
      const fallback = this.buildRulesFallback(cached.candidate, `AI council error: ${error instanceof Error ? error.message : 'unknown'}`);
      cached.decision = fallback;
      cached.expiresAt = Date.now() + CACHE_MS / 2;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Combine 3 local (free) providers: Pi + Ollama(hermes3) + Ollama2(qwen3.5).
   * Used when Ollama gatekeeper decides to skip cloud models.
   */
  private combineLocalOnly(
    piResult: AiProviderDecision,
    ollamaResult: AiProviderDecision,
    ollama2Result: AiProviderDecision,
    candidate: AiTradeCandidate
  ): { finalAction: AiDecisionAction; reason: string } {
    const votes = [piResult, ollamaResult, ollama2Result];
    const approves = votes.filter((v) => v.action === 'approve');
    const rejects = votes.filter((v) => v.action === 'reject');
    const avgConf = votes.reduce((s, v) => s + v.confidence, 0) / 3;

    if (rejects.length >= 2) {
      return { finalAction: 'reject', reason: `${rejects.length} local vetoes blocked setup.` };
    }
    if (approves.length === 3 && avgConf >= 55) {
      return { finalAction: 'approve', reason: `Unanimous local approve at ${avgConf.toFixed(0)}% avg.` };
    }
    if (approves.length >= 2 && rejects.length === 0 && avgConf >= 60) {
      return { finalAction: 'approve', reason: `${approves.length}/3 local approves at ${avgConf.toFixed(0)}% avg.` };
    }
    if (ollamaResult.confidence >= 70 && ollamaResult.action === 'reject' && candidate.score < 4) {
      return { finalAction: 'reject', reason: `hermes3 strong reject (${ollamaResult.confidence}%) blocked weak score.` };
    }
    return { finalAction: 'review', reason: `Local only: ${approves.length} approve, ${rejects.length} reject, avg ${avgConf.toFixed(0)}%.` };
  }

  private combine(
    primary: AiProviderDecision,
    challenger: AiProviderDecision,
    tertiary: AiProviderDecision,
    piResult: AiProviderDecision,
    candidate: AiTradeCandidate
  ): { finalAction: AiDecisionAction; reason: string } {
    const votes = [primary, challenger, tertiary, piResult];
    const approveVotes = votes.filter((vote) => vote.action === 'approve');
    const rejectVotes = votes.filter((vote) => vote.action === 'reject');
    const reviewVotes = votes.filter((vote) => vote.action === 'review');
    const averageConfidence = votes.reduce((sum, vote) => sum + vote.confidence, 0) / votes.length;
    const summary = `Claude ${primary.action} ${primary.confidence}%, Codex ${challenger.action} ${challenger.confidence}%, Gemini ${tertiary.action} ${tertiary.confidence}%, Pi ${piResult.action} ${piResult.confidence}%.`;
    const strongestReject = rejectVotes.reduce<AiProviderDecision | null>((best, vote) => {
      if (!best) return vote;
      return vote.confidence > best.confidence ? vote : best;
    }, null);

    // 4-provider voting: require 2+ rejects to hard veto, or majority approval
    if (rejectVotes.length >= 2) {
      return {
        finalAction: 'reject',
        reason: `${summary} Two or more reviewers vetoed the setup.`,
      };
    }

    if (strongestReject && strongestReject.confidence >= 80 && candidate.score < 4) {
      return {
        finalAction: 'reject',
        reason: `${summary} ${strongestReject.provider} issued a hard veto at ${strongestReject.confidence}% confidence.`,
      };
    }

    // 3+ approvals with no rejects and decent confidence = approve
    if (approveVotes.length >= 3 && rejectVotes.length === 0 && averageConfidence >= 55 && candidate.score >= 5) {
      return {
        finalAction: 'approve',
        reason: `${summary} Three+ approvals cleared the consensus gate at ${averageConfidence.toFixed(1)}% average confidence.`,
      };
    }

    // Full panel approval (4/4) even with lower confidence
    if (approveVotes.length === 4 && averageConfidence >= 50 && candidate.score >= 4.5) {
      return {
        finalAction: 'approve',
        reason: `${summary} Full-panel approval with ${averageConfidence.toFixed(1)}% average confidence.`,
      };
    }

    if (primary.action === 'approve' && rejectVotes.length === 0 && candidate.score >= 6.5 && primary.confidence >= 70) {
      return {
        finalAction: 'approve',
        reason: `${summary} Claude led with a strong approval and no veto arrived.`,
      };
    }

    if (reviewVotes.length >= 2 && approveVotes.length === 1 && rejectVotes.length === 0 && candidate.score < 6.5) {
      return {
        finalAction: 'review',
        reason: `${summary} The panel stayed cautious on a mixed setup.`,
      };
    }

    return {
      finalAction: 'review',
      reason: `${summary} Consensus was mixed or too weak for approval.`,
    };
  }

  /**
   * 6-provider combine — Claude, Codex, Gemini, Pi, Ollama(hermes3), Ollama(qwen3.5).
   * Voting rules for 6 voters:
   *   - 2+ rejects out of 6 = veto
   *   - 4+ approves with avg confidence >= 50 = strong approve
   *   - 3+ approves, no rejects, avg >= 55 = approve
   *   - Claude primary with high conviction overrides mixed panels
   */
  private combineSix(
    primary: AiProviderDecision,
    challenger: AiProviderDecision,
    tertiary: AiProviderDecision,
    piResult: AiProviderDecision,
    ollamaResult: AiProviderDecision,
    ollama2Result: AiProviderDecision,
    candidate: AiTradeCandidate
  ): { finalAction: AiDecisionAction; reason: string } {
    const votes = [primary, challenger, tertiary, piResult, ollamaResult, ollama2Result];
    const approveVotes = votes.filter((v) => v.action === 'approve');
    const rejectVotes = votes.filter((v) => v.action === 'reject');
    const reviewVotes = votes.filter((v) => v.action === 'review');
    const avgConfidence = votes.reduce((s, v) => s + v.confidence, 0) / votes.length;
    const summary = `Claude ${primary.action} ${primary.confidence}%, Codex ${challenger.action} ${challenger.confidence}%, Gemini ${tertiary.action} ${tertiary.confidence}%, Pi ${piResult.action} ${piResult.confidence}%, Ollama-hermes3 ${ollamaResult.action} ${ollamaResult.confidence}%, Ollama-qwen35 ${ollama2Result.action} ${ollama2Result.confidence}%.`;
    const strongestReject = rejectVotes.reduce<AiProviderDecision | null>((best, v) => !best || v.confidence > best.confidence ? v : best, null);

    // 2+ rejects out of 6 = hard veto
    if (rejectVotes.length >= 2) {
      return { finalAction: 'reject', reason: `${summary} ${rejectVotes.length} vetoes blocked the setup.` };
    }

    // Single high-confidence veto with weak score
    if (strongestReject && strongestReject.confidence >= 80 && candidate.score < 4) {
      return { finalAction: 'reject', reason: `${summary} ${strongestReject.provider} hard veto at ${strongestReject.confidence}%.` };
    }

    // 5+ approvals with avg confidence >= 45 = very strong approve
    if (approveVotes.length >= 5 && avgConfidence >= 45 && candidate.score >= 4.5) {
      return { finalAction: 'approve', reason: `${summary} Near-unanimous approve (${approveVotes.length}/6) at ${avgConfidence.toFixed(1)}% avg.` };
    }

    // 4+ approvals, no rejects, avg >= 50 = strong approve
    if (approveVotes.length >= 4 && rejectVotes.length === 0 && avgConfidence >= 50 && candidate.score >= 4.5) {
      return { finalAction: 'approve', reason: `${summary} Strong-panel approve (${approveVotes.length}/6) at ${avgConfidence.toFixed(1)}% avg.` };
    }

    // 3+ approvals, no rejects, avg >= 55 = approve
    if (approveVotes.length >= 3 && rejectVotes.length === 0 && avgConfidence >= 55 && candidate.score >= 5) {
      return { finalAction: 'approve', reason: `${summary} Majority approve at ${avgConfidence.toFixed(1)}% avg confidence.` };
    }

    // Claude primary approves with high conviction = trust it
    if (primary.action === 'approve' && rejectVotes.length === 0 && candidate.score >= 6.5 && primary.confidence >= 70) {
      return { finalAction: 'approve', reason: `${summary} Claude led with strong approval, no vetoes.` };
    }

    return { finalAction: 'review', reason: `${summary} No clear consensus (${approveVotes.length} approve, ${rejectVotes.length} reject, ${reviewVotes.length} review).` };
  }

  /**
   * 7-provider combine — Claude, Codex, Gemini, Pi, Ollama(hermes3), Ollama(qwen3.5), MetaLabel.
   * Voting rules for 7 voters:
   *   - 2+ rejects out of 7 = veto
   *   - 5+ approves with avg confidence >= 45 = strong approve
   *   - 4+ approves, no rejects, avg >= 50 = strong approve
   *   - 3+ approvals, no rejects, avg >= 55 = approve
   *   - Claude primary with high conviction overrides mixed panels
   */
  private combineSeven(
    primary: AiProviderDecision,
    challenger: AiProviderDecision,
    tertiary: AiProviderDecision,
    piResult: AiProviderDecision,
    ollamaResult: AiProviderDecision,
    ollama2Result: AiProviderDecision,
    metaLabelResult: AiProviderDecision,
    candidate: AiTradeCandidate
  ): { finalAction: AiDecisionAction; reason: string } {
    const votes = [primary, challenger, tertiary, piResult, ollamaResult, ollama2Result, metaLabelResult];
    const approveVotes = votes.filter((v) => v.action === 'approve');
    const rejectVotes = votes.filter((v) => v.action === 'reject');
    const reviewVotes = votes.filter((v) => v.action === 'review');
    const avgConfidence = votes.reduce((s, v) => s + v.confidence, 0) / votes.length;
    const summary = `Claude ${primary.action} ${primary.confidence}%, Codex ${challenger.action} ${challenger.confidence}%, Gemini ${tertiary.action} ${tertiary.confidence}%, Pi ${piResult.action} ${piResult.confidence}%, Ollama-hermes3 ${ollamaResult.action} ${ollamaResult.confidence}%, Ollama-qwen35 ${ollama2Result.action} ${ollama2Result.confidence}%, MetaLabel ${metaLabelResult.action} ${metaLabelResult.confidence}%.`;
    const strongestReject = rejectVotes.reduce<AiProviderDecision | null>((best, v) => !best || v.confidence > best.confidence ? v : best, null);

    // 2+ rejects out of 7 = hard veto
    if (rejectVotes.length >= 2) {
      return { finalAction: 'reject', reason: `${summary} ${rejectVotes.length} vetoes blocked the setup.` };
    }

    // Single high-confidence veto with weak score
    if (strongestReject && strongestReject.confidence >= 80 && candidate.score < 4) {
      return { finalAction: 'reject', reason: `${summary} ${strongestReject.provider} hard veto at ${strongestReject.confidence}%.` };
    }

    // 6+ approvals with avg confidence >= 40 = very strong approve
    if (approveVotes.length >= 6 && avgConfidence >= 40 && candidate.score >= 4) {
      return { finalAction: 'approve', reason: `${summary} Near-unanimous approve (${approveVotes.length}/7) at ${avgConfidence.toFixed(1)}% avg.` };
    }

    // 5+ approvals, no rejects, avg >= 45 = strong approve
    if (approveVotes.length >= 5 && rejectVotes.length === 0 && avgConfidence >= 45 && candidate.score >= 4.5) {
      return { finalAction: 'approve', reason: `${summary} Strong-panel approve (${approveVotes.length}/7) at ${avgConfidence.toFixed(1)}% avg.` };
    }

    // 4+ approvals, no rejects, avg >= 50 = approve
    if (approveVotes.length >= 4 && rejectVotes.length === 0 && avgConfidence >= 50 && candidate.score >= 4.5) {
      return { finalAction: 'approve', reason: `${summary} Majority approve at ${avgConfidence.toFixed(1)}% avg confidence.` };
    }

    // Claude primary approves with high conviction = trust it
    if (primary.action === 'approve' && rejectVotes.length === 0 && candidate.score >= 6.5 && primary.confidence >= 70) {
      return { finalAction: 'approve', reason: `${summary} Claude led with strong approval, no vetoes.` };
    }

    return { finalAction: 'review', reason: `${summary} No clear consensus (${approveVotes.length} approve, ${rejectVotes.length} reject, ${reviewVotes.length} review).` };
  }

  private buildQueuedDecision(candidate: AiTradeCandidate): AiCouncilDecision {
    return {
      id: this.makeKey(candidate),
      symbol: candidate.symbol,
      agentId: candidate.agentId,
      agentName: candidate.agentName,
      status: 'queued',
      finalAction: 'review',
      reason: 'Candidate queued for AI review.',
      timestamp: new Date().toISOString(),
      primary: {
        provider: 'claude',
        source: 'rules',
        action: 'review',
        confidence: 0,
        thesis: 'Queued for AI review.',
        riskNote: 'No model vote yet.',
        latencyMs: 0,
        timestamp: new Date().toISOString()
      },
      challenger: null,
      panel: []
    };
  }

  private buildRulesFallback(candidate: AiTradeCandidate, reason: string): AiCouncilDecision {
    const primary = {
      provider: 'rules' as const,
      source: 'rules' as const,
      action: candidate.score >= 3 ? 'approve' as const : 'review' as const,
      confidence: Math.min(Math.round(candidate.score * 12), 99),
      thesis: 'Rules-only fallback decision.',
      riskNote: 'External AI vote unavailable.',
      latencyMs: 0,
      timestamp: new Date().toISOString()
    };

    return {
      id: this.makeKey(candidate),
      symbol: candidate.symbol,
      agentId: candidate.agentId,
      agentName: candidate.agentName,
      status: 'complete',
      finalAction: primary.action,
      reason,
      timestamp: new Date().toISOString(),
      primary,
      challenger: null,
      panel: [primary]
    };
  }

  private makeKey(candidate: AiTradeCandidate): string {
    return makeCouncilDecisionKey(candidate);
  }
}

let council: AiCouncil | undefined;

export function getAiCouncil(): AiCouncil {
  if (!council) {
    council = new AiCouncil();
  }
  return council;
}

// Wire up the council reference so CLI providers can call recordTrace
setCouncilRef(getAiCouncil);
