<script lang="ts">
  import type { PaperAgentSnapshot, PositionSnapshot, ResearchCandidate } from '@hermes/contracts';
  import Panel from '$lib/components/Panel.svelte';
  import { currency, signed } from '$lib/format';

  export let traderRows: PaperAgentSnapshot[];
  export let research: ResearchCandidate[];
  export let positions: PositionSnapshot[];
</script>

<section class="dual-grid">
  <Panel title="Trader Win Rates" subtitle="Per-trader win rates and realized PnL from the current paper ledger. Firm NAV above sums all connected broker accounts.">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Trader</th>
            <th>Status</th>
            <th>Win Rate</th>
            <th>Trades</th>
            <th>Realized</th>
            <th>Last Action</th>
          </tr>
        </thead>
        <tbody>
          {#each traderRows as trader}
            <tr>
              <td>
                <strong>{trader.name}</strong>
                <div class="subtle">{trader.lastSymbol}</div>
              </td>
              <td class={trader.status === 'in-trade' ? 'status-positive' : trader.status === 'cooldown' ? 'status-warning' : ''}>{trader.status}</td>
              <td class:status-positive={trader.winRate >= 52} class:status-warning={trader.winRate >= 40 && trader.winRate < 52} class:status-negative={trader.winRate < 40}>{(trader.winRate ?? 0).toFixed(1)}%</td>
              <td>{trader.totalTrades}</td>
              <td class:status-positive={trader.realizedPnl >= 0} class:status-negative={trader.realizedPnl < 0}>
                {signed(trader.realizedPnl)}
              </td>
              <td>{trader.lastAction}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Panel>

  <Panel title="Opportunity Queue" subtitle="Only live broker-fed market snapshots are shown here. If a feed degrades into fallback or mock data, it drops out of this queue.">
    <div class="list-card compact-list">
      {#if research.length === 0}
        <article class="list-item">
          <h4>No live broker-fed candidates right now</h4>
          <p>The queue stays empty when the firm does not have clean live tape to evaluate.</p>
        </article>
      {:else}
        {#each research as candidate}
          <article class="list-item">
            <h4>{candidate.symbol} · {candidate.strategy}</h4>
            <p>{candidate.catalyst}</p>
            <p class="subtle">Score {candidate.score} · Edge {candidate.expectedEdgeBps} bps · {candidate.aiVerdict}</p>
          </article>
        {/each}
      {/if}
    </div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Broker</th>
            <th>Source</th>
            <th>Strategy</th>
            <th>Entry</th>
            <th>Mark</th>
            <th>Unrealized</th>
          </tr>
        </thead>
        <tbody>
          {#each positions as position}
            <tr>
              <td>{position.symbol}</td>
              <td>{position.broker}</td>
              <td>{position.source ?? 'unknown'}</td>
              <td>{position.strategy}</td>
              <td>{currency(position.avgEntry)}</td>
              <td>{currency(position.markPrice)}</td>
              <td class:status-positive={position.unrealizedPnl >= 0} class:status-negative={position.unrealizedPnl < 0}>
                {signed(position.unrealizedPnl)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Panel>
</section>
