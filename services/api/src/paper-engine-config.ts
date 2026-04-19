import type { AgentConfig, BrokerId, AgentExecutionMode } from './paper-engine/types.js';

type AgentSeedConfig = {
  id: string;
  name: string;
  symbol: string;
  broker: 'coinbase-live' | 'oanda-rest' | 'alpaca-paper';
  assetClass: 'crypto' | 'equity' | 'forex' | 'bond' | 'commodity' | 'commodity-proxy';
  style: 'momentum' | 'mean-reversion' | 'breakout' | 'arbitrage';
  executionMode: 'broker-paper' | 'watch-only';
  autonomyEnabled: boolean;
  focus: string;
  targetBps: number;
  stopBps: number;
  maxHoldTicks: number;
  cooldownTicks: number;
  sizeFraction: number;
  spreadLimitBps: number;
};

export function buildAgentConfigs(realPaperAutopilot: boolean): AgentSeedConfig[] {
  return [
    // ─── CRYPTO (Alpaca paper — real paper orders through Alpaca) ───
    {
      // Fix #10: Reduced overtrading — longer holds, higher cooldowns, smaller size
      id: 'agent-btc-tape',
      name: 'BTC Tape Scalper (KILLED — 47% WR, -$1,106 over 470 trades)',
      symbol: 'BTC-USD',
      broker: 'alpaca-paper',
      assetClass: 'crypto',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: false, // HARD KILL: historical -$2.35/trade expectancy
      focus: 'BTC momentum — ride trends for 10-30 minutes.',
      targetBps: 35,
      stopBps: 22,
      maxHoldTicks: 180,
      cooldownTicks: 10,
      sizeFraction: 0.03,
      spreadLimitBps: 3
    },
    {
      // Fix: switched from mean-reversion to momentum — ETH trends more than it mean-reverts (27.8% WR, -$3.08)
      id: 'agent-eth-revert',
      name: 'ETH Momentum',
      symbol: 'ETH-USD',
      broker: 'alpaca-paper',
      assetClass: 'crypto',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: false, // COO KILL: scalping lane
      focus: 'ETH momentum — ride trends for 10-40 minutes.',
      targetBps: 30,
      stopBps: 30,
      maxHoldTicks: 240,
      cooldownTicks: 18,
      sizeFraction: 0.03,
      spreadLimitBps: 3
    },
    {
      // Fix: switched from momentum to breakout — SOL has explosive moves, breakout captures better (20% WR, -$1.55)
      id: 'agent-sol-momentum',
      name: 'SOL Breakout',
      symbol: 'SOL-USD',
      broker: 'alpaca-paper',
      assetClass: 'crypto',
      style: 'breakout',
      executionMode: 'broker-paper',
      autonomyEnabled: false, // COO KILL: scalping lane
      focus: 'SOL breakout — capture explosive moves over 10-40 minutes.',
      targetBps: 35,
      stopBps: 22,
      maxHoldTicks: 234,
      cooldownTicks: 10,
      sizeFraction: 0.03,
      spreadLimitBps: 3
    },
    {
      // KILL: Alpaca paper does NOT support XRP-USD — zero trades since inception.
      // XRP-USD only trades on Coinbase live. The signal lives in agent-cb-xrp-momentum.
      id: 'agent-xrp-grid',
      name: 'XRP Momentum (KILLED: Alpaca paper has no XRP-USD)',
      symbol: 'XRP-USD',
      broker: 'alpaca-paper',
      assetClass: 'crypto',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: false,
      focus: 'XRP momentum — trend-follow with tight spreads.',
      targetBps: 20,
      stopBps: 16,
      maxHoldTicks: 180,
      cooldownTicks: 10,
      sizeFraction: 0.024,
      spreadLimitBps: 3
    },

    // ─── CRYPTO (Coinbase paper — live Coinbase prices, simulated fills locally) ───
    {
      id: 'agent-cb-btc-momentum',
      name: 'CB BTC Momentum (KILLED — doubles BTC exposure)',
      symbol: 'BTC-USD',
      broker: 'coinbase-live',
      assetClass: 'crypto',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: false, // HARD KILL: BTC is our biggest bleed; no BTC scalpers until we have evidence of edge
      focus: 'BTC momentum on Coinbase native pricing — tighter spreads than Alpaca passthrough.',
      targetBps: 25,
      stopBps: 18,
      maxHoldTicks: 60,
      cooldownTicks: 5,
      sizeFraction: 0.05,
      spreadLimitBps: 4
    },
    {
      id: 'agent-cb-eth-revert',
      name: 'CB ETH Reverter',
      symbol: 'ETH-USD',
      broker: 'coinbase-live',
      assetClass: 'crypto',
      style: 'mean-reversion',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'ETH mean-reversion on Coinbase native orderbook depth.',
      targetBps: 20,
      stopBps: 14,
      maxHoldTicks: 90,
      cooldownTicks: 5,
      sizeFraction: 0.05,
      spreadLimitBps: 4
    },
    {
      id: 'agent-cb-sol-breakout',
      name: 'CB SOL Breakout',
      symbol: 'SOL-USD',
      broker: 'coinbase-live',
      assetClass: 'crypto',
      style: 'breakout',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'SOL breakout on Coinbase — different style than Alpaca momentum for diversification.',
      targetBps: 35,
      stopBps: 20,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.04,
      spreadLimitBps: 5
    },
    {
      // BOOST: 110 trades, 75% WR, $2.16/trade edge — double position size.
      // XRP microstructure is the firm's strongest signal (confirmed by grid-xrp performance).
      id: 'agent-cb-xrp-momentum',
      name: 'CB XRP Momentum',
      symbol: 'XRP-USD',
      broker: 'coinbase-live',
      assetClass: 'crypto',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true,
      focus: 'XRP momentum on Coinbase — double size (75% WR, $2.16/trade edge).',
      targetBps: 20,
      stopBps: 14,
      maxHoldTicks: 50,
      cooldownTicks: 4,
      sizeFraction: 0.10,  // was 0.04 — scaled 2.5x (75% WR, 110 trades, $2.16/trade)
      spreadLimitBps: 4
    },

    // ─── FOREX (OANDA practice) ───
    {
      id: 'agent-eurusd-trend',
      name: 'EUR/USD Trend',
      symbol: 'EUR_USD',
      broker: 'oanda-rest',
      assetClass: 'forex',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Forex momentum on EUR/USD during London/NY overlap.',
      targetBps: 12,
      stopBps: 8,
      maxHoldTicks: 60,
      cooldownTicks: 3,
      sizeFraction: 0.08,
      spreadLimitBps: 3 // COO: tighten to block entries when spread > 3bps (GBP at 7.32bps now)
    },
    {
      // KILL: 3 trades, 33% WR, -$2,039. GBP/USD mean-reversion is structurally broken
      // (15bps stop is inside noise band — GBP daily ATR ~40-60bps). Replaces capital
      // drag with zero benefit. Re-enable only with ADX<20 regime filter + 25bps stop.
      id: 'agent-gbpusd-revert',
      name: 'GBP/USD Reverter (KILLED: 33% WR, -$2,039)',
      symbol: 'GBP_USD',
      broker: 'oanda-rest',
      assetClass: 'forex',
      style: 'mean-reversion',
      executionMode: 'broker-paper',
      autonomyEnabled: false,
      focus: 'Mean-reversion on GBP/USD after news spikes.',
      targetBps: 15,
      stopBps: 10,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.07,
      spreadLimitBps: 3
    },
    {
      id: 'agent-usdjpy-momentum',
      name: 'USD/JPY Momentum',
      symbol: 'USD_JPY',
      broker: 'oanda-rest',
      assetClass: 'forex',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'JPY carry and momentum during Tokyo/London sessions.',
      targetBps: 14,
      stopBps: 9,
      maxHoldTicks: 60,
      cooldownTicks: 3,
      sizeFraction: 0.07,
      spreadLimitBps: 3 // COO: tighten to block entries when spread > 3bps (GBP at 7.32bps now)
    },

    // ─── STOCK INDICES (OANDA CFDs) ───
    {
      id: 'agent-spx500-trend',
      name: 'S&P 500 Trend',
      symbol: 'SPX500_USD',
      broker: 'oanda-rest',
      assetClass: 'equity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Broad market index momentum during US regular hours.',
      targetBps: 15,
      stopBps: 10,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.08,
      spreadLimitBps: 5
    },
    {
      id: 'agent-nas100-breakout',
      name: 'Nasdaq 100 Breakout',
      symbol: 'NAS100_USD',
      broker: 'oanda-rest',
      assetClass: 'equity',
      style: 'breakout',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Tech-heavy index breakout entries with tight stops.',
      targetBps: 20,
      stopBps: 12,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.08,
      spreadLimitBps: 5
    },

    // ─── BONDS (OANDA practice) ───
    {
      id: 'agent-us10y-revert',
      name: 'US 10Y Bond Reverter',
      symbol: 'USB10Y_USD',
      broker: 'oanda-rest',
      assetClass: 'bond',
      style: 'mean-reversion',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Treasury mean-reversion on yield spikes and CPI events.',
      targetBps: 10,
      stopBps: 7,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.06,
      spreadLimitBps: 8
    },
    {
      id: 'agent-us30y-momentum',
      name: 'US 30Y Bond Momentum',
      symbol: 'USB30Y_USD',
      broker: 'oanda-rest',
      assetClass: 'bond',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Long-duration momentum following rate-cut / hike regime shifts.',
      targetBps: 12,
      stopBps: 8,
      maxHoldTicks: 60,
      cooldownTicks: 5,
      sizeFraction: 0.05,
      spreadLimitBps: 8
    },

    // ─── US STOCKS (Alpaca paper) ───
    {
      id: 'agent-spy-trend',
      name: 'SPY Trend',
      symbol: 'SPY',
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'S&P 500 ETF trend-following during regular hours.',
      targetBps: 15,
      stopBps: 10,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.06,
      spreadLimitBps: 3
    },
    {
      id: 'agent-qqq-breakout',
      name: 'QQQ Breakout',
      symbol: 'QQQ',
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'breakout',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Nasdaq 100 ETF breakout entries during US session.',
      targetBps: 20,
      stopBps: 12,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.06,
      spreadLimitBps: 3
    },
    {
      id: 'agent-nvda-momentum',
      name: 'NVDA Momentum',
      symbol: 'NVDA',
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'NVDA momentum following AI/semiconductor sentiment.',
      targetBps: 25,
      stopBps: 15,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.05,
      spreadLimitBps: 3
    },

    {
      id: 'agent-aapl-revert',
      name: 'AAPL Mean Reverter',
      symbol: 'AAPL',
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'mean-reversion',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'AAPL mean-reversion — buy dips on the most liquid stock.',
      targetBps: 15,
      stopBps: 10,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.05,
      spreadLimitBps: 2
    },
    {
      id: 'agent-tsla-momentum',
      name: 'TSLA Momentum',
      symbol: 'TSLA',
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'TSLA momentum — high beta, rides sentiment swings.',
      targetBps: 30,
      stopBps: 20,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.04,
      spreadLimitBps: 5
    },
    {
      id: 'agent-msft-trend',
      name: 'MSFT Trend',
      symbol: 'MSFT',
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'MSFT trend-following — cloud/AI earnings momentum.',
      targetBps: 12,
      stopBps: 8,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.05,
      spreadLimitBps: 2
    },
    {
      id: 'agent-amzn-breakout',
      name: 'AMZN Breakout',
      symbol: 'AMZN',
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'breakout',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'AMZN breakout entries on volume expansion.',
      targetBps: 20,
      stopBps: 12,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.05,
      spreadLimitBps: 3
    },
    {
      id: 'agent-meta-revert',
      name: 'META Mean Reverter',
      symbol: 'META',
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'mean-reversion',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'META mean-reversion — social media sector dip buying.',
      targetBps: 18,
      stopBps: 12,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.04,
      spreadLimitBps: 3
    },
    {
      id: 'agent-amd-momentum',
      name: 'AMD Momentum',
      symbol: 'AMD',
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'AMD momentum — semiconductor cycle plays, correlated with NVDA.',
      targetBps: 25,
      stopBps: 15,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.04,
      spreadLimitBps: 4
    },

    // ─── VOLATILITY (Alpaca paper) ───
    {
      id: 'agent-vixy-fear',
      name: 'VIXY Fear Spike',
      symbol: 'VIXY',
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Buy VIX proxy on geopolitical/macro fear spikes.',
      targetBps: 80,
      stopBps: 40,
      maxHoldTicks: 60,
      cooldownTicks: 8,
      sizeFraction: 0.04,
      spreadLimitBps: 15
    },

    // ─── COMMODITIES (OANDA practice) ───
    {
      id: 'agent-gold-revert',
      name: 'Gold Mean Reverter',
      symbol: 'XAU_USD',
      broker: 'oanda-rest',
      assetClass: 'commodity',
      style: 'mean-reversion',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Gold reversion after risk-off spikes.',
      targetBps: 18,
      stopBps: 12,
      maxHoldTicks: 60,
      cooldownTicks: 5,
      sizeFraction: 0.05,
      spreadLimitBps: 15
    },
    {
      id: 'agent-silver-momentum',
      name: 'Silver Momentum',
      symbol: 'XAG_USD',
      broker: 'oanda-rest',
      assetClass: 'commodity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Silver momentum for precious-metals beta and green-energy metal flow.',
      targetBps: 22,
      stopBps: 14,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.04,
      spreadLimitBps: 18
    },
    {
      id: 'agent-brent-momentum',
      name: 'Brent Oil Momentum',
      symbol: 'BCO_USD',
      broker: 'oanda-rest',
      assetClass: 'commodity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Brent momentum on global supply, shipping, and geopolitics.',
      targetBps: 22,
      stopBps: 14,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.04,
      spreadLimitBps: 3 // COO: tighten to block entries when spread > 3bps (GBP at 7.32bps now)
    },
    {
      id: 'agent-oil-momentum',
      name: 'Crude Oil Momentum',
      symbol: 'WTICO_USD',
      broker: 'oanda-rest',
      assetClass: 'commodity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'WTI crude momentum on supply/demand regime shifts.',
      targetBps: 20,
      stopBps: 14,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.05,
      spreadLimitBps: 3 // COO: tighten to block entries when spread > 3bps (GBP at 7.32bps now)
    },

    // ─── GREEN ENERGY / INDUSTRIAL METALS (OANDA practice) ───
    {
      id: 'agent-natgas-momentum',
      name: 'Natural Gas Momentum',
      symbol: 'NATGAS_USD',
      broker: 'oanda-rest',
      assetClass: 'commodity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: true, // FIX: re-enabled with wall-clock max hold (2h forex) + session-end flatten + entryTick preservation
      focus: 'Natural gas momentum on seasonal demand, storage reports, and LNG flows.',
      targetBps: 35,
      stopBps: 22,
      maxHoldTicks: 60,
      cooldownTicks: 5,
      sizeFraction: 0.04,
      spreadLimitBps: 20
    },
    {
      id: 'agent-copper-trend',
      name: 'Copper Trend',
      symbol: 'XCU_USD',
      broker: 'oanda-rest',
      assetClass: 'commodity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'Copper trend-following — EV/green energy demand proxy, China PMI sensitivity.',
      targetBps: 20,
      stopBps: 14,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.04,
      spreadLimitBps: 15
    },
    {
      id: 'agent-platinum-revert',
      name: 'Platinum Mean Reverter',
      symbol: 'XPT_USD',
      broker: 'oanda-rest',
      assetClass: 'commodity',
      style: 'mean-reversion',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'Platinum mean-reversion — hydrogen fuel cell catalyst demand, auto sector.',
      targetBps: 18,
      stopBps: 12,
      maxHoldTicks: 60,
      cooldownTicks: 5,
      sizeFraction: 0.03,
      spreadLimitBps: 20
    },

    {
      id: 'agent-palladium-momentum',
      name: 'Palladium Momentum',
      symbol: 'XPD_USD',
      broker: 'oanda-rest',
      assetClass: 'commodity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'Palladium momentum — catalytic converter demand, auto production cycles.',
      targetBps: 25,
      stopBps: 16,
      maxHoldTicks: 60,
      cooldownTicks: 5,
      sizeFraction: 0.03,
      spreadLimitBps: 25
    },

    // ─── CROSS-EXCHANGE ARBITRAGE (Alpaca ↔ Coinbase) ───
    // NOTE: Disabled — both brokers read the same market-data price feed.
    // Arb requires separate real-time price sources per venue to detect real spreads.
    // Re-enable when Alpaca and Coinbase have independent websocket price feeds.
    {
      // Fix: reduced sizeFraction 30% to limit losses while arb model improves (33.3% WR, -$0.17)
      id: 'agent-arb-btc',
      name: 'BTC Arb Scanner',
      symbol: 'BTC-USD',
      broker: 'coinbase-live',
      assetClass: 'crypto',
      style: 'arbitrage',
      executionMode: 'watch-only',
      autonomyEnabled: false,
      focus: 'Cross-exchange arb: buy BTC on cheaper venue, sell on expensive. Alpaca vs Coinbase.',
      targetBps: 8,
      stopBps: 5,
      maxHoldTicks: 10,
      cooldownTicks: 2,
      sizeFraction: 0.056,
      spreadLimitBps: 3
    },
    {
      id: 'agent-arb-eth',
      name: 'ETH Arb Scanner',
      symbol: 'ETH-USD',
      broker: 'coinbase-live',
      assetClass: 'crypto',
      style: 'arbitrage',
      executionMode: 'watch-only',
      autonomyEnabled: false,
      focus: 'Cross-exchange arb: buy ETH on cheaper venue, sell on expensive. Alpaca vs Coinbase.',
      targetBps: 8,
      stopBps: 5,
      maxHoldTicks: 10,
      cooldownTicks: 2,
      sizeFraction: 0.08,
      spreadLimitBps: 3
    },

    // ─── COPY SLEEVE (Shadow Trading) ───
    {
      id: 'agent-shadow-insider',
      name: 'Shadow Insider Bot',
      symbol: 'NVDA', // Default, Strategy Director will pivot this dynamically
      broker: 'alpaca-paper',
      assetClass: 'equity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'Copy-trading high-conviction insider and political signals based on AI Sentiment.',
      targetBps: 40,
      stopBps: 25,
      maxHoldTicks: 120,
      cooldownTicks: 10,
      sizeFraction: 0.00, // Starts at zero, scaled up by Director on confirmed signals
      spreadLimitBps: 5
    }
  ];
}

export function getDefaultAgentConfig(agentId: string, realPaperAutopilot: boolean) {
  return buildAgentConfigs(realPaperAutopilot).find((config) => config.id === agentId) ?? null;
}

export function withAgentConfigDefaults(config: AgentConfig): AgentConfig {
  return {
    ...config,
    broker: config.broker ?? defaultBrokerForSymbol(config.symbol),
    executionMode: (config as any).status === 'contender' ? 'watch-only' : (config.executionMode ?? defaultExecutionModeForSymbol(config.symbol)),
    autonomyEnabled: config.autonomyEnabled ?? defaultAutonomyEnabled(config.symbol)
  };
}

export function defaultBrokerForSymbol(symbol: string): BrokerId {
  if (symbol.endsWith('-USD')) {
    return 'coinbase-live';
  }
  if (symbol.includes('_')) {
    return 'oanda-rest';
  }
  return 'alpaca-paper';
}

export function defaultExecutionModeForSymbol(symbol: string): AgentExecutionMode {
  if (symbol === 'ETH-USD' || symbol === 'QQQ' || symbol === 'NVDA') {
    return 'broker-paper';
  }
  return 'watch-only';
}

export function defaultAutonomyEnabled(symbol: string): boolean {
  // @ts-ignore
  return symbol === 'ETH-USD' || symbol === 'QQQ' ? (global.REAL_PAPER_AUTOPILOT ?? true) : false;
}

/** Validate all agent configs at startup — catches typos, missing fields, bad ranges */
export function validateAgentConfigs(configs: AgentSeedConfig[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const c of configs) {
    if (!c.id) errors.push(`Agent missing id`);
    if (ids.has(c.id)) errors.push(`Duplicate agent id: ${c.id}`);
    ids.add(c.id);
    if (!c.symbol) errors.push(`${c.id}: missing symbol`);
    if (!c.name) errors.push(`${c.id}: missing name`);
    if (c.targetBps <= 0) errors.push(`${c.id}: targetBps must be > 0 (got ${c.targetBps})`);
    if (c.stopBps <= 0) errors.push(`${c.id}: stopBps must be > 0 (got ${c.stopBps})`);
    if (c.sizeFraction < 0 || c.sizeFraction > 1) errors.push(`${c.id}: sizeFraction must be 0-1 (got ${c.sizeFraction})`);
    if (c.maxHoldTicks <= 0) errors.push(`${c.id}: maxHoldTicks must be > 0 (got ${c.maxHoldTicks})`);
    if (c.spreadLimitBps < 0) errors.push(`${c.id}: spreadLimitBps must be >= 0 (got ${c.spreadLimitBps})`);
    if (!['momentum', 'mean-reversion', 'breakout', 'arbitrage'].includes(c.style)) errors.push(`${c.id}: invalid style '${c.style}'`);
    if (!['coinbase-live', 'oanda-rest', 'alpaca-paper'].includes(c.broker)) errors.push(`${c.id}: invalid broker '${c.broker}'`);
  }
  if (errors.length > 0) {
    console.error(`[paper-engine-config] ${errors.length} config validation errors:`);
    for (const e of errors) console.error(`  - ${e}`);
  }
  return errors;
}
