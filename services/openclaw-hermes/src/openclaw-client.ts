import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from './config.js';
import { logger } from '@hermes/logger';
import { router } from './model-router.js';

const RAW_DUMPS_DIR = path.join(RUNTIME_DIR, 'raw-coo');
try { fs.mkdirSync(RAW_DUMPS_DIR, { recursive: true }); } catch {}

const RAW_DUMP_KEEP = Number(process.env.OPENCLAW_HERMES_RAW_KEEP ?? 100);

function dumpRaw(tag: string, content: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fp = path.join(RAW_DUMPS_DIR, `${ts}-${tag}.txt`);
  try {
    fs.writeFileSync(fp, content);
    const files = fs.readdirSync(RAW_DUMPS_DIR).sort();
    const excess = files.length - RAW_DUMP_KEEP;
    if (excess > 0) {
      for (const old of files.slice(0, excess)) {
        try { fs.unlinkSync(path.join(RAW_DUMPS_DIR, old)); } catch {}
      }
    }
  } catch {}
  return fp;
}

export type CooAction =
  | { type: 'halt'; reason: string }
  | { type: 'clear-halt'; reason: string }
  | { type: 'directive'; text: string; priority?: 'low' | 'normal' | 'high' }
  | { type: 'note'; text: string }
  | { type: 'pause-strategy'; strategy: string; reason: string }
  | { type: 'amplify-strategy'; strategy: string; reason: string; factor?: number }
  | { type: 'force-close-symbol'; symbol: string; reason: string }
  | { type: 'set-max-positions'; scope: 'firm' | 'strategy'; strategy?: string; max: number; reason?: string }
  | { type: 'write-event'; eventType: string; body?: Record<string, unknown> }
  | { type: 'run-script'; scriptKey: string; reason: string }
  | { type: 'noop' };

export type CooResponse = {
  summary: string;
  confidence?: number;
  actions: CooAction[];
  rationale?: string;
};

const SYSTEM_PREFIX = `You are the COO of Hermes trading firm. Respond with ONLY valid JSON — no markdown, no explanation.

JSON format:
{"summary":"<one sentence>", "actions":[{"type":"noop|pause-strategy|amplify-strategy|directive|halt", "strategy":"<id or null>", "reason":"<text or null>", "factor":null}]}

Rules:
- 3+ consecutive losses → pause-strategy
- Capital protection overrides all
- Amplify only if WR > 60% and positive expectancy
- Empty actions = noop`;

export async function askCoo(events: unknown[], rollingContext: unknown): Promise<CooResponse | null> {
  // Truncate inputs so the model has output budget for JSON (not just reasoning)
  const MAX_EVENTS = 20;
  const MAX_CONTEXT_CHARS = 8000;
  const trimmedEvents = (events as unknown[]).slice(-MAX_EVENTS);
  let contextStr = JSON.stringify(rollingContext, null, 2);
  if (contextStr.length > MAX_CONTEXT_CHARS) {
    contextStr = contextStr.slice(0, MAX_CONTEXT_CHARS) + '\n... [truncated]';
  }

  const userContent = `ROLLING_CONTEXT:\n${contextStr}\n\nNEW_EVENTS (${trimmedEvents.length} of ${(events as unknown[]).length}):\n${JSON.stringify(trimmedEvents, null, 2)}\n\nYOU MUST RESPOND THIS TURN. Output ONLY a single JSON object (no markdown fences, no prose before or after). The JSON must match the schema exactly.`;

  const reply = await router.fast([
      { role: 'system', content: SYSTEM_PREFIX },
      { role: 'user', content: userContent },
    ]);

  if (!reply) {
    logger.warn('Ollama COO returned no reply');
    return null;
  }

  dumpRaw('ollama', reply);

  // Extract JSON from anywhere in the reply (reasoning models may output
  // chain-of-thought before/after the JSON block).
  let jsonText = reply.trim();
  const jsonMatch = reply.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonText = jsonMatch[0];
  }

  try {
    const raw = JSON.parse(jsonText);
    // Handle nested "data" wrapper: {"data":{"summary":...,"actions":[]}}
    const parsed = (raw as { data?: CooResponse }).data ?? raw as CooResponse;
    if (!parsed.summary || !Array.isArray(parsed.actions)) {
      logger.warn({ replyPreview: reply.slice(0, 200) }, 'Ollama COO reply missing required fields');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error({ err: String(err), replyPreview: reply.slice(0, 300), jsonTextPreview: jsonText.slice(0, 300) }, 'Failed to parse Ollama COO reply as JSON');
    return null;
  }
}
