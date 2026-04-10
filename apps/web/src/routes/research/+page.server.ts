import type { PageServerLoad } from './$types';
import type { MarketSnapshot, ResearchCandidate } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ fetch }) => {
  const [research, marketSnapshots] = await Promise.all([
    fetchFromApi<ResearchCandidate[]>('/api/research', fetch),
    fetchFromApi<MarketSnapshot[]>('/api/market-snapshots', fetch)
  ]);

  return {
    research,
    marketSnapshots
  };
};
