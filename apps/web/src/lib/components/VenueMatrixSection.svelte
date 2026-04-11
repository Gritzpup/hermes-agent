<script lang="ts">
  import type { BrokerAccountSnapshot, BrokerId, PaperDeskSnapshot, ServiceHealth } from '@hermes/contracts';
  import StatusPill from '$lib/components/StatusPill.svelte';
  import { currency } from '$lib/format';

  const brokerStart = 100_000; // Starting equity per paper broker

  export let brokerAccounts: BrokerAccountSnapshot[] = [];
  export let paperDesk: PaperDeskSnapshot;
  export let serviceHealth: ServiceHealth[] = [];
  export let mode: 'summary' | 'detail' = 'summary';

  const brokerOrder: BrokerId[] = ['alpaca-paper', 'coinbase-live', 'oanda-rest'];
  $: maxGroupSymbols = mode === 'summary' ? 4 : 10;

  const brokerLabel = (broker: BrokerId): string => {
    if (broker === 'coinbase-live') return 'Coinbase (Paper)';
    if (broker === 'oanda-rest') return 'OANDA (Practice)';
    return 'Alpaca (Paper)';
  };

  const venueNote = (broker: BrokerId, symbols: string[]): string => {
    if (broker === 'coinbase-live') {
      return 'Paper crypto venue. Live Coinbase prices, simulated local fills.';
    }
    if (broker === 'oanda-rest') {
      return 'Practice account for forex, index CFDs, bonds, and commodities.';
    }
    if (symbols.includes('VIXY')) {
      return 'Paper equity venue. VIXY is the visible fear-spike sleeve; autonomous equity entries stay regular-hours only.';
    }
    return 'Paper equity venue for U.S. symbols and volatility proxies.';
  };

  const healthTone = (status: string): 'healthy' | 'warning' | 'critical' => {
    if (status === 'connected' || status === 'healthy' || status === 'live') return 'healthy';
    if (status === 'degraded' || status === 'warning' || status === 'stale' || status === 'delayed') return 'warning';
    return 'critical';
  };

  const serviceStatusForBroker = (broker: BrokerId): string => {
    const name = broker === 'coinbase-live'
      ? 'market-data'
      : broker === 'oanda-rest'
        ? 'broker-router'
        : 'broker-router';
    return serviceHealth.find((entry) => entry.name === name)?.status ?? 'warning';
  };

  type AssetGroup = { class: string; symbols: string[]; agents: typeof paperDesk.agents; pnl: number; trades: number };

  const classifyAsset = (symbol: string): string => {
    if (symbol.endsWith('-USD') && !symbol.includes('_')) return 'crypto';
    if (symbol.includes('_USD') && symbol.startsWith('USB')) return 'bonds';
    if (symbol.includes('_USD') && ['XAU_USD', 'XAG_USD', 'BCO_USD', 'WTICO_USD', 'NATGAS_USD', 'XCU_USD', 'XPT_USD', 'XPD_USD'].includes(symbol)) return 'commodities';
    if (symbol.includes('_') && !['SPX500_USD','NAS100_USD','US30_USD'].includes(symbol)) return 'forex';
    if (['SPX500_USD','NAS100_USD','US30_USD'].includes(symbol)) return 'indices (CFD)';
    if (['SPY','QQQ','NVDA','AAPL','TSLA','MSFT','AMZN','VIXY'].includes(symbol)) return 'stocks';
    return 'other';
  };

  $: venueRows = brokerOrder
    .map((broker) => {
      const account = brokerAccounts.find((entry) => entry.broker === broker);
      const tapes = paperDesk.marketTape.filter((tape) => tape.broker === broker);
      const agents = paperDesk.agents.filter((agent) => agent.broker === broker);
      const activeAgents = agents.filter((agent) => agent.status !== 'watching');
      const liveTapes = tapes.filter((tape) => tape.status === 'live');
      const tradeableTapes = tapes.filter((tape) => tape.tradable);
      const symbols = tapes.map((tape) => tape.symbol);

      // Group by asset class
      const groupMap = new Map<string, AssetGroup>();
      for (const agent of agents) {
        const cls = classifyAsset(agent.lastSymbol || '');
        const group = groupMap.get(cls) ?? { class: cls, symbols: [], agents: [], pnl: 0, trades: 0 };
        if (agent.lastSymbol && !group.symbols.includes(agent.lastSymbol)) group.symbols.push(agent.lastSymbol);
        group.agents.push(agent);
        group.pnl += agent.realizedPnl;
        group.trades += agent.totalTrades;
        groupMap.set(cls, group);
      }
      const assetGroups = Array.from(groupMap.values())
        .filter((g) => g.symbols.length > 0 && g.class !== 'other')
        .sort((a, b) => b.trades - a.trades);

      return {
        broker,
        label: brokerLabel(broker),
        account,
        symbols,
        tapes,
        agents,
        activeAgents,
        liveTapes,
        tradeableTapes,
        assetGroups,
        feesPaid: agents.reduce((sum, agent) => sum + (agent.feesPaid ?? 0), 0),
        note: venueNote(broker, symbols),
        serviceStatus: serviceStatusForBroker(broker),
      };
    })
    .filter((row) => row.account || row.tapes.length || row.agents.length);
</script>

<!-- 3-column grid: each column = one broker, paper on top / live on bottom -->
<div class="vm-grid">
  {#each venueRows as row}
    <article class="vm-col">
      <!-- PAPER section -->
      <div class="vm-tier">
        <div class="vm-tier__label">PAPER</div>
        <div class="vm-tier__head">
          <div>
            <div class="eyebrow">{row.broker === 'coinbase-live' ? 'coinbase-paper' : row.broker}</div>
            <strong>{row.label}</strong>
          </div>
          <div class="vm-tier__pills">
            <StatusPill label={row.account?.mode ?? 'unknown'} status={row.account?.mode === 'live' ? 'healthy' : 'warning'} />
            <StatusPill label={row.account?.status ?? 'disconnected'} status={healthTone(row.account?.status ?? 'disconnected')} />
          </div>
        </div>
        <div class="vm-tier__stats">
          <div>
            <span class="eyebrow">Equity</span>
            <strong class:status-positive={row.account && row.account.equity >= brokerStart} class:status-negative={row.account && row.account.equity < brokerStart && row.account.equity > 0}>{currency(row.account?.equity ?? 0)}</strong>
          </div>
          <div>
            <span class="eyebrow">Trades</span>
            <strong>{row.agents.reduce((s, a) => s + a.totalTrades, 0)}</strong>
          </div>
          <div>
            <span class="eyebrow">Open</span>
            <strong class={row.agents.filter((a) => a.status === 'in-trade').length > 0 ? 'status-positive' : ''}>{row.agents.filter((a) => a.status === 'in-trade').length}</strong>
          </div>
        </div>
        {#if row.assetGroups.length > 0}
          <div class="vm-tier__groups">
            {#each row.assetGroups as group}
              <div class="vm-group">
                <span class="vm-group__class">{group.class}</span>
                <span class:status-positive={group.pnl > 0} class:status-negative={group.pnl < 0}>{currency(group.pnl)}</span>
                <span class="subtle">{group.trades}t</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- LIVE section -->
      <div class="vm-tier vm-tier--live">
        <div class="vm-tier__label vm-tier__label--live">LIVE</div>
        <div class="vm-tier__head">
          <div>
            <div class="eyebrow">{row.broker === 'coinbase-live' ? 'coinbase-live' : row.broker === 'alpaca-paper' ? 'alpaca-live' : 'oanda-live'}</div>
            <strong>{row.broker === 'coinbase-live' ? 'Coinbase (Live)' : row.broker === 'alpaca-paper' ? 'Alpaca (Live)' : 'OANDA (Live)'}</strong>
          </div>
          <StatusPill label={row.broker === 'coinbase-live' ? 'wallet' : 'inactive'} status="warning" />
        </div>
        <p class="vm-tier__note">{row.broker === 'coinbase-live' ? 'Wallet connected, trading inactive' : 'Enable after paper profits'}</p>
      </div>
    </article>
  {/each}
</div>

<style>
  .vm-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .vm-col {
    display: grid;
    gap: 4px;
  }

  .vm-tier {
    background: rgba(9, 16, 25, 0.95);
    border: 1px solid rgba(125, 163, 214, 0.1);
    padding: 8px 10px;
    display: grid;
    gap: 4px;
  }

  .vm-tier--live {
    opacity: 0.5;
  }

  .vm-tier__label {
    font-family: var(--mono, monospace);
    font-size: 0.54rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    color: #58d0ff;
  }

  .vm-tier__label--live {
    color: #fbbf24;
  }

  .vm-tier__head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 6px;
  }

  .vm-tier__head strong {
    font-size: 0.78rem;
  }

  .vm-tier__pills {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
  }

  .vm-tier__stats {
    display: flex;
    gap: 12px;
    font-size: 0.7rem;
    font-family: var(--mono, monospace);
  }

  .vm-tier__stats .eyebrow {
    font-size: 0.56rem;
    display: block;
    margin-bottom: 1px;
  }

  .vm-tier__groups {
    display: grid;
    gap: 2px;
  }

  .vm-group {
    display: flex;
    gap: 6px;
    font-size: 0.66rem;
    font-family: var(--mono, monospace);
    align-items: center;
  }

  .vm-group__class {
    color: var(--muted, #92a0b8);
    min-width: 60px;
  }

  .vm-tier__note {
    font-size: 0.66rem;
    color: var(--muted, #92a0b8);
    margin: 0;
  }
</style>
