<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    CopySleeveBacktestResult,
    CopySleeveManagerId,
    CopySleevePortfolioSnapshot
  } from '@hermes/contracts';
  import ArenaChart from '$lib/components/ArenaChart.svelte';
  import { currency, percent, signed } from '$lib/format';

  export let managerId: CopySleeveManagerId = 'berkshire-hathaway';
  export let mode: 'summary' | 'detail' = 'summary';

  let snapshot: CopySleevePortfolioSnapshot | null = null;
  let backtest: CopySleeveBacktestResult | null = null;
  let loading = true;
  let snapshotError = '';
  let backtestError = '';
  let refreshedAt = '';

  function formatDateTime(value?: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function formatDate(value?: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
  }

  async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' }
    });
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
    snapshot = null;
    backtest = null;

    const load = async () => {
      const query = `managerId=${encodeURIComponent(managerId)}`;
      const [snapshotResult, backtestResult] = await Promise.allSettled([
        fetchJson<CopySleevePortfolioSnapshot>(`/api/copy-sleeve?${query}`),
        fetchJson<CopySleeveBacktestResult>(`/api/copy-sleeve/backtest?${query}`)
      ]);

      if (cancelled) return;

      if (snapshotResult.status === 'fulfilled') {
        snapshot = snapshotResult.value;
      } else {
        snapshotError = snapshotResult.reason instanceof Error ? snapshotResult.reason.message : 'Snapshot unavailable';
      }

      if (backtestResult.status === 'fulfilled') {
        backtest = backtestResult.value;
      } else {
        backtestError = backtestResult.reason instanceof Error ? backtestResult.reason.message : 'Backtest unavailable';
      }

      loading = false;
      refreshedAt = new Date().toLocaleString();
    };

    void load();

    return () => {
      cancelled = true;
    };
  });

  $: latestFiling = snapshot?.latestFiling ?? null;
  $: displayHoldings = latestFiling?.holdings.slice(0, mode === 'detail' ? 12 : 6) ?? [];
  $: resolvedHoldings = latestFiling?.holdings.filter((holding) => holding.resolved).length ?? 0;
  $: totalHoldings = latestFiling?.holdings.length ?? 0;
  $: allNotes = [
    ...(snapshot?.notes ?? []),
    ...(backtest?.notes ?? [])
  ];
  $: backtestWindow = backtest ? `${formatDate(backtest.startDate)} → ${formatDate(backtest.endDate)}` : '—';
  $: headerMessage = snapshot
    ? `Latest filing available ${formatDateTime(latestFiling?.availableAt ?? latestFiling?.filingDate)}`
    : loading
      ? 'Loading live SEC 13F data and quarter backtest...'
      : snapshotError
        ? `Snapshot unavailable: ${snapshotError}`
        : 'Snapshot unavailable';
</script>

<div class="stack">
  {#if snapshotError || backtestError}
    <div class="advisory-banner">
      <span>Unavailable</span>
      <span>{snapshotError || 'SEC snapshot loaded'}</span>
      <span>{backtestError || 'quarter backtest loaded'}</span>
    </div>
  {:else if loading}
    <div class="advisory-banner">
      <span>Loading</span>
      <span>SEC 13F snapshot</span>
      <span>quarter backtest</span>
    </div>
  {:else}
    <div class="advisory-banner">
      <span>Delayed public-manager sleeve</span>
      <span>SEC 13F + historical price data only</span>
      <span>No fake values; unavailable stays unavailable</span>
    </div>
  {/if}

  <div class="subtle">{headerMessage}</div>

  <div class="technical-readout">
    <div class="readout-card">
      <span class="eyebrow">Latest Filing Value</span>
      <strong>{latestFiling ? currency(latestFiling.totalValueUsd) : '—'}</strong>
      <small>
        {#if latestFiling}
          filing date {latestFiling.filingDate} · {latestFiling.holdings.length} holdings
        {:else if loading}
          waiting for SEC 13F data
        {:else}
          {snapshotError || 'No filing data available'}
        {/if}
      </small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Resolved Coverage</span>
      <strong>{latestFiling ? `${latestFiling.resolvedWeightPct.toFixed(2)}%` : '—'}</strong>
      <small>
        {#if latestFiling}
          unresolved {latestFiling.unresolvedWeightPct.toFixed(2)}% · mapped {resolvedHoldings}/{totalHoldings}
        {:else if loading}
          waiting for filing resolution
        {:else}
          {snapshotError || 'Coverage unavailable'}
        {/if}
      </small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Quarter Net Return</span>
      <strong>{backtest ? percent(backtest.netReturnPct) : '—'}</strong>
      <small>
        {#if backtest}
          {signed(backtest.totalPnL)} PnL · {currency(backtest.totalFeesUsd)} fees
        {:else if loading}
          loading quarter simulation
        {:else}
          {backtestError || 'Backtest unavailable'}
        {/if}
      </small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Benchmark</span>
      <strong>{backtest ? percent(backtest.benchmarkReturnPct) : '—'}</strong>
      <small>
        {#if backtest}
          max drawdown {backtest.maxDrawdownPct.toFixed(2)}% · {backtest.rebalances} rebalance{backtest.rebalances === 1 ? '' : 's'}
        {:else if loading}
          loading benchmark comparison
        {:else}
          {backtestError || 'Benchmark unavailable'}
        {/if}
      </small>
    </div>
  </div>

  {#if mode === 'detail'}
    {#if backtest}
      <div class="list-item">
        <div class="panel-header">
          <div>
            <h3>Quarter curve</h3>
            <p>{backtestWindow} · {backtest.managerName} vs {backtest.benchmarkSymbol}</p>
          </div>
          <div class="subtle">Refreshed {refreshedAt || 'just now'}</div>
        </div>
        <ArenaChart
          series={[
            { label: `${backtest.managerName} copy sleeve`, color: 'var(--accent)', points: backtest.curve }
          ]}
        />
        <div class="chart-footnote">
          <span>{backtestWindow}</span>
          <span>{backtest.periods.length} period{backtest.periods.length === 1 ? '' : 's'} · {backtest.totalFeesUsd.toFixed(2)} fees</span>
        </div>
      </div>
    {:else if loading}
      <div class="list-item">
        <h4>Quarter backtest loading</h4>
        <p class="subtle">Fetching the last completed quarter from the backtest service.</p>
      </div>
    {:else}
      <div class="advisory-banner">
        <span>Backtest unavailable</span>
        <span>{backtestError || 'No backtest result returned'}</span>
      </div>
    {/if}
  {/if}

  <div>
    <div class="panel-header">
      <div>
        <h3>Top holdings</h3>
        <p>{snapshot ? `${latestFiling?.holdings.length ?? 0} holdings mapped from the latest filing` : 'Waiting for filing data'}</p>
      </div>
      <div class="subtle">{snapshot ? `as of ${snapshot.asOf}` : 'loading...'}</div>
    </div>

    {#if displayHoldings.length > 0}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Issuer</th>
              <th>Symbol</th>
              <th>Weight</th>
              <th>Value</th>
              <th>Resolution</th>
            </tr>
          </thead>
          <tbody>
            {#each displayHoldings as holding}
              <tr>
                <td>
                  <strong>{holding.issuerName}</strong>
                  <div class="subtle">{holding.titleOfClass ?? 'n/a'} · {holding.cusip ?? 'no CUSIP'}</div>
                </td>
                <td>{holding.symbol ?? '—'}</td>
                <td>{holding.weightPct.toFixed(2)}%</td>
                <td>{currency(holding.valueUsd)}</td>
                <td>
                  <span class="subtle">{holding.resolutionMethod}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if loading}
      <div class="list-item">
        <h4>Holdings loading</h4>
        <p class="subtle">SEC holdings are still being fetched.</p>
      </div>
    {:else}
      <div class="advisory-banner">
        <span>Holdings unavailable</span>
        <span>{snapshotError || 'No mapped holdings returned'}</span>
      </div>
    {/if}
  </div>

  {#if allNotes.length > 0}
    <div class="list-card">
      {#each allNotes as note}
        <article class="list-item">
          <p>{note}</p>
        </article>
      {/each}
    </div>
  {/if}

  <div class="chart-footnote">
    <span>
      {#if snapshot}
        SEC filing {latestFiling?.filingDate} · {snapshot.managerName}
      {:else if loading}
        loading live SEC snapshot
      {:else}
        snapshot unavailable
      {/if}
    </span>
    <span>
      <a href="/copy-sleeve">Open full copy-sleeve page</a>
    </span>
  </div>
</div>
