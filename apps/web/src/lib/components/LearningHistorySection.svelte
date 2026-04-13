<script lang="ts">
  import { onMount } from 'svelte';
  import type { LaneLearningDecision, LearningDecision } from '@hermes/contracts';
  import ArenaChart from '$lib/components/ArenaChart.svelte';
  import {
    dashboardResourceStatus,
    learningHistory as learningStore,
    laneLearningHistory as laneStore,
    refreshDashboardResource,
    startGlobalSSE
  } from '$lib/sse-store';

  export let mode: 'summary' | 'detail' = 'summary';
  export let initialLearning: LearningDecision[] = [];
  export let initialLaneLearning: LaneLearningDecision[] = [];
  const DAY_MS = 24 * 60 * 60 * 1000;
  const TREND_DAYS = 14;
  const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
  const WINDOW_30D_MS = 30 * 24 * 60 * 60 * 1000;

  let learning: LearningDecision[] = initialLearning;
  let laneLearning: LaneLearningDecision[] = initialLaneLearning;
  let loading = initialLearning.length === 0 && initialLaneLearning.length === 0;
  let error = '';
  let refreshedAt = '';
  let now = Date.now();

  const rowLimit = mode === 'detail' ? 12 : 6;

  function isWithinWindow(timestamp: string, now: number, windowMs: number): boolean {
    const value = Date.parse(timestamp);
    return Number.isFinite(value) && now - value <= windowMs && now - value >= 0;
  }

  function windowStats<T extends { timestamp: string }>(rows: T[], now: number, windowMs: number) {
    const current = rows.filter((row) => isWithinWindow(row.timestamp, now, windowMs));
    const prior = rows.filter((row) => {
      const value = Date.parse(row.timestamp);
      return Number.isFinite(value) && now - value > windowMs && now - value <= windowMs * 2;
    });
    return { current, prior };
  }

  function countLearningAction(rows: LearningDecision[], action: LearningDecision['action']): number {
    return rows.filter((row) => row.action === action).length;
  }

  function countLaneAction(rows: LaneLearningDecision[], action: LaneLearningDecision['action']): number {
    return rows.filter((row) => row.action === action).length;
  }

  function formatTimestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function buildDailySeries<T extends { timestamp: string }>(rows: T[], days: number, anchorMs: number, predicate?: (row: T) => boolean): number[] {
    const start = anchorMs - (days - 1) * DAY_MS;
    return Array.from({ length: days }, (_, dayIndex) => {
      const dayStart = start + dayIndex * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      return rows.reduce((sum, row) => {
        const stamp = Date.parse(row.timestamp);
        if (!Number.isFinite(stamp) || stamp < dayStart || stamp >= dayEnd) {
          return sum;
        }
        return sum + (predicate?.(row) ? 1 : predicate ? 0 : 1);
      }, 0);
    });
  }

  onMount(() => {
    startGlobalSSE();
    if (learning.length === 0) {
      void refreshDashboardResource('learning');
    }
    if (laneLearning.length === 0) {
      void refreshDashboardResource('laneLearning');
    }

    const tickInterval = setInterval(() => {
      now = Date.now();
    }, 5_000);

    return () => clearInterval(tickInterval);
  });

  // Subscribe to global store updates (refreshed every 15s)
  $: if ($learningStore && $learningStore.length > 0) {
    learning = $learningStore as LearningDecision[];
    loading = false;
    error = '';
    refreshedAt = new Date().toLocaleString();
  }
  $: if ($laneStore && $laneStore.length > 0) {
    laneLearning = $laneStore as LaneLearningDecision[];
  }
  $: learningStatus = $dashboardResourceStatus.learning;
  $: laneStatus = $dashboardResourceStatus.laneLearning;
  $: if (learning.length === 0 && laneLearning.length === 0) {
    loading = [learningStatus.state, laneStatus.state].some((state) => state === 'idle' || state === 'loading');
    error = [learningStatus.error, laneStatus.error].filter(Boolean).join(' · ');
    refreshedAt = learningStatus.lastSuccessAt || laneStatus.lastSuccessAt
      ? new Date(learningStatus.lastSuccessAt ?? laneStatus.lastSuccessAt ?? '').toLocaleString()
      : refreshedAt;
  }

  $: learningTrendSeries = buildDailySeries(learning, TREND_DAYS, now);
  $: learningPromoteTrendSeries = buildDailySeries(learning, TREND_DAYS, now, (row) => row.action === 'promote');
  $: laneTrendSeries = buildDailySeries(laneLearning, TREND_DAYS, now);
  $: laneRiskTrendSeries = buildDailySeries(laneLearning, TREND_DAYS, now, (row) => row.action === 'de-risk' || row.action === 'quarantine');
  $: learning7d = windowStats(learning, now, WINDOW_7D_MS);
  $: learning30d = windowStats(learning, now, WINDOW_30D_MS);
  $: lane7d = windowStats(laneLearning, now, WINDOW_7D_MS);
  $: lane30d = windowStats(laneLearning, now, WINDOW_30D_MS);
  $: learningPromotions7d = countLearningAction(learning7d.current, 'promote');
  $: learningPromotionsPrior7d = countLearningAction(learning7d.prior, 'promote');
  $: learningSkips7d = countLearningAction(learning7d.current, 'skip');
  $: learningEvolves7d = countLearningAction(learning7d.current, 'evolve');
  $: lanePromotions7d = countLaneAction(lane7d.current, 'promote');
  $: laneCuts7d = countLaneAction(lane7d.current, 'de-risk') + countLaneAction(lane7d.current, 'quarantine');
  $: lanePromotionsPrior7d = countLaneAction(lane7d.prior, 'promote');
  $: laneCutsPrior7d = countLaneAction(lane7d.prior, 'de-risk') + countLaneAction(lane7d.prior, 'quarantine');
  $: visibleLearning = [...learning].sort((left, right) => right.timestamp.localeCompare(left.timestamp)).slice(0, rowLimit);
  $: visibleLaneLearning = [...laneLearning].sort((left, right) => right.timestamp.localeCompare(left.timestamp)).slice(0, rowLimit);
  $: latestLearning = visibleLearning[0] ?? null;
  $: latestLane = visibleLaneLearning[0] ?? null;
  $: latestTimestamp = latestLearning?.timestamp ?? latestLane?.timestamp ?? '';
  $: lastActivityAgoMs = latestTimestamp ? now - Date.parse(latestTimestamp) : Infinity;
  $: lastActivityLabel = lastActivityAgoMs < 60_000 ? `${Math.floor(lastActivityAgoMs / 1000)}s ago`
    : lastActivityAgoMs < 3_600_000 ? `${Math.floor(lastActivityAgoMs / 60_000)}m ago`
    : lastActivityAgoMs < 86_400_000 ? `${Math.floor(lastActivityAgoMs / 3_600_000)}h ago`
    : lastActivityAgoMs < Infinity ? `${Math.floor(lastActivityAgoMs / 86_400_000)}d ago`
    : 'never';
  $: activityTone = lastActivityAgoMs < 300_000 ? 'status-positive' : lastActivityAgoMs < 3_600_000 ? 'status-warning' : 'status-negative';
  $: totalLearning = learning.length;
  $: totalLane = laneLearning.length;
</script>

<div class="stack">
  <div class="advisory-banner">
    <span class={activityTone}>Last activity: {lastActivityLabel}</span>
    <span>{totalLearning} self-learning · {totalLane} lane decisions</span>
    <span>Refreshed {refreshedAt || 'loading'}</span>
  </div>

  {#if error}
    <div class="advisory-banner">
      <span>Partial history</span>
      <span>{error}</span>
    </div>
  {:else if loading}
    <div class="advisory-banner">
      <span>Loading</span>
      <span>learning logs</span>
      <span>lane decisions</span>
    </div>
  {/if}

  <div class="technical-readout">
    <div class="readout-card">
      <span class="eyebrow">Learning 7d</span>
      <strong class={learning7d.current.length > 0 ? 'status-positive' : ''}>{learning7d.current.length}</strong>
      <small>prior 7d: {learning7d.prior.length} · 30d: {learning30d.current.length} · total: {totalLearning}</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Promotions 7d</span>
      <strong class={learningPromotions7d > 0 ? 'status-positive' : 'status-warning'}>{learningPromotions7d}</strong>
      <small>prior: {learningPromotionsPrior7d} · skips: {learningSkips7d} · evolves: {learningEvolves7d}</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Lane 7d</span>
      <strong class={lane7d.current.length > 0 ? 'status-positive' : ''}>{lane7d.current.length}</strong>
      <small>prior 7d: {lane7d.prior.length} · 30d: {lane30d.current.length} · total: {totalLane}</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Lane cuts 7d</span>
      <strong class={laneCuts7d > 0 ? 'status-negative' : 'status-positive'}>{laneCuts7d}</strong>
      <small>prior: {laneCutsPrior7d} · promotions: {lanePromotions7d} · prior: {lanePromotionsPrior7d}</small>
    </div>
  </div>

  <div class="chart-footnote">
    <span>Updated {refreshedAt || 'just now'}</span>
    <span>These logs are persisted, not fabricated. If there is no decision, the panel stays quiet.</span>
  </div>

  <div class="dual-grid">
    <div class="list-item">
      <div class="panel-header">
        <div>
          <h3>Self-learning trend</h3>
          <p>14-day activity with promotions highlighted against the full review cadence.</p>
        </div>
      </div>
      <ArenaChart
        series={[
          { label: 'Reviews', color: 'var(--accent)', points: learningTrendSeries },
          { label: 'Promotions', color: 'var(--positive)', points: learningPromoteTrendSeries }
        ]}
      />
      <div class="chart-footnote">
        <span>{learningTrendSeries.reduce((sum, value) => sum + value, 0)} reviews over {TREND_DAYS} days</span>
        <span>{learningPromotions7d} promotions in the current 7d window</span>
      </div>
    </div>

    <div class="list-item">
      <div class="panel-header">
        <div>
          <h3>Lane allocation trend</h3>
          <p>Lane-level capital shifts, including de-risk and quarantine activity.</p>
        </div>
      </div>
      <ArenaChart
        series={[
          { label: 'Lane decisions', color: 'var(--warning)', points: laneTrendSeries },
          { label: 'Risk cuts', color: 'var(--negative)', points: laneRiskTrendSeries }
        ]}
      />
      <div class="chart-footnote">
        <span>{laneTrendSeries.reduce((sum, value) => sum + value, 0)} lane decisions over {TREND_DAYS} days</span>
        <span>{laneCuts7d} cuts in the current 7d window</span>
      </div>
    </div>
  </div>

  <div class="dual-grid">
    <div>
      <div class="panel-header">
        <div>
          <h3>Self-learning decisions</h3>
          <p>Fast loop decisions from the paper engine and slow-loop promotions from the review cycle.</p>
        </div>
      </div>

      {#if visibleLearning.length > 0}
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Agent</th>
                <th>Action</th>
                <th>PF</th>
                <th>Win</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {#each visibleLearning as row}
                <tr>
                  <td class="subtle">{formatTimestamp(row.timestamp)}</td>
                  <td>
                    <strong>{row.agentName}</strong>
                    <div class="subtle">{row.symbol}</div>
                  </td>
                  <td>
                    <span class={`bias-chip bias-chip--${row.action === 'promote' ? 'press-edge' : row.action === 'evolve' ? 'tighten-risk' : 'hold-steady'}`}>
                      {row.action}
                    </span>
                  </td>
                  <td class:status-positive={row.currentPF >= 1.0} class:status-negative={row.currentPF < 1.0}>{row.currentPF.toFixed(2)}</td>
                  <td class:status-positive={row.currentWinRate >= 52} class:status-warning={row.currentWinRate >= 40 && row.currentWinRate < 52} class:status-negative={row.currentWinRate < 40}>{row.currentWinRate.toFixed(1)}%</td>
                  <td class="subtle">{row.reason}</td>
                </tr>
                {#if mode === 'detail' && (row.newConfig || row.backtestResult)}
                  <tr class="table-detail-row">
                    <td colspan="6">
                      {#if row.newConfig}
                        <div class="detail-row">
                          <span>target {row.newConfig.targetBps.toFixed(2)} bps</span>
                          <span>stop {row.newConfig.stopBps.toFixed(2)} bps</span>
                          <span>hold {row.newConfig.maxHoldTicks}</span>
                          <span>size {row.newConfig.sizeFraction.toFixed(2)}</span>
                        </div>
                      {/if}
                      {#if row.backtestResult}
                        <div class="detail-row">
                          <span>backtest PF {row.backtestResult.profitFactor.toFixed(2)}</span>
                          <span>win {row.backtestResult.winRate.toFixed(1)}%</span>
                          <span>sharpe {row.backtestResult.sharpeRatio.toFixed(2)}</span>
                          <span>return {row.backtestResult.totalReturnPct.toFixed(2)}%</span>
                        </div>
                      {/if}
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="list-item">
          <h4>No learning decisions yet</h4>
          <p class="subtle">Waiting for the first review cycle or promotion log.</p>
        </div>
      {/if}
    </div>

    <div>
      <div class="panel-header">
        <div>
          <h3>Lane allocation decisions</h3>
          <p>Pairs, grid, and maker lanes move separately from the scalping desk.</p>
        </div>
      </div>

      {#if visibleLaneLearning.length > 0}
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Strategy</th>
                <th>Lane</th>
                <th>Action</th>
                <th>Alloc</th>
                <th>Net edge</th>
              </tr>
            </thead>
            <tbody>
              {#each visibleLaneLearning as row}
                <tr>
                  <td class="subtle">{formatTimestamp(row.timestamp)}</td>
                  <td>
                    <strong>{row.strategy}</strong>
                    <div class="subtle">{row.strategyId}</div>
                  </td>
                  <td>{row.lane}</td>
                  <td>
                    <span class={`bias-chip bias-chip--${row.action === 'promote' ? 'press-edge' : row.action === 'quarantine' || row.action === 'de-risk' ? 'tighten-risk' : 'hold-steady'}`}>
                      {row.action}
                    </span>
                  </td>
                  <td class:status-positive={row.allocationMultiplier >= 1.0} class:status-negative={row.allocationMultiplier < 0.5} class:status-warning={row.allocationMultiplier >= 0.5 && row.allocationMultiplier < 1.0}>{row.allocationMultiplier.toFixed(2)}x</td>
                  <td class:status-positive={row.avgExpectedNetEdgeBps > 0} class:status-negative={row.avgExpectedNetEdgeBps <= 0}>{row.avgExpectedNetEdgeBps.toFixed(2)} bps</td>
                </tr>
                {#if mode === 'detail'}
                  <tr class="table-detail-row">
                    <td colspan="6">
                      <div class="detail-row">
                        <span>win {row.posteriorWinRate.toFixed(1)}%</span>
                        <span>PF {row.profitFactor.toFixed(2)}</span>
                        <span>expectancy {row.expectancy.toFixed(2)}</span>
                        <span>confidence {row.avgConfidencePct.toFixed(1)}%</span>
                      </div>
                      <p class="subtle">{row.reason}</p>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="list-item">
          <h4>No lane learning decisions yet</h4>
          <p class="subtle">Pairs/grid/maker lanes need more samples before they start voting.</p>
        </div>
      {/if}
    </div>
  </div>

  {#if latestLearning || latestLane}
    <div class="list-card">
      {#if latestLearning}
        <article class="list-item">
          <div class="panel-header">
            <div>
              <h4>Latest self-learning · {latestLearning.agentName}</h4>
              <p>{latestLearning.symbol} · {formatTimestamp(latestLearning.timestamp)}</p>
            </div>
            <span class={`bias-chip bias-chip--${latestLearning.action === 'promote' ? 'press-edge' : latestLearning.action === 'evolve' ? 'tighten-risk' : 'hold-steady'}`}>{latestLearning.action}</span>
          </div>
          <p>{latestLearning.reason}</p>
        </article>
      {/if}
      {#if latestLane}
        <article class="list-item">
          <div class="panel-header">
            <div>
              <h4>Latest lane decision · {latestLane.strategy}</h4>
              <p>{latestLane.lane} · {formatTimestamp(latestLane.timestamp)}</p>
            </div>
            <span class={`bias-chip bias-chip--${latestLane.action === 'promote' ? 'press-edge' : latestLane.action === 'quarantine' || latestLane.action === 'de-risk' ? 'tighten-risk' : 'hold-steady'}`}>{latestLane.action}</span>
          </div>
          <p>{latestLane.reason}</p>
        </article>
      {/if}
    </div>
  {/if}
</div>

<style>
  .stack {
    display: grid;
    gap: 1rem;
  }

  .dual-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 1rem;
  }

  .detail-row {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    color: var(--muted-foreground, #92a0b8);
    font-size: 0.92rem;
  }
</style>
