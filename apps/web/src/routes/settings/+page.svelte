<script lang="ts">
  import type { PageData } from './$types';
  import { currency } from '$lib/format';
  import Panel from '$lib/components/Panel.svelte';

  export let data: PageData;
</script>

<section class="dual-grid">
  <Panel title="Broker Routing" subtitle="Paper and live are deliberately separated to keep promotion honest.">
    <div class="list-card">
      <article class="list-item">
        <h4>Paper Broker</h4>
        <p>{data.settings.paperBroker}</p>
      </article>
      <article class="list-item">
        <h4>Live Broker</h4>
        <p>{data.settings.liveBroker}</p>
      </article>
      <article class="list-item">
        <h4>Universe</h4>
        <p>{data.settings.universe.join(', ')}</p>
      </article>
    </div>
  </Panel>

  <Panel title="Pilot Caps" subtitle="Autonomous live stays small until the system proves it deserves more room.">
    <div class="list-card">
      <article class="list-item"><h4>Max Trade Notional</h4><p>{currency(data.settings.riskCaps.maxTradeNotional)}</p></article>
      <article class="list-item"><h4>Max Daily Loss</h4><p>{currency(data.settings.riskCaps.maxDailyLoss)}</p></article>
      <article class="list-item"><h4>Max Strategy Exposure</h4><p>{data.settings.riskCaps.maxStrategyExposurePct}%</p></article>
      <article class="list-item"><h4>Max Symbol Exposure</h4><p>{data.settings.riskCaps.maxSymbolExposurePct}%</p></article>
      <article class="list-item"><h4>Max Drawdown</h4><p>{data.settings.riskCaps.maxDrawdownPct}%</p></article>
      <article class="list-item"><h4>Max Slippage</h4><p>{data.settings.riskCaps.maxSlippageBps} bps</p></article>
    </div>
  </Panel>
</section>

<section class="dual-grid">
  <Panel title="Kill Switches" subtitle="Every hard stop should be explicit and visible.">
    <div class="list-card">
      {#each data.settings.killSwitches as item}
        <article class="list-item"><p>{item}</p></article>
      {/each}
    </div>
  </Panel>

  <Panel title="Implementation Notes" subtitle="Known assumptions and constraints for the first cut.">
    <div class="list-card">
      {#each data.settings.notes as note}
        <article class="list-item"><p>{note}</p></article>
      {/each}
    </div>
  </Panel>
</section>
