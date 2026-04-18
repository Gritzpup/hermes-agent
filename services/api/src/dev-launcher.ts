/**
 * dev-launcher.ts — Proper signal-forwarding launcher for tsx watch.
 *
 * Problem: running `tsx watch …` via npm scripts leaves orphaned tsx
 * sub-processes when SIGTERM arrives (Tilt's restart cadence).
 * Solution: use `exec tsx watch …` so tsx replaces the node process.
 * This launcher is kept for backward compat; its sole job is to
 * forward termination signals to tsx then exit cleanly.
 *
 * Invoked from package.json as: exec tsx watch src/index.ts
 * (package.json dev script now uses exec directly — this file is unused
 * but retained as the approved signal-handler pattern).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Locate tsx in the api workspace node_modules
const tsxPath = join(__dirname, '..', 'node_modules', '.bin', 'tsx');

const child = spawn(tsxPath, ['watch', join(__dirname, 'index.ts')], {
  stdio: 'inherit',
  detached: false,
});

// Forward all termination signals to tsx then exit immediately.
// This ensures tsx receives SIGTERM the instant Tilt sends it,
// preventing orphaned watch processes from accumulating.
const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
for (const sig of signals) {
  process.on(sig, () => {
    child.kill(sig);
    process.exit(1);
  });
}

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
