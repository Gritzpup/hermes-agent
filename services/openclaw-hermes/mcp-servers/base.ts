/**
 * Shared utilities for MCP data servers.
 * Provides Redis-cached fetch + graceful degradation.
 */

import { redis } from '@hermes/infra';
import { createHash } from 'node:crypto';
import { logger } from '@hermes/logger';

// ── Cache TTL ─────────────────────────────────────────────────────────────────

export const CACHE_TTL_SECONDS = 30;

// ── Cache key helper ──────────────────────────────────────────────────────────

export function cacheKey(server: string, tool: string, args: Record<string, unknown>): string {
  const argHash = createHash('sha256')
    .update(JSON.stringify(args))
    .digest('hex')
    .slice(0, 12);
  return `mcp:${server}:${tool}:${argHash}`;
}

// ── Cached fetch ──────────────────────────────────────────────────────────────

export interface FetchResult<T> {
  data: T | null;
  fromCache: boolean;
  cachedAt?: number;
}

/**
 * Fetch from upstream with Redis cache (30s TTL).
 * On upstream 5xx: return last cached value if available; else null.
 */
export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<FetchResult<T>> {
  // Check cache first
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as { data: T; cachedAt: number };
      logger.debug({ key }, 'mcp-cache: hit');
      return { data: parsed.data, fromCache: true, cachedAt: parsed.cachedAt };
    }
  } catch {
    // Redis unavailable — proceed to fetch
  }

  // Fetch from upstream
  try {
    const data = await fetcher();

    // Cache successful response
    try {
      await redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify({ data, cachedAt: Date.now() }));
    } catch {
      /* non-fatal */
    }

    return { data, fromCache: false };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const is5xx = typeof status === 'number' && status >= 500 && status < 600;

    if (is5xx) {
      logger.warn({ key, status }, 'mcp-cache: upstream 5xx — attempting stale cache');
      try {
        const stale = await redis.get(key);
        if (stale) {
          const parsed = JSON.parse(stale) as { data: T; cachedAt: number };
          logger.info({ key, cachedAt: parsed.cachedAt }, 'mcp-cache: returning stale value');
          return { data: parsed.data, fromCache: true, cachedAt: parsed.cachedAt };
        }
      } catch {
        /* Redis also unavailable */
      }
    }

    logger.error({ key, err }, 'mcp-cache: upstream fetch failed, returning null');
    return { data: null, fromCache: false };
  }
}

// ── MCP HTTP server skeleton ──────────────────────────────────────────────────

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServer {
  tools: McpTool[];
  handleTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function jsonRpcSuccess(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
