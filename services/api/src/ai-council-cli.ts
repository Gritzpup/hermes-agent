// @ts-nocheck
/**
 * AI Council — CLI process spawning, parsing, and provider implementations.
 * Extracted from ai-council.ts
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AiProviderDecision, AiDecisionAction } from '@hermes/contracts';
import type { AiTradeCandidate } from './ai-council.js';
import { buildPrompt } from './ai-council-prompts.js';
import type { CouncilRole } from './ai-council-prompts.js';

const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? '/home/ubuntubox/.local/bin/claude';
const GEMINI_BIN = process.env.GEMINI_BIN ?? '/home/ubuntubox/.npm-global/bin/gemini';
const CODEX_BIN = process.env.CODEX_BIN ?? '/home/ubuntubox/.npm-global/bin/codex';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const CODEX_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.2';

export interface RateAwareProvider {
  evaluate(candidate: AiTradeCandidate, decisionId: string): Promise<AiProviderDecision>;
  isRateLimited(): boolean;
  getRole(): CouncilRole;
}

// Lazily resolve getAiCouncil to avoid circular import at module-load time
let _getAiCouncil: (() => import('./ai-council.js').AiCouncil) | undefined;
function council(): import('./ai-council.js').AiCouncil {
  if (!_getAiCouncil) {
    // Dynamic import avoided — we set the reference from the main module
    throw new Error('ai-council-cli: council reference not initialised');
  }
  return _getAiCouncil();
}
export function setCouncilRef(fn: () => import('./ai-council.js').AiCouncil): void {
  _getAiCouncil = fn;
}

export class ClaudeCliProvider implements RateAwareProvider {
  private rateLimitedUntil = 0;

  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  getRole(): CouncilRole {
    return 'claude';
  }

  async evaluate(candidate: AiTradeCandidate, decisionId: string): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'claude');
    const systemPrompt = `You are the primary trade reviewer for Hermes. Return JSON only. Approve only if edge is clear.`;

    try {
      const { stdout } = await runProcess(
        CLAUDE_BIN,
        ['-p', '--output-format', 'json', '--model', CLAUDE_MODEL],
        { cwd: WORKSPACE_ROOT, timeoutMs: 30_000, stdin: prompt },
      );

      const envelope = JSON.parse(stdout) as { result?: string };
      const rawOutput = envelope.result ?? '';
      const parsed = parseProviderPayload(rawOutput);

      const decision: AiProviderDecision = {
        provider: 'claude',
        source: 'cli',
        action: parsed.action,
        confidence: parsed.confidence,
        thesis: parsed.thesis,
        riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };

      // Record trace
      council().recordTrace({
        id: randomUUID(),
        decisionId,
        symbol: candidate.symbol,
        agentId: candidate.agentId,
        agentName: candidate.agentName,
        role: 'claude',
        transport: 'cli',
        status: parsed.isValid ? 'complete' : 'error',
        candidateScore: candidate.score,
        prompt,
        systemPrompt,
        rawOutput,
        parsedAction: parsed.action,
        parsedConfidence: parsed.confidence,
        parsedThesis: parsed.thesis,
        parsedRiskNote: parsed.riskNote,
        latencyMs: decision.latencyMs,
        timestamp: decision.timestamp,
        error: parsed.isValid ? undefined : 'AI returned invalid/error payload'
      });

      return decision;
    } catch (error) {
      const errorMessage = formatError(error);
      if (/rate.?limit|429|too many|overloaded|capacity/i.test(errorMessage)) {
        const cooldownMs = 60_000 + Math.random() * 30_000;
        this.rateLimitedUntil = Date.now() + cooldownMs;
        console.log(`[ai-council] claude-cli rate-limited, cooling down ${Math.round(cooldownMs / 1000)}s`);
      }

      const decision = buildRulesDecision(candidate, `Claude CLI unavailable: ${errorMessage}`);

      council().recordTrace({
        id: randomUUID(),
        decisionId,
        symbol: candidate.symbol,
        agentId: candidate.agentId,
        agentName: candidate.agentName,
        role: 'claude',
        transport: 'cli',
        status: 'error',
        candidateScore: candidate.score,
        prompt,
        systemPrompt,
        rawOutput: '',
        error: errorMessage,
        timestamp: new Date().toISOString()
      });

      return decision;
    }
  }
}

export class CodexCliProvider implements RateAwareProvider {
  private rateLimitedUntil = 0;

  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  getRole(): CouncilRole {
    return 'codex';
  }

  async evaluate(candidate: AiTradeCandidate, decisionId: string): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'codex');
    const systemPrompt = `You are the skeptical challenger reviewer for Hermes. Return JSON only.`;

    try {
      const { stdout } = await runProcess(
        CODEX_BIN,
        ['exec', '-m', CODEX_MODEL, '--full-auto', '-'],
        { cwd: WORKSPACE_ROOT, timeoutMs: 30_000, stdin: prompt },
      );

      // Codex emits JSONL streaming format — extract the last agent_message item
      let rawOutput: string;
      try {
        rawOutput = parseCodexJsonl(stdout);
      } catch {
        rawOutput = stdout; // fallback to raw if JSONL parse fails
      }
      const parsed = parseProviderPayload(rawOutput);
      const decision: AiProviderDecision = {
        provider: 'codex',
        source: 'cli',
        action: parsed.action,
        confidence: parsed.confidence,
        thesis: parsed.thesis,
        riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };

      // Record trace
      council().recordTrace({
        id: randomUUID(),
        decisionId,
        symbol: candidate.symbol,
        agentId: candidate.agentId,
        agentName: candidate.agentName,
        role: 'codex',
        transport: 'cli',
        status: parsed.isValid ? 'complete' : 'error',
        candidateScore: candidate.score,
        prompt,
        systemPrompt,
        rawOutput,
        parsedAction: parsed.action,
        parsedConfidence: parsed.confidence,
        parsedThesis: parsed.thesis,
        parsedRiskNote: parsed.riskNote,
        latencyMs: decision.latencyMs,
        timestamp: decision.timestamp,
        error: parsed.isValid ? undefined : 'AI returned invalid/error payload'
      });

      return decision;
    } catch (error) {
      const errorMessage = formatError(error);
      if (/rate.?limit|429|too many|overloaded|capacity/i.test(errorMessage)) {
        this.rateLimitedUntil = Date.now() + 60_000 + Math.random() * 30_000;
      }

      const decision = buildRulesDecision(candidate, `Codex CLI unavailable: ${errorMessage}`);

      council().recordTrace({
        id: randomUUID(),
        decisionId,
        symbol: candidate.symbol,
        agentId: candidate.agentId,
        agentName: candidate.agentName,
        role: 'codex',
        transport: 'cli',
        status: 'error',
        candidateScore: candidate.score,
        prompt,
        systemPrompt,
        rawOutput: '',
        error: errorMessage,
        timestamp: new Date().toISOString()
      });

      return decision;
    }
  }
}

export class GeminiCliProvider implements RateAwareProvider {
  private rateLimitedUntil = 0;

  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  getRole(): CouncilRole {
    return 'gemini';
  }

  async evaluate(candidate: AiTradeCandidate, decisionId: string): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'gemini');
    const systemPrompt = `You are the tertiary long-context reviewer for Hermes. Return JSON only.`;

    try {
      const { stdout } = await runProcess(
        GEMINI_BIN,
        ['-m', GEMINI_MODEL, '--output-format', 'json', '-p', '-'],
        { cwd: WORKSPACE_ROOT, timeoutMs: 30_000, stdin: prompt },
      );

      const rawOutput = stdout;
      const parsed = parseProviderPayload(rawOutput);
      const decision: AiProviderDecision = {
        provider: 'gemini',
        source: 'cli',
        action: parsed.action,
        confidence: parsed.confidence,
        thesis: parsed.thesis,
        riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };

      // Record trace
      council().recordTrace({
        id: randomUUID(),
        decisionId,
        symbol: candidate.symbol,
        agentId: candidate.agentId,
        agentName: candidate.agentName,
        role: 'gemini',
        transport: 'cli',
        status: parsed.isValid ? 'complete' : 'error',
        candidateScore: candidate.score,
        prompt,
        systemPrompt,
        rawOutput,
        parsedAction: parsed.action,
        parsedConfidence: parsed.confidence,
        parsedThesis: parsed.thesis,
        parsedRiskNote: parsed.riskNote,
        latencyMs: decision.latencyMs,
        timestamp: decision.timestamp,
        error: parsed.isValid ? undefined : 'AI returned invalid/error payload'
      });

      return decision;
    } catch (error) {
      const errorMessage = formatError(error);
      if (/rate.?limit|429|too many|overloaded|capacity/i.test(errorMessage)) {
        this.rateLimitedUntil = Date.now() + 60_000 + Math.random() * 30_000;
      }

      const decision = buildRulesDecision(candidate, `Gemini CLI unavailable: ${errorMessage}`);

      council().recordTrace({
        id: randomUUID(),
        decisionId,
        symbol: candidate.symbol,
        agentId: candidate.agentId,
        agentName: candidate.agentName,
        role: 'gemini',
        transport: 'cli',
        status: 'error',
        candidateScore: candidate.score,
        prompt,
        systemPrompt,
        rawOutput: '',
        error: errorMessage,
        timestamp: new Date().toISOString()
      });

      return decision;
    }
  }
}

export function buildRulesDecision(candidate: AiTradeCandidate, reason: string): AiProviderDecision {
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

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'unknown error';
}

export function parseProviderPayload(raw: string): { action: AiDecisionAction; confidence: number; thesis: string; riskNote: string; isValid: boolean } {
  let normalized = normalizeJsonPayload(raw);

  // Detect explicit CLI error messages inside the payload
  if (raw.includes('ERROR:') || raw.includes('usage limit') || raw.includes('failed to') || raw.trim() === '') {
    return { action: 'review', confidence: 0, thesis: raw || 'Empty response.', riskNote: 'CLI Error detected.', isValid: false };
  }

  // Unwrap nested CLI envelopes (Gemini puts the raw generation inside "response", Claude inside "result")
  try {
    const envelope = JSON.parse(normalized) as Record<string, unknown>;
    if (typeof envelope.response === 'string') {
      normalized = normalizeJsonPayload(envelope.response);
    } else if (typeof envelope.result === 'string') {
      normalized = normalizeJsonPayload(envelope.result);
    }
  } catch {
    // String contains raw JSON of the struct directly
  }

  try {
    const parsed = JSON.parse(normalized) as Partial<{ action: AiDecisionAction; confidence: number; thesis: string; riskNote: string }>;
    const hasRequired = !!(parsed.action && (parsed.thesis || parsed.riskNote));

    return {
      action: parsed.action === 'approve' || parsed.action === 'reject' || parsed.action === 'review' ? parsed.action : 'review',
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(parsed.confidence, 100)) : 0,
      thesis: typeof parsed.thesis === 'string' ? parsed.thesis : 'No thesis returned.',
      riskNote: typeof parsed.riskNote === 'string' ? parsed.riskNote : 'No risk note returned.',
      isValid: hasRequired
    };
  } catch {
    return { action: 'review', confidence: 0, thesis: raw, riskNote: 'Parse failed.', isValid: false };
  }
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
