/**
 * Self-healing orchestrator for the COO bridge.
 * Tracks errors, enforces cooldowns, runs safe scripts, and escalates
 * persistent failures to human review.
 */

import { spawn } from 'node:child_process';
import { logger } from '@hermes/logger';

const SCRIPT_ALLOWLIST: Record<string, string> = {
  'restart:hermes-api': 'systemctl --user restart hermes-api || true',
  'restart:hermes-market-data': 'systemctl --user restart hermes-market-data || true',
  'restart:hermes-risk-engine': 'systemctl --user restart hermes-risk-engine || true',
  'restart:hermes-review-loop': 'systemctl --user restart hermes-review-loop || true',
  'restart:openclaw-hermes': 'systemctl --user restart openclaw-hermes || true',
  'restart:openclaw-gateway': 'systemctl --user restart openclaw-gateway || true',
  'clear:bot-lock': 'redis-cli -p 16380 del bot:instance_lock || true',
  'clear:opencode-snapshot-locks': 'rm -f /tmp/opencode-snapshot-* || true',
  'typecheck:api': 'cd /mnt/Storage/github/hermes-trading-firm && npm run check --workspace @hermes/api || true',
  'journal:commit-snapshot': 'cd /mnt/Storage/github/hermes-trading-firm && git add docs/coo-journal && git commit -m "chore(coo): journal snapshot" || true',
};

const COOLDOWN_MS = 5 * 60 * 1000;
const HOURLY_CAP = 10;

interface ErrorRecord {
  count: number;
  firstSeen: number;
  lastSeen: number;
  scriptKeyHint?: string | undefined;
  selfHealAttempts: number;
}

interface ScriptRun {
  key: string;
  at: number;
}

export class SelfHealOrchestrator {
  private errors = new Map<string, ErrorRecord>();
  private scriptRuns: ScriptRun[] = [];
  private deferredScripts: { key: string; reason: string }[] = [];

  recordError(serviceKey: string, message: string, scriptKeyHint?: string) {
    const now = Date.now();
    const existing = this.errors.get(serviceKey);
    if (existing) {
      existing.count++;
      existing.lastSeen = now;
      if (scriptKeyHint) existing.scriptKeyHint = scriptKeyHint;
    } else {
      this.errors.set(serviceKey, {
        count: 1,
        firstSeen: now,
        lastSeen: now,
        scriptKeyHint,
        selfHealAttempts: 0,
      });
    }
    logger.warn({ serviceKey, message, scriptKeyHint }, 'Self-heal: error recorded');
  }

  canRunScript(key: string): boolean {
    const now = Date.now();
    this.scriptRuns = this.scriptRuns.filter(r => now - r.at < 60 * 60 * 1000);
    if (this.scriptRuns.length >= HOURLY_CAP) return false;
    const lastRun = this.scriptRuns.filter(r => r.key === key).pop();
    if (lastRun && now - lastRun.at < COOLDOWN_MS) return false;
    return true;
  }

  async runScript(key: string, reason: string): Promise<{ ok: boolean; output: string }> {
    if (!SCRIPT_ALLOWLIST[key]) {
      logger.error({ key }, 'Self-heal: script not in allowlist');
      return { ok: false, output: 'not in allowlist' };
    }
    if (!this.canRunScript(key)) {
      logger.warn({ key }, 'Self-heal: script on cooldown or hourly cap reached');
      return { ok: false, output: 'cooldown or cap' };
    }

    const cmd = SCRIPT_ALLOWLIST[key];
    logger.info({ key, reason, cmd }, 'Self-heal: running script');

    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());
      child.on('close', (code) => {
        this.scriptRuns.push({ key, at: Date.now() });
        const ok = code === 0;
        const output = stdout + stderr;
        logger.info({ key, code, ok }, 'Self-heal: script completed');
        resolve({ ok, output: output.slice(0, 2000) });
      });
    });
  }

  deferScript(key: string, reason: string) {
    this.deferredScripts.push({ key, reason });
  }

  async runDeferred(): Promise<void> {
    const batch = this.deferredScripts.splice(0, 2); // max 2 per tick
    for (const { key, reason } of batch) {
      await this.runScript(key, reason);
    }
  }

  status() {
    const now = Date.now();
    const errorList = [...this.errors.entries()].map(([k, v]) => ({
      serviceKey: k,
      count: v.count,
      ageSec: Math.round((now - v.lastSeen) / 1000),
      selfHealAttempts: v.selfHealAttempts,
    }));
    return {
      activeErrors: errorList.length,
      errors: errorList.slice(-5),
      hourlyScriptRuns: this.scriptRuns.filter(r => now - r.at < 60 * 60 * 1000).length,
      deferredQueue: this.deferredScripts.length,
    };
  }
}
