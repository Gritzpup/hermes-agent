<script lang="ts">
  import { onMount } from 'svelte';
  import type { AiCouncilTrace } from '@hermes/contracts';
  import StatusPill from '$lib/components/StatusPill.svelte';
  import {
    aiCouncilTraces as tracesStore,
    dashboardResourceStatus,
    refreshDashboardResource,
    startGlobalSSE
  } from '$lib/sse-store';

  export let mode: 'summary' | 'detail' = 'summary';
  export let initialTraces: AiCouncilTrace[] = [];

  let traces: AiCouncilTrace[] = initialTraces;
  let loading = initialTraces.length === 0;

  $: if ($tracesStore && $tracesStore.length > 0) {
    traces = $tracesStore as AiCouncilTrace[];
    loading = false;
    error = '';
    refreshedAt = new Date().toLocaleString();
  }
  $: traceStatus = $dashboardResourceStatus.aiCouncilTraces;
  $: if (traces.length === 0) {
    loading = traceStatus.state === 'idle' || traceStatus.state === 'loading';
    error = traceStatus.state === 'connected' ? '' : (traceStatus.error ?? '');
    refreshedAt = traceStatus.lastSuccessAt ? new Date(traceStatus.lastSuccessAt).toLocaleString() : refreshedAt;
  }
  let error = '';
  let refreshedAt = '';
  let query = '';
  type TraceRoleFilter = 'all' | AiCouncilTrace['role'];
  const roleFilters: TraceRoleFilter[] = ['all', 'claude', 'codex', 'gemini'];
  let activeRole: TraceRoleFilter = 'all';

  function formatTimestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function statusTone(status: AiCouncilTrace['status']): 'healthy' | 'warning' | 'critical' {
    return status === 'complete' ? 'healthy' : status === 'evaluating' ? 'warning' : 'critical';
  }

  function roleLabel(role: TraceRoleFilter): string {
    return role === 'all' ? 'All' : role.charAt(0).toUpperCase() + role.slice(1);
  }

  function traceSearchHaystack(trace: AiCouncilTrace): string {
    return [
      trace.role,
      trace.agentName,
      trace.symbol,
      trace.status,
      trace.transport,
      trace.parsedAction ?? '',
      trace.parsedThesis ?? '',
      trace.parsedRiskNote ?? '',
      trace.error ?? '',
      trace.prompt,
      trace.rawOutput,
    ].join(' ').toLowerCase();
  }

  onMount(() => {
    startGlobalSSE();
    if (traces.length === 0) {
      void refreshDashboardResource('aiCouncilTraces');
    }
  });

  $: normalizedQuery = query.trim().toLowerCase();
  $: sorted = [...traces].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  $: queryFiltered = normalizedQuery ? sorted.filter((trace) => traceSearchHaystack(trace).includes(normalizedQuery)) : sorted;
  $: filtered = activeRole === 'all' ? queryFiltered : queryFiltered.filter((trace) => trace.role === activeRole);
  $: roleCounts = roleFilters.map((role) => ({
    role,
    count: role === 'all' ? queryFiltered.length : queryFiltered.filter((trace) => trace.role === role).length,
  }));
  $: latestTrace = filtered[0] ?? null;
  $: cliTraceCount = filtered.filter((trace) => trace.transport === 'cli').length;
  $: errorCount = filtered.filter((trace) => trace.status === 'error').length;
  $: completeCount = filtered.filter((trace) => trace.status === 'complete').length;
  $: rolesSeen = [...new Set(filtered.map((trace) => trace.role))];
  $: visibleTraces = filtered.slice(0, mode === 'detail' ? 12 : 5);
</script>

<div class="stack">
  <div class="advisory-banner">
    <span>Council transcript log</span>
    <span>raw prompts and raw outputs only</span>
    <span>errors and fallbacks are labeled</span>
  </div>

  {#if error}
    <div class="advisory-banner">
      <span>Partial transcript feed</span>
      <span>{error}</span>
    </div>
  {:else if loading}
    <div class="advisory-banner">
      <span>Loading</span>
      <span>AI Council transcript log</span>
      <span>decision traces</span>
    </div>
  {/if}

  <div class="trace-toolbar">
    <label class="trace-search">
      <span class="eyebrow">Search transcript log</span>
      <input bind:value={query} type="search" placeholder="agent, symbol, prompt, output, error, action" />
    </label>
    {#if query}
      <button type="button" class="trace-search__clear" on:click={() => (query = '')}>Clear</button>
    {/if}
  </div>

  <div class="trace-filters">
    <div class="trace-filters__head">
      <span class="eyebrow">Role filter</span>
      <span class="subtle">AI transcripts only · narrow the transcript log by model role.</span>
    </div>
    <div class="trace-filter-pills">
      {#each roleCounts as item}
        <button
          type="button"
          class="trace-filter-pill"
          class:selected={activeRole === item.role}
          aria-pressed={activeRole === item.role}
          on:click={() => (activeRole = item.role)}
        >
          <span>{roleLabel(item.role)}</span>
          <strong>{item.count}</strong>
        </button>
      {/each}
    </div>
  </div>

  <div class="technical-readout">
    <div class="readout-card">
      <span class="eyebrow">Trace count</span>
      <strong>{filtered.length}</strong>
      <small>{sorted.length} total · {cliTraceCount} CLI transcripts · {errorCount} errors</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Completed</span>
      <strong>{completeCount}</strong>
      <small>{rolesSeen.length} roles seen · updated {refreshedAt || 'just now'}</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Latest role</span>
      <strong>{latestTrace ? latestTrace.role : '—'}</strong>
      <small>{latestTrace ? `${latestTrace.status} · ${latestTrace.transport}` : 'waiting for an AI response'}</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Latest action</span>
      <strong>{latestTrace?.parsedAction ?? '—'}</strong>
      <small>{latestTrace ? `${latestTrace.parsedConfidence?.toFixed(0) ?? '0'}% confidence` : 'no trace yet'}</small>
    </div>
  </div>

  {#if latestTrace}
    <div class="list-item">
      <div class="panel-header">
        <div>
          <h3>Latest transcript</h3>
          <p>{latestTrace.agentName} · {latestTrace.symbol} · {latestTrace.role}</p>
        </div>
        <StatusPill label={latestTrace.status} status={statusTone(latestTrace.status)} />
      </div>
      <p class="subtle">
        {latestTrace.transport} · candidate score {latestTrace.candidateScore.toFixed(2)} · latency {latestTrace.latencyMs ?? 0}ms
        {#if latestTrace.error} · error {latestTrace.error}{/if}
      </p>
      <div class="transcript-grid">
        <div>
          <span class="eyebrow">Prompt</span>
          <pre class="transcript-box">{latestTrace.prompt}</pre>
        </div>
        <div>
          <span class="eyebrow">Raw output</span>
          <pre class="transcript-box">{latestTrace.rawOutput}</pre>
        </div>
      </div>
    </div>
  {/if}

  {#if visibleTraces.length > 0}
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Role</th>
            <th>Status</th>
            <th>Action</th>
            <th>Score</th>
            <th>Prompt</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          {#each visibleTraces as trace}
            <tr>
              <td class="subtle">{formatTimestamp(trace.timestamp)}</td>
              <td>
                <strong>{trace.role}</strong>
                <div class="subtle">{trace.agentName} · {trace.symbol}</div>
              </td>
              <td>
                <StatusPill label={trace.status} status={statusTone(trace.status)} />
              </td>
              <td>{trace.parsedAction ?? '—'}</td>
              <td>{trace.parsedConfidence?.toFixed(0) ?? '0'}%</td>
              <td class="subtle">{trace.prompt.slice(0, 140)}{trace.prompt.length > 140 ? '…' : ''}</td>
              <td class="subtle">{trace.rawOutput.slice(0, 140)}{trace.rawOutput.length > 140 ? '…' : ''}</td>
            </tr>
            {#if mode === 'detail'}
              <tr class="table-detail-row">
                <td colspan="7">
                  <div class="detail-row">
                    <span>Decision {trace.decisionId}</span>
                    <span>Latency {trace.latencyMs ?? 0}ms</span>
                    <span>Transport {trace.transport}</span>
                    <span>Candidate {trace.candidateScore.toFixed(2)}</span>
                  </div>
                  {#if trace.parsedThesis}
                    <p class="subtle">Thesis: {trace.parsedThesis}</p>
                  {/if}
                  {#if trace.parsedRiskNote}
                    <p class="subtle">Risk: {trace.parsedRiskNote}</p>
                  {/if}
                  {#if trace.error}
                    <p class="subtle">Error: {trace.error}</p>
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {:else if normalizedQuery || activeRole !== 'all'}
    <div class="list-item">
      <h4>No matching transcripts</h4>
      <p class="subtle">No prompt, output, symbol, role, or error matched the active filters. Clear search or reset the role filter to show the full log.</p>
    </div>
  {:else}
    <div class="list-item">
      <h4>No AI transcripts yet</h4>
      <p class="subtle">Waiting for the first council evaluation to log a transcript.</p>
    </div>
  {/if}
</div>

<style>
  .stack {
    display: grid;
    gap: 1rem;
  }

  .trace-toolbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: flex-end;
  }

  .trace-filters {
    display: grid;
    gap: 0.6rem;
  }

  .trace-filters__head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: baseline;
  }

  .trace-filter-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
  }

  .trace-filter-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.6rem 0.85rem;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--border, #233149) 72%, transparent);
    background: rgba(255, 255, 255, 0.04);
    color: var(--foreground, #e5eefb);
    cursor: pointer;
    font: inherit;
    font-size: 0.82rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .trace-filter-pill strong {
    font-family: var(--mono);
  }

  .trace-filter-pill:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .trace-filter-pill.selected {
    border-color: color-mix(in srgb, var(--accent, #7dd3fc) 72%, white);
    box-shadow: 0 0 0 3px rgba(125, 211, 252, 0.12);
  }

  .trace-search {
    flex: 1;
    display: grid;
    gap: 0.35rem;
    min-width: min(100%, 280px);
  }

  .trace-search input {
    width: 100%;
    border-radius: 0.85rem;
    border: 1px solid color-mix(in srgb, var(--border, #233149) 72%, transparent);
    background: color-mix(in srgb, var(--background, #020617) 96%, transparent);
    color: var(--foreground, #e5eefb);
    padding: 0.85rem 0.95rem;
    font: inherit;
    font-size: 0.92rem;
  }

  .trace-search input::placeholder {
    color: var(--muted-foreground, #92a0b8);
  }

  .trace-search input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent, #7dd3fc) 72%, white);
    box-shadow: 0 0 0 3px rgba(125, 211, 252, 0.12);
  }

  .trace-search__clear {
    justify-self: start;
    border: 1px solid color-mix(in srgb, var(--border, #233149) 72%, transparent);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--foreground, #e5eefb);
    padding: 0.55rem 0.9rem;
    cursor: pointer;
    font: inherit;
    font-size: 0.82rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .trace-search__clear:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .transcript-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1rem;
  }

  .transcript-box {
    margin: 0.35rem 0 0;
    padding: 0.85rem;
    border-radius: 0.8rem;
    border: 1px solid color-mix(in srgb, var(--border, #233149) 65%, transparent);
    background: color-mix(in srgb, var(--background, #020617) 92%, transparent);
    color: color-mix(in srgb, var(--foreground, #e5eefb) 92%, var(--muted-foreground, #92a0b8));
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.84rem;
    line-height: 1.45;
    min-height: 7rem;
  }

  .detail-row {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    color: var(--muted-foreground, #92a0b8);
    font-size: 0.92rem;
  }
</style>
