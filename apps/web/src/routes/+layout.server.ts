import type { LayoutServerLoad } from './$types';
import type { ServiceHealth } from '@hermes/contracts';
import { fetchFromApi } from '$lib/server/api';

export const load: LayoutServerLoad = async ({ fetch }) => {
  try {
    const health = await fetchFromApi<{ services: ServiceHealth[] }>('/api/health', fetch);
    return {
      serviceHealth: health.services
    };
  } catch {
    return {
      serviceHealth: [
        {
          name: 'api',
          port: 4300,
          status: 'critical' as ServiceHealth['status'],
          message: 'unavailable'
        }
      ]
    };
  }
};
