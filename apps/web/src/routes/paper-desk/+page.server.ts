import type { PageServerLoad } from './$types';
import type { AiCouncilTrace, LaneLearningDecision, LearningDecision, OverviewSnapshot, PaperDeskSnapshot } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ fetch }) => {
  const [overview, paperDesk, learning, laneLearning, aiCouncilTraces] = await Promise.all([
    fetchFromApi<OverviewSnapshot>('/api/overview', fetch),
    fetchFromApi<PaperDeskSnapshot>('/api/paper-desk', fetch),
    fetchFromApi<LearningDecision[]>('/api/learning', fetch),
    fetchFromApi<LaneLearningDecision[]>('/api/lane-learning', fetch),
    fetchFromApi<AiCouncilTrace[]>('/api/ai-council/traces', fetch)
  ]);

  return {
    overview,
    paperDesk,
    learning,
    laneLearning,
    aiCouncilTraces
  };
};
