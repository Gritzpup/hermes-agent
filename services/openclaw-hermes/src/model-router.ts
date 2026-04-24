/**
 * Model Router — single entry point for all LLM calls in the firm.
 * 
 * Hardware constraint: NVIDIA 2080 can only hold ONE model at a time.
 * All calls are serialized through a promise chain to prevent concurrent loads.
 * 
 * Provider: port 9000 (proxy auto-routes by model name to Bonsai/Ollama backends)
 *   - bonsai-1.7b:latest, bonsai-8b:latest → WSL/llama-server
 *   - phi3.5:latest, qwen2.5:* → native Ollama
 * 
 * Fallback: direct backends (BONSAI_BASE_URL, OLLAMA_DIRECT_URL) if proxy is down.
 */

import { logger } from '@hermes/logger';
import {
  MODEL_PROXY_URL,
  BONSAI_BASE_URL,
  BONSAI_MODEL,
  BONSAI_TIMEOUT_MS,
  OLLAMA_DIRECT_URL,
  OLLAMA_COO_MODEL,
  OLLAMA_REASONING_MODEL,
  OLLAMA_TIMEOUT_MS,
  KIMI_API_KEY,
  KIMI_BASE_URL,
  KIMI_MODEL,
  KIMI_TIMEOUT_MS,
} from './config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskType = 'fast' | 'reasoning' | 'heavy';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface RouterOptions {
  taskType?: TaskType;
  model?: string;       // override model selection
  maxTokens?: number;
  temperature?: number;
}

// ── Model selection ────────────────────────────────────────────────────────────

const TASK_MODEL_MAP: Record<TaskType, string> = {
  fast: 'phi3.5:latest',          // ~94 TPS, good for directives/classification
  reasoning: 'bonsai-1.7b:latest', // WSL backend, better for complex analysis
  heavy: 'qwen2.5:7b',             // Ollama, deeper reasoning when needed
};

function selectModel(opts: RouterOptions): string {
  if (opts.model) return opts.model;
  const taskType = opts.taskType ?? 'fast';
  return TASK_MODEL_MAP[taskType];
}

// ── Serialized request queue ───────────────────────────────────────────────────

// 2080 constraint: only one model loaded at a time. Queue all requests.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  queue = queue.then(fn, (err) => { logger.error({ err }, 'queue chain error'); return fn(); });
  return queue as Promise<T>;
}

// ── HTTP call helper ──────────────────────────────────────────────────────────

interface ApiResponse {
  id: string;
  choices: Array<{
    message: { content: string | null; role: string };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function postChat(
  url: string,
  model: string,
  messages: ChatMessage[],
  opts: RouterOptions,
  apiKey?: string,
  timeoutMs = 120_000,
): Promise<string | null> {
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 4096,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const elapsed = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error({ status: res.status, elapsed, url, preview: text.slice(0, 300) }, 'model-router HTTP error');
      return null;
    }

    const data = await res.json() as ApiResponse;
    const content = data.choices?.[0]?.message?.content ?? null;
    logger.info({ elapsed, model, contentLen: content?.length ?? 0, url }, 'model-router call succeeded');
    return content;
  } catch (err) {
    logger.error({ err, elapsed: Date.now() - start, url }, 'model-router request failed');
    return null;
  }
}

// ── Proxy fallback chain ──────────────────────────────────────────────────────

async function callWithProxy(model: string, messages: ChatMessage[], opts: RouterOptions): Promise<string | null> {
  const url = MODEL_PROXY_URL;

  // Try proxy first
  const result = await postChat(url, model, messages, opts, undefined, 120_000);
  if (result !== null) return result;

  // Proxy failed — fall back to direct backends based on model family
  logger.warn({ model }, 'proxy failed, trying direct backend');
  if (model.includes('bonsai')) {
    return postChat(`${BONSAI_BASE_URL}/v1/chat/completions`, BONSAI_MODEL, messages, opts, undefined, BONSAI_TIMEOUT_MS);
  } else {
    return postChat(`${OLLAMA_DIRECT_URL}/v1/chat/completions`, model, messages, opts, undefined, OLLAMA_TIMEOUT_MS);
  }
}

// ── Kimi API (heavy tasks only) ───────────────────────────────────────────────

async function callKimi(messages: ChatMessage[], opts: RouterOptions): Promise<string | null> {
  if (!KIMI_API_KEY) {
    logger.error('KIMI_API_KEY not set — cannot call Kimi for heavy tasks');
    return null;
  }

  const base = KIMI_BASE_URL.endsWith('/v1') ? KIMI_BASE_URL : `${KIMI_BASE_URL}/v1`;
  const url = `${base}/chat/completions`;

  const body = {
    model: KIMI_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 120_000,
  };

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KIMI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(KIMI_TIMEOUT_MS),
    });

    const elapsed = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error({ status: res.status, elapsed }, 'Kimi API error');
      return null;
    }

    const data = await res.json() as ApiResponse;
    const content = data.choices?.[0]?.message?.content ?? null;
    logger.info({ elapsed, contentLen: content?.length ?? 0 }, 'Kimi call succeeded');
    return content;
  } catch (err) {
    logger.error({ err, elapsed: Date.now() - start }, 'Kimi request failed');
    return null;
  }
}

// ── Main router ───────────────────────────────────────────────────────────────

/**
 * Route an LLM call through the appropriate provider.
 * All calls are serialized to respect the 2080 single-model constraint.
 * 
 * @param messages   - chat messages (system + user + assistant)
 * @param opts       - routing options (task type, model override, generation params)
 * @returns          - assistant's response string, or null on failure
 */
export async function modelRouter(
  messages: ChatMessage[],
  opts: RouterOptions = {},
): Promise<string | null> {
  const model = selectModel(opts);

  const call = async (): Promise<string | null> => {
    // Heavy tasks go to Kimi API (no local VRAM needed)
    if (opts.taskType === 'heavy') {
      logger.info({ model: KIMI_MODEL, taskType: 'heavy' }, 'routing to Kimi API');
      return callKimi(messages, opts);
    }

    // Fast/reasoning tasks go through local proxy → Bonsai or Ollama
    logger.info({ model, taskType: opts.taskType ?? 'fast' }, 'routing to local proxy');
    return callWithProxy(model, messages, opts);
  };

  return enqueue(call);
}

// ── Convenience aliases ───────────────────────────────────────────────────────

export const router = {
  fast: (messages: ChatMessage[], opts?: Omit<RouterOptions, 'taskType'>) =>
    modelRouter(messages, { ...opts, taskType: 'fast' }),

  reasoning: (messages: ChatMessage[], opts?: Omit<RouterOptions, 'taskType'>) =>
    modelRouter(messages, { ...opts, taskType: 'reasoning' }),

  heavy: (messages: ChatMessage[], opts?: Omit<RouterOptions, 'taskType'>) =>
    modelRouter(messages, { ...opts, taskType: 'heavy' }),

  raw: modelRouter,
};
