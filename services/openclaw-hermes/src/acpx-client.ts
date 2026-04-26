// ACP client using acpx wrapper for proper session management
// acpx handles session lifecycle, queue management, reconnection, and IPC automatically
//
// Usage: Set OPENCLAW_HERMES_USE_ACPX=1 to enable this path.
// Fallback: The spawn-based askCoo() in openclaw-client.ts always works but is slower.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '@hermes/logger';
import type { CooResponse } from './openclaw-client.js';

export const USE_ACPX = process.env.OPENCLAW_HERMES_USE_ACPX === '1';
const ACPX_CMD = process.env.ACPX_CMD ?? 'acpx';
const SESSION_NAME = process.env.OPENCLAW_HERMES_SESSION ?? 'hermes-coo';
const ACPX_TIMEOUT_MS = Number(process.env.OPENCLAW_HERMES_ACPX_TIMEOUT_MS ?? 180_000); // 3 min for full prompt
const CWD = process.env.HERMES_CWD ?? '/mnt/Storage/github/hermes-trading-firm';

// ROOT CAUSE of the earlier session/new hang: openclaw acp (spawned as the ACP
// agent under acpx) needs the gateway token to talk to the gateway on :18789.
// Without it the gateway silently drops the request and session/new never
// returns. The token is in ~/.openclaw/openclaw.json under gateway.auth.token,
// and openclaw acp reads it from env OPENCLAW_GATEWAY_TOKEN.
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

interface AcpxResult {
  ok: boolean;
  text?: string;
  error?: string;
  exitCode?: number;
}

// Parse acpx output to extract response text
function parseAcpxOutput(stdout: string, stderr: string): AcpxResult {
  // Check for errors in stderr
  if (stderr.includes('error:') || stderr.includes('Error:')) {
    // Extract error message
    const errorMatch = stderr.match(/error:\s*(.+?)(?:\n|$)/i);
    return { ok: false, error: errorMatch?.[1] ?? stderr.slice(0, 200), exitCode: 1 };
  }

  // acpx outputs text responses directly to stdout in a structured format
  // Look for our JSON response embedded in the output
  const text = stdout.trim();
  
  if (!text) {
    return { ok: false, error: 'No output from acpx', exitCode: 1 };
  }

  return { ok: true, text };
}

export async function askCooAcpx(events: unknown[], rollingContext: unknown): Promise<CooResponse | null> {
  if (!USE_ACPX) return null;

  const prompt = `You are the COO of Hermes Trading Firm. Respond with ONLY a JSON object.

ROLLING_CONTEXT:
${JSON.stringify(rollingContext, null, 2)}

NEW_EVENTS:
${JSON.stringify(events, null, 2)}

Respond with JSON: {"summary":"...","confidence":0.0-1.0,"actions":[...],"rationale":"..."}`;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    // Forward the gateway token so the child `openclaw acp` the wrapper spawns
    // can authenticate to the gateway on :18789. Without this, session/new hangs.
    const env = { ...process.env };
    if (GATEWAY_TOKEN) env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_TOKEN;

    const child = spawn(ACPX_CMD, ['openclaw', '-s', SESSION_NAME, prompt], {
      cwd: CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      logger.warn({ timeoutMs: ACPX_TIMEOUT_MS }, 'acpx prompt timed out');
    }, ACPX_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      
      if (killed) {
        resolve(null);
        return;
      }

      logger.debug({ code, stdoutLen: stdout.length, stderrLen: stderr.length }, 'acpx completed');

      const result = parseAcpxOutput(stdout, stderr);
      
      if (!result.ok) {
        logger.warn({ error: result.error }, 'acpx returned error');
        resolve(null);
        return;
      }

      // Extract JSON from output
      const text = result.text ?? '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        logger.warn({ textPreview: text.slice(0, 200) }, 'acpx: no JSON found in output');
        resolve(null);
        return;
      }

      try {
        const cooResponse = JSON.parse(jsonMatch[0]) as CooResponse;
        resolve(cooResponse);
      } catch (err) {
        logger.warn({ err: String(err) }, 'acpx: failed to parse JSON response');
        resolve(null);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.error({ err: String(err) }, 'acpx spawn error');
      resolve(null);
    });
  });
}

// Initialize a session for persistent use
export async function ensureAcpxSession(): Promise<{ sessionId: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(ACPX_CMD, ['openclaw', 'sessions', 'ensure', '-s', SESSION_NAME], {
      cwd: CWD,
      stdio: 'pipe',
    });

    let stdout = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        // Extract session ID from output
        const match = stdout.match(/([a-f0-9-]{36})/);
        resolve({ sessionId: match?.[0] ?? SESSION_NAME });
      } else {
        resolve({ sessionId: SESSION_NAME, error: `Exit code ${code}` });
      }
    });

    child.on('error', (err) => {
      resolve({ sessionId: SESSION_NAME, error: String(err) });
    });
  });
}
