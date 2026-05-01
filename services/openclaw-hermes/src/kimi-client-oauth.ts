/**
 * OAuth-enabled Kimi API client for the COO bridge.
 * Uses Kimi CLI's OAuth credentials to access restricted models like kimi-for-coding.
 * 
 * The API requires specific headers that identify "Coding Agents" - using the same
 * headers and device ID as Kimi CLI ensures compatibility.
 */

import { logger } from '@hermes/logger';
import { KIMI_BASE_URL, KIMI_MODEL, KIMI_TIMEOUT_MS } from './config.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import os from 'node:os';

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

// ── Constants ────────────────────────────────────────────────────────────────

const KIMI_CLI_VERSION = '1.30.0';
const KIMI_CLI_CREDS_PATH = `${homedir()}/.kimi/credentials/kimi-code.json`;
const KIMI_CLI_DEVICE_ID_PATH = `${homedir()}/.kimi/device_id`;

// ── Token Management (Kimi CLI format) ────────────────────────────────────────

interface KimiCLIToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  token_type: string;
  expires_in: number;
}

function getDeviceId(): string {
  try {
    if (existsSync(KIMI_CLI_DEVICE_ID_PATH)) {
      return readFileSync(KIMI_CLI_DEVICE_ID_PATH, 'utf8').trim();
    }
  } catch {
    // Fall through
  }
  return '1de38712480a4acd91c054c43e920a4b'; // fallback
}

function getCommonHeaders(): Record<string, string> {
  return {
    'User-Agent': `KimiCLI/${KIMI_CLI_VERSION}`,
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': KIMI_CLI_VERSION,
    'X-Msh-Device-Id': getDeviceId(),
    'X-Msh-Device-Model': `${os.platform()} ${os.release()} ${os.machine() || os.arch()}`,
    'X-Msh-Os-Version': os.release(),
    'X-Msh-Device-Name': os.hostname(),
  };
}

function loadKimiToken(): { access: string; refresh: string; expires: number } | null {
  try {
    if (!existsSync(KIMI_CLI_CREDS_PATH)) {
      logger.debug({ path: KIMI_CLI_CREDS_PATH }, 'Kimi CLI credentials not found');
      return null;
    }
    const data = JSON.parse(readFileSync(KIMI_CLI_CREDS_PATH, 'utf8')) as KimiCLIToken;
    if (data.access_token && data.refresh_token && data.expires_at) {
      return {
        access: data.access_token,
        refresh: data.refresh_token,
        expires: data.expires_at * 1000, // Convert to milliseconds
      };
    }
    return null;
  } catch (e) {
    logger.warn({ err: e }, 'Failed to load Kimi CLI token');
    return null;
  }
}

// ── Rate Limiter ─────────────────────────────────────────────────────────────

class KimiRateLimiter {
  private lastCall = 0;
  private minIntervalMs = 500;
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
    const delay = Math.pow(2, base) * 1000;
    this.backoffUntil = Date.now() + delay;
    logger.warn({ status, consecutiveErrors: this.consecutiveErrors, backoffMs: delay }, 'Kimi rate limiter: error backoff');
  }
}

const rateLimiter = new KimiRateLimiter();

// ── API Call ────────────────────────────────────────────────────────────────

export async function chatCompletion(messages: ChatMessage[]): Promise<string | null> {
  await rateLimiter.gate();

  const body = {
    model: KIMI_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 120_000,
  };

  const base = KIMI_BASE_URL.endsWith('/v1') ? KIMI_BASE_URL : `${KIMI_BASE_URL}/v1`.replace(/\/v1\/v1/, '/v1');
  const url = `${base}/chat/completions`;
  const start = Date.now();

  // Load token from Kimi CLI credentials
  const token = loadKimiToken();
  if (!token) {
    logger.error('No Kimi OAuth token found. Run `kimi` CLI first to authenticate.');
    return null;
  }

  // Check if token is still valid (with 5 min buffer)
  if (token.expires < Date.now() + 5 * 60 * 1000) {
    logger.warn('Kimi OAuth token expired. Please re-authenticate with `kimi` CLI.');
    return null;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token.access}`,
    ...getCommonHeaders(),
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
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
