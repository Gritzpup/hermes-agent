import type { PageServerLoad } from './$types';
import type { AiCouncilTrace, LaneLearningDecision, LearningDecision, PaperDeskSnapshot } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ fetch }) => {
  const [learning, laneLearning, traces, paperDesk] = await Promise.all([
    fetchFromApi<LearningDecision[]>('/api/learning', fetch),
    fetchFromApi<LaneLearningDecision[]>('/api/lane-learning', fetch),
    fetchFromApi<AiCouncilTrace[]>('/api/ai-council/traces', fetch),
    fetchFromApi<PaperDeskSnapshot>('/api/paper-desk', fetch)
  ]);

  return {
    learning,
    laneLearning,
    traces,
    paperDesk
  };
};
