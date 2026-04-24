/**
 * MiniMax client for CFO LLM analysis.
 * CFO arithmetic runs first, then MiniMax provides strategic financial insight.
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const SYSTEM_PROMPT = `You are the CFO (Chief Financial Officer) of a trading firm running a live paper trading operation.
You receive arithmetic metrics (P&L, win rates, drawdown, expectancy) computed from the trading journal.
Your job is to provide sharp, specific financial analysis in plain English.

Return a JSON object with these fields:
{
  "verdict": "bullish" | "neutral" | "bearish" — overall firm financial health
  "key_concerns": [string] — top 2-3 issues requiring capital protection
  "allocation_signal": "increase" | "hold" | "reduce" — capital deployment guidance
  "tail_risk": string — primary downside scenario if conditions deteriorate
  "stride_summary": string — one sentence on firm velocity and health
}

Be concise. No hedging. No boilerplate. Only output JSON.`;

export async function askCfoAnalysis(metrics: {
  firmPnl: number;
  firmWr: number;
  firmDrawdownPct: number;
  totalTrades: number;
  lanes: Array<{lane: string; pnl: number; wr: number; trades: number; avgPerTrade: number}>;
  alerts: string[];
}): Promise<{
  verdict: string;
  key_concerns: string[];
  allocation_signal: string;
  tail_risk: string;
  stride_summary: string;
} | null> {
  const apiKey = process.env.MINIMAX_CFO_API_KEY ?? process.env.KIMI_API_KEY ?? '';
  const baseUrl = process.env.MINIMAX_CFO_BASE_URL ?? 'https://api.minimax.io/anthropic';
  const model = process.env.MINIMAX_CFO_MODEL ?? 'MiniMax-M2.7';

  if (!apiKey) {
    // No API key — skip LLM layer, return neutral
    return null;
  }

  const lanesMd = metrics.lanes
    .map(l => `- ${l.lane}: $${l.pnl.toFixed(2)}, ${l.wr.toFixed(1)}% WR, ${l.trades} trades, $${l.avgPerTrade.toFixed(2)}/trade`)
    .join('\n');

  const userContent = `FIRM ARITHMETIC:
- NAV: paper (starting $100K)
- Total P&L: $${metrics.firmPnl.toFixed(2)}
- Firm Win Rate: ${metrics.firmWr.toFixed(1)}%
- Firm Drawdown: ${metrics.firmDrawdownPct.toFixed(2)}%
- Total Trades: ${metrics.totalTrades}

LANE BREAKDOWN:
${lanesMd}

ALERTS (from arithmetic checks):
${metrics.alerts.map(a => `- ${a}`).join('\n')}

Respond with ONLY a JSON object matching the schema. No markdown fences.`;

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ] as ChatMessage[],
    temperature: 0.2,
    max_tokens: 8000,
  };

  const normalizedBase = baseUrl.replace(/\/$/, '').replace(/(\/v1)$/, '');
  const url = `${normalizedBase}/v1/chat/completions`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      console.warn(`[CFO MiniMax] API error ${res.status}`);
      return null;
    }

    const data = await res.json() as { choices?: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content ?? '';

    // Extract JSON
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn('[CFO MiniMax] No JSON in response');
      return null;
    }

    return JSON.parse(match[0]) as ReturnType<typeof askCfoAnalysis> extends Promise<infer T | null> ? T : never;
  } catch (err) {
    console.warn(`[CFO MiniMax] Request failed: ${err}`);
    return null;
  }
}
