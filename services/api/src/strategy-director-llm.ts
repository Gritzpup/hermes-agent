/**
 * Strategy Director — Tiered LLM fallback chain.
 * Extracted from strategy-director.ts for maintainability.
 *
 * Chain: Ollama (free) → Kimi (primary cloud) → Gemini (fallback)
 * Claude disabled 2026-04-21 (subscription not renewed).
 * MiniMax was removed 2026-04-21.
 */

import { runProcess } from './ai-council.js';
import { logOllamaCall } from './services/ollama-activity.js';
import { pickModel } from './lib/llm-router.js';

const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_ROOT ?? '/mnt/Storage/github/hermes-trading-firm';
const GEMINI_BIN = process.env.GEMINI_BIN ?? '/home/ubuntubox/.npm-global/bin/gemini';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const KIMI_API_KEY = process.env.KIMI_API_KEY ?? '';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL ?? 'http://127.0.0.1:11235/v1';
const KIMI_MODEL = process.env.STRATEGY_DIRECTOR_KIMI_MODEL ?? 'kimi-for-coding';

const STRATEGY_DIRECTOR_TIMEOUT_MS = Number(process.env.STRATEGY_DIRECTOR_TIMEOUT_MS ?? 180_000);
const USE_OLLAMA_FIRST = process.env.STRATEGY_DIRECTOR_OLLAMA_FIRST !== '0';
const STRATEGY_DIRECTOR_OLLAMA_URL = process.env.STRATEGY_DIRECTOR_OLLAMA_URL ?? 'http://localhost:11434/v1';

export async function evaluateWithFallback(prompt: string): Promise<string> {
  // --- Tier 0: Ollama (free) ---
  if (USE_OLLAMA_FIRST) {
    const ollamaStart = Date.now();
    const sdModel = process.env.STRATEGY_DIRECTOR_OLLAMA_MODEL ?? 'hermes3:8b';
    const ollamaPrompt = `${prompt}\n\nRespond with JSON only.`;
    try {
      logOllamaCall({ source: 'strategy-director', model: sdModel, prompt: ollamaPrompt, status: 'started' });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      const resp = await fetch(`${STRATEGY_DIRECTOR_OLLAMA_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: sdModel,
          messages: [{ role: 'user', content: ollamaPrompt }],
          max_tokens: 2048,
          temperature: 0.3,
          format: 'json',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (resp.ok) {
        const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
        const content = (data.choices?.[0]?.message?.content ?? '').trim();
        let parsedValid = false;
        if (content && content !== '{}') {
          try { JSON.parse(content); parsedValid = true; } catch { /* ignore */ }
        }
        if (parsedValid) {
          console.log(`[strategy-director] Ollama (${sdModel}) served strategy analysis.`);
          logOllamaCall({ source: 'strategy-director', model: sdModel, prompt: ollamaPrompt, responseSummary: content.slice(0, 80), latencyMs: Date.now() - ollamaStart, status: 'complete' });
          return content;
        }
        console.log(`[strategy-director] Ollama returned non-JSON (${content.slice(0, 40)}), falling back...`);
        logOllamaCall({ source: 'strategy-director', model: sdModel, prompt: ollamaPrompt, latencyMs: Date.now() - ollamaStart, status: 'error', errorPreview: `non-JSON: ${content.slice(0, 80)}` });
      } else {
        logOllamaCall({ source: 'strategy-director', model: sdModel, prompt: ollamaPrompt, latencyMs: Date.now() - ollamaStart, status: 'error', errorPreview: `HTTP ${resp.status}` });
      }
    } catch (ollamaErr) {
      const errMsg = ollamaErr instanceof Error ? ollamaErr.message : String(ollamaErr);
      console.log(`[strategy-director] Ollama failed (${errMsg.slice(0, 60)}), falling back to cloud...`);
      logOllamaCall({ source: 'strategy-director', model: pickModel('financial-reasoning').model, prompt: ollamaPrompt, latencyMs: Date.now() - ollamaStart, status: 'error', errorPreview: errMsg.slice(0, 120) });
    }
  }

  // --- Tier 1: Kimi primary (Moonshot AI) ---
  if (KIMI_API_KEY) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      const resp = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${KIMI_API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': 'KimiCLI/1.5',
        },
        body: JSON.stringify({
          model: KIMI_MODEL,
          messages: [{ role: 'user', content: `${prompt}\n\nRespond with JSON only.` }],
          max_tokens: 2048,
          temperature: 0.3,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        throw new Error(`Kimi API ${resp.status}`);
      }

      const data = await resp.json() as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      const msg = data.choices?.[0]?.message;
      const raw = (msg?.reasoning_content || msg?.content) ?? '{}';
      console.log('[strategy-director] Kimi served as primary cloud provider.');
      return raw;
    } catch (kimiError) {
      console.log(`[strategy-director] Kimi failed (${kimiError instanceof Error ? kimiError.message.slice(0, 60) : 'unknown'}), falling back to Gemini...`);
    }
  } else {
    console.log('[strategy-director] KIMI_API_KEY not set, skipping Kimi primary...');
  }

  // --- Tier 2: Gemini Flash fallback ---
  try {
    const { stdout } = await runProcess(
      GEMINI_BIN,
      ['-m', GEMINI_MODEL, '--output-format', 'json', '-p', '-'],
      { cwd: WORKSPACE_ROOT, timeoutMs: STRATEGY_DIRECTOR_TIMEOUT_MS, stdin: prompt }
    );
    const envelope = JSON.parse(stdout) as { result?: string; error?: string };
    console.log('[strategy-director] Gemini Flash served as fallback.');
    return envelope.result ?? stdout;
  } catch (geminiError) {
    console.log(`[strategy-director] Gemini failed (${geminiError instanceof Error ? geminiError.message.slice(0, 60) : 'unknown'}), falling back to Kimi...`);
  }

  throw new Error('All providers failed for strategy-director.');
}
