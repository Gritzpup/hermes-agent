/**
 * Direct Kimi API client for the COO bridge.
 * Replaces the openclaw → MiniMax indirection with a single HTTP call.
 * Kimi (Moonshot AI) exposes an OpenAI-compatible chat completions endpoint.
 */

import { logger } from '@hermes/logger';
import { KIMI_API_KEY, KIMI_BASE_URL, KIMI_MODEL, KIMI_TIMEOUT_MS } from './config.js';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

interface KimiCompletionChoice {
  index: number;
  message: { role: string; content: string; reasoning_content?: string; refusal?: string | null };
  finish_reason: string | null;
}

interface KimiCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: KimiCompletionChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

class KimiRateLimiter {
  private lastCall = 0;
  private minIntervalMs = 500; // conservative: 2 calls/sec max
  private consecutiveErrors = 0;
  private backoffUntil = 0;

  async gate(): Promise<void> {
    const now = Date.now();
    if (now < this.backoffUntil) {
      const wait = this.backoffUntil - now;
      logger.warn({ waitMs: wait }, 'Kimi rate limiter: backing off');
      await new Promise(r => setTimeout(r, wait));
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

  recordError(status?: number) {
    this.lastCall = Date.now();
    this.consecutiveErrors++;
    const base = Math.min(this.consecutiveErrors, 5);
    const delay = Math.pow(2, base) * 1000; // exponential: 2s, 4s, 8s, 16s, 32s
    this.backoffUntil = Date.now() + delay;
    logger.warn({ status, consecutiveErrors: this.consecutiveErrors, backoffMs: delay }, 'Kimi rate limiter: error backoff');
  }
}

const rateLimiter = new KimiRateLimiter();

export async function chatCompletion(messages: ChatMessage[]): Promise<string | null> {
  if (!KIMI_API_KEY) {
    logger.error('KIMI_API_KEY is not set — cannot dispatch to COO');
    return null;
  }

  await rateLimiter.gate();

  const body = {
    model: KIMI_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  };

  const url = `${KIMI_BASE_URL}/chat/completions`;
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KIMI_API_KEY}`,
        'User-Agent': 'KimiCLI/1.5',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(KIMI_TIMEOUT_MS),
    });

    const elapsed = Date.now() - start;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error({ status: res.status, elapsed, preview: text.slice(0, 400) }, 'Kimi API error');
      rateLimiter.recordError(res.status);
      return null;
    }

    const data = await res.json() as KimiCompletionResponse;
    rateLimiter.recordSuccess();

    const choice = data.choices?.[0];
    if (!choice) {
      logger.warn('Kimi API returned no choices');
      return null;
    }

    if (choice.finish_reason === 'content_filter' || choice.message.refusal) {
      logger.warn({ refusal: choice.message.refusal }, 'Kimi content filter triggered');
      return null;
    }

    const output = (choice.message.content || choice.message.reasoning_content) || null;
    logger.info({ elapsed, usage: data.usage, finishReason: choice.finish_reason, hasReasoning: !!choice.message.reasoning_content, contentLen: choice.message.content?.length, reasoningLen: choice.message.reasoning_content?.length }, 'Kimi COO call succeeded');
    return output;
  } catch (err) {
    const elapsed = Date.now() - start;
    logger.error({ err: String(err), elapsed }, 'Kimi API request failed');
    rateLimiter.recordError();
    return null;
  }
}
