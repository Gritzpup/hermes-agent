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

<div class="venue-matrix">
  <div class="venue-section-label">PAPER TRADING</div>
  {#each venueRows as row}
    <article class="venue-card">
      <div class="venue-card__head">
        <div>
          <div class="eyebrow">{row.broker === 'coinbase-live' ? 'coinbase-paper' : row.broker}</div>
          <h4>{row.label}</h4>
        </div>
        <div class="venue-card__pills">
          <StatusPill label={row.account?.mode ?? 'unknown'} status={row.account?.mode === 'live' ? 'healthy' : 'warning'} />
          <StatusPill label={row.account?.status ?? 'disconnected'} status={healthTone(row.account?.status ?? 'disconnected')} />
          <StatusPill label={`svc ${row.serviceStatus}`} status={healthTone(row.serviceStatus)} />
        </div>
      </div>

      <div class="venue-card__grid">
        <div>
          <span class="eyebrow">Account</span>
          <strong class:status-positive={row.account && row.account.equity >= brokerStart} class:status-negative={row.account && row.account.equity < brokerStart && row.account.equity > 0}>{currency(row.account?.equity ?? 0)}</strong>
          <small>Cash {currency(row.account?.cash ?? 0)}</small>
        </div>
        <div>
          <span class="eyebrow">Trades</span>
          <strong>{row.agents.reduce((s, a) => s + a.totalTrades, 0)}</strong>
          <small class:status-positive={row.account && (row.account.equity - brokerStart) > 0} class:status-negative={row.account && (row.account.equity - brokerStart) < 0}>PnL {currency((row.account?.equity ?? 0) - brokerStart)}</small>
        </div>
        <div>
          <span class="eyebrow">Open</span>
          <strong class={row.agents.filter((a) => a.status === 'in-trade').length > 0 ? 'status-positive' : ''}>{row.agents.filter((a) => a.status === 'in-trade').length} positions</strong>
          <small>{row.activeAgents.length}/{row.agents.length} agents active</small>
        </div>
      </div>

      {#if row.assetGroups.length > 0}
        <div class="venue-groups">
          {#each row.assetGroups as group}
            <div class="venue-group">
              <div class="venue-group__head">
                <span class="venue-group__class">{group.class}</span>
                <span class="venue-group__stats">
                  <span>{group.trades} trades</span>
                  <span class:status-positive={group.pnl > 0} class:status-negative={group.pnl < 0}>{currency(group.pnl)}</span>
                </span>
              </div>
              <div class="venue-tags">
                {#each group.symbols.slice(0, maxGroupSymbols) as symbol}
                  <span class="venue-tag">{symbol}</span>
                {/each}
                {#if group.symbols.length > maxGroupSymbols}
                  <span class="venue-tag venue-tag--muted">+{group.symbols.length - maxGroupSymbols} more</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <p class="venue-card__note">{row.note}</p>
      {/if}
    </article>
  {/each}

  <div class="venue-section-label venue-section-label--live">LIVE TRADING</div>
  <div class="venue-live-row">
    <article class="venue-card venue-card--inactive">
      <div class="venue-card__head">
        <div><div class="eyebrow">alpaca-live</div><h4>Alpaca (Live)</h4></div>
        <StatusPill label="not connected" status="warning" />
      </div>
      <p class="venue-card__note">Enable after paper profits</p>
    </article>
    <article class="venue-card venue-card--inactive">
      <div class="venue-card__head">
        <div><div class="eyebrow">coinbase-live</div><h4>Coinbase (Live)</h4></div>
        <StatusPill label="wallet only" status="warning" />
      </div>
      <p class="venue-card__note">Trading inactive — wallet connected</p>
    </article>
    <article class="venue-card venue-card--inactive">
      <div class="venue-card__head">
        <div><div class="eyebrow">oanda-live</div><h4>OANDA (Live)</h4></div>
        <StatusPill label="not connected" status="warning" />
      </div>
      <p class="venue-card__note">Enable after paper profits</p>
    </article>
  </div>
</div>

<style>
  .venue-section-label {
    font-family: var(--mono, monospace);
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: #58d0ff;
    padding: 6px 0 2px;
  }
  .venue-section-label--live {
    color: #fbbf24;
    margin-top: 8px;
  }
  .venue-live-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .venue-card--inactive {
    opacity: 0.5;
  }
</style>
