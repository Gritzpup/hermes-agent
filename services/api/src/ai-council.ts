import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiCouncilDecision, AiCouncilTrace, AiDecisionAction, AiProviderDecision } from '@hermes/contracts';

const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? '/home/ubuntubox/.local/bin/claude';
const GEMINI_BIN = process.env.GEMINI_BIN ?? '/home/ubuntubox/.npm-global/bin/gemini';
const CODEX_BIN = process.env.CODEX_BIN ?? '/home/ubuntubox/.npm-global/bin/codex';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'sonnet';
const CACHE_MS = Number(process.env.AI_COUNCIL_CACHE_MS ?? 45_000);
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

type CouncilRole = 'claude' | 'codex' | 'gemini';

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

interface AiProvider {
  evaluate(candidate: AiTradeCandidate): Promise<AiProviderDecision>;
}

interface RateAwareProvider extends AiProvider {
  isRateLimited(): boolean;
  getRole(): CouncilRole;
}


// --------------- API-based providers (fast, preferred) ---------------

class ClaudeApiProvider implements AiProvider {
  constructor(private readonly apiKey: string) {}

  async evaluate(candidate: AiTradeCandidate): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'claude');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: controller.signal
      });

      const body = await response.json() as { content?: Array<{ text?: string }> };
      const text = body.content?.[0]?.text ?? '';
      const parsed = parseProviderPayload(text);

      return {
        provider: 'claude',
        source: 'api',
        action: parsed.action,
        confidence: parsed.confidence,
        thesis: parsed.thesis,
        riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString()
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

class OpenAiApiProvider implements AiProvider {
  constructor(private readonly apiKey: string) {}

  async evaluate(candidate: AiTradeCandidate): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'codex');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          max_tokens: 256,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: controller.signal
      });

      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content ?? '';
      const parsed = parseProviderPayload(text);

      return {
        provider: 'codex',
        source: 'api',
        action: parsed.action,
        confidence: parsed.confidence,
        thesis: parsed.thesis,
        riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString()
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// Pi provider removed — all providers use native CLIs only (Claude, Codex, Gemini)

class RulesOnlyProvider implements AiProvider {
  constructor(private readonly reason: string) {}

  async evaluate(candidate: AiTradeCandidate): Promise<AiProviderDecision> {
    return buildRulesDecision(candidate, this.reason);
  }
}

class ClaudeCliProvider implements RateAwareProvider {
  private rateLimitedUntil = 0;

  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  getRole(): CouncilRole {
    return 'claude';
  }

  async evaluate(candidate: AiTradeCandidate): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'claude');

    try {
      const { stdout } = await runProcess(
        CLAUDE_BIN,
        ['-p', '--output-format', 'json', '--model', CLAUDE_MODEL],
        { cwd: WORKSPACE_ROOT, timeoutMs: 30_000, stdin: prompt },
      );

      const envelope = JSON.parse(stdout) as { result?: string };
      const parsed = parseProviderPayload(envelope.result ?? '');

      return {
        provider: 'claude',
        source: 'cli',
        action: parsed.action,
        confidence: parsed.confidence,
        thesis: parsed.thesis,
        riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = formatError(error);
      if (/rate.?limit|429|too many|overloaded|capacity/i.test(errorMessage)) {
        const cooldownMs = 60_000 + Math.random() * 30_000;
        this.rateLimitedUntil = Date.now() + cooldownMs;
        console.log(`[ai-council] claude-cli rate-limited, cooling down ${Math.round(cooldownMs / 1000)}s`);
      }
      return buildRulesDecision(candidate, `Claude CLI unavailable: ${errorMessage}`);
    }
  }
}

class CodexCliProvider implements RateAwareProvider {
  private rateLimitedUntil = 0;

  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  getRole(): CouncilRole {
    return 'codex';
  }

  async evaluate(candidate: AiTradeCandidate): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'codex');

    try {
      const { stdout } = await runProcess(
        CODEX_BIN,
        ['exec', '--full-auto', '-'],
        { cwd: WORKSPACE_ROOT, timeoutMs: 30_000, stdin: prompt },
      );

      const parsed = parseProviderPayload(stdout);
      return {
        provider: 'codex',
        source: 'cli',
        action: parsed.action,
        confidence: parsed.confidence,
        thesis: parsed.thesis,
        riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = formatError(error);
      if (/rate.?limit|429|too many|overloaded|capacity/i.test(errorMessage)) {
        this.rateLimitedUntil = Date.now() + 60_000 + Math.random() * 30_000;
      }
      return buildRulesDecision(candidate, `Codex CLI unavailable: ${errorMessage}`);
    }
  }
}

class GeminiCliProvider implements RateAwareProvider {
  private rateLimitedUntil = 0;

  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  getRole(): CouncilRole {
    return 'gemini';
  }

  async evaluate(candidate: AiTradeCandidate): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'gemini');

    try {
      const { stdout } = await runProcess(
        GEMINI_BIN,
        ['-p', '-'],
        { cwd: WORKSPACE_ROOT, timeoutMs: 30_000, stdin: prompt },
      );

      const parsed = parseProviderPayload(stdout);
      return {
        provider: 'gemini',
        source: 'cli',
        action: parsed.action,
        confidence: parsed.confidence,
        thesis: parsed.thesis,
        riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = formatError(error);
      if (/rate.?limit|429|too many|overloaded|capacity/i.test(errorMessage)) {
        this.rateLimitedUntil = Date.now() + 60_000 + Math.random() * 30_000;
      }
      return buildRulesDecision(candidate, `Gemini CLI unavailable: ${errorMessage}`);
    }
  }
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

  constructor() {
    // All providers use native CLIs — no Pi proxy
    this.claudeProvider = new ClaudeCliProvider();
    this.codexProvider = new CodexCliProvider();
    this.geminiProvider = new GeminiCliProvider();

    console.log(`[ai-council] Council routing ready. Claude=claude-cli:${CLAUDE_MODEL}, Codex=codex-cli, Gemini=gemini-cli, Enabled=${ENABLED}`);

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
    const results = Array.from(this.decisions.values())
      .sort((left, right) => right.decision.timestamp.localeCompare(left.decision.timestamp))
      .slice(0, limit)
      .map((entry) => entry.decision);
    return results;
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

  private recordTrace(trace: AiCouncilTrace): void {
    try {
      fs.mkdirSync(path.dirname(TRACE_LOG_PATH), { recursive: true });
      fs.appendFileSync(TRACE_LOG_PATH, `${JSON.stringify(trace)}\n`, 'utf8');
    } catch {
      // trace persistence is best-effort
    }
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

  private isRateLimitReason(value: string): boolean {
    return /rate.?limit|429|too many|overloaded|capacity/i.test(value);
  }

  private async evaluateWithRotation(preferred: RateAwareProvider, candidate: AiTradeCandidate): Promise<AiProviderDecision> {
    // Try preferred first, then always fall back to Claude (most reliable)
    const pool = preferred.getRole() === 'claude'
      ? [preferred]
      : [preferred, this.claudeProvider];

    for (const provider of pool) {
      if (provider.isRateLimited()) {
        continue;
      }
      try {
        const result = await provider.evaluate(candidate);
        if (result.provider === 'rules' && this.isRateLimitReason(result.riskNote)) {
          console.log(`[ai-council] ${provider.getRole()} rate-limited, falling back to Claude`);
          continue;
        }
        return result;
      } catch {
        console.log(`[ai-council] ${provider.getRole()} failed, trying next`);
        continue;
      }
    }

    // Last resort: direct Claude call ignoring rate limit
    try {
      return await this.claudeProvider.evaluate(candidate);
    } catch {
      return buildRulesDecision(candidate, 'All providers failed including Claude fallback.');
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
      // Claude is primary. Codex/Gemini tried but fall back to Claude if rate-limited.
      // Run sequentially to avoid 3 simultaneous Claude calls hitting rate limits.
      console.log(`[ai-council] calling providers for ${cached.candidate.symbol}...`);
      const primary = await this.evaluateWithRotation(this.claudeProvider, cached.candidate);
      const challenger = await this.evaluateWithRotation(this.codexProvider, cached.candidate);
      const tertiary = await this.evaluateWithRotation(this.geminiProvider, cached.candidate);
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
      reason: 'Candidate queued for Pi review.',
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

function buildPrompt(candidate: AiTradeCandidate, role: CouncilRole): string {
  const roleLine = role === 'claude'
    ? 'You are the primary trade reviewer for Hermes.'
    : role === 'codex'
      ? 'You are the skeptical challenger reviewer for Hermes.'
      : 'You are the tertiary long-context reviewer for Hermes.';

  const roleFocus = role === 'claude'
    ? 'Optimize for precision and after-cost expectancy.'
    : role === 'codex'
      ? 'Challenge brittle heuristics, fee leakage, and overfitting.'
      : 'Look for cross-asset, macro, and regime contradictions.';

  return [
    roleLine,
    roleFocus,
    'Return JSON only with this schema:',
    '{"action":"approve|reject|review","confidence":0-100,"thesis":"short string","riskNote":"short string"}',
    'No markdown. No code fences. No extra commentary.',
    'Approve only if the setup has a clear after-cost edge and no material vetoes.',
    'Reject if spread, slippage, liquidity, macro, news, or regime risk is poor.',
    'Use review when the evidence is mixed or the setup is under-specified.',
    'Treat fresh critical macro or symbol-specific news as a reason to reject or review rather than force a scalp.',
    JSON.stringify(candidate)
  ].join('\n');
}

function makeCouncilDecisionKey(candidate: AiTradeCandidate): string {
  const scoreBucket = candidate.score >= 8 ? 'high' : candidate.score >= 5 ? 'mid' : 'low';
  const shortBucket = candidate.shortReturnPct >= 0.15 ? 'up' : candidate.shortReturnPct <= -0.15 ? 'down' : 'flat';
  const spreadBucket = candidate.spreadBps <= 2.5 ? 'tight' : candidate.spreadBps <= 4.5 ? 'normal' : 'wide';
  return [candidate.symbol, candidate.agentId, candidate.style, scoreBucket, shortBucket, spreadBucket].join(':');
}

function truncateTranscript(text: string, limit = 8_000): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}

function buildRulesDecision(candidate: AiTradeCandidate, reason: string): AiProviderDecision {
  const action: AiDecisionAction = candidate.score >= 6 ? 'approve' : 'review';
  return {
    provider: 'rules',
    source: 'rules',
    action,
    confidence: Math.min(Math.round(candidate.score * 12), 99),
    thesis: 'Rules-only fallback decision.',
    riskNote: reason,
    latencyMs: 0,
    timestamp: new Date().toISOString()
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'unknown error';
}

function parseProviderPayload(raw: string): { action: AiDecisionAction; confidence: number; thesis: string; riskNote: string } {
  const normalized = normalizeJsonPayload(raw);
  const parsed = JSON.parse(normalized) as Partial<{ action: AiDecisionAction; confidence: number; thesis: string; riskNote: string }>;
  return {
    action: parsed.action === 'approve' || parsed.action === 'reject' || parsed.action === 'review' ? parsed.action : 'review',
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(parsed.confidence, 100)) : 0,
    thesis: typeof parsed.thesis === 'string' ? parsed.thesis : 'No thesis returned.',
    riskNote: typeof parsed.riskNote === 'string' ? parsed.riskNote : 'No risk note returned.'
  };
}

function normalizeJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const unfenced = fenceMatch ? (fenceMatch[1] ?? '').trim() : trimmed;
  const firstBrace = unfenced.indexOf('{');
  const lastBrace = unfenced.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return unfenced.slice(firstBrace, lastBrace + 1);
  }
  return unfenced;
}

function parseCodexJsonl(stdout: string): string {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    const parsed = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
    if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message' && typeof parsed.item.text === 'string') {
      return parsed.item.text;
    }
  }
  throw new Error('Codex did not return an agent message payload.');
}

export async function runProcess(command: string, args: string[], options: { cwd: string; timeoutMs: number; stdin?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        child.kill('SIGTERM');
        setTimeout(() => { if (!finished) { child.kill('SIGKILL'); finished = true; reject(new Error(`${command} timed out after ${options.timeoutMs}ms`)); } }, 3_000);
      }
    }, options.timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timeout); finished = true; reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (finished) return;
      finished = true;
      if (code !== 0 && stdout.trim().length === 0) {
        reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 'unknown'}.`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(options.stdin ?? '');
  });
}

let council: AiCouncil | undefined;

export function getAiCouncil(): AiCouncil {
  if (!council) {
    council = new AiCouncil();
  }
  return council;
}
