/**
 * Twelve Data MCP Server — services/openclaw-hermes/mcp-servers/twelvedata-mcp.ts
 * Port: 7424
 *
 * Wraps Twelve Data REST API as MCP tools:
 *   - get_time_series — OHLCV time series data
 *
 * Caches responses in Redis with 30s TTL.
 * Graceful degradation: upstream 5xx → stale cache → null.
 */

import https from 'node:https';
import { cachedFetch, cacheKey, CACHE_TTL_SECONDS, McpServer, jsonRpcSuccess, jsonRpcError } from './base.js';
import { logger } from '@hermes/logger';
import http from 'node:http';

const PORT = Number(process.env.MCP_TWELVEDATA_PORT ?? 7424);
const API_KEY = process.env.TWELVE_DATA_API_KEY ?? '';
const BASE_URL = 'https://api.twelvedata.com';

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_time_series',
    description: 'Get OHLCV time series data from Twelve Data',
    inputSchema: {
      type: 'object',
      properties: {
        symbol:     { type: 'string', description: 'Ticker symbol (e.g. AAPL, BTC/USD)' },
        interval:   { type: 'string', description: '1min|5min|15min|1h|4h|1day|1week' },
        outputsize: { type: 'number', description: 'Number of data points (default 30, max 5000)' },
        format:     { type: 'string', description: 'json | csv (default json)' },
        order:      { type: 'string', description: 'asc | desc (default desc)' },
      },
      required: ['symbol', 'interval'],
    },
  },
];

// ── API client ───────────────────────────────────────────────────────────────

async function twelveDataFetch<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('apikey', API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  return new Promise((resolve, reject) => {
    https.get(url.toString(), { timeout: 15_000 }, (res) => {
      if (!res.statusCode || res.statusCode >= 500) {
        reject(Object.assign(new Error(`TwelveData ${res.statusCode}`), { status: res.statusCode }));
        return;
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body) as T); }
        catch { reject(new Error(`TwelveData parse error: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function getTimeSeries(args: {
  symbol: string;
  interval: string;
  outputsize?: number;
  format?: string;
  order?: string;
}): Promise<unknown> {
  const key = cacheKey('twelvedata', 'get_time_series', args);
  const result = await cachedFetch(key, async () => {
    const params: Record<string, string | number> = {
      symbol: args.symbol,
      interval: args.interval,
      outputsize: args.outputsize ?? 30,
      format: args.format ?? 'json',
    };
    if (args.order) params['order'] = args.order;
    const data = await twelveDataFetch<unknown>('/time_series', params);
    return data;
  });
  return {
    symbol: args.symbol,
    data: result.data,
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
      case 'get_time_series': return getTimeSeries(args as Parameters<typeof getTimeSeries>[0]);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  },
};

// ── HTTP transport ───────────────────────────────────────────────────────────

function buildResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    return buildResponse(res, 200, { status: 'ok', server: 'twelvedata-mcp', port: PORT });
  }
  if (url.pathname === '/tools') {
    return buildResponse(res, 200, { tools: server.tools });
  }
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
        logger.error({ err }, 'twelvedata-mcp: RPC error');
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

srv.listen(PORT, () => { logger.info({ port: PORT }, 'twelvedata-mcp: listening'); });
srv.on('error', (err) => { logger.error({ err }, 'twelvedata-mcp: server error'); });

export { server };
