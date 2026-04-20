// ACP (Agent Client Protocol) bridge to openclaw — phase-2 scaffold.
//
// Current bridge spawns `openclaw agent --local` per tick (~30s node bootstrap cost per call).
// ACP gives us a persistent WebSocket session to the openclaw gateway with structured tool
// calls, cutting per-turn overhead and enabling tool-use instead of prompt-stuffing.
//
// Enabled via env: OPENCLAW_HERMES_USE_ACP=1.
// Default is OFF — the existing spawn-based askCoo() in openclaw-client.ts is the live path.
// This file is a scaffold: exports a typed interface + stub that currently falls back to the
// spawn-based path. Implementation is phase-2 scope (200-300 line rewrite).
//
// When implemented, this module should:
// 1. Spawn `openclaw acp --session agent:main:hermes-bridge` once at bridge startup.
// 2. Keep the child's stdin/stdout pipes open; speak JSON-RPC over them.
// 3. Expose askCooAcp(events, rollingContext) that sends a `agent.turn` request + awaits reply.
// 4. Handle reconnect on child exit (openclaw acp occasionally restarts the embedded gateway).
// 5. Register firm-side tools (getBrokerHealth, getJournalForSymbol, getPnlAttribution)
//    so the COO can pull context on demand instead of us prefetching 10 endpoints/tick.

import type { CooResponse } from './openclaw-client.js';

export const USE_ACP = process.env.OPENCLAW_HERMES_USE_ACP === '1';

/**
 * Placeholder ACP client. Returns null so the caller falls through to the spawn-based path.
 * When the phase-2 rewrite lands, this replaces the child_process.spawn flow in askCoo().
 */
export async function askCooAcp(_events: unknown[], _rollingContext: unknown): Promise<CooResponse | null> {
  // Not implemented yet — caller should fall back to the spawn-based askCoo.
  return null;
}

/**
 * Gracefully close the ACP connection. No-op until phase-2.
 */
export async function closeAcp(): Promise<void> {
  /* no-op */
}
