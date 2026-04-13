import type { PageServerLoad } from './$types';
import type {
  OverviewSnapshot,
  PaperDeskSnapshot,
  PositionSnapshot,
  ResearchCandidate
} from '@hermes/contracts';

const emptyOverview = {
  asOf: new Date().toISOString(), nav: 0, dailyPnl: 0, dailyPnlPct: 0,
  drawdownPct: 0, activeRiskBudgetPct: 0, realizedPnl30d: 0, winRate30d: 0,
  expectancyR: 0, brokerAccounts: [], serviceHealth: []
} as unknown as OverviewSnapshot;

const emptyDesk = {
  asOf: new Date().toISOString(), chartWindow: '', startingEquity: 300000,
  totalEquity: 0, totalDayPnl: 0, totalReturnPct: 0, realizedPnl: 0,
  realizedReturnPct: 0, winRate: 0, totalTrades: 0, activeAgents: 0,
  agents: [], fills: [], marketTape: [], executionBands: [], aiCouncil: [],
  analytics: { totalOpenRisk: 0, avgHoldTicks: 0, avgSpreadBps: 0, avgSlippageBps: 0 },
  deskCurve: [], benchmarkCurve: [], tuning: [], sources: [], signals: []
} as unknown as PaperDeskSnapshot;

async function loadJson<T>(fetcher: typeof fetch, path: string, fallback: T): Promise<T> {
  try {
    const response = await fetcher(path, {
      headers: { accept: 'application/json' }
    });
    if (!response.ok) {
      return fallback;
    }
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export const load: PageServerLoad = async ({ fetch }) => {
  const [overview, positions, research, paperDesk] = await Promise.all([
    loadJson(fetch, '/api/overview', emptyOverview),
    loadJson(fetch, '/api/positions', [] as PositionSnapshot[]),
    loadJson(fetch, '/api/research', [] as ResearchCandidate[]),
    loadJson(fetch, '/api/paper-desk', emptyDesk)
  ]);

  return {
    overview,
    positions,
    research,
    paperDesk,
    learning: [],
    laneLearning: [],
    aiCouncilTraces: []
  };
};
