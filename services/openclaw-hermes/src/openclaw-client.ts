import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OPENCLAW_CMD, SESSION_ID, RUNTIME_DIR } from './config.js';
import { logger } from '@hermes/logger';

const RAW_DUMPS_DIR = path.join(RUNTIME_DIR, 'raw-coo');
try { fs.mkdirSync(RAW_DUMPS_DIR, { recursive: true }); } catch {}

const RAW_DUMP_KEEP = Number(process.env.OPENCLAW_HERMES_RAW_KEEP ?? 100);

function dumpRaw(tag: string, content: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fp = path.join(RAW_DUMPS_DIR, `${ts}-${tag}.txt`);
  try {
    fs.writeFileSync(fp, content);
    // Rotate: keep newest N files only.
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
  | { type: 'noop' };

export type CooResponse = {
  summary: string;
  confidence?: number;
  actions: CooAction[];
  rationale?: string;
};

const SYSTEM_PREFIX = `You are the COO of the hermes trading firm. You monitor the firm's event stream and actively work to improve profitability by identifying losing patterns, flagging strategy problems, and directing attention.

YOUR OBJECTIVES (priority order):
1. PROTECT CAPITAL — halt trading on rapid drawdown (>2% of portfolio in an hour) or systemic risk (multiple brokers unhealthy, feed degrading).
2. REDUCE LOSSES — flag any strategy that has lost money 3+ times consecutively and recommend pausing it.
3. AMPLIFY WINNERS — identify strategies consistently profitable and recommend increasing allocation.
4. SURFACE PATTERNS — note concentration risk, correlated losses, spread widening, unusual fills.
5. BUILD MEMORY — write observations into the firm's event stream so other services learn.

CONTEXT EACH TURN:
- rolling_context: recent 50 journal entries, per-strategy win/loss stats, total realized PnL
- new_events: structured events since last turn (broker health, trade closes, live-safety, strategy-director, capital-allocation, learning, pnl-attribution, calendar, etc.)

Respond ONLY with one JSON object (no prose before/after):
{
  "summary": "<one-sentence what you observed and decided>",
  "confidence": <0..1>,
  "actions": [...],
  "rationale": "<reasoning>"
}

ACTION TYPES (use as many as warranted; empty array = noop):
- {"type":"halt","reason":"..."}  emergency halt of all trading
- {"type":"clear-halt","reason":"..."}  resume after halt
- {"type":"directive","text":"...","priority":"low|normal|high"}  directive for other services (review-loop, strategy-director read these)
- {"type":"note","text":"..."}  observation only, no enactment
- {"type":"pause-strategy","strategy":"<id>","reason":"..."}  pause a losing strategy (use when 3+ consecutive losses or negative sustained PnL)
- {"type":"amplify-strategy","strategy":"<id>","reason":"...","factor":1.25}  increase capital allocation to a winning strategy
- {"type":"write-event","eventType":"<type>","body":{...}}  escape hatch: write an arbitrary event into the firm's stream
- {"type":"noop"}  nothing warranted

PROFITABILITY RULES (user's standing guidance):
- Never cut a scalp at a loss — wait for breakeven or tiny gain before closing.
- Be proactive about selection, not reactive.
- Prefer pausing a losing strategy over continuing to bleed into it.

Decision discipline:
- confidence < 0.4 → prefer note/noop over directive/halt
- only HALT on clear, critical risk (systemic, not per-trade)
- for repeat-losing strategies use write-event with eventType "coo-strategy-pause" + reasoning
- for winners worth more capital use write-event with eventType "coo-strategy-amplify"`;

export async function askCoo(events: unknown[], rollingContext: unknown): Promise<CooResponse | null> {
  const prompt = `${SYSTEM_PREFIX}

ROLLING_CONTEXT:
${JSON.stringify(rollingContext, null, 2)}

NEW_EVENTS:
${JSON.stringify(events, null, 2)}

YOU MUST RESPOND THIS TURN. Do not say NO_REPLY. Even if the events are routine, emit a JSON object with summary/confidence/actions/rationale — you may use {"type":"noop"} if truly nothing warrants action, but the JSON itself is required. Your response will be parsed as JSON. Output ONLY the JSON object, no prose before or after.`;

  return new Promise((resolve) => {
    const child = spawn(OPENCLAW_CMD, ['agent', '--local', '--thinking', 'medium', '--session-id', SESSION_ID, '--json', '-m', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      logger.warn('COO call timed out after 300s');
    }, 300_000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      // Always dump raw stdout + stderr for forensic review. Keeps last ~200 files (rotated externally or manually).
      const dumpPath = dumpRaw(
        code === 0 ? 'ok' : `err-${code}`,
        `=== exit=${code} stdout_len=${stdout.length} stderr_len=${stderr.length} ===\n=== STDOUT ===\n${stdout}\n=== STDERR ===\n${stderr}\n`,
      );
      logger.info({ code, stdoutLen: stdout.length, dump: dumpPath }, 'openclaw agent completed');
      if (code !== 0) {
        logger.error({ code, stderr: stderr.slice(0, 400) }, 'openclaw agent exited non-zero');
        resolve(null);
        return;
      }
      try {
        // openclaw routes envelope to stdout in gateway mode, to stderr in --local mode.
        // Try BOTH — combined, stripped of ANSI.
        const combined = (stdout + '\n' + stderr).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        const stripped = combined;
        // Envelope starts at the first top-level '{' on its own line or the first '{' overall.
        const envStart = stripped.indexOf('{');
        if (envStart === -1) { resolve(null); return; }
        const envText = stripped.slice(envStart);
        let envelope: unknown;
        try { envelope = JSON.parse(envText); }
        catch {
          // trailing junk — find last '}' and retry
          const lastBrace = envText.lastIndexOf('}');
          envelope = JSON.parse(envText.slice(0, lastBrace + 1));
        }
        // Known openclaw shapes we've seen:
        //   { payloads: [{text: "..."}], meta: {...} }                    (local/embedded)
        //   { reply: "..." }                                                (legacy)
        //   { result: { text: "..." } } / { result: { finalAssistantVisibleText: "..." } }
        let replyText: string | null = null;
        const e = envelope as Record<string, unknown>;
        if (Array.isArray(e.payloads) && e.payloads.length > 0) {
          const p0 = e.payloads[0] as Record<string, unknown>;
          if (typeof p0.text === 'string') replyText = p0.text;
        }
        if (!replyText && typeof e.reply === 'string') replyText = e.reply;
        const resultObj = e.result as Record<string, unknown> | undefined;
        if (!replyText && resultObj && typeof resultObj.text === 'string') {
          replyText = resultObj.text;
        }
        if (!replyText && resultObj && typeof resultObj.finalAssistantVisibleText === 'string') {
          replyText = resultObj.finalAssistantVisibleText;
        }
        // Fallback: walk the entire envelope for any string field that looks like our COO schema.
        if (!replyText) {
          const seek = (obj: unknown): string | null => {
            if (typeof obj === 'string') {
              if (obj.includes('"summary"') && obj.includes('"actions"')) return obj;
              return null;
            }
            if (Array.isArray(obj)) {
              for (const x of obj) { const r = seek(x); if (r) return r; }
              return null;
            }
            if (obj && typeof obj === 'object') {
              for (const v of Object.values(obj)) { const r = seek(v); if (r) return r; }
            }
            return null;
          };
          replyText = seek(envelope);
        }
        // Last-resort fallback: regex-scan the ENTIRE combined output for our COO schema.
        if (!replyText) {
          const schemaRe = /\{[^{}]*"summary"[\s\S]*?"actions"[\s\S]*?\}/;
          const m = stripped.match(schemaRe);
          if (m) replyText = m[0];
        }
        if (!replyText) {
          logger.error({ envelopeKeys: Object.keys(e) }, 'COO envelope: no known text field and no schema match');
          resolve(null);
          return;
        }
        // The COO's reply is itself a JSON object (our schema). Find first {...} and parse.
        const cooMatch = replyText.match(/\{[\s\S]*\}/);
        if (!cooMatch) {
          logger.error({ replyPreview: replyText.slice(0, 200) }, 'COO reply: no JSON object found');
          resolve(null);
          return;
        }
        const cooJson = JSON.parse(cooMatch[0]);
        resolve(cooJson as CooResponse);
      } catch (err) {
        logger.error({ err: String(err), stdoutPreview: stdout.slice(0, 300) }, 'failed to parse COO response');
        resolve(null);
      }
    });
  });
}
