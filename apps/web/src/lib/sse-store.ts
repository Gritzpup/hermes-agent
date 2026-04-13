import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export type DashboardResourceKey =
  | 'insiderRadar'
  | 'capitalAllocation'
  | 'learning'
  | 'laneLearning'
  | 'aiCouncilTraces'
  | 'quarterOutlook'
  | 'copySleeve'
  | 'macroPreservation';

export type DashboardResourceState = 'idle' | 'loading' | 'connected' | 'degraded' | 'disconnected';

export interface DashboardResourceStatus {
  key: DashboardResourceKey;
  label: string;
  url: string;
  state: DashboardResourceState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
  httpStatus: number | null;
}

export const insiderRadar = writable<any>(null);
export const capitalAllocation = writable<any>(null);
export const learningHistory = writable<any[]>([]);
export const laneLearningHistory = writable<any[]>([]);
export const aiCouncilTraces = writable<any[]>([]);
export const quarterOutlook = writable<any>(null);
export const copySleeve = writable<any>(null);
export const macroPreservation = writable<any>(null);

const resources = [
  { key: 'insiderRadar', label: 'Insider Radar', url: '/api/insider-radar', store: insiderRadar },
  { key: 'capitalAllocation', label: 'Capital Allocator', url: '/api/capital-allocation', store: capitalAllocation },
  { key: 'learning', label: 'Learning History', url: '/api/learning?limit=200', store: learningHistory },
  { key: 'laneLearning', label: 'Lane Learning', url: '/api/lane-learning?limit=200', store: laneLearningHistory },
  { key: 'aiCouncilTraces', label: 'AI Council Traces', url: '/api/ai-council/traces?limit=40', store: aiCouncilTraces },
  { key: 'quarterOutlook', label: 'Quarter Outlook', url: '/api/quarter-outlook', store: quarterOutlook },
  { key: 'copySleeve', label: 'Copy Sleeve', url: '/api/copy-sleeve', store: copySleeve },
  { key: 'macroPreservation', label: 'Macro Preservation', url: '/api/macro-preservation', store: macroPreservation },
] as const satisfies ReadonlyArray<{ key: DashboardResourceKey; label: string; url: string; store: { set(value: unknown): void } }>;

const resourceMap = new Map(resources.map((resource) => [resource.key, resource] as const));

const initialStatus = resources.reduce<Record<DashboardResourceKey, DashboardResourceStatus>>((acc, resource) => {
  acc[resource.key] = {
    key: resource.key,
    label: resource.label,
    url: resource.url,
    state: 'idle',
    lastAttemptAt: null,
    lastSuccessAt: null,
    error: null,
    httpStatus: null
  };
  return acc;
}, {} as Record<DashboardResourceKey, DashboardResourceStatus>);

export const dashboardResourceStatus = writable<Record<DashboardResourceKey, DashboardResourceStatus>>(initialStatus);

let started = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timerId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timerId);
  }
}

function updateResourceStatus(key: DashboardResourceKey, update: Partial<DashboardResourceStatus>) {
  dashboardResourceStatus.update((current) => ({
    ...current,
    [key]: {
      ...current[key],
      ...update
    }
  }));
}

async function refreshResource(key: DashboardResourceKey) {
  const resource = resourceMap.get(key);
  if (!resource) return;

  const attemptedAt = new Date().toISOString();
  updateResourceStatus(key, {
    state: 'loading',
    lastAttemptAt: attemptedAt,
    error: null
  });

  try {
    const response = await fetchWithTimeout(resource.url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      updateResourceStatus(key, {
        state: response.status >= 500 ? 'disconnected' : 'degraded',
        error: text || `${response.status} ${response.statusText}`,
        httpStatus: response.status
      });
      return;
    }

    resource.store.set(await response.json());
    updateResourceStatus(key, {
      state: 'connected',
      lastSuccessAt: new Date().toISOString(),
      error: null,
      httpStatus: response.status
    });
  } catch (error) {
    updateResourceStatus(key, {
      state: 'disconnected',
      error: error instanceof Error ? error.message : 'request failed',
      httpStatus: null
    });
  }
}

async function refreshAll() {
  await Promise.allSettled(resources.map((resource) => refreshResource(resource.key)));
}

export function refreshDashboardResource(key: DashboardResourceKey) {
  if (!browser) return Promise.resolve();
  return refreshResource(key);
}

export function startGlobalSSE() {
  if (!browser || started) return;
  started = true;

  void refreshAll();
  intervalId = setInterval(() => void refreshAll(), 15_000);
}

export function stopGlobalSSE() {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
  started = false;
}
