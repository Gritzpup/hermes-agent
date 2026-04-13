<script lang="ts">
  import type { ServiceHealth } from '@hermes/contracts';
  import type { DashboardResourceStatus } from '$lib/sse-store';
  import StatusPill from '$lib/components/StatusPill.svelte';

  export let connectionState = 'disconnected';
  export let feedMessageCount = 0;
  export let lastFeedTimestamp = '';
  export let serviceHealth: ServiceHealth[] = [];
  export let resourceStatus: Record<string, DashboardResourceStatus> = {};

  const toneForConnection = (state: string): 'healthy' | 'warning' | 'critical' =>
    state.includes('connected') ? 'healthy' : state.includes('reconnecting') ? 'warning' : 'critical';

  const toneForService = (status: ServiceHealth['status']): 'healthy' | 'warning' | 'critical' =>
    status === 'healthy' ? 'healthy' : status === 'warning' ? 'warning' : 'critical';

  const toneForResource = (status?: DashboardResourceStatus): 'healthy' | 'warning' | 'critical' => {
    if (!status) return 'critical';
    if (status.state === 'connected') return 'healthy';
    if (status.state === 'loading' || status.state === 'degraded') return 'warning';
    return 'critical';
  };

  $: resources = Object.values(resourceStatus);
  $: serviceIssues = serviceHealth.filter((service) => service.status !== 'healthy');
  $: loadingResources = resources.filter((resource) => resource.state === 'idle' || resource.state === 'loading');
  $: resourceIssues = resources.filter((resource) => resource.state === 'degraded' || resource.state === 'disconnected');
  $: healthyServiceCount = serviceHealth.length - serviceIssues.length;
  $: healthyResourceCount = resources.filter((resource) => resource.state === 'connected').length;
  $: totalIssues = serviceIssues.length + resourceIssues.length + (toneForConnection(connectionState) === 'healthy' ? 0 : 1);
</script>

<div class="diagnostics-footer">
  <div class="diagnostics-summary">
    <div class="diagnostics-chip">
      <span class="eyebrow">Feed</span>
      <div class="diagnostics-chip__value">
        <StatusPill label={connectionState} status={toneForConnection(connectionState)} />
      </div>
      <small>{feedMessageCount} msgs · {lastFeedTimestamp || '—'}</small>
    </div>
    <div class="diagnostics-chip">
      <span class="eyebrow">Services</span>
      <strong>{healthyServiceCount}/{serviceHealth.length}</strong>
      <small>{serviceIssues.length} issue{serviceIssues.length === 1 ? '' : 's'}</small>
    </div>
    <div class="diagnostics-chip">
      <span class="eyebrow">Resources</span>
      <strong>{healthyResourceCount}/{resources.length}</strong>
      <small>{resourceIssues.length} issue{resourceIssues.length === 1 ? '' : 's'}{#if loadingResources.length > 0} · {loadingResources.length} loading{/if}</small>
    </div>
    <div class="diagnostics-chip">
      <span class="eyebrow">Issues</span>
      <strong class:status-positive={totalIssues === 0} class:status-warning={totalIssues > 0 && totalIssues < 3} class:status-negative={totalIssues >= 3}>{totalIssues}</strong>
      <small>footer summary only</small>
    </div>
  </div>

  {#if totalIssues === 0}
    <p class="subtle diagnostics-ok">No active diagnostics issues. Feed, services, and dashboard resources are connected.</p>
  {:else}
    <div class="diagnostics-issues">
      {#if toneForConnection(connectionState) !== 'healthy'}
        <article class="diagnostics-issue">
          <div>
            <strong>Feed</strong>
            <p>{connectionState}</p>
          </div>
          <StatusPill label={connectionState} status={toneForConnection(connectionState)} />
        </article>
      {/if}

      {#each serviceIssues as service}
        <article class="diagnostics-issue">
          <div>
            <strong>{service.name}</strong>
            <p>{service.message || 'No service message.'}</p>
          </div>
          <StatusPill label={service.status} status={toneForService(service.status)} />
        </article>
      {/each}

      {#each resourceIssues as resource}
        <article class="diagnostics-issue">
          <div>
            <strong>{resource.label}</strong>
            <p>{resource.error ?? `${resource.state} · ${resource.url}`}</p>
          </div>
          <StatusPill label={resource.state} status={toneForResource(resource)} />
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .diagnostics-footer {
    display: grid;
    gap: 10px;
  }

  .diagnostics-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }

  .diagnostics-chip {
    display: grid;
    gap: 4px;
    padding: 8px 10px;
    background: rgba(10, 18, 28, 0.55);
    border: 1px solid rgba(125, 163, 214, 0.08);
  }

  .diagnostics-chip strong {
    font-size: 1rem;
  }

  .diagnostics-chip small {
    color: var(--muted, #92a0b8);
  }

  .diagnostics-chip__value :global(.status-pill) {
    width: fit-content;
  }

  .diagnostics-issues {
    display: grid;
    gap: 6px;
  }

  .diagnostics-issue {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    padding: 8px 10px;
    background: rgba(10, 18, 28, 0.4);
    border: 1px solid rgba(125, 163, 214, 0.08);
  }

  .diagnostics-issue strong {
    display: block;
    margin-bottom: 2px;
  }

  .diagnostics-issue p,
  .diagnostics-ok {
    margin: 0;
  }

  @media (max-width: 900px) {
    .diagnostics-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
