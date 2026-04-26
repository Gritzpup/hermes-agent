import './load-env.js';
import { execFile } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { logger, setupErrorEmitter } from '@hermes/logger';

setupErrorEmitter(logger);

const app = express();
const port = Number(process.env.PORT ?? 4311);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ───────────────────────────────────────────────────────────
const KIMI_BASE_URL = process.env.KIMI_BASE_URL ?? 'http://127.0.0.1:11235/v1';
const KIMI_API_KEY = process.env.KIMI_API_KEY ?? '';
const KIMI_MODEL = process.env.KIMI_VISION_MODEL ?? 'kimi-for-coding';
const KIMI_TIMEOUT_MS = Number(process.env.KIMI_VISION_TIMEOUT_MS ?? 60_000);
const CAPTURE_INTERVAL_MS = Number(process.env.VISION_CAPTURE_INTERVAL_MS ?? 300_000); // 5 min
const SCREENSHOT_CMD = process.env.VISION_SCREENSHOT_CMD ?? 'scrot';
const SCREENSHOT_ARGS = (process.env.VISION_SCREENSHOT_ARGS ?? '').split(' ').filter(Boolean);
const EVENTS_FILE = process.env.HERMES_EVENTS_FILE
  ?? path.resolve(MODULE_DIR, '../../api/.runtime/paper-ledger/events.jsonl');
const RUNTIME_DIR = path.resolve(MODULE_DIR, '../.runtime');
const SCREENSHOT_PATH = path.join(RUNTIME_DIR, 'latest-screenshot.png');

// ── State ───────────────────────────────────────────────────────────────────
let latestAnalysis: VisionAnalysis | null = null;
let lastCaptureAt: string | null = null;
let captureErrors = 0;
let captureSuccesses = 0;
let inFlight = false;

interface VisionAnalysis {
  timestamp: string;
  description: string;
  provider: string;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
}

// ── Screenshot capture ──────────────────────────────────────────────────────
async function captureScreenshot(): Promise<Buffer> {
  await execFileAsync(SCREENSHOT_CMD, [...SCREENSHOT_ARGS, SCREENSHOT_PATH]);
  return readFile(SCREENSHOT_PATH);
}

function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 15_000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
    child.on('error', reject);
  });
}

// ── Kimi Vision API ─────────────────────────────────────────────────────────
async function analyzeWithKimi(imageBase64: string): Promise<VisionAnalysis | null> {
  if (!KIMI_API_KEY) {
    logger.warn('KIMI_API_KEY not set — skipping vision analysis');
    return null;
  }

  const url = `${KIMI_BASE_URL}/chat/completions`;
  const body = {
    model: KIMI_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe what is visible on this screen in 2-3 sentences. Focus on any trading dashboards, terminals, charts, or alerts that might be relevant to a trading firm.',
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${imageBase64}` },
          },
        ],
      },
    ],
    max_tokens: 512,
  };

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KIMI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(KIMI_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error({ status: res.status, preview: text.slice(0, 200) }, 'Kimi vision API error');
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? choice?.message?.reasoning_content ?? '';
    const elapsed = Date.now() - start;

    if (!content) {
      logger.warn('Kimi vision returned empty content');
      return null;
    }

    logger.info({ elapsed, usage: data.usage, finishReason: choice?.finish_reason }, 'Kimi vision analysis complete');

    return {
      timestamp: new Date().toISOString(),
      description: content.trim(),
      provider: 'kimi',
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    };
  } catch (err) {
    logger.error({ err: String(err), elapsed: Date.now() - start }, 'Kimi vision request failed');
    return null;
  }
}

// ── Gemini fallback (stub — CLI does not support headless images) ──────────
async function analyzeWithGemini(_imageBase64: string): Promise<VisionAnalysis | null> {
  logger.warn('Gemini vision fallback not implemented — CLI lacks headless image support');
  return null;
}

// ── Event emission ──────────────────────────────────────────────────────────
async function emitVisionEvent(analysis: VisionAnalysis): Promise<void> {
  const event = {
    timestamp: analysis.timestamp,
    type: 'vision-snapshot',
    source: 'hermes-vision',
    description: analysis.description,
    provider: analysis.provider,
    promptTokens: analysis.promptTokens,
    completionTokens: analysis.completionTokens,
  };

  try {
    await appendFile(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf8');
    logger.debug({ eventType: 'vision-snapshot' }, 'Emitted vision event');
  } catch (err) {
    logger.error({ err: String(err) }, 'Failed to emit vision event');
  }
}

// ── Main capture cycle ──────────────────────────────────────────────────────
async function runCaptureCycle(): Promise<void> {
  if (inFlight) {
    logger.debug('Capture already in flight, skipping');
    return;
  }

  inFlight = true;
  try {
    logger.info('Capturing desktop screenshot...');
    const image = await captureScreenshot();
    const base64 = image.toString('base64');
    lastCaptureAt = new Date().toISOString();

    let analysis = await analyzeWithKimi(base64);
    if (!analysis) {
      analysis = await analyzeWithGemini(base64);
    }

    if (analysis) {
      latestAnalysis = analysis;
      captureSuccesses++;
      await emitVisionEvent(analysis);
    } else {
      captureErrors++;
    }
  } catch (err) {
    captureErrors++;
    logger.error({ err: String(err) }, 'Vision capture cycle failed');
  } finally {
    inFlight = false;
  }
}

// ── Express routes ──────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({
    service: 'hermes-vision',
    status: 'healthy',
    lastCaptureAt,
    captureSuccesses,
    captureErrors,
    inFlight,
    latestDescription: latestAnalysis?.description.slice(0, 120) ?? null,
    timestamp: new Date().toISOString(),
  });
});

app.get('/latest', (_req, res) => {
  if (!latestAnalysis) {
    return res.status(404).json({ error: 'No analysis available yet' });
  }
  res.json(latestAnalysis);
});

app.post('/capture', async (_req, res) => {
  await runCaptureCycle();
  if (latestAnalysis) {
    res.json({ ok: true, analysis: latestAnalysis });
  } else {
    res.status(502).json({ ok: false, error: 'Capture or analysis failed' });
  }
});

// ── Startup ─────────────────────────────────────────────────────────────────
app.listen(port, () => {
  logger.info({ port, captureIntervalMs: CAPTURE_INTERVAL_MS }, 'hermes-vision listening');

  // Run first capture after 10s, then on interval
  setTimeout(runCaptureCycle, 10_000);
  setInterval(runCaptureCycle, CAPTURE_INTERVAL_MS);
});
