/**
 * Ollama client for local model inference (bonsai-1.7b / bonsai-8b).
 * Used for the COO loop — fast, local, tool-calling capable.
 *
 * Ollama's OpenAI compat endpoint: http://host:11434/v1/chat/completions
 * No API key needed for local Ollama.
 */

import { logger } from '@hermes/logger';
import { OLLAMA_BASE_URL, OLLAMA_COO_MODEL, OLLAMA_TIMEOUT_MS } from './config.js';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OllamaChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OllamaToolCall[];
  };
  finish_reason: string | null;
}

interface OllamaResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OllamaChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

class OllamaRateLimiter {
  private lastCall = 0;
  private minIntervalMs = 200; // 5 calls/sec max for local model
  private consecutiveErrors = 0;
  private backoffUntil = 0;

  async gate(): Promise<void> {
    const now = Date.now();
    if (now < this.backoffUntil) {
      await new Promise(r => setTimeout(r, this.backoffUntil - now));
    }
    const elapsed = now - this.lastCall;
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
    }
  }

  recordSuccess() {
    this.lastCall = Date.now();
    this.consecutiveErrors = 0;
  }

  recordError() {
    this.lastCall = Date.now();
    this.consecutiveErrors++;
    const delay = Math.min(Math.pow(2, this.consecutiveErrors) * 500, 10_000);
    this.backoffUntil = Date.now() + delay;
    logger.warn({ errors: this.consecutiveErrors, backoffMs: delay }, 'Ollama rate limiter backoff');
  }
}

const rateLimiter = new OllamaRateLimiter();

export interface OllamaCallOptions {
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  temperature?: number;
  max_tokens?: number;
}

/**
 * Call Ollama with a chat completions request.
 * Returns the assistant's raw response string (may include tool calls).
 */
export async function ollamaChat(opts: OllamaCallOptions): Promise<string | null> {
  const {
    messages,
    tools,
    temperature = 0.3,
    max_tokens = 4096,
  } = opts;

  const baseUrl = OLLAMA_BASE_URL;
  const model = OLLAMA_COO_MODEL;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  await rateLimiter.gate();

  // Normalize base URL: ensure exactly one /v1
  const normalizedBase = baseUrl.replace(/\/$/, '').replace(/(\/v1)$/, '');
  const url = `${normalizedBase}/v1/chat/completions`;
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });

    const elapsed = Date.now() - start;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error({ status: res.status, elapsed, preview: text.slice(0, 300) }, 'Ollama API error');
      rateLimiter.recordError();
      return null;
    }

    const data = await res.json() as OllamaResponse;
    rateLimiter.recordSuccess();

    const choice = data.choices?.[0];
    if (!choice) {
      logger.warn('Ollama returned no choices');
      return null;
    }

    const msg = choice.message;
    const content = msg.content ?? '';

    // If model emitted tool calls, serialize them as structured strings
    // so the caller can handle them.
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const calls = msg.tool_calls.map(
        tc => `TOOL_CALL: name=${tc.function.name} args=${tc.function.arguments}`
      ).join('\n');
      logger.info({ elapsed, toolCalls: msg.tool_calls.length, model }, 'Ollama tool call emitted');
      return `${content}\n${calls}`.trim();
    }

    logger.info({ elapsed, contentLen: content.length, model }, 'Ollama call succeeded');
    return content || null;
  } catch (err) {
    const elapsed = Date.now() - start;
    logger.error({ err: String(err), elapsed }, 'Ollama request failed');
    rateLimiter.recordError();
    return null;
  }
}

/**
 * Parse tool-call strings emitted by ollamaChat.
 * Returns an array of {name, args} objects.
 */
export function parseToolCalls(raw: string): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const regex = /^TOOL_CALL: name=(\S+) args=([\s\S]*)$/gm;
  let m;
  while ((m = regex.exec(raw)) !== null) {
    try {
      calls.push({ name: m[1]!, args: JSON.parse(m[2]!) });
    } catch {
      // If args aren't valid JSON, store raw
      calls.push({ name: m[1]!, args: { _raw: m[2]! } });
    }
  }
  return calls;
}
