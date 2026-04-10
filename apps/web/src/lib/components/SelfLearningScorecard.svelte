<script lang="ts">
  import type { PaperStrategyTelemetry } from '@hermes/contracts';

  export let rows: PaperStrategyTelemetry[] = [];

  const trendLabel = (trend?: 'improving' | 'worsening' | 'stable') => trend ?? 'stable';

  $: sorted = [...rows].sort((left, right) => {
    const leftSeverity = left.mistakeScore ?? 0;
    const rightSeverity = right.mistakeScore ?? 0;
    return rightSeverity - leftSeverity || left.agentName.localeCompare(right.agentName);
  });
  $: worstRows = sorted.slice(0, 4);
  $: improvingCount = rows.filter((row) => row.mistakeTrend === 'improving' || row.performanceTrend === 'improving').length;
  $: worseningCount = rows.filter((row) => row.mistakeTrend === 'worsening' || row.performanceTrend === 'worsening').length;
  $: avgMistakeScore = rows.length > 0 ? rows.reduce((sum, row) => sum + (row.mistakeScore ?? 0), 0) / rows.length : 0;
  $: avgAllocation = rows.length > 0 ? rows.reduce((sum, row) => sum + (row.allocationMultiplier ?? 1), 0) / rows.length : 1;
  $: pressCount = rows.filter((row) => (row.allocationMultiplier ?? 1) > 1.05).length;
  $: cutCount = rows.filter((row) => (row.allocationMultiplier ?? 1) < 0.95).length;
</script>

<div class="stack">
  <div class="technical-readout">
    <div class="readout-card">
      <span class="eyebrow">Average mistake score</span>
      <strong>{avgMistakeScore.toFixed(1)}</strong>
      <small>Lower is cleaner; larger means the loop sees more friction.</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Improving lanes</span>
      <strong>{improvingCount}</strong>
      <small>Rows where mistake or performance trend improved.</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Worsening lanes</span>
      <strong>{worseningCount}</strong>
      <small>Rows where the loop is still learning the hard way.</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Average allocation</span>
      <strong>{avgAllocation.toFixed(2)}x</strong>
      <small>{pressCount} pressed · {cutCount} cut</small>
    </div>
  </div>

  {#if sorted.length > 0}
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Dominant mistake</th>
            <th>Severity</th>
            <th>Mistake trend</th>
            <th>Perf trend</th>
            <th>Adjusted?</th>
            <th>Allocator</th>
          </tr>
        </thead>
        <tbody>
          {#each sorted as row}
            <tr>
              <td>
                <strong>{row.symbol}</strong>
                <div class="subtle">{row.agentName}</div>
              </td>
              <td>
                <span>{row.mistakeSummary ?? 'No dominant pattern'}</span>
              </td>
              <td class:status-positive={(row.mistakeScore ?? 0) < 25} class:status-negative={(row.mistakeScore ?? 0) >= 50}>
                {(row.mistakeScore ?? 0).toFixed(1)}
              </td>
              <td class:status-positive={row.mistakeTrend === 'improving'} class:status-negative={row.mistakeTrend === 'worsening'}>
                {trendLabel(row.mistakeTrend)}
                {#if row.mistakeDelta !== undefined}
                  <div class="subtle">Δ {row.mistakeDelta > 0 ? '+' : ''}{row.mistakeDelta.toFixed(1)}</div>
                {/if}
              </td>
              <td class:status-positive={row.performanceTrend === 'improving'} class:status-negative={row.performanceTrend === 'worsening'}>
                {trendLabel(row.performanceTrend)}
                {#if row.performanceDeltaPct !== undefined}
                  <div class="subtle">Δ {row.performanceDeltaPct > 0 ? '+' : ''}{row.performanceDeltaPct.toFixed(1)}pp</div>
                {/if}
              </td>
              <td>
                <span class:status-positive={row.lastAdjustmentImproved} class:status-negative={row.lastAdjustmentImproved === false}>
                  {row.lastAdjustmentImproved === undefined ? 'n/a' : row.lastAdjustmentImproved ? 'yes' : 'no'}
                </span>
                <div class="subtle">{row.lastAdjustment}</div>
              </td>
              <td>
                <strong>{row.allocationMultiplier ? `${row.allocationMultiplier.toFixed(2)}x` : 'n/a'}</strong>
                <div class="subtle">{row.allocationReason ?? 'allocator reason unavailable'}</div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="list-item">
      <h4>Learning scorecard unavailable</h4>
      <p class="subtle">No tuning rows are available yet.</p>
    </div>
  {/if}

  {#if worstRows.length > 0}
    <div class="list-card">
      {#each worstRows as row}
        <article class="list-item">
          <div class="panel-header">
            <div>
              <h4>{row.symbol} · {row.agentName}</h4>
              <p>{row.mistakeSummary ?? 'No dominant pattern yet'}</p>
            </div>
            <span class="subtle">score {(row.mistakeScore ?? 0).toFixed(1)}</span>
          </div>
          <p class="subtle">
            mistake trend {trendLabel(row.mistakeTrend)} · performance trend {trendLabel(row.performanceTrend)} ·
            allocator {(row.allocationMultiplier ?? 1).toFixed(2)}x
          </p>
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
</style>
