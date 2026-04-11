<script lang="ts">
  import { onMount } from 'svelte';
  import type { QuarterSimulationClassSummary, QuarterSimulationReport } from '@hermes/contracts';
  import ArenaChart from '$lib/components/ArenaChart.svelte';
  import { currency, percent, signed } from '$lib/format';

  export let mode: 'summary' | 'detail' = 'summary';

  let report: QuarterSimulationReport | null = null;
  let loading = true;
  let error = '';
  let refreshedAt = '';

  const classOrder: QuarterSimulationClassSummary['classKey'][] = ['crypto', 'stocks', 'forex', 'bond'];

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
    error = '';

    const load = async () => {
      try {
        const result = await fetchJson<QuarterSimulationReport>('/api/quarter-outlook');
        if (cancelled) return;
        report = result;
        refreshedAt = new Date().toLocaleString();
      } catch (err) {
        if (cancelled) return;
        error = err instanceof Error ? err.message : 'Quarter outlook unavailable';
      } finally {
        if (!cancelled) loading = false;
      }
    };

    void load();
    const interval = setInterval(() => { void load(); }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  });

  $: overall = report?.overall ?? null;
  $: classSummaries = report?.classSummaries ?? [];
  $: orderedClasses = classOrder
    .map((classKey) => classSummaries.find((summary) => summary.classKey === classKey))
    .filter((value): value is QuarterSimulationClassSummary => Boolean(value));
  $: bestClass = [...orderedClasses].sort((left, right) => right.nextQuarter.strategyMedianReturnPct - left.nextQuarter.strategyMedianReturnPct)[0] ?? null;
  $: weakestClass = [...orderedClasses].sort((left, right) => left.lastQuarter.strategyReturnPct - right.lastQuarter.strategyReturnPct)[0] ?? null;
  $: strategyLastQuarterPnL = report ? report.capital * (report.overall.lastQuarter.strategyReturnPct / 100) : 0;
  $: benchmarkLastQuarterPnL = report ? report.capital * (report.overall.lastQuarter.benchmarkReturnPct / 100) : 0;
  $: strategyNextQuarterPnL = report ? report.capital * (report.overall.nextQuarter.strategyMedianReturnPct / 100) : 0;
  $: benchmarkNextQuarterPnL = report ? report.capital * (report.overall.nextQuarter.benchmarkMedianReturnPct / 100) : 0;
  $: curveSeries = overall
    ? [
        { label: 'Strategy basket', color: 'var(--accent)', points: overall.strategyCurve },
        { label: 'Passive basket', color: 'var(--warning)', points: overall.benchmarkCurve }
      ]
    : [];
  $: symbolRows = orderedClasses.flatMap((summary) => summary.perSymbol.map((symbol) => ({ ...symbol, classKey: summary.classKey })));
  $: totalSymbols = classSummaries.reduce((sum, summary) => sum + summary.symbols.length, 0);
</script>

<div class="stack">
  <div class="advisory-banner">
    <span>Simulation-backed quarter outlook</span>
    <span>historical backtest + bootstrap next-quarter projection</span>
    <span>not a profit guarantee</span>
  </div>

  {#if error}
    <div class="advisory-banner">
      <span>Unavailable</span>
      <span>{error}</span>
    </div>
  {:else if loading}
    <div class="advisory-banner">
      <span>Loading</span>
      <span>last-quarter simulation</span>
      <span>next-quarter projection</span>
    </div>
  {/if}

  <div class="technical-readout">
    <div class="readout-card">
      <span class="eyebrow">Last Quarter Strategy</span>
      <strong>{report ? percent(report.overall.lastQuarter.strategyReturnPct) : '—'}</strong>
      <small>
        {#if report}
          {signed(strategyLastQuarterPnL)} on {currency(report.capital)} base · passive {percent(report.overall.lastQuarter.benchmarkReturnPct)}
        {:else if loading}
          running quarter backtest
        {:else}
          waiting for historical inputs
        {/if}
      </small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Passive Baseline</span>
      <strong>{report ? percent(report.overall.lastQuarter.benchmarkReturnPct) : '—'}</strong>
      <small>
        {#if report}
          {signed(benchmarkLastQuarterPnL)} on the same basket · max DD {report.overall.lastQuarter.benchmarkMaxDrawdownPct.toFixed(2)}%
        {:else if loading}
          loading market benchmark
        {:else}
          benchmark unavailable
        {/if}
      </small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Next Quarter Median</span>
      <strong>{report ? percent(report.overall.nextQuarter.strategyMedianReturnPct) : '—'}</strong>
      <small>
        {#if report}
          ≈ {signed(strategyNextQuarterPnL)} on {currency(report.capital)} base · benchmark {percent(report.overall.nextQuarter.benchmarkMedianReturnPct)}
        {:else if loading}
          projecting next quarter
        {:else}
          projection unavailable
        {/if}
      </small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Positive Path</span>
      <strong>{report ? percent(report.overall.nextQuarter.strategyPositivePct) : '—'}</strong>
      <small>
        {#if report}
          benchmark positive-path {percent(report.overall.nextQuarter.benchmarkPositivePct)} · symbols {totalSymbols}
        {:else if loading}
          bootstrapping scenarios
        {:else}
          scenario unavailable
        {/if}
      </small>
    </div>
  </div>

  {#if overall}
    <div class="panel">
      <div class="panel-header">
        <div>
          <h3>Quarter curve</h3>
          <p>
            {report?.startDate.slice(0, 10)} → {report?.endDate.slice(0, 10)} ·
            equal-weight strategy basket versus passive basket baseline
          </p>
        </div>
        <div class="subtle">Updated {refreshedAt || 'just now'}</div>
      </div>
      <ArenaChart series={curveSeries} />
      {#if bestClass && weakestClass}
        <div class="quarter-note">
          <span>Best projected class: {bestClass.classKey.toUpperCase()} · {percent(bestClass.nextQuarter.strategyMedianReturnPct)}</span>
          <span>Weakest trailing class: {weakestClass.classKey.toUpperCase()} · {percent(weakestClass.lastQuarter.strategyReturnPct)}</span>
        </div>
      {/if}
      <div class="chart-footnote">
        <span>{report?.capital.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} simulation base</span>
        <span>{report?.interval ?? '1h'} bars · bootstrap forecast from last quarter</span>
      </div>
    </div>
  {/if}

  <div class="panel-header">
    <div>
      <h3>Asset-class scorecard</h3>
      <p>Crypto, stocks, forex, and bonds shown separately so one sleeve cannot hide another.</p>
    </div>
    <div class="subtle">{report ? `${report.classSummaries.length} classes` : 'loading...'}</div>
  </div>

  {#if orderedClasses.length > 0}
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Class</th>
            <th>Last Q Strategy</th>
            <th>Last Q Passive</th>
            <th>Edge</th>
            <th>Win Rate</th>
            <th>Accuracy</th>
            <th>Next Q Median</th>
            <th>Next Q Positive</th>
            <th>Symbols</th>
          </tr>
        </thead>
        <tbody>
          {#each orderedClasses as summary}
            <tr>
              <td>
                <strong>{summary.classKey.toUpperCase()}</strong>
              </td>
              <td class:status-positive={summary.lastQuarter.strategyReturnPct >= 0} class:status-negative={summary.lastQuarter.strategyReturnPct < 0}>
                {percent(summary.lastQuarter.strategyReturnPct)}
              </td>
              <td class:status-positive={summary.lastQuarter.benchmarkReturnPct >= 0} class:status-negative={summary.lastQuarter.benchmarkReturnPct < 0}>
                {percent(summary.lastQuarter.benchmarkReturnPct)}
              </td>
              <td class:status-positive={summary.lastQuarter.strategyReturnPct - summary.lastQuarter.benchmarkReturnPct >= 0} class:status-negative={summary.lastQuarter.strategyReturnPct - summary.lastQuarter.benchmarkReturnPct < 0}>
                {percent(summary.lastQuarter.strategyReturnPct - summary.lastQuarter.benchmarkReturnPct)}
              </td>
              <td>{summary.lastQuarter.winRate.toFixed(1)}%</td>
              <td class:status-positive={summary.accuracyPct >= 60} class:status-negative={summary.accuracyPct < 50}>
                {summary.accuracyPct.toFixed(1)}%
              </td>
              <td class:status-positive={summary.nextQuarter.strategyMedianReturnPct >= 0} class:status-negative={summary.nextQuarter.strategyMedianReturnPct < 0}>
                {percent(summary.nextQuarter.strategyMedianReturnPct)}
              </td>
              <td>{summary.nextQuarter.strategyPositivePct.toFixed(1)}%</td>
              <td>
                <span class="subtle">{summary.symbols.join(', ')}</span>
              </td>
            </tr>
            {#if mode === 'detail'}
              <tr class="table-detail-row">
                <td colspan="9">
                  <div class="detail-row">
                    <span>Accuracy {summary.accuracyPct.toFixed(1)}%</span>
                    <span>Class max DD {summary.lastQuarter.strategyMaxDrawdownPct.toFixed(2)}%</span>
                    <span>Projection range {percent(summary.nextQuarter.strategyP25ReturnPct)} → {percent(summary.nextQuarter.strategyP75ReturnPct)}</span>
                    <span>Benchmark range {percent(summary.nextQuarter.benchmarkP25ReturnPct)} → {percent(summary.nextQuarter.benchmarkP75ReturnPct)}</span>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
    <div class="chart-footnote">
      <span>Accuracy rating blends trailing win rate, next-quarter positive-path probability, and scenario width.</span>
      <span>50% is roughly neutral; higher is more reliable.</span>
    </div>
  {:else if loading}
    <div class="list-item">
      <h4>Quarter outlook loading</h4>
      <p class="subtle">Fetching the current quarter simulation and projected scenario bands.</p>
    </div>
  {/if}

  {#if mode === 'detail' && report}
    <div class="panel-header">
      <div>
        <h3>Symbol breakdown</h3>
        <p>Per-symbol results make it obvious which legs are helping or dragging the basket.</p>
      </div>
      <div class="subtle">Nominal base {currency(report.capital)}</div>
    </div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Class</th>
            <th>Strategy Return</th>
            <th>Passive Return</th>
            <th>PF</th>
            <th>Win Rate</th>
            <th>Trades</th>
          </tr>
        </thead>
        <tbody>
          {#each symbolRows as row}
            <tr>
              <td><strong>{row.symbol}</strong></td>
              <td class="subtle">{row.classKey.toUpperCase()}</td>
              <td class:status-positive={row.strategyReturnPct >= 0} class:status-negative={row.strategyReturnPct < 0}>{percent(row.strategyReturnPct)}</td>
              <td class:status-positive={row.benchmarkReturnPct >= 0} class:status-negative={row.benchmarkReturnPct < 0}>{percent(row.benchmarkReturnPct)}</td>
              <td>{row.strategyProfitFactor.toFixed(2)}</td>
              <td>{row.strategyWinRate.toFixed(1)}%</td>
              <td>{row.strategyTrades}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if report?.notes?.length}
    <div class="list-card">
      {#each report.notes as note}
        <article class="list-item">
          <p>{note}</p>
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .stack {
    display: grid;
    gap: 1rem;
  }

  .quarter-note,
  .detail-row {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    color: var(--muted-foreground, #92a0b8);
    font-size: 0.92rem;
  }
</style>
