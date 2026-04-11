import type { PageServerLoad } from './$types';
import type { AiCouncilTrace, LaneLearningDecision, LearningDecision, OverviewSnapshot, PaperDeskSnapshot, PositionSnapshot, ResearchCandidate } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

async function tryFetch<T>(path: string, fetchImpl: typeof fetch, fallback: T): Promise<T> {
  try {
    return await fetchFromApi<T>(path, fetchImpl, 4000);
  } catch {
    return fallback;
  }
}

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
  deskCurve: [], benchmarkCurve: []
} as unknown as PaperDeskSnapshot;

export const load: PageServerLoad = async ({ fetch }) => {
  const [overview, positions, research, paperDesk, learning, laneLearning, aiCouncilTraces] = await Promise.all([
    tryFetch<OverviewSnapshot>('/api/overview', fetch, emptyOverview),
    tryFetch<PositionSnapshot[]>('/api/positions', fetch, []),
    tryFetch<ResearchCandidate[]>('/api/research', fetch, []),
    tryFetch<PaperDeskSnapshot>('/api/paper-desk', fetch, emptyDesk),
    tryFetch<LearningDecision[]>('/api/learning', fetch, []),
    tryFetch<LaneLearningDecision[]>('/api/lane-learning', fetch, []),
    tryFetch<AiCouncilTrace[]>('/api/ai-council/traces', fetch, [])
  ]);

  return {
    overview,
    positions,
    research,
    paperDesk,
    learning,
    laneLearning,
    aiCouncilTraces
  };
};
