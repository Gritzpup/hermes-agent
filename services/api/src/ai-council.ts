import fs from 'node:fs';
import path from 'node:path';
import type { AiCouncilDecision, AiCouncilTrace, AiDecisionAction, AiProviderDecision } from '@hermes/contracts';
import { pushLog } from './services/live-log.js';

import {
  ClaudeCliProvider, CodexCliProvider, GeminiCliProvider,
  buildRulesDecision, setCouncilRef,
} from './ai-council-cli.js';
import { makeCouncilDecisionKey } from './ai-council-prompts.js';

// Re-export so strategy-director.ts (and others) can keep importing from here
export { runProcess } from './ai-council-cli.js';
export type { RateAwareProvider } from './ai-council-cli.js';
export type { CouncilRole } from './ai-council-prompts.js';

import type { RateAwareProvider } from './ai-council-cli.js';

const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';
const CODEX_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.2';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const CACHE_MS = Number(process.env.AI_COUNCIL_CACHE_MS ?? 300_000);
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
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private lastRealDecision: AiCouncilDecision | null = null;

  constructor() {
    this.claudeProvider = new ClaudeCliProvider();
    this.codexProvider = new CodexCliProvider();
    this.geminiProvider = new GeminiCliProvider();

    console.log(`[ai-council] Council routing ready. Claude=cli:${CLAUDE_MODEL}, Codex=cli:${CODEX_MODEL}, Gemini=cli:${GEMINI_MODEL}, Enabled=${ENABLED}`);

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

    const pool = [this.claudeProvider, this.codexProvider, this.geminiProvider];
    const available = pool.filter((provider) => !provider.isRateLimited());
    if (available.length > 0) {
      const pick = available[Math.floor(Math.random() * available.length)]!;
      console.log(`[ai-council] ${preferred.getRole()} rate-limited, rotating to ${pick.getRole()}`);
      return pick;
    }

    return preferred;
  }

  private isFallbackTrigger(value: string): boolean {
    return /rate.?limit|429|too many|overloaded|capacity|unavailable|timeout|enoent|not found|refused|failed to reach/i.test(value);
  }

  private async evaluateWithRotation(preferred: RateAwareProvider, candidate: AiTradeCandidate, decisionId: string): Promise<AiProviderDecision> {
    // Gemini Flash is free with high rate limits — use it as the universal fallback.
    // Claude/Codex rate-limited → Gemini. Gemini rate-limited (rare) → Claude.
    const pool = preferred.getRole() === 'gemini'
      ? [preferred, this.claudeProvider]   // Gemini → Claude as last resort
      : [preferred, this.geminiProvider];  // Claude/Codex → Gemini fallback

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
          console.log(`[ai-council] ${provider.getRole()} unavailable (${result.riskNote}), falling back to next provider`);
          continue;
        }

        return result;
      } catch (error) {
        console.log(`[ai-council] ${provider.getRole()} threw critical error, trying next: ${error instanceof Error ? error.message : 'unknown'}`);
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

  private async drain(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) return;

    const key = this.queue.shift();
    if (!key) return;

    const cached = this.decisions.get(key);
    if (!cached) return;

    console.log(`[ai-council] draining ${key} — calling Claude (primary) + Codex/Gemini (fallback to Claude)`);
    this.inFlight = true;
    cached.decision = {
      ...cached.decision,
      status: 'evaluating',
      reason: 'AI council is reviewing the candidate now.',
      timestamp: new Date().toISOString()
    };

    try {
      const results: (AiProviderDecision | null)[] = [null, null, null];
      const providers = [
        { provider: this.claudeProvider, name: 'claude', index: 0 },
        { provider: this.codexProvider, name: 'codex', index: 1 },
        { provider: this.geminiProvider, name: 'gemini', index: 2 }
      ];

      console.log(`[ai-council] calling providers in parallel for ${cached.candidate.symbol}...`);

      const evaluations = providers.map(async ({ provider, name, index }) => {
        try {
          const result = await this.evaluateWithRotation(provider, cached.candidate, key);
          results[index] = result;
        } catch (err) {
          results[index] = buildRulesDecision(cached.candidate, `${name} critical failure: ${err instanceof Error ? err.message : 'unknown'}`);
        }
        // Update incremental state in cache so getSnapshot() picks it up immediately
        cached.decision.panel = results.filter((r): r is AiProviderDecision => r !== null);
      });

      await Promise.allSettled(evaluations);

      const primary = results[0] ?? buildRulesDecision(cached.candidate, 'Claude failed to return a result');
      const challenger = results[1] ?? buildRulesDecision(cached.candidate, 'Codex failed to return a result');
      const tertiary = results[2] ?? buildRulesDecision(cached.candidate, 'Gemini failed to return a result');

      console.log(`[ai-council] providers returned: claude=${primary.provider}:${primary.action} codex=${challenger.provider}:${challenger.action} gemini=${tertiary.provider}:${tertiary.action}`);
      const final = this.combine(primary, challenger, tertiary, cached.candidate);

      cached.decision = {
        id: key,
        symbol: cached.candidate.symbol,
        agentId: cached.candidate.agentId,
        agentName: cached.candidate.agentName,
        status: 'complete',
        finalAction: final.finalAction,
        reason: final.reason,
        timestamp: new Date().toISOString(),
        primary,
        challenger,
        panel: [primary, challenger, tertiary]
      };
      cached.expiresAt = Date.now() + CACHE_MS;
      this.lastRealDecision = cached.decision;
      console.log(`[ai-council] drain complete: ${primary.provider}:${primary.action} ${primary.confidence}% / ${challenger.provider}:${challenger.action} ${challenger.confidence}% / ${tertiary.provider}:${tertiary.action} ${tertiary.confidence}% → ${final.finalAction}`);
    } catch (error) {
      console.error(`[ai-council] drain error:`, error instanceof Error ? error.message : error);
      const fallback = this.buildRulesFallback(
        cached.candidate,
        `AI council error. Falling back to rules-only approval: ${error instanceof Error ? error.message : 'unknown error'}.`
      );
      cached.decision = fallback;
      cached.expiresAt = Date.now() + CACHE_MS / 2;
    } finally {
      this.inFlight = false;
    }
  }

  private combine(
    primary: AiProviderDecision,
    challenger: AiProviderDecision,
    tertiary: AiProviderDecision,
    candidate: AiTradeCandidate
  ): { finalAction: AiDecisionAction; reason: string } {
    const votes = [primary, challenger, tertiary];
    const approveVotes = votes.filter((vote) => vote.action === 'approve');
    const rejectVotes = votes.filter((vote) => vote.action === 'reject');
    const reviewVotes = votes.filter((vote) => vote.action === 'review');
    const averageConfidence = votes.reduce((sum, vote) => sum + vote.confidence, 0) / votes.length;
    const summary = `Claude ${primary.action} ${primary.confidence}%, Codex ${challenger.action} ${challenger.confidence}%, Gemini ${tertiary.action} ${tertiary.confidence}%.`;
    const strongestReject = rejectVotes.reduce<AiProviderDecision | null>((best, vote) => {
      if (!best) return vote;
      return vote.confidence > best.confidence ? vote : best;
    }, null);

    if (rejectVotes.length >= 2) {
      return {
        finalAction: 'reject',
        reason: `${summary} Two or more reviewers vetoed the setup.`,
      };
    }

    if (strongestReject && strongestReject.confidence >= 80 && candidate.score < 7) {
      return {
        finalAction: 'reject',
        reason: `${summary} ${strongestReject.provider} issued a hard veto at ${strongestReject.confidence}% confidence.`,
      };
    }

    if (approveVotes.length >= 2 && rejectVotes.length === 0 && averageConfidence >= 60 && candidate.score >= 5.5) {
      return {
        finalAction: 'approve',
        reason: `${summary} Two approvals cleared the consensus gate at ${averageConfidence.toFixed(1)}% average confidence.`,
      };
    }

    if (approveVotes.length === 3 && averageConfidence >= 55 && candidate.score >= 5) {
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
      action: candidate.score >= 6 ? 'approve' as const : 'review' as const,
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
