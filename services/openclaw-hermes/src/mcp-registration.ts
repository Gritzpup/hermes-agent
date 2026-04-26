/**
 * MCP Registration — services/openclaw-hermes/src/mcp-registration.ts
 *
 * On bridge startup, registers each MCP data server with the OpenClaw gateway
 * at loopback :18789 using the gateway's MCP registration HTTP API.
 *
 * Registration is idempotent (re-registering the same server is a no-op on
 * the gateway side) and re-runnable. If the gateway is unreachable, we log
 * a warning and continue — do NOT block bridge startup.
 *
 * OpenClaw gateway registration endpoint:
 *   POST http://localhost:18789/api/mcp/servers
 *   Body: { id, name, transport: 'http', url: 'http://localhost:7420' }
 *
 * See: openclaw-client.ts pattern for gateway token injection.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@hermes/logger';
import { MCP_SERVERS, type McpServerEntry } from '../mcp-servers/index.js';
import { OPENCLAW_GATEWAY_URL } from './config.js';

const GATEWAY_URL = OPENCLAW_GATEWAY_URL;
const REGISTRATION_ENDPOINT = `${GATEWAY_URL}/api/mcp/servers`;

// ── Gateway token loader (same pattern as acp-client.ts) ─────────────────────

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

const GATEWAY_AUTH_TOKEN: string | null = loadGatewayToken();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function gatewayRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = `${GATEWAY_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (GATEWAY_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${GATEWAY_AUTH_TOKEN}`;
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
      signal: AbortSignal.timeout(10_000),
    });
    let resBody: unknown;
    try { resBody = await res.json(); } catch { resBody = null; }
    return { ok: res.ok, status: res.status, body: resBody };
  } catch (err) {
    logger.warn({ err, url }, 'mcp-registration: gateway request failed');
    return { ok: false, status: 0, body: null };
  }
}

// ── Per-server registration ──────────────────────────────────────────────────

async function registerServer(srv: McpServerEntry): Promise<void> {
  const payload = {
    id: `hermes-${srv.name}`,
    name: srv.name,
    transport: 'http',
    url: `http://localhost:${srv.port}`,
  };

  const result = await gatewayRequest('POST', '/api/mcp/servers', payload);

  if (result.ok) {
    logger.info({ server: srv.name, port: srv.port }, 'mcp-registration: registered');
  } else if (result.status === 409) {
    // Already registered — idempotent, not an error
    logger.debug({ server: srv.name }, 'mcp-registration: already registered (409)');
  } else {
    logger.warn(
      { server: srv.name, port: srv.port, status: result.status, body: result.body },
      'mcp-registration: unexpected response — server may not be registered',
    );
  }
}

// ── Public: register all MCP servers ─────────────────────────────────────────

/**
 * Register all MCP data servers with the OpenClaw gateway.
 * Idempotent and non-blocking — gateway errors are logged but do not throw.
 */
export async function registerAllMcpServers(): Promise<void> {
  logger.info({ count: MCP_SERVERS.length }, 'mcp-registration: starting');

  const results = await Promise.allSettled(MCP_SERVERS.map(registerServer));
  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    logger.warn({ failures: failures.length }, 'mcp-registration: some servers failed to register');
  } else {
    logger.info({ count: MCP_SERVERS.length }, 'mcp-registration: all servers registered');
  }
}

/**
 * Unregister all MCP data servers from the gateway.
 * Called on graceful bridge shutdown.
 */
export async function unregisterAllMcpServers(): Promise<void> {
  logger.info('mcp-registration: unregistering all');

  await Promise.allSettled(
    MCP_SERVERS.map(async (srv) => {
      await gatewayRequest('DELETE', `/api/mcp/servers/hermes-${srv.name}`);
      logger.info({ server: srv.name }, 'mcp-registration: unregistered');
    }),
  );
}
