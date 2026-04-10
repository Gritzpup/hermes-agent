<script lang="ts">
  import type { PageData } from './$types';
  import { currency, percent } from '$lib/format';
  import Panel from '$lib/components/Panel.svelte';
  import LearningHistorySection from '$lib/components/LearningHistorySection.svelte';

  export let data: PageData;
</script>

<div class="stack">
  <Panel title="Strategy Reviews" subtitle="Closed-loop review proposals stay visible before any promotion step.">
    <div class="list-card">
      {#each data.reviews as review}
        <article class="list-item">
          <h4>{review.strategy}</h4>
          <p>{review.recommendation}</p>
          <p class="subtle">Stage {review.stage} · 30D {currency(review.pnl30d)} · Win rate {review.winRate.toFixed(1)}% · Expectancy {review.expectancy.toFixed(2)}R</p>
          <p class="subtle">Changes: {review.proposedChanges.join(' · ')}</p>
        </article>
      {/each}
    </div>
  </Panel>

  <Panel title="Trade Journal" subtitle="Every trade writes a thesis, fill quality, and exit reason for later review.">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Broker</th>
            <th>Strategy</th>
            <th>Realized</th>
            <th>Return</th>
            <th>Spread</th>
            <th>Slippage</th>
            <th>Verdict</th>
            <th>Exit</th>
          </tr>
        </thead>
        <tbody>
          {#each data.journal as entry}
            <tr>
              <td>{entry.symbol}</td>
              <td>{entry.broker}</td>
              <td>{entry.strategy}</td>
              <td class:status-positive={entry.realizedPnl >= 0} class:status-negative={entry.realizedPnl < 0}>{currency(entry.realizedPnl)}</td>
              <td>{percent(entry.realizedPnlPct)}</td>
              <td>{entry.spreadBps} bps</td>
              <td>{entry.slippageBps} bps</td>
              <td>{entry.verdict}</td>
              <td>{entry.exitReason}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Panel>

  <Panel title="Learning History" subtitle="Persisted review-loop logs and lane-allocation decisions. This is the operational memory behind the reviews." aside="history">
    <LearningHistorySection mode="summary" initialLearning={data.learning} initialLaneLearning={data.laneLearning} />
  </Panel>
</div>
