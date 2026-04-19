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
import { pickModel } from './lib/llm-router.js';
import { logOllamaCall } from './services/ollama-activity.js';

const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? '/home/ubuntubox/.local/bin/claude';
const GEMINI_BIN = process.env.GEMINI_BIN ?? '/home/ubuntubox/.npm-global/bin/gemini';
const CODEX_BIN = process.env.CODEX_BIN ?? '/home/ubuntubox/.npm-global/bin/codex';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const CODEX_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.2';

const PI_BIN = process.env.PI_BIN ?? '/home/ubuntubox/.npm-global/bin/pi';
const PI_MODEL = process.env.PI_MODEL ?? 'MiniMax-M2.7';
const PI_TIMEOUT_MS = Number(process.env.PI_TIMEOUT_MS ?? 45_000);

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
        // Claude rate-limited, cooling down
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
        { cwd: WORKSPACE_ROOT, timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS ?? 90_000), stdin: prompt },
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

export class PiCliProvider implements RateAwareProvider {
  private rateLimitedUntil = 0;

  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  getRole(): CouncilRole {
    return 'pi';
  }

  async evaluate(candidate: AiTradeCandidate, decisionId: string): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'gemini');
    const systemPrompt = `You are MiniMax-M2.7, the independent deliberator on Hermes trading firm's AI council. Your vote provides diversity from Claude/Codex/Gemini. Return JSON only with fields: action (approve/reject/review), confidence (0-100), thesis (string), riskNote (string).`;

    try {
      const piProvider = process.env.PI_PROVIDER ?? 'minimax';
      const { stdout } = await runProcess(
        PI_BIN,
        [
          '-p',
          '--mode', 'json',
          '--provider', piProvider,
          '--model', PI_MODEL,
          '--no-tools',
          '--no-extensions',
          '--thinking', 'minimal',
          '--system-prompt', systemPrompt,
          prompt,
        ],
        { cwd: WORKSPACE_ROOT, timeoutMs: PI_TIMEOUT_MS }
      );

      let rawOutput: string;
      try {
        rawOutput = parsePiJsonl(stdout);
      } catch {
        rawOutput = stdout; // fallback if the JSONL parser can't find a text block
      }
      const parsed = parseProviderPayload(rawOutput);
      const decision: AiProviderDecision = {
        provider: 'pi',
        source: 'cli',
        action: parsed.action,
        confidence: parsed.confidence,
        thesis: parsed.thesis,
        riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };

      council().recordTrace({
        id: randomUUID(),
        decisionId,
        symbol: candidate.symbol,
        agentId: candidate.agentId,
        agentName: candidate.agentName,
        role: 'pi',
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
        error: parsed.isValid ? undefined : 'Pi returned invalid/error payload'
      });

      return decision;
    } catch (error) {
      // TEMP DEBUG: print full error so next pi failure is visible in Tilt logs
      console.error('[ai-council] pi error:', error);
      const errorMessage = formatError(error);
      if (/rate.?limit|429|too many|overloaded|capacity/i.test(errorMessage)) {
        this.rateLimitedUntil = Date.now() + 60_000 + Math.random() * 30_000;
      }

      const decision = buildRulesDecision(candidate, `Pi CLI unavailable: ${errorMessage}`);

      council().recordTrace({
        id: randomUUID(),
        decisionId,
        symbol: candidate.symbol,
        agentId: candidate.agentId,
        agentName: candidate.agentName,
        role: 'pi',
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

// ============================================================================
// OllamaCliProvider — local free LLM via OpenAI-compatible API
// Uses martain7r/finance-llama-8b:q4_k_m (quantised Finance Llama 8B)
// Tier 3 in hermes routing: zero cost, sub-100ms, for fast classification
// ============================================================================

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://192.168.1.8:11434/v1';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'hermes3:8b';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 15_000);

const OLLAMA2_BASE_URL = process.env.OLLAMA2_BASE_URL ?? 'http://192.168.1.8:11434/v1';
const OLLAMA2_MODEL = process.env.OLLAMA2_MODEL ?? 'qwen3.5:9b-q4_k_m';
const OLLAMA2_TIMEOUT_MS = Number(process.env.OLLAMA2_TIMEOUT_MS ?? 60_000);

// ============================================================================
// BonsaiCliProvider — ultra-fast 1-bit local model on 192.168.1.8
// Bonsai-8B.gguf is a 1-bit quantised model, ultra-fast, low VRAM
// Tier 3 in hermes routing: ZERO cost, sub-50ms for fast classification
// Used for rapid YES/NO/ABSTAIN triage on trade candidates
// ============================================================================

// Bonsai removed - now using hermes3:8b and qwen3.5:9b-q4_k_m via Ollama

// Fix D — retry wrapper for Ollama HTTP calls (handles ~1359 "fetch failed" errors on 192.168.1.8)
async function fetchOllamaWithRetry(url: string, body: unknown, timeoutMs: number): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const resp = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ollama' }
      });
      clearTimeout(t);
      if (resp.ok || resp.status === 404) return resp;
      lastErr = new Error(`Ollama HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr;
}

export class OllamaCliProvider implements RateAwareProvider {
  private rateLimitedUntil = 0;
  /** null = unknown, true = up, false = down (lazy detection) */
  private _available: boolean | null = null;

  isRateLimited(): boolean {
    if (this._available === false) return true;
    return Date.now() < this.rateLimitedUntil;
  }

  getRole(): CouncilRole {
    return 'ollama';
  }

  /** Lazy health check — sets _available on first call */
  private async ping(): Promise<boolean> {
    if (this._available !== null) return this._available;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3_000);
      const resp = await fetch(`${OLLAMA_BASE_URL}/models`, {
        signal: ctrl.signal,
        headers: { Authorization: 'Bearer ollama' }
      });
      clearTimeout(t);
      this._available = resp.ok;
    } catch {
      this._available = false;
    }
    return this._available ?? false;
  }

  async evaluate(candidate: AiTradeCandidate, decisionId: string): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'ollama');
    const systemPrompt = 'You are finance-llama-8b, a finance-specialised 8B reasoning model. Return ONLY valid JSON with fields: action (approve/reject/review), confidence (0-100), thesis (string), riskNote (string).';

    if (this._available === false) {
      const decision = buildRulesDecision(candidate, 'Ollama (hermes3) confirmed unavailable.');
      council().recordTrace({
        id: randomUUID(), decisionId, symbol: candidate.symbol,
        agentId: candidate.agentId, agentName: candidate.agentName,
        role: 'ollama', transport: 'http', status: 'error',
        candidateScore: candidate.score, prompt, systemPrompt,
        rawOutput: '', error: 'Ollama hermes3 down', timestamp: new Date().toISOString()
      });
      return decision;
    }

    const cfg = pickModel("financial-reasoning");
    try {
      logOllamaCall({ source: 'ai-council-finance-llama', model: cfg.model, prompt, status: 'started' });

      const resp = await fetchOllamaWithRetry(`${cfg.baseUrl}/chat/completions`, {
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 300
      }, cfg.timeoutMs);

      if (!resp.ok) {
        if (resp.status === 404) {
          this._available = false;
          // Ollama model not found
        }
        throw new Error(`Ollama API ${resp.status}`);
      }

      this._available = true;
      const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      const rawOutput = data.choices?.[0]?.message?.content ?? '';
      const parsed = parseProviderPayload(rawOutput);

      const decision: AiProviderDecision = {
        provider: 'ollama-hermes3', source: 'http',
        action: parsed.action, confidence: parsed.confidence,
        thesis: parsed.thesis, riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt, timestamp: new Date().toISOString()
      };

      logOllamaCall({
        source: 'ai-council-finance-llama',
        model: cfg.model,
        prompt,
        responseSummary: `${parsed.action} ${parsed.confidence}% — ${(parsed.thesis ?? '').slice(0, 80)}`,
        latencyMs: decision.latencyMs,
        status: parsed.isValid ? 'complete' : 'error',
        errorPreview: parsed.isValid ? undefined : 'invalid payload',
      });

      council().recordTrace({
        id: randomUUID(), decisionId, symbol: candidate.symbol,
        agentId: candidate.agentId, agentName: candidate.agentName,
        role: 'ollama', transport: 'http',
        status: parsed.isValid ? 'complete' : 'error',
        candidateScore: candidate.score, prompt, systemPrompt,
        rawOutput,
        parsedAction: parsed.action, parsedConfidence: parsed.confidence,
        parsedThesis: parsed.thesis, parsedRiskNote: parsed.riskNote,
        latencyMs: decision.latencyMs, timestamp: decision.timestamp,
        error: parsed.isValid ? undefined : 'Ollama hermes3 invalid payload'
      });

      return decision;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/abort|timeout|fetch failed|connection refused/i.test(msg)) {
        this._available = false;
        // Ollama connection failed
      }
      logOllamaCall({ source: 'ai-council-finance-llama', model: cfg.model, prompt, latencyMs: Date.now() - startedAt, status: 'error', errorPreview: msg });
      const decision = buildRulesDecision(candidate, `Ollama hermes3 unavailable: ${msg}`);
      council().recordTrace({
        id: randomUUID(), decisionId, symbol: candidate.symbol,
        agentId: candidate.agentId, agentName: candidate.agentName,
        role: 'ollama', transport: 'http', status: 'error',
        candidateScore: candidate.score, prompt, systemPrompt,
        rawOutput: '', error: msg, timestamp: new Date().toISOString()
      });
      return decision;
    }
  }
}

// ============================================================================
// Ollama2CliProvider — qwen3.5:9b-q4_k_m for analysis and technical tasks
// Strong at coding, math, and structured analysis
// ============================================================================

export class Ollama2CliProvider implements RateAwareProvider {
  private rateLimitedUntil = 0;
  private _available: boolean | null = null;

  isRateLimited(): boolean {
    if (this._available === false) return true;
    return Date.now() < this.rateLimitedUntil;
  }

  getRole(): CouncilRole {
    return 'ollama';
  }

  async evaluate(candidate: AiTradeCandidate, decisionId: string): Promise<AiProviderDecision> {
    const startedAt = Date.now();
    const prompt = buildPrompt(candidate, 'ollama');
    const systemPrompt = 'You are qwen3.5:9b, excellent at analysis and technical reasoning. Use this for complex trading decisions only. Return ONLY valid JSON with fields: action (approve/reject/review), confidence (0-100), thesis (string), riskNote (string).';

    if (this._available === false) {
      const decision = buildRulesDecision(candidate, 'Ollama2 (qwen3.5) confirmed unavailable.');
      council().recordTrace({
        id: randomUUID(), decisionId, symbol: candidate.symbol,
        agentId: candidate.agentId, agentName: candidate.agentName,
        role: 'ollama', transport: 'http', status: 'error',
        candidateScore: candidate.score, prompt, systemPrompt,
        rawOutput: '', error: 'Ollama qwen3.5 down', timestamp: new Date().toISOString()
      });
      return decision;
    }

    const cfg = pickModel("strategic");
    try {
      logOllamaCall({ source: 'ai-council-qwen', model: cfg.model, prompt, status: 'started' });

      const resp = await fetchOllamaWithRetry(`${cfg.baseUrl}/chat/completions`, {
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 500
      }, cfg.timeoutMs);

      if (!resp.ok) {
        if (resp.status === 404) {
          this._available = false;
          // Ollama2 model not found
        }
        throw new Error(`Ollama2 API ${resp.status}`);
      }

      this._available = true;
      const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      const rawOutput = data.choices?.[0]?.message?.content ?? '';
      const parsed = parseProviderPayload(rawOutput);

      const decision: AiProviderDecision = {
        provider: 'ollama-qwen35', source: 'http',
        action: parsed.action, confidence: parsed.confidence,
        thesis: parsed.thesis, riskNote: parsed.riskNote,
        latencyMs: Date.now() - startedAt, timestamp: new Date().toISOString()
      };

      logOllamaCall({
        source: 'ai-council-qwen',
        model: cfg.model,
        prompt,
        responseSummary: `${parsed.action} ${parsed.confidence}% — ${(parsed.thesis ?? '').slice(0, 80)}`,
        latencyMs: decision.latencyMs,
        status: parsed.isValid ? 'complete' : 'error',
        errorPreview: parsed.isValid ? undefined : 'invalid payload',
      });

      council().recordTrace({
        id: randomUUID(), decisionId, symbol: candidate.symbol,
        agentId: candidate.agentId, agentName: candidate.agentName,
        role: 'ollama', transport: 'http',
        status: parsed.isValid ? 'complete' : 'error',
        candidateScore: candidate.score, prompt, systemPrompt,
        rawOutput,
        parsedAction: parsed.action, parsedConfidence: parsed.confidence,
        parsedThesis: parsed.thesis, parsedRiskNote: parsed.riskNote,
        latencyMs: decision.latencyMs, timestamp: decision.timestamp,
        error: parsed.isValid ? undefined : 'Ollama qwen3.5 invalid payload'
      });

      return decision;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/abort|timeout|fetch failed|connection refused/i.test(msg)) {
        this._available = false;
        // Ollama2 connection failed
      }
      logOllamaCall({ source: 'ai-council-qwen', model: cfg.model, prompt, latencyMs: Date.now() - startedAt, status: 'error', errorPreview: msg });
      const decision = buildRulesDecision(candidate, `Ollama qwen3.5 unavailable: ${msg}`);
      council().recordTrace({
        id: randomUUID(), decisionId, symbol: candidate.symbol,
        agentId: candidate.agentId, agentName: candidate.agentName,
        role: 'ollama', transport: 'http', status: 'error',
        candidateScore: candidate.score, prompt, systemPrompt,
        rawOutput: '', error: msg, timestamp: new Date().toISOString()
      });
      return decision;
    }
  }
}

export function buildRulesDecision(candidate: AiTradeCandidate, reason: string): AiProviderDecision {
  const action: AiDecisionAction = candidate.score >= 3 ? 'approve' : 'review';
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
  // Fix A — catch plain-text usage-limit messages BEFORE JSON parsing (prevents ~2311 parse errors)
  if (/hit your (usage )?limit|upgrade to (plus|pro)|rate limit exceeded|quota exceeded/i.test(raw)) {
    return {
      action: 'review',
      confidence: 0,
      thesis: 'Provider quota exhausted — not a real vote.',
      riskNote: 'Quota hit',
      isValid: false,
      _isRateLimit: true
    } as any;
  }

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

function parsePiJsonl(stdout: string): string {
  // pi --mode json emits a JSONL stream: message_start, thinking_delta, text_delta, message_end, agent_end.
  // The final assistant text is the `text` block in the last `agent_end` or `message_end` event.
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as { type?: string; message?: { content?: any[] }; messages?: any[] };
      if (parsed.type === 'agent_end' && Array.isArray(parsed.messages)) {
        const assistant = [...parsed.messages].reverse().find((m: any) => m?.role === 'assistant');
        if (assistant) {
          const textBlock = (assistant.content || []).find((b: any) => b?.type === 'text');
          if (textBlock?.text) return textBlock.text as string;
        }
      }
      if ((parsed.type === 'message_end' || parsed.type === 'turn_end') && parsed.message?.content) {
        const textBlock = parsed.message.content.find((b: any) => b?.type === 'text');
        if (textBlock?.text) return textBlock.text as string;
      }
    } catch { /* not JSON, skip */ }
  }
  throw new Error('pi did not return an assistant text block.');
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Fix C — thread PI_TIMEOUT_MS so pi/gemini subprocesses don't ReferenceError on process.env.PI_TIMEOUT_MS
      env: { ...process.env, PI_TIMEOUT_MS: String(process.env.PI_TIMEOUT_MS ?? 90_000) }
    });
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
