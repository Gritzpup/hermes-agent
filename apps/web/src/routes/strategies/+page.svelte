<script lang="ts">
  import type { PageData } from './$types';
  import { currency } from '$lib/format';
  import Panel from '$lib/components/Panel.svelte';

  export let data: PageData;
</script>

<div class="stack">
  {#each data.strategies as strategy}
    <Panel title={strategy.name} subtitle={strategy.summary} aside={`Stage: ${strategy.stage}`}>
      <div class="dual-grid">
        <div class="list-item">
          <h4>Deployment</h4>
          <p>{strategy.mode} on {strategy.broker}</p>
          <p class="subtle">Symbols: {strategy.symbols.join(', ')}</p>
        </div>
        <div class="list-item">
          <h4>Daily PnL</h4>
          <p>{currency(strategy.dailyPnl)}</p>
          <p class="subtle">Status: {strategy.status} · Last review {new Date(strategy.lastReviewAt).toLocaleString()}</p>
        </div>
      </div>
    </Panel>
  {/each}
</div>
