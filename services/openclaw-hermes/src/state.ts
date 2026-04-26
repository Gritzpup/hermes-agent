import fs from 'node:fs';
import { RUNTIME_DIR, SEEN_EVENTS_FILE } from './config.js';

export function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

const seen = new Set<string>();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(SEEN_EVENTS_FILE)) return;
  const lines = fs.readFileSync(SEEN_EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.key === 'string') seen.add(obj.key);
    } catch {}
  }
}

export function hasSeen(key: string): boolean {
  load();
  return seen.has(key);
}

export function markSeen(key: string, meta: Record<string, unknown> = {}) {
  load();
  if (seen.has(key)) return;
  seen.add(key);
  fs.appendFileSync(SEEN_EVENTS_FILE, JSON.stringify({ key, seenAt: new Date().toISOString(), ...meta }) + '\n');
}

export function appendJsonl(file: string, entry: Record<string, unknown>) {
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}
