import type { PageServerLoad } from './$types';
import type { ExecutionReport } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ fetch }) => ({
  orders: await fetchFromApi<ExecutionReport[]>('/api/orders', fetch)
});
