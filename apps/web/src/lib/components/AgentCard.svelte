<script lang="ts">
  import type { PaperAgentSnapshot } from '@hermes/contracts';
  import { currency, percent } from '$lib/format';
  import Sparkline from '$lib/components/Sparkline.svelte';

  export let agent: PaperAgentSnapshot;
</script>

<article class="agent-card">
  <div class="agent-meta">
    <span class={`status-pill status-${agent.status === 'in-trade' ? 'positive' : agent.status === 'cooldown' ? 'warning' : 'healthy'}`}>{agent.status}</span>
    <span>{agent.lane}</span>
    <span>{agent.broker}</span>
  </div>
  <div>
    <h4>{agent.name}</h4>
    <p class="subtle">{agent.focus}</p>
  </div>
  <div class="agent-meta">
    <span>Sleeve {currency(agent.equity)}</span>
    <span class:status-positive={agent.dayPnl >= 0} class:status-negative={agent.dayPnl < 0}>P&L {currency(agent.dayPnl)}</span>
    <span>Return {percent(agent.returnPct)}</span>
    <span>Realized {currency(agent.realizedPnl)}</span>
  </div>
  <div class="agent-meta">
    <span>Win {agent.winRate.toFixed(1)}%</span>
    <span>Trades {agent.totalTrades}</span>
    <span>Open {agent.openPositions}</span>
    <span class:status-positive={agent.lastExitPnl >= 0} class:status-negative={agent.lastExitPnl < 0}>Last exit {currency(agent.lastExitPnl)}</span>
  </div>
  <Sparkline points={agent.curve} color={agent.dayPnl >= 0 ? 'var(--green)' : 'var(--red)'} fill={agent.dayPnl >= 0 ? 'rgba(83, 214, 157, 0.12)' : 'rgba(240, 125, 125, 0.12)'} />
  <p><strong>{agent.lastSymbol}</strong> · {agent.lastAction}</p>
</article>
