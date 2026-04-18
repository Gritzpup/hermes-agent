<script lang="ts">
  import type { PaperDeskSnapshot } from '@hermes/contracts';
  import Panel from '$lib/components/Panel.svelte';
  import { currency, signed } from '$lib/format';

  export let paperDesk: PaperDeskSnapshot;

  $: activeBands = (paperDesk.executionBands ?? []).filter((b) => b.entryPrice != null);
</script>

<section class="stack">
  {#if paperDesk}
  <Panel
    title="Adaptive Tuning Matrix"
    subtitle="Scalping parameters move inside hard bounds based on recent paper exits. This is adaptive tuning, not broker-verified self-learning."
  >
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Style</th>
            <th>PF</th>
            <th>Win</th>
            <th>Target</th>
            <th>Stop</th>
            <th>Hold</th>
            <th>Mistake</th>
            <th>Alloc</th>
            <th>Bias</th>
          </tr>
        </thead>
        <tbody>
          {#each paperDesk.tuning ?? [] as row}
            <tr>
              <td>
                <strong>{row.agentName ?? row.agentId}</strong>
                <div class="subtle">{row.symbol}</div>
              </td>
              <td>{row.style ?? '—'}</td>
              <td class:status-positive={(row.profitFactor ?? 0) >= 1.0} class:status-negative={(row.profitFactor ?? 0) < 1.0}>{(row.profitFactor ?? 0).toFixed(2)}</td>
              <td class:status-positive={(row.winRate ?? 0) >= 52} class:status-warning={(row.winRate ?? 0) >= 40 && (row.winRate ?? 0) < 52} class:status-negative={(row.winRate ?? 0) < 40}>{(row.winRate ?? 0).toFixed(1)}%</td>
              <td>{(row.targetBps ?? 0).toFixed(1)}</td>
              <td>{(row.stopBps ?? 0).toFixed(1)}</td>
              <td>{row.maxHoldTicks ?? 0}</td>
              <td>
                <span class:status-positive={row.mistakeTrend === 'improving'} class:status-negative={row.mistakeTrend === 'worsening'}>
                  {row.mistakeScore != null ? row.mistakeScore.toFixed(1) : '—'} {row.mistakeTrend ?? ''}
                </span>
              </td>
              <td>
                <strong>{row.allocationMultiplier != null ? `${row.allocationMultiplier.toFixed(2)}x` : '—'}</strong>
              </td>
              <td>
                <span class="bias-chip bias-chip--{row.improvementBias ?? 'neutral'}">{row.improvementBias ?? 'neutral'}</span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Panel>

  <Panel title="Open Risk Bands" subtitle="Current positions with active price range and unrealized PnL. Only agents with open positions are shown.">
    {#if activeBands.length === 0}
      <p class="subtle">No open positions. All agents are flat.</p>
    {:else}
      <div class="band-grid">
        {#each activeBands as band}
          <article class="band-card-compact">
            <div class="band-card-compact__head">
              <strong>{band.agentName}</strong>
              <span class="subtle">{band.symbol}</span>
              <span class:status-positive={band.unrealizedPnl >= 0} class:status-negative={band.unrealizedPnl < 0}>{signed(band.unrealizedPnl)}</span>
            </div>
            <div class="band-card-compact__levels">
              <span>E {band.entryPrice ? currency(band.entryPrice) : '—'}</span>
              <span>M {currency(band.currentPrice)}</span>
              <span>S {band.stopPrice ? currency(band.stopPrice) : '—'}</span>
              <span>T {band.targetPrice ? currency(band.targetPrice) : '—'}</span>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </Panel>
{:else}
  <div class="skeleton h-24 bg-neutral-800/40 animate-pulse rounded"></div>
{/if}
</section>
