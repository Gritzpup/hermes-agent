// ACP client using acpx wrapper for proper session management
// acpx handles session lifecycle, queue management, reconnection, and IPC automatically
//
// Usage: Set OPENCLAW_HERMES_USE_ACPX=1 to enable this path.
// Fallback: The spawn-based askCoo() in openclaw-client.ts always works but is slower.

import { spawn } from 'node:child_process';
import { logger } from '@hermes/logger';
import type { CooResponse } from './openclaw-client.js';

export const USE_ACPX = process.env.OPENCLAW_HERMES_USE_ACPX === '1';
const ACPX_CMD = process.env.ACPX_CMD ?? 'acpx';
const SESSION_NAME = process.env.OPENCLAW_HERMES_SESSION ?? 'hermes-coo';
const ACPX_TIMEOUT_MS = Number(process.env.OPENCLAW_HERMES_ACPX_TIMEOUT_MS ?? 180_000); // 3 min for full prompt
const CWD = process.env.HERMES_CWD ?? '/mnt/Storage/github/hermes-trading-firm';

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

    const child = spawn(ACPX_CMD, ['openclaw', '-s', SESSION_NAME, prompt], {
      cwd: CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      logger.warn('acpx prompt timed out after', ACPX_TIMEOUT_MS, 'ms');
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
