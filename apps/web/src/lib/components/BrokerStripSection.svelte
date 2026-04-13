<script lang="ts">
  import type { BrokerAccountSnapshot } from '@hermes/contracts';
  import { isBrokerConnected } from '$lib/broker-status';
  import { currency, signed } from '$lib/format';

  export let brokerLights: Record<string, string>;
  export let brokerFlashing: Record<string, boolean>;
  export let legendInTrade: boolean;
  export let legendCouncil: boolean;
  export let legendHot: boolean;
  export let legendCooldown: boolean;
  export let alpacaAccount: BrokerAccountSnapshot | undefined;
  export let oandaAccount: BrokerAccountSnapshot | undefined;
  export let alpacaLiveAccount: BrokerAccountSnapshot | undefined;
  export let oandaLiveAccount: BrokerAccountSnapshot | undefined;
  export let coinbaseRealAccount: BrokerAccountSnapshot | undefined;
  export let coinbasePaperEquity: number;
  export let coinbaseEquity: number;
  export let cbPaperTrades: number;
  export let cbPaperWinRate: number;
  export let cbPaperPnl: number;
  export let cbPaperOpen: number;
  export let cbLight: string;
  export let cbFlashing: boolean;
  export let brokerTradeStats: Map<string, { trades: number; wins: number; pnl: number; active: number }>;
  export let BROKER_STARTING_EQUITY: number;

</script>

<div class="broker-section">
  <div class="broker-row-label">
    PAPER
    <span class="light-legend">
      <span class="light-legend__item" class:light-legend__item--active={legendInTrade}><span class={`traffic-light traffic-light--green ${legendInTrade ? 'traffic-light--flash' : ''}`}></span> in trade</span>
      <span class="light-legend__item" class:light-legend__item--active={legendCouncil}><span class="traffic-light traffic-light--cyan"></span> AI thinking</span>
      <span class="light-legend__item" class:light-legend__item--active={legendHot}><span class="traffic-light traffic-light--white"></span> hot signal</span>
      <span class="light-legend__item" class:light-legend__item--active={legendCooldown}><span class={`traffic-light traffic-light--yellow ${legendCooldown ? 'traffic-light--flash' : ''}`}></span> cooldown</span>
      <span class="light-legend__item"><span class="traffic-light traffic-light--blue"></span> idle</span>
    </span>
  </div>
  <div class="broker-strip">
    {#each [alpacaAccount, null, oandaAccount] as account, i}
      {#if i === 1}
        <!-- Coinbase Paper (middle) — simulated locally using live Coinbase prices -->
        <div class="broker-chip broker-chip--live">
          <div class="broker-chip__head">
            <span class="eyebrow">coinbase-paper</span>
            <div class="broker-chip__lights">
              <span class={`traffic-light traffic-light--${cbLight}`} class:traffic-light--flash={cbFlashing}></span>
              <span class="broker-chip__mode">paper</span>
            </div>
          </div>
          <div class="broker-chip__equity">
            <strong class:status-positive={coinbasePaperEquity >= BROKER_STARTING_EQUITY} class:status-negative={coinbasePaperEquity < BROKER_STARTING_EQUITY}>{currency(coinbasePaperEquity)}</strong>
            <small class:status-positive={coinbasePaperEquity >= BROKER_STARTING_EQUITY} class:status-negative={coinbasePaperEquity < BROKER_STARTING_EQUITY}>{signed(coinbasePaperEquity - BROKER_STARTING_EQUITY)} since start</small>
          </div>
          <div class="broker-chip__trades">
            <span>{cbPaperTrades} trades</span>
            <span class:status-positive={cbPaperWinRate >= 50} class:status-negative={cbPaperWinRate < 50 && cbPaperTrades > 0}>{cbPaperWinRate.toFixed(0)}% win</span>
            <span class:status-positive={cbPaperPnl > 0} class:status-negative={cbPaperPnl < 0}>{signed(cbPaperPnl)}</span>
            <span class={cbPaperOpen > 0 ? 'broker-chip__active' : 'broker-chip__idle'}>{cbPaperOpen} open</span>
          </div>
        </div>
      {:else if account}
        {@const stats = brokerTradeStats.get(account.broker) ?? { trades: 0, wins: 0, pnl: 0, active: 0 }}
        {@const winRate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0}
        {@const light = brokerLights[account.broker] ?? 'blue'}
        {@const flashing = brokerFlashing[account.broker] ?? false}
        <div class={`broker-chip broker-chip--${isBrokerConnected(account.status) ? 'live' : 'off'}`}>
          <div class="broker-chip__head">
            <span class="eyebrow">{account.broker}</span>
            <div class="broker-chip__lights">
              <span class={`traffic-light traffic-light--${light}`} class:traffic-light--flash={flashing}></span>
              <span class="broker-chip__mode">{account.mode}</span>
            </div>
          </div>
          <div class="broker-chip__equity">
            <strong class:status-positive={account.equity >= BROKER_STARTING_EQUITY} class:status-negative={account.equity < BROKER_STARTING_EQUITY}>{currency(account.equity)}</strong>
            <small class:status-positive={account.equity >= BROKER_STARTING_EQUITY} class:status-negative={account.equity < BROKER_STARTING_EQUITY}>{signed(account.equity - BROKER_STARTING_EQUITY)} since start</small>
          </div>
          <div class="broker-chip__trades">
            <span>{stats.trades} trades</span>
            <span class:status-positive={winRate >= 50} class:status-negative={winRate < 50 && stats.trades > 0}>{winRate.toFixed(0)}% win</span>
            <span class:status-positive={stats.pnl > 0} class:status-negative={stats.pnl < 0}>{signed(stats.pnl)}</span>
            <span class={stats.active > 0 ? 'broker-chip__active' : 'broker-chip__idle'}>{stats.active} open</span>
          </div>
          <div class="broker-chip__meta">
            <span>Cash {currency(account.cash)}</span>
            <span>BP {currency(account.buyingPower)}</span>
            <span class={`broker-chip__status broker-chip__status--${account.status}`}>{account.status}</span>
            <span>{new Date(account.updatedAt).toLocaleTimeString()}</span>
          </div>
        </div>
      {/if}
    {/each}
  </div>
  <div class="broker-row-label broker-row-label--live">LIVE</div>
  <div class="broker-strip">
    <div class={`broker-chip broker-chip--${isBrokerConnected(alpacaLiveAccount?.status) ? 'live' : 'off'}`}>
      <div class="broker-chip__head">
        <span class="eyebrow">alpaca-live</span>
        <div class="broker-chip__lights">
          <span class={`traffic-light traffic-light--${isBrokerConnected(alpacaLiveAccount?.status) ? 'green' : 'yellow'}`}></span>
          <span class="broker-chip__mode">{alpacaLiveAccount?.mode ?? 'live'}</span>
        </div>
      </div>
      <div class="broker-chip__equity">
        <strong>{(alpacaLiveAccount?.equity ?? 0) > 0 ? currency(alpacaLiveAccount?.equity ?? 0) : '\u2014'}</strong>
        <small>{alpacaLiveAccount?.status ?? 'disconnected'}</small>
      </div>
    </div>
    <div class={`broker-chip broker-chip--${isBrokerConnected(coinbaseRealAccount?.status) ? 'live' : 'off'}`}>
      <div class="broker-chip__head">
        <span class="eyebrow">coinbase-live</span>
        <div class="broker-chip__lights">
          <span class={`traffic-light traffic-light--${coinbaseRealAccount ? 'green' : 'yellow'}`}></span>
          <span class="broker-chip__mode">{coinbaseRealAccount?.mode ?? 'wallet'}</span>
        </div>
      </div>
      <div class="broker-chip__equity">
        <strong>{coinbaseEquity > 0 ? currency(coinbaseEquity) : '\u2014'}</strong>
        <small>{coinbaseRealAccount?.status ?? 'disconnected'}</small>
      </div>
    </div>
    <div class={`broker-chip broker-chip--${isBrokerConnected(oandaLiveAccount?.status) ? 'live' : 'off'}`}>
      <div class="broker-chip__head">
        <span class="eyebrow">oanda-live</span>
        <div class="broker-chip__lights">
          <span class={`traffic-light traffic-light--${isBrokerConnected(oandaLiveAccount?.status) ? 'green' : 'yellow'}`}></span>
          <span class="broker-chip__mode">{oandaLiveAccount?.mode ?? 'live'}</span>
        </div>
      </div>
      <div class="broker-chip__equity">
        <strong>{(oandaLiveAccount?.equity ?? 0) > 0 ? currency(oandaLiveAccount?.equity ?? 0) : '\u2014'}</strong>
        <small>{oandaLiveAccount?.status ?? 'disconnected'}</small>
      </div>
    </div>
  </div>
</div>
