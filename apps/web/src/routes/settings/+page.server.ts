import type { PageServerLoad } from './$types';
import type { ServiceHealth, SystemSettings } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ fetch }) => {
  const [settings, health] = await Promise.all([
    fetchFromApi<SystemSettings>('/api/settings', fetch),
    fetchFromApi<{ services: ServiceHealth[] }>('/api/health', fetch)
  ]);

  return {
    settings,
    health: health.services
  };
};
