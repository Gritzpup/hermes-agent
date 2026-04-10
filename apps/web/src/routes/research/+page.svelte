<script lang="ts">
  import type { PageData } from './$types';
  import { currency, percent } from '$lib/format';
  import Panel from '$lib/components/Panel.svelte';

  export let data: PageData;
</script>

<section class="dual-grid">
  <Panel title="Market State" subtitle="Normalized snapshots across venues, with live versus fallback status visible per symbol.">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Broker</th>
            <th>Asset</th>
            <th>Last</th>
            <th>Change</th>
            <th>Spread</th>
            <th>Liquidity</th>
            <th>Status</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {#each data.marketSnapshots as snapshot}
            <tr>
              <td>{snapshot.symbol}</td>
              <td>{snapshot.broker}</td>
              <td>{snapshot.assetClass}</td>
              <td>{currency(snapshot.lastPrice)}</td>
              <td>{percent(snapshot.changePct)}</td>
              <td>{snapshot.spreadBps} bps</td>
              <td>{snapshot.liquidityScore}</td>
              <td>{snapshot.status}</td>
              <td>{snapshot.source ?? 'unknown'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Panel>

  <Panel title="Candidate Queue" subtitle="What the rules engine sees before risk and routing.">
    <div class="list-card">
      {#each data.research as candidate}
        <article class="list-item">
          <h4>{candidate.symbol} · {candidate.strategy} · score {candidate.score}</h4>
          <p>{candidate.catalyst}</p>
          <p class="subtle">Expected edge {candidate.expectedEdgeBps} bps · Risk {candidate.riskStatus} · {candidate.aiVerdict}</p>
        </article>
      {/each}
    </div>
  </Panel>
</section>
