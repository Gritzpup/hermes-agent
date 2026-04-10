<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    MacroPreservationBacktestResult,
    MacroPreservationPortfolioSnapshot
  } from '@hermes/contracts';
  import ArenaChart from '$lib/components/ArenaChart.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import { currency, percent } from '$lib/format';

  export let mode: 'summary' | 'detail' = 'summary';

  let snapshot: MacroPreservationPortfolioSnapshot | null = null;
  let backtest: MacroPreservationBacktestResult | null = null;
  let loading = true;
  let snapshotError = '';
  let backtestError = '';
  let refreshedAt = '';

  function formatDate(value?: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
  }

  function formatDateTime(value?: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  onMount(() => {
    let cancelled = false;
    loading = true;
    snapshotError = '';
    backtestError = '';

    const load = async () => {
      const backtestQuery = mode === 'detail'
        ? 'startDate=2010-01-01T00:00:00.000Z'
        : 'startDate=2018-01-01T00:00:00.000Z';
      const [snapshotResult, backtestResult] = await Promise.allSettled([
        fetchJson<MacroPreservationPortfolioSnapshot>('/api/macro-preservation'),
        fetchJson<MacroPreservationBacktestResult>(`/api/macro-preservation/backtest?${backtestQuery}`)
      ]);

      if (cancelled) return;

      if (snapshotResult.status === 'fulfilled') {
        snapshot = snapshotResult.value;
      } else {
        snapshotError = snapshotResult.reason instanceof Error ? snapshotResult.reason.message : 'Macro snapshot unavailable';
      }

      if (backtestResult.status === 'fulfilled') {
        backtest = backtestResult.value;
      } else {
        backtestError = backtestResult.reason instanceof Error ? backtestResult.reason.message : 'Macro backtest unavailable';
      }

      loading = false;
      refreshedAt = new Date().toLocaleString();
    };

    void load();

    return () => {
      cancelled = true;
    };
  });

  $: latestObservation = snapshot?.latestObservation ?? null;
  $: allocationRows = snapshot?.selectedAllocations ?? [];
  $: inflationPeriods = backtest?.inflationPeriods ?? [];
  $: chartSeries = backtest
    ? [
        { label: `${backtest.benchmarkSymbol} preservation sleeve`, color: 'var(--accent)', points: backtest.curve },
        { label: `${backtest.benchmarkSymbol} benchmark`, color: 'var(--warning)', points: backtest.benchmarkCurve },
        { label: `${backtest.cashSymbol} cash`, color: 'var(--positive)', points: backtest.cashCurve }
      ]
    : [];
  $: recentCpi = snapshot?.recentObservations ?? [];
  $: statusLabel = snapshot
    ? snapshot.inflationHot
      ? `inflation active: ${snapshot.regime}`
      : 'cash fallback'
    : loading
      ? 'loading macro data...'
      : 'unavailable';
</script>

<div class="stack">
  <div class="advisory-banner">
    <span>Macro preservation sleeve</span>
    <span>cash-first until inflation actually shows up</span>
    <span>no fake values, no hidden guesses</span>
  </div>

  {#if snapshotError || backtestError}
    <div class="advisory-banner">
      <span>Unavailable</span>
      <span>{snapshotError || 'snapshot loaded'}</span>
      <span>{backtestError || 'backtest loaded'}</span>
    </div>
  {:else if loading}
    <div class="advisory-banner">
      <span>Loading</span>
      <span>macro snapshot</span>
      <span>inflation-aware backtest</span>
    </div>
  {/if}

  <div class="grid-hero">
    <MetricCard
      title="Regime"
      value={statusLabel}
      delta={snapshot ? `threshold ${snapshot.inflationThresholdPct.toFixed(2)}% CPI YoY` : 'waiting for CPI history'}
      points={snapshot ? snapshot.selectedAllocations.map((allocation) => allocation.weightPct) : []}
      tone={snapshot?.inflationHot ? 'warning' : 'positive'}
    />
    <MetricCard
      title="Latest CPI YoY"
      value={latestObservation ? percent(latestObservation.yoyPct) : '—'}
      delta={latestObservation ? `release ${formatDateTime(latestObservation.availableAt)}` : 'no released CPI yet'}
      points={recentCpi.map((point) => point.yoyPct)}
      tone={latestObservation && latestObservation.yoyPct >= (snapshot?.inflationThresholdPct ?? 3) ? 'warning' : 'positive'}
    />
    <MetricCard
      title="Net Return"
      value={backtest ? percent(backtest.netReturnPct) : '—'}
      delta={backtest ? `${currency(backtest.totalPnL)} PnL · ${currency(backtest.totalFeesUsd)} fees` : 'backtest pending'}
      points={backtest?.curve ?? []}
      tone={backtest && backtest.netReturnPct >= 0 ? 'positive' : 'negative'}
    />
    <MetricCard
      title="Inflation Periods"
      value={backtest ? `${backtest.inflationPeriodCount}` : '—'}
      delta={backtest ? `inflation return ${percent(backtest.inflationReturnPct)} vs SPY ${percent(backtest.inflationBenchmarkReturnPct)}` : 'waiting for period analysis'}
      points={inflationPeriods.map((period) => period.sleeveReturnPct)}
      tone={backtest && backtest.inflationReturnPct >= 0 ? 'positive' : 'warning'}
    />
  </div>

  {#if mode === 'detail'}
    {#if backtest}
      <div class="panel">
        <div class="panel-header">
          <div>
            <h3>Macro preservation curve</h3>
            <p>{formatDate(backtest.startDate)} → {formatDate(backtest.endDate)} · {backtest.benchmarkSymbol} benchmark · {backtest.cashSymbol} cash fallback</p>
          </div>
          <div class="subtle">Refreshed {refreshedAt || 'just now'}</div>
        </div>
        <ArenaChart series={chartSeries} />
        <div class="chart-footnote">
          <span>{backtest.periods.length} rebalance period{backtest.periods.length === 1 ? '' : 's'}</span>
          <span>{currency(backtest.totalFeesUsd)} fees · max drawdown {backtest.maxDrawdownPct.toFixed(2)}%</span>
        </div>
      </div>
    {:else if loading}
      <div class="list-item">
        <h4>Backtest loading</h4>
        <p class="subtle">Fetching the full inflation-aware history.</p>
      </div>
    {/if}
  {/if}

  <div class="dual-grid">
    <div>
      <div class="panel-header">
        <div>
          <h3>Current posture</h3>
          <p>Real assets only when inflation is hot; otherwise the sleeve stays in cash.</p>
        </div>
        <div class="subtle">{snapshot ? `as of ${formatDateTime(snapshot.asOf)}` : 'loading...'}</div>
      </div>

      {#if allocationRows.length > 0}
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Weight</th>
                <th>Trailing</th>
                <th>Score</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {#each allocationRows as allocation}
                <tr>
                  <td>
                    <strong>{allocation.symbol}</strong>
                    <div class="subtle">{allocation.name}</div>
                  </td>
                  <td>{allocation.weightPct.toFixed(2)}%</td>
                  <td>{percent(allocation.trailingReturnPct)}</td>
                  <td>{allocation.score.toFixed(2)}</td>
                  <td class="subtle">{allocation.reason}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if loading}
        <div class="list-item">
          <h4>Allocation data loading</h4>
          <p class="subtle">Waiting for the current macro posture.</p>
        </div>
      {/if}
    </div>

    <div>
      <div class="panel-header">
        <div>
          <h3>Inflation periods</h3>
          <p>Segments where CPI crossed the threshold and the sleeve left cash.</p>
        </div>
      </div>

      {#if inflationPeriods.length > 0}
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Start</th>
                <th>End</th>
                <th>Regime</th>
                <th>Sleeve</th>
                <th>SPY</th>
                <th>Cash</th>
              </tr>
            </thead>
            <tbody>
              {#each inflationPeriods.slice(0, mode === 'detail' ? 10 : 5) as period}
                <tr>
                  <td>{formatDate(period.startDate)}</td>
                  <td>{formatDate(period.endDate)}</td>
                  <td>{period.regime}</td>
                  <td>{percent(period.sleeveReturnPct)}</td>
                  <td>{percent(period.benchmarkReturnPct)}</td>
                  <td>{percent(period.cashReturnPct)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if loading}
        <div class="list-item">
          <h4>Inflation period analysis loading</h4>
          <p class="subtle">The macro sleeve is still checking the inflation history.</p>
        </div>
      {:else}
        <div class="advisory-banner">
          <span>No inflation periods found</span>
          <span>{backtestError || 'The current threshold did not produce an inflation sleeve window.'}</span>
        </div>
      {/if}
    </div>
  </div>

  {#if snapshot?.notes?.length || backtest?.notes?.length}
    <div class="list-card">
      {#each [...(snapshot?.notes ?? []), ...(backtest?.notes ?? [])] as note}
        <article class="list-item">
          <p>{note}</p>
        </article>
      {/each}
    </div>
  {/if}

  <div class="chart-footnote">
    <span>{snapshot ? `latest CPI ${latestObservation ? percent(latestObservation.yoyPct) : '—'}` : 'loading macro data'}</span>
    <span>
      <a href="/macro-preservation">Open full macro-preservation page</a>
    </span>
  </div>
</div>
