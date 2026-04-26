/**
 * FinGPT v3 Sentiment Scoring
 *
 * Scores a text string for financial sentiment using a finance-fine-tuned
 * model on the remote Ollama host (martain7r/finance-llama-8b:q4_k_m).
 *
 * Output lives in Redis at hermes:sentiment:{symbol} with a 1-hour TTL.
 * Falls back to neutral { score: 0, confidence: 0 } on any error/timeout —
 * never throws, so upstream consumers are never broken by a bad model call.
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import { fetchWithTimeout } from './utils.js';

/* ── Config ───────────────────────────────────────────────────────── */

const OLLAMA_BASE   = process.env.OLLAMA_BASE_URL ?? 'http://192.168.1.8:11434';
const OLLAMA_MODEL  = process.env.OLLAMA_SENTIMENT_MODEL ?? 'martain7r/finance-llama-8b:q4_k_m';
const SENTIMENT_TTL = Number(process.env.SENTIMENT_TTL_SECONDS ?? 3_600); // 1 hour

/* ── Types ─────────────────────────────────────────────────────────── */

export interface SentimentResult {
  symbol: string;
  score: number;         // -1 (bearish) … +1 (bullish)
  horizon: '1h' | '1d' | '1w';
  confidence: number;    // 0 … 1
}

export interface ScoredNewsItem {
  symbol: string;
  headline: string;
  source: string;
  publishedAt: string;
}

/* ── FinGPT v3 sentiment prompt ────────────────────────────────────────
 *
 * Based on the FinGPT v3 instruction format from AI4Finance-Foundation.
 * We use a structured-JSON output instruction so the response can be
 * parsed reliably even if the model adds conversational preamble.
 * The prompt explicitly asks for a short reasoning + labeled JSON.
 */

function buildSentimentPrompt(text: string, symbol: string): string {
  return `<|system|>
You are FinGPT v3, a financial sentiment analysis model.
You MUST respond with ONLY a valid JSON object and nothing else.
Do not include any preamble, explanation, or markdown fences.
</s>
<|user|>
Analyze the financial sentiment for symbol **${symbol}** expressed in the following text.
Return a JSON object with the exact fields below:

{
  "score": <float from -1.0 (very bearish) to +1.0 (very bullish)>,
  "horizon": <"1h" for short-term, "1d" for intraday/swing, "1w" for weekly>,
  "confidence": <float from 0.0 to 1.0 representing how certain you are>,
  "reasoning": <2-3 sentence explanation of the sentiment>
}

Text to analyze:
"""
${text.slice(0, 2000)}
"""

Respond with ONLY the JSON object.</s>`;
}

/* ── Parse model output ─────────────────────────────────────────────── */

function parseSentiment(raw: string, symbol: string): SentimentResult {
  try {
    // Try to extract JSON from the raw output (model sometimes adds leading text)
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON object found');
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;

    const score      = clamp(-1, 1, Number(parsed.score)    || 0);
    const horizonRaw = String(parsed.horizon ?? '1d');
    const confidence = clamp(0, 1, Number(parsed.confidence ?? 0));

    const horizon: SentimentResult['horizon'] =
      horizonRaw === '1h' ? '1h' :
      horizonRaw === '1w' ? '1w' : '1d';

    return { symbol, score, horizon, confidence };
  } catch (err) {
    logger.warn({ err, raw: raw.slice(0, 200), symbol }, 'sentiment parse failed — returning neutral');
    return { symbol, score: 0, horizon: '1d', confidence: 0 };
  }
}

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ── Core scoring function ──────────────────────────────────────────── */

export async function scoreSentiment(
  text: string,
  symbol: string,
): Promise<SentimentResult> {
  const prompt = buildSentimentPrompt(text, symbol);
  let rawOutput = '';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 800);

    const response = await fetchWithTimeout(
      `${OLLAMA_BASE}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:   OLLAMA_MODEL,
          stream:  false,
          options: { temperature: 0.1, num_predict: 300 },
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: controller.signal,
      },
      900, // slightly longer than abort so we catch timeout first
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama responded ${response.status}: ${body}`);
    }

    const payload = await response.json() as { message?: { content?: string } };
    rawOutput = payload?.message?.content ?? '';

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, symbol }, 'scoreSentiment Ollama call failed — returning neutral fallback');
    return { symbol, score: 0, horizon: '1d', confidence: 0 };
  }

  const result = parseSentiment(rawOutput, symbol);

  // Write to Redis asynchronously — don't block on write errors
  void writeToRedis(symbol, result).catch((e) =>
    logger.error({ e, symbol }, 'failed to write sentiment to Redis'),
  );

  return result;
}

/* ── Batch CLI-friendly entry ──────────────────────────────────────── */

export async function scoreSentimentNews(
  symbol: string,
  newsItems: Array<{ headline: string; source: string; publishedAt: string }>,
): Promise<SentimentResult[]> {
  if (!newsItems.length) return [];

  // Concatenate headlines into a single text window (model ctx is 131K so
  // a reasonable batch fits easily). For very long batches, aggregate
  // per-item to avoid prompt bloat.
  const combined = newsItems
    .slice(0, 20) // cap at 20 items to stay well within context
    .map((n) => `[${n.source} ${n.publishedAt}] ${n.headline}`)
    .join(' | ');

  const result = await scoreSentiment(combined, symbol);

  // Store per-item sentiment scores in Redis as a hash for debugging
  const redisKey = `hermes:sentiment:${symbol}:news`;
  const fieldScores: Record<string, string> = {};
  for (const item of newsItems.slice(0, 20)) {
    fieldScores[`${item.source}:${item.publishedAt}`] = JSON.stringify({
      headline: item.headline.slice(0, 100),
      // We only scored once on the combined text, so attribution is coarse
      combined_score: result.score,
      confidence: result.confidence,
    });
  }
  void (async () => {
    try {
      await redis.hset(redisKey, fieldScores);
      await redis.expire(redisKey, SENTIMENT_TTL);
    } catch (e) {
      logger.error({ e }, 'scoreSentimentNews Redis write failed');
    }
  })();

  return [result];
}

/* ── Redis write ────────────────────────────────────────────────────── */

async function writeToRedis(symbol: string, result: SentimentResult): Promise<void> {
  const key = `hermes:sentiment:${symbol}`;
  await redis.set(key, JSON.stringify(result), 'EX', SENTIMENT_TTL);
}

/* ── Read last cached result (for callers that want to avoid a call) ─ */

export async function getCachedSentiment(symbol: string): Promise<SentimentResult | null> {
  const raw = await redis.get(`hermes:sentiment:${symbol}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SentimentResult;
  } catch {
    return null;
  }
}
