/**
 * Polygon MCP Server — services/openclaw-hermes/mcp-servers/polygon-mcp.ts
 * Port: 7420
 *
 * Wraps Polygon.io REST API as MCP tools:
 *   - get_quote     — latest trade/quote for a ticker
 *   - get_aggregates — OHLCV bars (1min/5min/hour/day)
 *
 * Caches responses in Redis with 30s TTL.
 * Graceful degradation: upstream 5xx → stale cache → null.
 */

import http from 'node:http';
import https from 'node:node:https';
import { cachedFetch, cacheKey, CACHE_TTL_SECONDS, McpServer, jsonRpcSuccess, jsonRpcError } from './base.js';
import { logger } from '@hermes/logger';

const PORT = Number(process.env.MCP_POLYGON_PORT ?? 7420);
const API_KEY = process.env.POLYGON_API_KEY ?? '';
const BASE_URL = 'https://api.polygon.io';

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_quote',
    description: 'Get the latest trade/quote for a ticker from Polygon.io',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, BTC-USD)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_aggregates',
    description: 'Get OHLCV aggregate bars from Polygon.io',
    inputSchema: {
      type: 'object',
      properties: {
        symbol:    { type: 'string', description: 'Ticker symbol' },
        multiplier: { type: 'number', description: 'Multiplier for timespan (default 1)' },
        timespan:   { type: 'string', description: 'minute|hour|day|week|month' },
        from:       { type: 'string', description: 'Start date YYYY-MM-DD' },
        to:         { type: 'string', description: 'End date YYYY-MM-DD' },
        adjusted:   { type: 'boolean', description: 'Whether to use adjusted close (default true)' },
      },
      required: ['symbol', 'timespan', 'from', 'to'],
    },
  },
];

// ── API clients ──────────────────────────────────────────────────────────────

async function polygonFetch<T>(path: string, params: Record<string, string | number | boolean>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('apiKey', API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  return new Promise((resolve, reject) => {
    const req = https.get(url.toString(), { timeout: 15_000 }, (res) => {
      if (!res.statusCode || res.statusCode >= 500) {
        reject(Object.assign(new Error(`Polygon ${res.statusCode}`), { status: res.statusCode }));
        return;
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body) as T); }
        catch { reject(new Error(`Polygon parse error: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Polygon timeout')); });
  });
}

async function getQuote(symbol: string): Promise<unknown> {
  const key = cacheKey('polygon', 'get_quote', { symbol });
  const result = await cachedFetch(key, async () => {
    const data = await polygonFetch<{ results?: unknown[] }>(`/v2/last/trade/${symbol}`, {});
    return data.results?.[0] ?? null;
  });
  return {
    symbol,
    quote: result.data,
    fromCache: result.fromCache,
    cachedAt: result.cachedAt,
    ttlSeconds: CACHE_TTL_SECONDS,
  };
}

async function getAggregates(args: {
  symbol: string;
  multiplier?: number;
  timespan: string;
  from: string;
  to: string;
  adjusted?: boolean;
}): Promise<unknown> {
  const key = cacheKey('polygon', 'get_aggregates', args);
  const result = await cachedFetch(key, async () => {
    const data = await polygonFetch<{ results?: unknown[] }>(
      `/v2/aggs/ticker/${args.symbol}/range/${args.multiplier ?? 1}/${args.timespan}/${args.from}/${args.to}`,
      { adjusted: args.adjusted ?? true },
    );
    return data.results ?? [];
  });
  return {
    symbol: args.symbol,
    bars: result.data,
    fromCache: result.fromCache,
    cachedAt: result.cachedAt,
    ttlSeconds: CACHE_TTL_SECONDS,
  };
}

// ── MCP server interface ──────────────────────────────────────────────────────

const server: McpServer = {
  tools: TOOLS,

  async handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'get_quote':     return getQuote(String(args['symbol']));
      case 'get_aggregates': return getAggregates(args as Parameters<typeof getAggregates>[0]);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  },
};

// ── HTTP transport ───────────────────────────────────────────────────────────
// MCP over HTTP/JSON-RPC 2.0. Clients POST to /rpc with a tools/call request.

function buildResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const mcpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    return buildResponse(res, 200, { status: 'ok', server: 'polygon-mcp', port: PORT });
  }

  // MCP tool list
  if (url.pathname === '/tools') {
    return buildResponse(res, 200, { tools: server.tools });
  }

  // JSON-RPC endpoint
  if (url.pathname === '/rpc' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        const reqBody = JSON.parse(raw);
        const { method, params, id } = reqBody;

        if (method === 'tools/call') {
          const { name, arguments: toolArgs = {} } = params ?? {};
          const result = await server.handleTool(name, toolArgs as Record<string, unknown>);
          return buildResponse(res, 200, jsonRpcSuccess(id, result));
        }

        if (method === 'tools/list') {
          return buildResponse(res, 200, jsonRpcSuccess(id, { tools: server.tools }));
        }

        return buildResponse(res, 200, jsonRpcError(id, -32601, `Method not found: ${method}`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'polygon-mcp: RPC error');
        try {
          const reqBody = JSON.parse(raw);
          return buildResponse(res, 200, jsonRpcError(reqBody?.id ?? null, -32603, `Internal error: ${msg}`));
        } catch {
          return buildResponse(res, 400, { error: 'parse error' });
        }
      }
    });
    return;
  }

  buildResponse(res, 404, { error: 'Not found' });
});

mcpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'polygon-mcp: listening');
});

mcpServer.on('error', (err) => {
  logger.error({ err }, 'polygon-mcp: server error');
});

export { server };
