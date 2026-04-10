import type { PageServerLoad } from './$types';
import type { LaneLearningDecision, LearningDecision, StrategyReview, TradeJournalEntry } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ fetch }) => {
  const [reviews, journal, learning, laneLearning] = await Promise.all([
    fetchFromApi<StrategyReview[]>('/api/reviews', fetch),
    fetchFromApi<TradeJournalEntry[]>('/api/journal', fetch),
    fetchFromApi<LearningDecision[]>('/api/learning', fetch),
    fetchFromApi<LaneLearningDecision[]>('/api/lane-learning', fetch)
  ]);

  return {
    reviews,
    journal,
    learning,
    laneLearning
  };
};
