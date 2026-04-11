<script lang="ts">
  import type { PaperDeskSnapshot } from '@hermes/contracts';
  import StatusPill from '$lib/components/StatusPill.svelte';
  import { currency, percent, signed } from '$lib/format';

  export let paperDesk: PaperDeskSnapshot;
  export let mode: 'summary' | 'detail' = 'summary';

  $: agents = [...paperDesk.agents];
  $: activeAgents = agents.filter((agent) => agent.status !== 'watching');
  $: watchOnlyAgents = agents.filter((agent) => agent.status === 'watching');
  $: liveTapeCount = paperDesk.marketTape.filter((tape) => tape.status === 'live').length;
  $: delayedTapeCount = paperDesk.marketTape.filter((tape) => tape.status === 'delayed').length;
  $: staleTapeCount = paperDesk.marketTape.filter((tape) => tape.status === 'stale').length;
  $: councilBusyCount = paperDesk.aiCouncil.filter((decision) => decision.status !== 'complete').length;
  $: activeSymbols = [...new Set(activeAgents.map((agent) => agent.lastSymbol).filter(Boolean))];
  $: topAgents = [...agents].sort((left, right) => {
    const leftStatusScore = left.status === 'in-trade' ? 3 : left.status === 'cooldown' ? 2 : 1;
    const rightStatusScore = right.status === 'in-trade' ? 3 : right.status === 'cooldown' ? 2 : 1;
    return rightStatusScore - leftStatusScore || right.totalTrades - left.totalTrades || right.winRate - left.winRate || right.realizedPnl - left.realizedPnl;
  });

  const statusLabel = (status: string) =>
    status === 'in-trade' ? 'in-trade' : status === 'cooldown' ? 'cooldown' : 'watching';
</script>

<div class="stack">
  <div class="technical-readout">
    <div class="readout-card">
      <span class="eyebrow">Active lanes</span>
      <strong>{activeAgents.length}</strong>
      <small>{activeSymbols.length ? activeSymbols.join(', ') : 'No active broker-backed symbols yet.'}</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Watch-only lanes</span>
      <strong>{watchOnlyAgents.length}</strong>
      <small>Visible, but not allowed to trade until venue parity exists.</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">Live tape</span>
      <strong>{liveTapeCount}</strong>
      <small>{delayedTapeCount} delayed · {staleTapeCount} stale</small>
    </div>
    <div class="readout-card">
      <span class="eyebrow">AI council</span>
      <strong>{councilBusyCount}</strong>
      <small>Queued or evaluating decisions waiting on model votes.</small>
    </div>
  </div>

  {#if mode === 'detail'}
    {#if topAgents.length > 0}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Symbol</th>
              <th>Win Rate</th>
              <th>Trades</th>
              <th>Realized</th>
              <th>Last Action</th>
            </tr>
          </thead>
          <tbody>
            {#each topAgents as agent}
              <tr>
                <td>
                  <strong>{agent.name}</strong>
                  <div class="subtle">{agent.lane} · {agent.broker}</div>
                </td>
                <td>
                  <StatusPill label={statusLabel(agent.status)} status={agent.status === 'in-trade' ? 'healthy' : agent.status === 'cooldown' ? 'warning' : 'healthy'} />
                </td>
                <td>{agent.lastSymbol}</td>
                <td>{agent.winRate.toFixed(1)}%</td>
                <td>{agent.totalTrades}</td>
                <td class:status-positive={agent.realizedPnl >= 0} class:status-negative={agent.realizedPnl < 0}>{signed(agent.realizedPnl)}</td>
                <td>{agent.lastAction}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="list-item">
        <h4>No pilot lanes yet</h4>
        <p class="subtle">Waiting for paper desk telemetry.</p>
      </div>
    {/if}
  {:else}
    <div class="list-card compact-list">
      {#each topAgents.slice(0, 5) as agent}
        <article class="list-item">
          <div class="panel-header">
            <div>
              <h4>{agent.name}</h4>
              <p class="subtle">{agent.lastSymbol} · {agent.lane} · {agent.broker}</p>
            </div>
            <StatusPill label={statusLabel(agent.status)} status={agent.status === 'in-trade' ? 'healthy' : agent.status === 'cooldown' ? 'warning' : 'healthy'} />
          </div>
          <p>{agent.lastAction}</p>
          <p class="subtle">
            Win {agent.winRate.toFixed(1)}% · trades {agent.totalTrades} · realized {signed(agent.realizedPnl)} · sleeve {currency(agent.equity)}
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
