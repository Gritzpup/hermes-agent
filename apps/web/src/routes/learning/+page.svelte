<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types';
  import type { PaperDeskSnapshot } from '@hermes/contracts';
  import Panel from '$lib/components/Panel.svelte';
  import LearningHistorySection from '$lib/components/LearningHistorySection.svelte';
  import AiCouncilTraceSection from '$lib/components/AiCouncilTraceSection.svelte';
  import { councilSources, formatCouncilSource, getCouncilSourceCounts, getCouncilSourceSummary } from '$lib/council';

  export let data: PageData;

  let paperDesk: PaperDeskSnapshot = data.paperDesk;
  let paperDeskUpdatedAt = new Date(data.paperDesk.asOf).toLocaleString();
  const POLL_MS = 10_000;

  async function refreshPaperDesk(): Promise<void> {
    try {
      const response = await fetch('/api/paper-desk', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      paperDesk = await response.json() as PaperDeskSnapshot;
      paperDeskUpdatedAt = new Date(paperDesk.asOf).toLocaleString();
    } catch {
      // best-effort refresh for the learning center header
    }
  }

  onMount(() => {
    void refreshPaperDesk();
    const interval = setInterval(() => void refreshPaperDesk(), POLL_MS);
    return () => clearInterval(interval);
  });

  $: councilFallbackCount = paperDesk.aiCouncil.filter((decision) => getCouncilSourceSummary(decision).fallback).length;
  $: councilSourceCounts = getCouncilSourceCounts(paperDesk.aiCouncil);
  $: councilSourceRows = councilSources.map((source) => ({
    source,
    label: formatCouncilSource(source),
    count: councilSourceCounts[source]
  }));
</script>

<div class="stack">
  <div class="panel hero-surface">
    <div class="hero-surface__copy">
      <div class="eyebrow">Learning Center</div>
      <h2>Adaptation history and AI council transcripts.</h2>
      <p>
        This page is the audit trail for the fast self-learning loop, the slower lane allocation loop,
        and the raw AI council transcript log. If the system learns, you should be able to see what changed.
      </p>
    </div>
    <div class="hero-surface__meta">
      {#if councilFallbackCount > 0}
        <div class="advisory-banner">
          <span>Fallback active</span>
          <span>{councilFallbackCount} decisions used API / CLI / rules instead of AI.</span>
        </div>
      {/if}
      <div class="hero-meta-block">
        <span class="hero-meta-label">Fast decisions</span>
        <strong>{data.learning.length}</strong>
      </div>
      <div class="hero-meta-block">
        <span class="hero-meta-label">Lane decisions</span>
        <strong>{data.laneLearning.length}</strong>
      </div>
      <div class="hero-meta-block">
        <span class="hero-meta-label">AI transcripts</span>
        <strong>{data.traces.length}</strong>
      </div>
      <div class="hero-meta-block hero-meta-block--source">
        <span class="hero-meta-label">Council source mix</span>
        <div class="source-breakdown">
          {#each councilSourceRows as row}
            <div class={`source-pill source-pill--${row.source}`}>
              <span>{row.label}</span>
              <strong>{row.count}</strong>
            </div>
          {/each}
        </div>
        <small>{councilSourceCounts.totalVotes} votes across {councilSourceCounts.totalDecisions} verified decisions · refreshed {paperDeskUpdatedAt}</small>
      </div>
    </div>
  </div>

  <Panel title="Learning History" subtitle="Persisted review-loop logs with 7d and 30d trend windows. This is the operational memory behind the reviews." aside="history">
    <LearningHistorySection mode="detail" initialLearning={data.learning} initialLaneLearning={data.laneLearning} />
  </Panel>

  <Panel title="AI Council Transcripts" subtitle="Raw prompts and raw outputs from the AI-based council, plus the resulting vote metadata." aside="transcripts">
    <AiCouncilTraceSection mode="detail" initialTraces={data.traces} />
  </Panel>
</div>

<style>
  .stack {
    display: grid;
    gap: 1rem;
  }

  .hero-meta-block--source {
    gap: 0.65rem;
  }

  .source-breakdown {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .source-pill {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.65rem;
    padding: 0.55rem 0.7rem;
    border-radius: 0.7rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .source-pill strong {
    font-family: var(--mono);
  }

  .source-pill--pi {
    color: var(--positive);
  }

  .source-pill--api {
    color: var(--accent);
  }

  .source-pill--cli {
    color: var(--warning);
  }

  .source-pill--rules {
    color: var(--negative);
  }
</style>
