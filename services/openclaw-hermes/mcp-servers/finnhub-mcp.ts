/**
 * Finnhub MCP Server — services/openclaw-hermes/mcp-servers/finnhub-mcp.ts
 * Port: 7421
 *
 * Wraps Finnhub REST API as MCP tools:
 *   - get_quote     — real-time quote
 *   - get_company_news — company news for a symbol
 *
 * Caches responses in Redis with 30s TTL.
 * Graceful degradation: upstream 5xx → stale cache → null.
 */

import http from 'node:http';
import { cachedFetch, cacheKey, CACHE_TTL_SECONDS, McpServer, jsonRpcSuccess, jsonRpcError } from './base.js';
import { logger } from '@hermes/logger';

const PORT = Number(process.env.MCP_FINNHUB_PORT ?? 7421);
const API_KEY = process.env.FINNHUB_API_KEY ?? '';
const BASE_URL = 'https://finnhub.io/api/v1';

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_quote',
    description: 'Get real-time quote for a ticker from Finnhub',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, AMZN)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_company_news',
    description: 'Get company news for a symbol from Finnhub',
    inputSchema: {
      type: 'object',
      properties: {
        symbol:    { type: 'string', description: 'Ticker symbol' },
        from:      { type: 'string', description: 'Start date YYYY-MM-DD' },
        to:        { type: 'string', description: 'End date YYYY-MM-DD' },
        category:  { type: 'string', description: 'News category (general, forex, crypto, merger)' },
      },
      required: ['symbol', 'from', 'to'],
    },
  },
];

// ── API client ───────────────────────────────────────────────────────────────

async function finnhubFetch<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('token', API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  return new Promise((resolve, reject) => {
    http.get(url.toString(), { timeout: 15_000 }, (res) => {
      if (!res.statusCode || res.statusCode >= 500) {
        reject(Object.assign(new Error(`Finnhub ${res.statusCode}`), { status: res.statusCode }));
        return;
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body) as T); }
        catch { reject(new Error(`Finnhub parse error: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function getQuote(symbol: string): Promise<unknown> {
  const key = cacheKey('finnhub', 'get_quote', { symbol });
  const result = await cachedFetch(key, async () => {
    const data = await finnhubFetch<Record<string, unknown>>(`/quote?symbol=${symbol}`, {});
    return data;
  });
  return {
    symbol,
    quote: result.data,
    fromCache: result.fromCache,
    cachedAt: result.cachedAt,
    ttlSeconds: CACHE_TTL_SECONDS,
  };
}

async function getCompanyNews(args: { symbol: string; from: string; to: string; category?: string }): Promise<unknown> {
  const key = cacheKey('finnhub', 'get_company_news', args);
  const result = await cachedFetch(key, async () => {
    const params: Record<string, string> = { symbol: args.symbol, from: args.from, to: args.to };
    if (args.category) params['category'] = args.category;
    const data = await finnhubFetch<unknown[]>('/news', params);
    return data;
  });
  return {
    symbol: args.symbol,
    articles: result.data,
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
      case 'get_quote':         return getQuote(String(args['symbol']));
      case 'get_company_news':  return getCompanyNews(args as Parameters<typeof getCompanyNews>[0]);
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
    return buildResponse(res, 200, { status: 'ok', server: 'finnhub-mcp', port: PORT });
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
        logger.error({ err }, 'finnhub-mcp: RPC error');
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

srv.listen(PORT, () => { logger.info({ port: PORT }, 'finnhub-mcp: listening'); });
srv.on('error', (err) => { logger.error({ err }, 'finnhub-mcp: server error'); });

export { server };
