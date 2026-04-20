// ACP (Agent Client Protocol) bridge to openclaw — persistent session replacement
// for the per-tick spawn-based path in openclaw-client.ts.
//
// Benefit: current askCoo() spawns a fresh `openclaw agent --local` per tick which
// eats ~25-30s of node bootstrap each call. ACP keeps one long-lived `openclaw acp`
// process with a persistent JSON-RPC session, cutting that overhead to near-zero.
//
// Feature-flagged via OPENCLAW_HERMES_USE_ACP=1 (default OFF). On any ACP error the
// caller falls back to the spawn-based askCoo so a bad ACP path never breaks the bridge.
//
// Protocol notes (summarised from @agentclientprotocol/sdk):
//   - ndjson JSON-RPC 2.0 over stdin/stdout
//   - Methods: initialize → session/new or session/load → session/prompt → response
//   - Errors come back via {error: {code, message}}
//
// We only implement the minimum needed for "send a prompt, get a JSON response."

import { spawn, type ChildProcess } from 'node:child_process';
import { OPENCLAW_CMD, SESSION_ID } from './config.js';
import { logger } from '@hermes/logger';
import type { CooResponse } from './openclaw-client.js';

export const USE_ACP = process.env.OPENCLAW_HERMES_USE_ACP === '1';

type PendingReply = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
};

class AcpSession {
  private child: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingReply>();
  private ready: Promise<void> | null = null;
  private acpSessionId: string | null = null;
  private restartCount = 0;
  private readonly MAX_RESTARTS = 5;

  async ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.start();
    return this.ready;
  }

  private async start(): Promise<void> {
    if (this.restartCount >= this.MAX_RESTARTS) {
      throw new Error(`ACP session exceeded ${this.MAX_RESTARTS} restarts; giving up`);
    }
    this.restartCount++;
    logger.info({ restartCount: this.restartCount }, 'ACP: starting openclaw acp process');

    this.child = spawn(OPENCLAW_CMD, ['acp', '--no-prefix-cwd'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr!.on('data', (d) => logger.debug({ stderr: d.toString().slice(0, 200) }, 'ACP stderr'));
    this.child.on('exit', (code, signal) => {
      logger.warn({ code, signal }, 'ACP child exited — will lazy-restart on next call');
      this.child = null;
      this.ready = null;
      // Fail all pending requests
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('ACP child exited'));
      }
      this.pending.clear();
    });

    // Handshake: initialize + load session
    try {
      await this.rpc('initialize', { protocolVersion: 1, clientInfo: { name: 'openclaw-hermes', version: '0.1.0' } });
      const sess = await this.rpc('session/new', { sessionKey: `agent:main:${SESSION_ID}` }) as { sessionId?: string };
      this.acpSessionId = sess?.sessionId ?? null;
      logger.info({ acpSessionId: this.acpSessionId }, 'ACP: session established');
    } catch (err) {
      logger.error({ err: String(err) }, 'ACP handshake failed');
      throw err;
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string };
        if (typeof msg.id === 'number') {
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            if (msg.error) pending.reject(new Error(`ACP RPC ${msg.error.code}: ${msg.error.message}`));
            else pending.resolve(msg.result);
          }
        } else if (msg.method) {
          // Server-initiated notification (e.g. session/update). Ignore for now.
          logger.debug({ method: msg.method }, 'ACP notification (unhandled)');
        }
      } catch (err) {
        logger.warn({ line: line.slice(0, 120), err: String(err) }, 'ACP: unparseable stdout line');
      }
    }
  }

  private rpc(method: string, params: unknown, timeoutMs = 300_000): Promise<unknown> {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      return Promise.reject(new Error('ACP child not alive'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP RPC timeout on ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        this.child!.stdin!.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async sendPrompt(prompt: string): Promise<CooResponse | null> {
    await this.ensureReady();
    try {
      const reply = await this.rpc('session/prompt', {
        sessionId: this.acpSessionId,
        prompt: [{ type: 'text', text: prompt }],
      }) as { payloads?: Array<{ text?: string }>; reply?: string };

      let text: string | null = null;
      if (Array.isArray(reply?.payloads) && reply.payloads[0]?.text) text = reply.payloads[0].text;
      else if (typeof reply?.reply === 'string') text = reply.reply;
      if (!text) {
        logger.warn({ replyKeys: reply ? Object.keys(reply) : [] }, 'ACP: no text payload');
        return null;
      }
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) {
        logger.warn({ textPreview: text.slice(0, 150) }, 'ACP: no JSON in reply');
        return null;
      }
      return JSON.parse(m[0]) as CooResponse;
    } catch (err) {
      logger.error({ err: String(err) }, 'ACP prompt failed — bridge will retry via spawn fallback');
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.ready = null;
  }
}

const singleton = new AcpSession();

export async function askCooAcp(events: unknown[], rollingContext: unknown): Promise<CooResponse | null> {
  if (!USE_ACP) return null;
  const prompt = `ROLLING_CONTEXT:\n${JSON.stringify(rollingContext, null, 2)}\n\nNEW_EVENTS:\n${JSON.stringify(events, null, 2)}\n\nRespond with ONLY a JSON object matching the COO action schema.`;
  return singleton.sendPrompt(prompt);
}

export async function closeAcp(): Promise<void> {
  return singleton.close();
}
