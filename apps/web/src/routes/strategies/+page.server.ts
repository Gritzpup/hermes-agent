import type { PageServerLoad } from './$types';
import type { StrategySnapshot } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ fetch }) => ({
  strategies: await fetchFromApi<StrategySnapshot[]>('/api/strategies', fetch)
});
