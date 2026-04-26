/**
 * Trading Economics MCP Server — services/openclaw-hermes/mcp-servers/tradingeconomics-mcp.ts
 * Port: 7422
 *
 * Wraps Trading Economics API as MCP tools:
 *   - get_economic_events — economic calendar events
 *
 * Caches responses in Redis with 30s TTL.
 * Graceful degradation: upstream 5xx → stale cache → null.
 */

import http from 'node:http';
import { cachedFetch, cacheKey, CACHE_TTL_SECONDS, McpServer, jsonRpcSuccess, jsonRpcError } from './base.js';
import { logger } from '@hermes/logger';

const PORT = Number(process.env.MCP_TRADINGECONOMICS_PORT ?? 7422);
const API_KEY = process.env.TRADING_ECONOMICS_API_KEY ?? '';
const BASE_URL = 'https://api.tradingeconomics.com';

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_economic_events',
    description: 'Get economic calendar events from Trading Economics',
    inputSchema: {
      type: 'object',
      properties: {
        country:    { type: 'string', description: 'Country code or name (e.g. US, UK, CHINA)' },
        indicator:  { type: 'string', description: 'Indicator (e.g. inflation, gdp, interest-rate)' },
        from:       { type: 'string', description: 'Start date YYYY-MM-DD' },
        to:         { type: 'string', description: 'End date YYYY-MM-DD' },
        pageSize:   { type: 'number', description: 'Number of results (default 100)' },
      },
      required: ['from', 'to'],
    },
  },
];

// ── API client ───────────────────────────────────────────────────────────────

async function teFetch<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  // Trading Economics uses ?c=API_KEY format
  url.searchParams.set('c', API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  return new Promise((resolve, reject) => {
    http.get(url.toString(), { timeout: 15_000 }, (res) => {
      if (!res.statusCode || res.statusCode >= 500) {
        reject(Object.assign(new Error(`TradingEconomics ${res.statusCode}`), { status: res.statusCode }));
        return;
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body) as T); }
        catch { reject(new Error(`TradingEconomics parse error: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function getEconomicEvents(args: {
  country?: string;
  indicator?: string;
  from: string;
  to: string;
  pageSize?: number;
}): Promise<unknown> {
  const key = cacheKey('tradingeconomics', 'get_economic_events', args);
  const result = await cachedFetch(key, async () => {
    const params: Record<string, string | number> = { from: args.from, to: args.to };
    if (args.country) params['country'] = args.country;
    if (args.indicator) params['indicator'] = args.indicator;
    if (args.pageSize) params['page-size'] = args.pageSize;
    const data = await teFetch<unknown[]>('/calendar', params);
    return data;
  });
  return {
    events: result.data,
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
      case 'get_economic_events': return getEconomicEvents(args as Parameters<typeof getEconomicEvents>[0]);
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
    return buildResponse(res, 200, { status: 'ok', server: 'tradingeconomics-mcp', port: PORT });
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
        logger.error({ err }, 'tradingeconomics-mcp: RPC error');
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

srv.listen(PORT, () => { logger.info({ port: PORT }, 'tradingeconomics-mcp: listening'); });
srv.on('error', (err) => { logger.error({ err }, 'tradingeconomics-mcp: server error'); });

export { server };
