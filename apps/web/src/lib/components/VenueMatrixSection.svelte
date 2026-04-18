<script lang="ts">
  import type { BrokerAccountSnapshot, BrokerId, PaperDeskSnapshot, ServiceHealth } from '@hermes/contracts';
  import StatusPill from '$lib/components/StatusPill.svelte';
  import { brokerStatusTone, isBrokerConnected } from '$lib/broker-status';
  import { currency } from '$lib/format';

  const brokerStart = 100_000; // Starting equity per paper broker

  export let brokerAccounts: BrokerAccountSnapshot[] = [];
  export let liveRouteAccounts: BrokerAccountSnapshot[] = [];
  export let paperDesk: PaperDeskSnapshot;
  export let serviceHealth: ServiceHealth[] = [];
  export let mode: 'summary' | 'detail' = 'summary';

  $: brokerRollupByBroker = new Map((paperDesk.brokerRollups ?? []).map((r) => [r.broker, r]));

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

  const serviceStatusForBroker = (broker: BrokerId): ServiceHealth['status'] =>
    serviceHealth.find((entry) => entry.name === (broker === 'coinbase-live' ? 'market-data' : 'broker-router'))?.status ?? 'critical';

  type AssetGroup = { class: string; symbols: string[]; agents: typeof paperDesk.agents; pnl: number; trades: number; lastTradeAt: string | null };

  const formatRelativeTime = (iso: string | null): string => {
    if (!iso) return '—';
    const diffMs = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diffMs) || diffMs < 0) return '—';
    const m = Math.floor(diffMs / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  };

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
      const liveRouteAccount = liveRouteAccounts.find((entry) => entry.broker === broker);

      // Group by asset class
      const groupMap = new Map<string, AssetGroup>();
      for (const agent of agents) {
        const cls = classifyAsset(agent.lastSymbol || '');
        const group = groupMap.get(cls) ?? { class: cls, symbols: [], agents: [], pnl: 0, trades: 0, lastTradeAt: null };
        if (agent.lastSymbol && !group.symbols.includes(agent.lastSymbol)) group.symbols.push(agent.lastSymbol);
        group.agents.push(agent);
        group.pnl += agent.realizedPnl;
        group.trades += agent.totalTrades;
        if (agent.lastTradeAt && (!group.lastTradeAt || agent.lastTradeAt > group.lastTradeAt)) {
          group.lastTradeAt = agent.lastTradeAt;
        }
        groupMap.set(cls, group);
      }
      // If this broker has only one asset class group and the broker reports its own
      // realizedPnl, prefer that over the journal-sum (authoritative vs journal drift).
      const brokerTrades = brokerRollupByBroker.get(broker)?.trades ?? 0;
      const brokerRealized = brokerRollupByBroker.get(broker)?.realizedPnl;
      const liveGroups = Array.from(groupMap.values()).filter((g) => g.trades > 0 || g.agents.length > 0);
      if (liveGroups.length === 1 && typeof brokerRealized === 'number' && brokerTrades > 0) {
        liveGroups[0]!.pnl = brokerRealized;
        liveGroups[0]!.trades = brokerTrades;
      }
      const assetGroups = Array.from(groupMap.values())
        .filter((g) => g.symbols.length > 0 && g.class !== 'other')
        .sort((a, b) => b.trades - a.trades);

      // For Coinbase paper: compute equity from agents (simulated), not real wallet
      // For Alpaca/OANDA: if disconnected (no account), show starting equity instead of $0
      const isCoinbasePaper = broker === 'coinbase-live';
      const agentPnl = agents.reduce((s, a) => s + a.realizedPnl, 0);
      const rollupPnl = brokerRollupByBroker.get(broker)?.realizedPnl ?? 0;
      // Use broker equity when connected, fallback to $100K + rollup PnL when disconnected
      const paperEquity = account?.equity
        ? account.equity
        : brokerStart + rollupPnl;

      return {
        broker,
        label: brokerLabel(broker),
        account,
        paperEquity,
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
        liveRouteAccount,
      };
    });
  // COO FIX: Always show all 3 brokers even when disconnected.
  // Previously filtered out brokers with no account/tape/agents, causing cards to disappear.
  // Now we show the broker row always, with 'disconnected' status when offline.

  const liveModeLabel = (broker: BrokerId, serviceStatus: ServiceHealth['status']): string =>
    broker === 'coinbase-live' ? 'wallet' : isConnectedStatus(serviceStatus) ? 'ready' : 'offline';

  const isConnectedStatus = (status?: string | null): boolean => isBrokerConnected(status);

  const liveNote = (broker: BrokerId, serviceStatus: ServiceHealth['status']): string => {
    if (broker === 'coinbase-live') {
      return isConnectedStatus(serviceStatus)
        ? 'Wallet connected. Live execution can route immediately.'
        : 'Coinbase wallet route is unavailable right now.';
    }
    return isConnectedStatus(serviceStatus)
      ? 'Live broker route is online. Deployment remains policy-gated, not disconnected.'
      : 'Live broker route is unavailable right now.';
  };
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
            <StatusPill label={row.broker === 'coinbase-live' ? 'paper' : (row.account?.mode ?? 'unknown')} status={row.broker === 'coinbase-live' ? 'warning' : (row.account?.mode === 'live' ? 'healthy' : 'warning')} />
            <StatusPill label={row.broker === 'coinbase-live' ? 'simulated' : (row.account?.status ?? 'disconnected')} status={row.broker === 'coinbase-live' ? 'healthy' : brokerStatusTone(row.account?.status ?? 'disconnected')} />
          </div>
        </div>
        <div class="vm-tier__stats">
          <div>
            <span class="eyebrow">Equity</span>
            <strong class:status-positive={row.paperEquity >= brokerStart} class:status-negative={row.paperEquity < brokerStart && row.paperEquity > 0}>{currency(row.paperEquity)}</strong>
          </div>
          <div>
            <span class="eyebrow">Trades</span>
            <strong>{row.agents.reduce((s, a) => s + a.totalTrades, 0)}</strong>
          </div>
          <div>
            <span class="eyebrow">Open</span>
            <strong class={row.agents.filter((a) => a.status === 'in-trade').length > 0 ? 'status-positive' : ''}>{row.agents.filter((a) => a.status === 'in-trade').length}</strong>
          </div>
          <div title="Realized P&L reported directly by the broker (authoritative). The per-asset-class rows below show hermes-journal sums which may diverge if positions were opened or closed outside the journal.">
            <span class="eyebrow">Realized</span>
            <strong
              class:status-positive={(row.account?.realizedPnl ?? 0) > 0}
              class:status-negative={(row.account?.realizedPnl ?? 0) < 0}
            >{typeof row.account?.realizedPnl === 'number' ? currency(row.account.realizedPnl) : '—'}</strong>
          </div>
          <div title="Unrealized P&L on positions still open at the broker. Closes into realized P&L when the position exits.">
            <span class="eyebrow">Unrealized</span>
            <strong
              class:status-positive={(row.account?.unrealizedPnl ?? 0) > 0}
              class:status-negative={(row.account?.unrealizedPnl ?? 0) < 0}
            >{typeof row.account?.unrealizedPnl === 'number' ? currency(row.account.unrealizedPnl) : '—'}</strong>
          </div>
        </div>
        {#if row.assetGroups.length > 0}
          <div class="vm-tier__groups">
            {#each row.assetGroups as group}
              <div class="vm-group">
                <span class="vm-group__class">{group.class}</span>
                <span class:status-positive={group.pnl > 0} class:status-negative={group.pnl < 0}>{currency(group.pnl)}</span>
                <span class="subtle">{group.trades}t</span>
                <span class="subtle" title={group.lastTradeAt ?? 'No recorded trades'}>
                  last {formatRelativeTime(group.lastTradeAt)}
                </span>
              </div>
              <div class="vm-tags">
                {#each group.symbols.slice(0, maxGroupSymbols) as sym}
                  <span class="vm-tag">{sym}</span>
                {/each}
                {#if group.symbols.length > maxGroupSymbols}
                  <span class="vm-tag vm-tag--muted">+{group.symbols.length - maxGroupSymbols}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- LIVE section -->
      <div
        class="vm-tier vm-tier--live"
        class:vm-tier--muted={!isConnectedStatus(row.liveRouteAccount?.status)}
      >
        <div class="vm-tier__label vm-tier__label--live">LIVE</div>
        <div class="vm-tier__head">
          <div>
            <div class="eyebrow">{row.broker === 'coinbase-live' ? 'coinbase-live' : row.broker === 'alpaca-paper' ? 'alpaca-live' : 'oanda-live'}</div>
            <strong>{row.broker === 'coinbase-live' ? 'Coinbase (Live)' : row.broker === 'alpaca-paper' ? 'Alpaca (Live)' : 'OANDA (Live)'}</strong>
          </div>
          <div class="vm-tier__pills">
            <StatusPill label={liveModeLabel(row.broker, row.serviceStatus)} status={isConnectedStatus(row.serviceStatus) ? 'healthy' : brokerStatusTone(row.serviceStatus)} />
            <StatusPill
              label={row.liveRouteAccount?.status ?? 'disconnected'}
              status={brokerStatusTone(row.liveRouteAccount?.status)}
            />
          </div>
        </div>
        <p class="vm-tier__note">{liveNote(row.broker, row.serviceStatus)}</p>
      </div>
    </article>
  {/each}
</div>

<style>
  .vm-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    align-items: start;
  }

  .vm-col {
    display: grid;
    grid-template-rows: 1fr auto;
    gap: 4px;
    height: 100%;
  }

  .vm-tier {
    background: rgba(9, 16, 25, 0.95);
    border: 1px solid rgba(125, 163, 214, 0.1);
    padding: 10px 12px;
    display: grid;
    gap: 6px;
    align-content: start;
  }

  .vm-tier--live {
    opacity: 1;
  }

  .vm-tier--muted {
    opacity: 0.5;
  }

  .vm-tier__label {
    font-family: var(--mono, monospace);
    font-size: 0.68rem;
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
    font-size: 0.88rem;
  }

  .vm-tier__pills {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
  }

  .vm-tier__stats {
    display: flex;
    gap: 14px;
    font-size: 0.82rem;
    font-family: var(--mono, monospace);
  }

  .vm-tier__stats .eyebrow {
    font-size: 0.68rem;
    display: block;
    margin-bottom: 1px;
  }

  .vm-tier__groups {
    display: grid;
    gap: 3px;
  }

  .vm-group {
    display: flex;
    gap: 8px;
    font-size: 0.78rem;
    font-family: var(--mono, monospace);
    align-items: center;
  }

  .vm-group__class {
    color: var(--muted, #92a0b8);
    min-width: 70px;
  }

  .vm-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-bottom: 3px;
  }

  .vm-tag {
    font-family: var(--mono, monospace);
    font-size: 0.72rem;
    padding: 1px 5px;
    background: rgba(88, 208, 255, 0.06);
    color: var(--muted, #92a0b8);
    border-radius: 2px;
  }

  .vm-tag--muted {
    opacity: 0.5;
  }

  .vm-tier__note {
    font-size: 0.78rem;
    color: var(--muted, #92a0b8);
    margin: 0;
  }
</style>
