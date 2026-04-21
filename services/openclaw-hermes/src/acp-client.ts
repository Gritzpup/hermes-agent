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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OPENCLAW_CMD, SESSION_ID } from './config.js';
import { logger } from '@hermes/logger';
import type { CooResponse } from './openclaw-client.js';

export const USE_ACP = process.env.OPENCLAW_HERMES_USE_ACP === '1';

// Root cause of the earlier session/new hang: openclaw acp needs the gateway
// token to talk to the gateway on :18789. Without it, gateway silently ignores
// the RPC and session/new never returns. Token lives in ~/.openclaw/openclaw.json
// under gateway.auth.token; openclaw acp reads env OPENCLAW_GATEWAY_TOKEN.
function loadGatewayToken(): string | null {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const cfgPath = path.join(os.homedir(), '.openclaw/openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { gateway?: { auth?: { token?: string } } };
    const token = cfg?.gateway?.auth?.token;
    return (typeof token === 'string' && token) ? token : null;
  } catch {
    return null;
  }
}
const GATEWAY_TOKEN = loadGatewayToken();

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
  // In-flight prompt accumulator: session/update agent_message_chunk notifications
  // arrive asynchronously and must be concatenated until session/prompt returns.
  private activePromptChunks: string[] | null = null;

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

    // NOTE: The --session key must NOT conflict with the main gateway process.
    // openclaw acp defaults to a session key like "agent:main:main" which does not
    // match our "hermes-bridge" sessionId, causing "Session not found" on session/prompt.
    // We use agent:main:explicit:${SESSION_ID}-acp to avoid file-lock conflicts with
    // the main gateway process that holds the real "hermes-bridge" session lock.
    // Pass the gateway token via env (preferred form per openclaw acp docs).
    // Without this the gateway silently ignores RPCs from openclaw acp and
    // session/new hangs forever. Token loaded once at module init from
    // ~/.openclaw/openclaw.json (gateway.auth.token).
    const env = { ...process.env };
    if (GATEWAY_TOKEN) env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_TOKEN;

    this.child = spawn(OPENCLAW_CMD, ['acp', '--no-prefix-cwd', '--verbose', '--session', `agent:main:explicit:${SESSION_ID}-acp`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr!.on('data', (d) => logger.info({ stderr: d.toString().slice(0, 400) }, 'ACP stderr'));
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

    // Handshake: initialize + new session.
    // Shapes verified against live `openclaw acp` 2026.4.15:
    //   initialize -> {protocolVersion: 1, clientCapabilities: {}}
    //   session/new -> {cwd, mcpServers: []} -> returns {sessionId: uuid}
    try {
      await this.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const sess = await this.rpc('session/new', {
        cwd: '/mnt/Storage/github/hermes-trading-firm',
        mcpServers: [],
      }) as { sessionId?: string };
      this.acpSessionId = sess?.sessionId ?? null;
      if (!this.acpSessionId) throw new Error('session/new returned no sessionId');
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
        } else if (msg.method === 'session/update') {
          try {
            fs.appendFileSync('/tmp/acp-debug.log', new Date().toISOString() + ' UPDATE ' + JSON.stringify((msg as any).params) + '\n');
          } catch {}
          // Streaming: agent_message_chunk carries the actual response text.
          const p = (msg as { params?: { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } } }).params;
          const update = p?.update;
          if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && update.content.text && this.activePromptChunks) {
            this.activePromptChunks.push(update.content.text);
          }
        } else if (msg.method) {
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
    // Arm the chunk accumulator BEFORE sending so no chunks are lost to race.
    this.activePromptChunks = [];
    try {
      // session/prompt returns a stopReason when the agent finishes. The actual
      // response text arrives via streamed session/update agent_message_chunk
      // notifications between now and the final response.
      const promptResult = await this.rpc('session/prompt', {
        sessionId: this.acpSessionId,
        prompt: [{ type: 'text', text: prompt }],
      }, 300_000);

      // Log the RPC result so we can see exactly what shape openclaw returns.
      try {
        fs.appendFileSync('/tmp/acp-debug.log',
          new Date().toISOString() + ' RESULT ' + JSON.stringify(promptResult).slice(0, 2000) + '\n');
      } catch {}

      // Try two shapes: chunks-accumulated (original), and result-embedded (fallback).
      let text = this.activePromptChunks.join('');
      if (!text && promptResult && typeof promptResult === 'object') {
        // Some ACP servers return the response text directly in the prompt result.
        const r = promptResult as Record<string, unknown>;
        if (typeof r.text === 'string') text = r.text;
        else if (typeof r.content === 'string') text = r.content;
        else if (r.response && typeof r.response === 'object') {
          const respText = (r.response as Record<string, unknown>).text;
          if (typeof respText === 'string') text = respText;
        }
      }
      if (!text) {
        logger.warn({ resultKeys: promptResult && typeof promptResult === 'object' ? Object.keys(promptResult as object) : [] }, 'ACP: prompt returned but no text found in chunks or result');
        return null;
      }
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) {
        logger.warn({ textPreview: text.slice(0, 200) }, 'ACP: no JSON object in streamed reply');
        return null;
      }
      return JSON.parse(m[0]) as CooResponse;
    } catch (err) {
      logger.error({ err: String(err) }, 'ACP prompt failed — bridge will retry via spawn fallback');
      return null;
    } finally {
      this.activePromptChunks = null;
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
