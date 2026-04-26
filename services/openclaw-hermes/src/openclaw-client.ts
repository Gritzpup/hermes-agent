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

// ── Director context helpers ──────────────────────────────────────────────────────

interface RollingContextExt {
  context_version: string | undefined;
  live_venue_per_symbol: Record<string, string> | undefined;
  broker_capabilities: Record<string, string[]> | undefined;
  alpaca_has_activity: boolean | undefined;
}

/**
 * Extract Director context fields from the rolling context object.
 * All fields are optional — callers that pass older context shapes are not broken.
 */
function extractDirectorContext(ctx: unknown): RollingContextExt {
  if (!ctx || typeof ctx !== 'object') {
    return { context_version: undefined, live_venue_per_symbol: undefined, broker_capabilities: undefined, alpaca_has_activity: undefined };
  }
  const c = ctx as RollingContextExt;
  return {
    context_version: typeof c.context_version === 'string' ? c.context_version : undefined,
    live_venue_per_symbol: c.live_venue_per_symbol && typeof c.live_venue_per_symbol === 'object'
      ? c.live_venue_per_symbol
      : undefined,
    broker_capabilities: c.broker_capabilities && typeof c.broker_capabilities === 'object'
      ? c.broker_capabilities
      : undefined,
    alpaca_has_activity: typeof c.alpaca_has_activity === 'boolean' ? c.alpaca_has_activity : undefined,
  };
}

/**
 * Build the broker capabilities section injected into the COO system prompt.
 *
 * (a) When `alpaca_has_activity` is false, alpaca_universe is dropped from
 *     the prompt — eliminates the 12+ corrupted runs where the Director
 *     hallucinated "XRP-USD is not in Alpaca."
 *
 * (b) live_venue_per_symbol replaces the stale hardcoded broker capability map
 *     with authoritative per-symbol venue data sourced from Redis.
 */
function buildBrokerCapabilitiesBlock(dc: RollingContextExt): string {
  const { live_venue_per_symbol: venueMap, broker_capabilities: caps, alpaca_has_activity: hasActivity } = dc;

  const lines: string[] = [];

  // (b) Inject live_venue_per_symbol if available from Redis.
  if (venueMap && Object.keys(venueMap).length > 0) {
    lines.push('LIVE VENUE MAP (authoritative — from Redis hermes:routing:venues):');
    lines.push(JSON.stringify(venueMap, null, 2));
    lines.push('');
  }

  // (a) Broker capabilities — include alpaca only if there has been recent activity.
  // When hasActivity is false, omitting alpaca_universe prevents the Director from
  // incorrectly citing Alpaca's absence as a reason to remove XRP-USD (which is live on Coinbase).
  if (caps && Object.keys(caps).length > 0) {
    lines.push('AUTHORITATIVE BROKER CAPABILITIES:');
    for (const [broker, symbols] of Object.entries(caps)) {
      if (broker === 'alpaca-paper' && hasActivity === false) {
        lines.push(`  ${broker}: [ALPACA HAS HAD NO ACTIVITY IN 24 H — alpaca_universe omitted from this context]`);
        continue;
      }
      lines.push(`  ${broker}: [${(symbols ?? []).join(', ')}]`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * (c) Defensive parser: validate that any symbol referenced in the COO's response
 * is present in the Director context (live_venue_per_symbol or broker_capabilities).
 *
 * This prevents hallucinated "ghost symbols" from being enacted.
 * If the Director context is incomplete (no venue map, no broker caps), validation
 * is skipped — conservative behaviour when data is unavailable.
 *
 * Throws if a symbol is found in the response that is absent from the context.
 */
function validateDirectorSymbols(actions: CooAction[], dc: RollingContextExt): void {
  const { live_venue_per_symbol: venueMap, broker_capabilities: caps } = dc;

  // Build the set of known symbols.
  const knownSymbols = new Set<string>();
  if (venueMap) {
    for (const sym of Object.keys(venueMap)) knownSymbols.add(sym);
  }
  if (caps) {
    for (const symbols of Object.values(caps)) {
      for (const sym of (symbols ?? [])) knownSymbols.add(sym);
    }
  }

  // If we have no symbol data, skip validation (conservative — don't block the pipeline).
  if (knownSymbols.size === 0) {
    logger.debug('validateDirectorSymbols: no known symbols in context, skipping validation');
    return;
  }

  const unknownSymbols = new Set<string>();
  for (const action of actions) {
    if (action.type === 'force-close-symbol') {
      const sym = action.symbol?.trim();
      if (sym && !knownSymbols.has(sym)) unknownSymbols.add(sym);
    }
    // strategy field may embed a symbol as "grid-xrp-usd" — extract the embedded symbol.
    if ('strategy' in action) {
      const strat = String(action.strategy ?? '');
      // Patterns: "grid-XRP-USD" → XRP-USD, "grid-btc-usd" → BTC-USD, "agent-sol-momentum" → SOL-USD
      // Normalize to uppercase so lowercase strategy IDs (grid-btc-usd) are handled correctly.
      const embedded = strat.toUpperCase().match(/[-_]([A-Z]{2,}[-_][A-Z]{2,}|[A-Z]{2,}[-][A-Z0-9]{2,})/)?.[1]?.replace(/_/g, '-');
      if (embedded && !knownSymbols.has(embedded)) unknownSymbols.add(embedded);
    }
  }

  if (unknownSymbols.size > 0) {
    const errMsg = `Defensive parser REJECTED: response references unknown symbols not in Director context: ${[...unknownSymbols].join(', ')}. Known symbols: ${[...knownSymbols].join(', ')}.`;
    logger.error({ unknownSymbols: [...unknownSymbols], knownSymbols: [...knownSymbols] }, errMsg);
    throw new Error(errMsg);
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────────

function buildSystemPrefix(dc: RollingContextExt): string {
  const capsBlock = buildBrokerCapabilitiesBlock(dc);
  const versionNote = dc.context_version
    ? `\nDIRECTOR_CONTEXT_VERSION: ${dc.context_version}\n`
    : '';

  return `You are the COO of Hermes trading firm. Respond with ONLY valid JSON — no markdown, no explanation.

JSON format:
{"summary":"<one sentence>", "actions":[{"type":"noop|pause-strategy|amplify-strategy|directive|halt", "strategy":"<id or null>", "reason":"<text or null>", "factor":null}]}

Rules:
- 3+ consecutive losses → pause-strategy
- Capital protection overrides all
- Amplify only if WR > 60% and positive expectancy
- Empty actions = noop
${capsBlock}${versionNote}`;
}

export async function askCoo(events: unknown[], rollingContext: unknown): Promise<CooResponse | null> {
  // (a) + (b) + (c): Extract Director context fields from the rolling context.
  // This block carries venue map, broker capabilities, and context_version.
  const dc = extractDirectorContext(rollingContext);

  // Truncate inputs so the model has output budget for JSON (not just reasoning)
  const MAX_EVENTS = 20;
  const MAX_CONTEXT_CHARS = 8000;
  const trimmedEvents = (events as unknown[]).slice(-MAX_EVENTS);
  let contextStr = JSON.stringify(rollingContext, null, 2);
  if (contextStr.length > MAX_CONTEXT_CHARS) {
    contextStr = contextStr.slice(0, MAX_CONTEXT_CHARS) + '\n... [truncated]';
  }

  // (b) Build the enriched system prompt with live venue info.
  // (a) alpaca_universe is dropped when alpaca_has_activity === false.
  // (c) context_version is included so the COO is aligned with the Director context.
  const systemContent = buildSystemPrefix(dc);

  const userContent = `ROLLING_CONTEXT:\n${contextStr}\n\nNEW_EVENTS (${trimmedEvents.length} of ${(events as unknown[]).length}):\n${JSON.stringify(trimmedEvents, null, 2)}\n\nYOU MUST RESPOND THIS TURN. Output ONLY a single JSON object (no markdown fences, no prose before or after). The JSON must match the schema exactly.`;

  const reply = await router.minimax([
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ]);

  if (!reply) {
    logger.warn('COO model returned no reply');
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
    // Normalize wrapper formats: {"answer":{...}}, {"queryResult":{...}}, {"data":{...}}, {"turn":1, "question":..., "answer":{...}}
    const findCooResponse = (obj: Record<string, unknown>): unknown => {
      if (!obj || typeof obj !== 'object') return undefined;
      if ('summary' in obj && 'actions' in obj) return obj;
      for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') {
          const found = findCooResponse(val as Record<string, unknown>);
          if (found) return found;
        }
      }
      return undefined;
    };
    const candidate = findCooResponse(raw as Record<string, unknown>);
    if (!candidate || typeof candidate !== 'object' || !('summary' in candidate) || !('actions' in (candidate as Record<string, unknown>))) {
      logger.warn({ replyPreview: reply.slice(0, 200) }, 'Ollama COO reply missing required fields');
      return null;
    }
    const parsed = candidate as CooResponse;

    // (c) Defensive parser: reject responses that reference symbols absent from
    // the Director context. This catches hallucinated "ghost symbols" that would
    // otherwise cause corrupted directive enactment (e.g. claiming XRP-USD is not
    // in Alpaca when the Director context already knows it's on Coinbase).
    try {
      validateDirectorSymbols(parsed.actions, dc);
    } catch (validationErr) {
      // Validation error means the COO response is corrupt/stale — do not enact.
      logger.warn({ err: String(validationErr) }, 'COO response REJECTED by defensive parser');
      return null;
    }

    return parsed;
  } catch (err) {
    logger.error({ err: String(err), replyPreview: reply.slice(0, 300), jsonTextPreview: jsonText.slice(0, 300) }, 'Failed to parse Ollama COO reply as JSON');
    return null;
  }
}
