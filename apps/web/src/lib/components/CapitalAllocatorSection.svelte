<script lang="ts">
  import { onMount } from 'svelte';
  import type { CapitalAllocatorSnapshot } from '@hermes/contracts';
  import { percent } from '$lib/format';
  import { capitalAllocation, dashboardResourceStatus, refreshDashboardResource, startGlobalSSE } from '$lib/sse-store';

  export let mode: 'summary' | 'detail' = 'summary';

  let snapshot: CapitalAllocatorSnapshot | null = null;
  let loading = true;
  let error = '';
  let refreshedAt = '';

  $: if ($capitalAllocation) {
    snapshot = $capitalAllocation as CapitalAllocatorSnapshot;
    loading = false;
    error = '';
    refreshedAt = new Date().toLocaleString();
  }
  $: allocatorStatus = $dashboardResourceStatus.capitalAllocation;
  $: if (!snapshot) {
    loading = allocatorStatus.state === 'idle' || allocatorStatus.state === 'loading';
    error = allocatorStatus.state === 'connected' ? '' : (allocatorStatus.error ?? '');
    refreshedAt = allocatorStatus.lastSuccessAt ? new Date(allocatorStatus.lastSuccessAt).toLocaleString() : refreshedAt;
  }

  $: sleeves = snapshot?.sleeves ?? [];
  $: liveSleeves = sleeves.filter((sleeve) => sleeve.kind !== 'cash' && sleeve.liveEligible && sleeve.targetWeightPct > 0);
  $: stagedSleeves = sleeves.filter((sleeve) => sleeve.staged && sleeve.kind !== 'cash');
  $: cashSleeve = sleeves.find((sleeve) => sleeve.kind === 'cash') ?? null;
  $: visibleSleeves = mode === 'detail' ? sleeves : sleeves.slice(0, 8);

  onMount(() => {
    startGlobalSSE();
    if (!snapshot) {
      void refreshDashboardResource('capitalAllocation');
    }
  });
</script>

<div class="stack">
  <div class="advisory-banner">
    <span>Unified capital allocator</span>
    <span>cash-first until a sleeve earns live capital</span>
    <span>forex and bond remain staged until venue parity exists</span>
  </div>

  {#if error}
    <div class="advisory-banner">
      <span>Unavailable</span>
      <span>{error}</span>
    </div>
  {:else if loading}
    <div class="advisory-banner">
      <span>Loading</span>
      <span>live sleeve scores</span>
      <span>capital policy</span>
    </div>
  {/if}

  <div class="technical-readout">
    <div class="readout-card">
      <span class="eyebrow">Capital</span>
      <strong>{snapshot ? snapshot.capital.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—'}</strong>
      <small>{snapshot ? `as of ${new Date(snapshot.asOf).toLocaleString()}` : 'waiting for allocator snapshot'}</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Deployable budget</span>
      <strong>{snapshot ? percent(snapshot.deployablePct) : '—'}</strong>
      <small>Reserve {snapshot ? percent(snapshot.reservePct) : '—'}</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Firm KPI ratio</span>
      <strong>{snapshot ? `${snapshot.firmKpiRatio.toFixed(1)}%` : '—'}</strong>
      <small>Desk + best live sleeve composite</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Live sleeves</span>
      <strong>{liveSleeves.length}</strong>
      <small>Eligible for actual capital now</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Staged sleeves</span>
      <strong>{stagedSleeves.length}</strong>
      <small>Paper-only, parity pending, or still proving edge</small>
    </div>
  </div>

  {#if mode === 'detail'}
    <div class="panel-header">
      <div>
        <h3>Allocation table</h3>
        <p>Live sleeves get weight; paper/staged sleeves remain at zero until they earn it.</p>
      </div>
      <div class="subtle">{refreshedAt || 'just now'}</div>
    </div>

    {#if visibleSleeves.length > 0}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Sleeve</th>
              <th>Status</th>
              <th>Target</th>
              <th>Score</th>
              <th>KPI</th>
              <th>Edge</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {#each visibleSleeves as sleeve}
              <tr>
                <td>
                  <strong>{sleeve.name}</strong>
                  <div class="subtle">
                    {sleeve.kind}{#if sleeve.assetClass} · {sleeve.assetClass}{/if}
                    {#if sleeve.symbols.length > 0} · {sleeve.symbols.join(', ')}{/if}
                  </div>
                </td>
                <td>{sleeve.status}</td>
                <td>{sleeve.targetWeightPct.toFixed(2)}%</td>
                <td>{sleeve.score.toFixed(2)}</td>
                <td>{sleeve.kpiRatio.toFixed(1)}%</td>
                <td>{sleeve.expectedNetEdgeBps.toFixed(2)} bps</td>
                <td class="subtle">{sleeve.reason}</td>
              </tr>
              {#if sleeve.notes.length > 0}
                <tr class="table-detail-row">
                  <td colspan="7">{sleeve.notes.join(' · ')}</td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {:else if loading}
      <div class="list-item">
        <h4>Allocation loading</h4>
        <p class="subtle">Waiting for the unified capital plan.</p>
      </div>
    {/if}
  {:else if snapshot}
    <div class="list-card">
      {#each visibleSleeves.slice(0, 5) as sleeve}
        <article class="list-item">
          <div class="band-card__head">
            <div>
              <h4>{sleeve.name}</h4>
              <p class="subtle">{sleeve.status} · {sleeve.kind}{#if sleeve.assetClass} · {sleeve.assetClass}{/if}</p>
            </div>
            <strong>{sleeve.targetWeightPct.toFixed(2)}%</strong>
          </div>
          <p>{sleeve.reason}</p>
          <p class="subtle">Score {sleeve.score.toFixed(2)} · KPI {sleeve.kpiRatio.toFixed(1)}% · Edge {sleeve.expectedNetEdgeBps.toFixed(2)} bps</p>
        </article>
      {/each}
    </div>
  {/if}

  {#if snapshot?.notes?.length}
    <div class="list-card">
      {#each snapshot.notes as note}
        <article class="list-item">
          <p>{note}</p>
        </article>
      {/each}
    </div>
  {/if}

  <div class="chart-footnote">
    <span>
      {#if cashSleeve}
        cash reserve {cashSleeve.targetWeightPct.toFixed(2)}%
      {:else if loading}
        loading reserve
      {:else}
        reserve unavailable
      {/if}
    </span>
    <span>
      <a href="/capital-allocation">Open full capital-allocation page</a>
    </span>
  </div>
</div>
