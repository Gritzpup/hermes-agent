/**
 * Direct MiniMax API client for the COO bridge.
 * MiniMax-M2.7-highspeed exposes an OpenAI-compatible chat completions endpoint.
 *
 * Endpoint: https://api.minimax.chat/v1/chat/completions  (not api.minimax.io)
 * Model:    MiniMax-M2.7-highspeed
 * Docs:     https://www.minimaxi.com/document
 */

import { logger } from '@hermes/logger';
import { MINIMAX_API_KEY, MINIMAX_BASE_URL, MINIMAX_MODEL, MINIMAX_TIMEOUT_MS } from './config.js';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

interface MiniMaxChoice {
  index: number;
  message: { role: string; content: string; reasoning_content?: string; refusal?: string | null };
  finish_reason: string | null;
}

interface MiniMaxCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: MiniMaxChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

class MiniMaxRateLimiter {
  private lastCall = 0;
  private minIntervalMs = 500; // 2 calls/sec max — conservative despite "unlimited" sub
  private consecutiveErrors = 0;
  private backoffUntil = 0;

  async gate(): Promise<void> {
    const now = Date.now();
    if (now < this.backoffUntil) {
      const wait = this.backoffUntil - now;
      logger.warn({ waitMs: wait }, 'MiniMax rate limiter: backing off');
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
    const delay = Math.pow(2, base) * 1000;
    this.backoffUntil = Date.now() + delay;
    logger.warn({ status, consecutiveErrors: this.consecutiveErrors, backoffMs: delay }, 'MiniMax rate limiter: error backoff');
  }
}

const rateLimiter = new MiniMaxRateLimiter();

export async function minimaxChatCompletion(messages: ChatMessage[]): Promise<string | null> {
  if (!MINIMAX_API_KEY) {
    logger.error('MINIMAX_API_KEY is not set — cannot dispatch to MiniMax');
    return null;
  }

  await rateLimiter.gate();

  const body = {
    model: MINIMAX_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 4096,
  };

  const base = MINIMAX_BASE_URL.endsWith('/v1')
    ? MINIMAX_BASE_URL
    : `${MINIMAX_BASE_URL}/v1`.replace(/\/v1\/v1/, '/v1');
  const url = `${base}/chat/completions`.replace(/anthropic$/, 'chat/completions');
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MINIMAX_TIMEOUT_MS),
    });

    const elapsed = Date.now() - start;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error({ status: res.status, elapsed, preview: text.slice(0, 400) }, 'MiniMax API error');
      rateLimiter.recordError(res.status);
      return null;
    }

    const data = await res.json() as MiniMaxCompletionResponse;
    rateLimiter.recordSuccess();

    const choice = data.choices?.[0];
    if (!choice) {
      logger.warn('MiniMax API returned no choices');
      return null;
    }

    if (choice.finish_reason === 'content_filter' || choice.message.refusal) {
      logger.warn({ refusal: choice.message.refusal }, 'MiniMax content filter triggered');
      return null;
    }

    const output = (choice.message.content || choice.message.reasoning_content) || null;
    logger.info({ elapsed, usage: data.usage, finishReason: choice.finish_reason, hasReasoning: !!choice.message.reasoning_content, contentLen: choice.message.content?.length, reasoningLen: choice.message.reasoning_content?.length }, 'MiniMax COO call succeeded');
    return output;
  } catch (err) {
    const elapsed = Date.now() - start;
    logger.error({ err: String(err), elapsed }, 'MiniMax API request failed');
    rateLimiter.recordError();
    return null;
  }
}
