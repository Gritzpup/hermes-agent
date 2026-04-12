/**
 * Terminal Snapshot Builder
 *
 * Builds the terminal pane data for the dashboard.
 * Extracted from index.ts to reduce file size.
 */

import type { TerminalSnapshot } from '@hermes/contracts';
import { compactTerminalLines, fetchJson, previewText, asString, round } from './helpers.js';

export interface TerminalDeps {
  paperEngine: { getSnapshot: () => any; getJournal: () => any[]; getMarketSnapshots: () => any };
  aiCouncil: { getTraces: (n: number) => any[] };
  marketIntelUrl: string;
  newsIntelUrl: string;
  marketDataUrl: string;
  riskEngineUrl: string;
  brokerRouterUrl: string;
  reviewLoopUrl: string;
  backtestUrl: string;
  strategyLabUrl: string;
}

function buildTerminalPane(
  id: string,
  label: string,
  status: 'healthy' | 'warning' | 'critical',
  summary: string,
  lines: Array<string | null | undefined>
): TerminalSnapshot['terminals'][number] {
  return {
    id,
    label,
    status,
    summary,
    lines: compactTerminalLines(lines)
  };
}

export function buildTerminalFallbackSnapshot(error: unknown): TerminalSnapshot {
  return {
    asOf: new Date().toISOString(),
    terminals: [
      buildTerminalPane('error', 'Error', 'critical', formatError(error), [formatError(error)])
    ]
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

export async function buildTerminalSnapshot(deps: TerminalDeps): Promise<TerminalSnapshot> {
  try {
    const desk = deps.paperEngine.getSnapshot();
    const traces = deps.aiCouncil.getTraces(6);
    const journal = deps.paperEngine.getJournal().slice(0, 5);

    // Build individual terminal panes
    const terminals: TerminalSnapshot['terminals'] = [];

    // Paper Engine pane
    const inTrade = desk.agents.filter((a: any) => a.status === 'in-trade').length;
    const cooldown = desk.agents.filter((a: any) => a.status === 'cooldown').length;
    const watching = desk.agents.filter((a: any) => a.status === 'watching').length;
    terminals.push(buildTerminalPane(
      'paper-engine', 'Paper Engine',
      inTrade > 0 ? 'healthy' : cooldown > 0 ? 'warning' : 'healthy',
      `${inTrade} in-trade, ${cooldown} cooldown, ${watching} watching`,
      [
        `Equity: $${desk.totalEquity.toFixed(2)} | PnL: $${desk.realizedPnl.toFixed(2)} | Win: ${desk.winRate.toFixed(1)}%`,
        `Trades: ${desk.totalTrades} | Active: ${desk.activeAgents}`,
        ...desk.agents
          .filter((a: any) => a.status !== 'watching')
          .slice(0, 5)
          .map((a: any) => `[${a.status}] ${a.name}: ${a.lastAction?.slice(0, 80) ?? ''}`)
      ]
    ));

    // AI Council pane
    const recentTraces = traces.slice(0, 3);
    terminals.push(buildTerminalPane(
      'ai-council', 'AI Council',
      recentTraces.length > 0 ? 'healthy' : 'warning',
      `${traces.length} recent traces`,
      recentTraces.map((t: any) =>
        `[${t.status}] ${t.role}: ${asString(t.action) ?? 'pending'} — ${previewText(asString(t.reasoning), 60)}`
      )
    ));

    // Journal pane
    terminals.push(buildTerminalPane(
      'journal', 'Trade Journal',
      journal.length > 0 ? 'healthy' : 'warning',
      `${journal.length} recent entries`,
      journal.map((j: any) => `${j.verdict} ${j.symbol} $${j.realizedPnl?.toFixed(2) ?? '?'} | ${j.exitReason ?? ''}`)
    ));

    return {
      asOf: new Date().toISOString(),
      terminals
    };
  } catch (error) {
    return buildTerminalFallbackSnapshot(error);
  }
}
