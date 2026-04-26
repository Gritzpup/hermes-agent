/**
 * Financial Modeling Prep MCP Server — services/openclaw-hermes/mcp-servers/fmp-mcp.ts
 * Port: 7423
 *
 * Wraps Financial Modeling Prep REST API as MCP tools:
 *   - get_fundamentals — income statement, balance sheet, cash flow
 *   - get_ratios       — valuation, profitability, liquidity ratios
 *
 * Caches responses in Redis with 30s TTL.
 * Graceful degradation: upstream 5xx → stale cache → null.
 */

import http from 'node:http';
import https from 'node:https';
import { cachedFetch, cacheKey, CACHE_TTL_SECONDS, McpServer, jsonRpcSuccess, jsonRpcError } from './base.js';
import { logger } from '@hermes/logger';

const PORT = Number(process.env.MCP_FMP_PORT ?? 7423);
const API_KEY = process.env.FMP_API_KEY ?? '';
const BASE_URL = 'https://financialmodelingprep.com/api/v3';

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_fundamentals',
    description: 'Get financial statements (income, balance sheet, cash flow) from FMP',
    inputSchema: {
      type: 'object',
      properties: {
        symbol:     { type: 'string', description: 'Ticker symbol (e.g. AAPL)' },
        statement:  { type: 'string', description: 'income-statement | balance-sheet-statement | cash-flow-statement | all' },
        period:     { type: 'string', description: 'annual | quarter (default annual)' },
        limit:      { type: 'number', description: 'Number of periods (default 5)' },
      },
      required: ['symbol', 'statement'],
    },
  },
  {
    name: 'get_ratios',
    description: 'Get financial ratios from Financial Modeling Prep',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol' },
        period: { type: 'string', description: 'annual | quarter (default annual)' },
        limit:  { type: 'number', description: 'Number of periods (default 5)' },
      },
      required: ['symbol'],
    },
  },
];

// ── API client ───────────────────────────────────────────────────────────────

async function fmpFetch<T>(path: string): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('apikey', API_KEY);

  return new Promise((resolve, reject) => {
    https.get(url.toString(), { timeout: 15_000 }, (res) => {
      if (!res.statusCode || res.statusCode >= 500) {
        reject(Object.assign(new Error(`FMP ${res.statusCode}`), { status: res.statusCode }));
        return;
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body) as T); }
        catch { reject(new Error(`FMP parse error: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function getFundamentals(args: {
  symbol: string;
  statement: string;
  period?: string;
  limit?: number;
}): Promise<unknown> {
  const key = cacheKey('fmp', 'get_fundamentals', args);
  const result = await cachedFetch(key, async () => {
    if (args.statement === 'all') {
      const [income, balance, cashflow] = await Promise.all([
        fmpFetch<unknown[]>(`/income-statement/${args.symbol}?period=${args.period ?? 'annual'}&limit=${args.limit ?? 5}`),
        fmpFetch<unknown[]>(`/balance-sheet-statement/${args.symbol}?period=${args.period ?? 'annual'}&limit=${args.limit ?? 5}`),
        fmpFetch<unknown[]>(`/cash-flow-statement/${args.symbol}?period=${args.period ?? 'annual'}&limit=${args.limit ?? 5}`),
      ]);
      return { incomeStatement: income, balanceSheet: balance, cashFlowStatement: cashflow };
    }
    const data = await fmpFetch<unknown[]>(`/${args.statement}/${args.symbol}?period=${args.period ?? 'annual'}&limit=${args.limit ?? 5}`);
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

async function getRatios(args: { symbol: string; period?: string; limit?: number }): Promise<unknown> {
  const key = cacheKey('fmp', 'get_ratios', args);
  const result = await cachedFetch(key, async () => {
    const data = await fmpFetch<unknown[]>(`/ratios/${args.symbol}?period=${args.period ?? 'annual'}&limit=${args.limit ?? 5}`);
    return data;
  });
  return {
    symbol: args.symbol,
    ratios: result.data,
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
      case 'get_fundamentals': return getFundamentals(args as Parameters<typeof getFundamentals>[0]);
      case 'get_ratios':       return getRatios(args as Parameters<typeof getRatios>[0]);
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
    return buildResponse(res, 200, { status: 'ok', server: 'fmp-mcp', port: PORT });
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
        logger.error({ err }, 'fmp-mcp: RPC error');
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

srv.listen(PORT, () => { logger.info({ port: PORT }, 'fmp-mcp: listening'); });
srv.on('error', (err) => { logger.error({ err }, 'fmp-mcp: server error'); });

export { server };
