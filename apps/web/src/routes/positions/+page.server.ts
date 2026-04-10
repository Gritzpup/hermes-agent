import type { PageServerLoad } from './$types';
import type { PositionSnapshot } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ fetch }) => ({
  positions: await fetchFromApi<PositionSnapshot[]>('/api/positions', fetch)
});
