// Safe scripts — allowlist of named operations the COO can request via
// CooAction type "run-script". Each entry maps a stable key (e.g.
// "restart:hermes-api") to a fixed command + args. The COO cannot supply
// arbitrary commands — only keys from this file. Unknown keys are rejected.
//
// Guardrails:
//   - Per-key cooldown (5 min default): a given script can't fire twice in 5 min
//   - Global hour cap (10/hour): bridge-wide limit on script runs
//   - Every attempt and outcome is logged to .runtime/coo-scripts.jsonl
//   - Timeout on every spawn (60s default)
//   - No pipes, shells, or user-controlled args — the Record<key,spec> values
//     are frozen at build time
//
// Add new entries here if you want the COO to be able to trigger them.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { RUNTIME_DIR } from './config.js';
import { appendJsonl } from './state.js';
import { logger, emitFirmError } from '@hermes/logger';

export type SafeScriptKey =
  | 'restart:hermes-api'
  | 'restart:hermes-market-data'
  | 'restart:hermes-risk-engine'
  | 'restart:hermes-review-loop'
  | 'restart:openclaw-hermes'
  | 'restart:openclaw-gateway'
  | 'clear:bot-lock'
  | 'clear:opencode-snapshot-locks'
  | 'typecheck:api'
  | 'journal:commit-snapshot';

type ScriptSpec = {
  cmd: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  describe: string;
};

const SCRIPTS: Record<SafeScriptKey, ScriptSpec> = {
  'restart:hermes-api': {
    cmd: 'tilt', args: ['trigger', 'hermes-api'],
    describe: 'Restart hermes-api (port 4300) via tilt',
  },
  'restart:hermes-market-data': {
    cmd: 'tilt', args: ['trigger', 'hermes-market-data'],
    describe: 'Restart market-data (port 4302) via tilt',
  },
  'restart:hermes-risk-engine': {
    cmd: 'tilt', args: ['trigger', 'hermes-risk-engine'],
    describe: 'Restart risk-engine (port 4301) via tilt',
  },
  'restart:hermes-review-loop': {
    cmd: 'tilt', args: ['trigger', 'hermes-review-loop'],
    describe: 'Restart review-loop (port 4304) via tilt',
  },
  'restart:openclaw-hermes': {
    cmd: 'tilt', args: ['trigger', 'openclaw-hermes'],
    describe: 'Restart the COO bridge itself — use if the COO sees its own tickInFlight stuck',
  },
  'restart:openclaw-gateway': {
    cmd: 'systemctl', args: ['--user', 'restart', 'openclaw-gateway.service'],
    describe: 'Restart the openclaw gateway (port 18789) via user-systemd',
  },
  'clear:bot-lock': {
    cmd: 'redis-cli', args: ['-p', '16380', 'del', 'bot:instance_lock'],
    describe: 'Clear the shared Redis bot-instance-lock key on port 16380',
  },
  'clear:opencode-snapshot-locks': {
    cmd: 'bash', args: ['-c', 'rm -f /home/ubuntubox/.local/share/opencode/snapshot/global/*/index.lock'],
    describe: 'Remove stale opencode snapshot git locks (only /home/.../snapshot/global/*/index.lock)',
  },
  'typecheck:api': {
    cmd: 'npm', args: ['run', 'check', '--workspace', '@hermes/api'],
    cwd: '/mnt/Storage/github/hermes-trading-firm',
    timeoutMs: 180_000,
    describe: 'Run tsc --noEmit on @hermes/api to verify TS compile health',
  },
  'journal:commit-snapshot': {
    cmd: 'tilt', args: ['trigger', 'coo-journal-committer'],
    describe: 'Force an immediate COO journal commit + push to GitHub',
  },
};

const SCRIPTS_LOG = path.join(RUNTIME_DIR, 'coo-scripts.jsonl');
const PER_KEY_COOLDOWN_MS = 5 * 60_000;
const GLOBAL_HOUR_CAP = 10;
const DEFAULT_TIMEOUT_MS = 60_000;

const lastRunByKey = new Map<string, number>();
const recentRunTimestamps: number[] = [];

export function listSafeScriptKeys(): string[] {
  return Object.keys(SCRIPTS);
}

export function describeSafeScripts(): string {
  return Object.entries(SCRIPTS)
    .map(([k, s]) => `  - ${k}: ${s.describe}`)
    .join('\n');
}

export async function runSafeScript(key: string, reason: string): Promise<{ ok: boolean; detail: string }> {
  if (!(key in SCRIPTS)) {
    const detail = `unknown script key "${key}". Allowed: ${Object.keys(SCRIPTS).join(', ')}`;
    appendJsonl(SCRIPTS_LOG, { ts: new Date().toISOString(), key, reason, error: detail });
    logger.warn({ key }, 'COO requested unknown script key');
    return { ok: false, detail };
  }

  const now = Date.now();

  const last = lastRunByKey.get(key) ?? 0;
  if (now - last < PER_KEY_COOLDOWN_MS) {
    const remainSec = Math.round((PER_KEY_COOLDOWN_MS - (now - last)) / 1000);
    const detail = `per-key cooldown: ${key} ran ${Math.round((now - last) / 1000)}s ago, ${remainSec}s remaining`;
    appendJsonl(SCRIPTS_LOG, { ts: new Date().toISOString(), key, reason, skipped: 'cooldown', detail });
    logger.info({ key, remainSec }, 'run-script cooldown');
    return { ok: false, detail };
  }

  while (recentRunTimestamps.length > 0 && now - (recentRunTimestamps[0] as number) > 3_600_000) {
    recentRunTimestamps.shift();
  }
  if (recentRunTimestamps.length >= GLOBAL_HOUR_CAP) {
    const detail = `global cap: ${GLOBAL_HOUR_CAP} runs/hour exceeded (${recentRunTimestamps.length} in last hour)`;
    appendJsonl(SCRIPTS_LOG, { ts: new Date().toISOString(), key, reason, skipped: 'cap', detail });
    logger.warn({ count: recentRunTimestamps.length }, 'run-script hour cap hit');
    return { ok: false, detail };
  }

  const spec = SCRIPTS[key as SafeScriptKey];
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  lastRunByKey.set(key, now);
  recentRunTimestamps.push(now);

  logger.info({ key, reason, cmd: spec.cmd, args: spec.args }, 'COO run-script dispatching');

  return new Promise((resolve) => {
    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      logger.warn({ key, timeoutMs }, 'run-script timeout — SIGTERM');
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const entry = {
        ts: new Date().toISOString(),
        key, reason,
        cmd: spec.cmd, args: spec.args, cwd: spec.cwd ?? null,
        exitCode: code,
        stdoutPreview: stdout.slice(0, 800),
        stderrPreview: stderr.slice(0, 800),
      };
      appendJsonl(SCRIPTS_LOG, entry);
      if (code === 0) {
        const firstLine = stdout.split('\n').find((l) => l.trim()) ?? '';
        resolve({ ok: true, detail: `exit 0 — ${firstLine.slice(0, 120)}` });
      } else {
        const detail = `exit ${code} — ${stderr.slice(0, 200).trim() || stdout.slice(0, 200).trim()}`;
        emitFirmError('coo-script-run-error', `Script ${key} failed with exit ${code}`, { scriptKey: key });
        resolve({ ok: false, detail });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const entry = {
        ts: new Date().toISOString(),
        key, reason, error: String(err),
      };
      appendJsonl(SCRIPTS_LOG, entry);
      resolve({ ok: false, detail: `spawn error: ${String(err)}` });
    });
  });
}
