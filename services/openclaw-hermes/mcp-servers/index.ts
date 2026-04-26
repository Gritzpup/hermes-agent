/**
 * MCP Server Registry — services/openclaw-hermes/mcp-servers/index.ts
 *
 * Lists all 5 MCP data servers with their ports and tool summaries.
 * Import this file to get a list of all servers for auto-discovery / health checks.
 */

export interface McpServerEntry {
  name: string;
  port: number;
  envVar: string;
  description: string;
  tools: string[];
  /** Import specifier for the server module (used by the Tilt runner) */
  module: string;
}

export const MCP_SERVERS: McpServerEntry[] = [
  {
    name: 'polygon-mcp',
    port: 7420,
    envVar: 'MCP_POLYGON_PORT',
    description: 'Polygon.io — real-time quotes, OHLCV aggregates',
    tools: ['get_quote', 'get_aggregates'],
    module: './polygon-mcp.js',
  },
  {
    name: 'finnhub-mcp',
    port: 7421,
    envVar: 'MCP_FINNHUB_PORT',
    description: 'Finnhub — real-time quotes, company news',
    tools: ['get_quote', 'get_company_news'],
    module: './finnhub-mcp.js',
  },
  {
    name: 'tradingeconomics-mcp',
    port: 7422,
    envVar: 'MCP_TRADINGECONOMICS_PORT',
    description: 'Trading Economics — economic calendar events',
    tools: ['get_economic_events'],
    module: './tradingeconomics-mcp.js',
  },
  {
    name: 'fmp-mcp',
    port: 7423,
    envVar: 'MCP_FMP_PORT',
    description: 'Financial Modeling Prep — fundamentals, financial ratios',
    tools: ['get_fundamentals', 'get_ratios'],
    module: './fmp-mcp.js',
  },
  {
    name: 'twelvedata-mcp',
    port: 7424,
    envVar: 'MCP_TWELVEDATA_PORT',
    description: 'Twelve Data — OHLCV time series',
    tools: ['get_time_series'],
    module: './twelvedata-mcp.js',
  },
];

/**
 * Health check all MCP servers.
 * Returns a map of server name → { ok, latencyMs, error? }.
 */
export async function healthCheckAll(): Promise<Record<string, { ok: boolean; latencyMs: number; error?: string }>> {
  const results: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};

  await Promise.allSettled(
    MCP_SERVERS.map(async (srv) => {
      const start = Date.now();
      try {
        const res = await fetch(`http://localhost:${srv.port}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        results[srv.name] = {
          ok: res.ok,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        results[srv.name] = {
          ok: false,
          latencyMs: Date.now() - start,
          error: String(err),
        };
      }
    }),
  );

  return results;
}
