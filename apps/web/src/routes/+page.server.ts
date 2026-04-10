import type { PageServerLoad } from './$types';
import type { AiCouncilTrace, LaneLearningDecision, LearningDecision, OverviewSnapshot, PaperDeskSnapshot, PositionSnapshot, ResearchCandidate } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ fetch }) => {
  const [overview, positions, research, paperDesk, learning, laneLearning, aiCouncilTraces] = await Promise.all([
    fetchFromApi<OverviewSnapshot>('/api/overview', fetch),
    fetchFromApi<PositionSnapshot[]>('/api/positions', fetch),
    fetchFromApi<ResearchCandidate[]>('/api/research', fetch),
    fetchFromApi<PaperDeskSnapshot>('/api/paper-desk', fetch),
    fetchFromApi<LearningDecision[]>('/api/learning', fetch),
    fetchFromApi<LaneLearningDecision[]>('/api/lane-learning', fetch),
    fetchFromApi<AiCouncilTrace[]>('/api/ai-council/traces', fetch)
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
