type AgentSeedConfig = {
  id: string;
  name: string;
  symbol: string;
  broker: 'coinbase-live' | 'oanda-rest' | 'alpaca-paper';
  assetClass: 'crypto' | 'equity' | 'forex' | 'bond' | 'commodity' | 'commodity-proxy';
  style: 'momentum' | 'mean-reversion' | 'breakout';
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
    // ─── CRYPTO (routed through Alpaca paper for order execution, Coinbase for market data) ───
    {
      id: 'agent-btc-tape',
      name: 'BTC Tape Scalper',
      symbol: 'BTC-USD',
      broker: 'alpaca-paper',
      assetClass: 'crypto',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'BTC momentum — ride trends for 5-15 minutes.',
      targetBps: 30,
      stopBps: 20,
      maxHoldTicks: 90,
      cooldownTicks: 6,
      sizeFraction: 0.06,
      spreadLimitBps: 5
    },
    {
      id: 'agent-eth-revert',
      name: 'ETH Mean Reverter',
      symbol: 'ETH-USD',
      broker: 'alpaca-paper',
      assetClass: 'crypto',
      style: 'mean-reversion',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'ETH mean-reversion — buy dips, sell rips over 5-20 minutes.',
      targetBps: 25,
      stopBps: 18,
      maxHoldTicks: 120,
      cooldownTicks: 6,
      sizeFraction: 0.06,
      spreadLimitBps: 5
    },
    {
      id: 'agent-sol-momentum',
      name: 'SOL Momentum',
      symbol: 'SOL-USD',
      broker: 'alpaca-paper',
      assetClass: 'crypto',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'SOL trend-following over 5-10 minutes.',
      targetBps: 30,
      stopBps: 20,
      maxHoldTicks: 60,
      cooldownTicks: 4,
      sizeFraction: 0.06,
      spreadLimitBps: 5
    },
    {
      id: 'agent-xrp-grid',
      name: 'XRP Grid Scalper',
      symbol: 'XRP-USD',
      broker: 'alpaca-paper',
      assetClass: 'crypto',
      style: 'mean-reversion',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'XRP grid mean-reversion on chop.',
      targetBps: 15,
      stopBps: 12,
      maxHoldTicks: 40,
      cooldownTicks: 3,
      sizeFraction: 0.05,
      spreadLimitBps: 3
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
      autonomyEnabled: realPaperAutopilot,
      focus: 'Forex momentum on EUR/USD during London/NY overlap.',
      targetBps: 12,
      stopBps: 8,
      maxHoldTicks: 10,
      cooldownTicks: 3,
      sizeFraction: 0.08,
      spreadLimitBps: 2
    },
    {
      id: 'agent-gbpusd-revert',
      name: 'GBP/USD Reverter',
      symbol: 'GBP_USD',
      broker: 'oanda-rest',
      assetClass: 'forex',
      style: 'mean-reversion',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'Mean-reversion on GBP/USD after news spikes.',
      targetBps: 15,
      stopBps: 10,
      maxHoldTicks: 12,
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
      autonomyEnabled: realPaperAutopilot,
      focus: 'JPY carry and momentum during Tokyo/London sessions.',
      targetBps: 14,
      stopBps: 9,
      maxHoldTicks: 10,
      cooldownTicks: 3,
      sizeFraction: 0.07,
      spreadLimitBps: 2
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
      autonomyEnabled: realPaperAutopilot,
      focus: 'Broad market index momentum during US regular hours.',
      targetBps: 15,
      stopBps: 10,
      maxHoldTicks: 8,
      cooldownTicks: 4,
      sizeFraction: 0.08,
      spreadLimitBps: 2
    },
    {
      id: 'agent-nas100-breakout',
      name: 'Nasdaq 100 Breakout',
      symbol: 'NAS100_USD',
      broker: 'oanda-rest',
      assetClass: 'equity',
      style: 'breakout',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'Tech-heavy index breakout entries with tight stops.',
      targetBps: 20,
      stopBps: 12,
      maxHoldTicks: 8,
      cooldownTicks: 4,
      sizeFraction: 0.08,
      spreadLimitBps: 3
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
      autonomyEnabled: realPaperAutopilot,
      focus: 'Treasury mean-reversion on yield spikes and CPI events.',
      targetBps: 10,
      stopBps: 7,
      maxHoldTicks: 16,
      cooldownTicks: 4,
      sizeFraction: 0.06,
      spreadLimitBps: 2.5
    },
    {
      id: 'agent-us30y-momentum',
      name: 'US 30Y Bond Momentum',
      symbol: 'USB30Y_USD',
      broker: 'oanda-rest',
      assetClass: 'bond',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'Long-duration momentum following rate-cut / hike regime shifts.',
      targetBps: 12,
      stopBps: 8,
      maxHoldTicks: 20,
      cooldownTicks: 5,
      sizeFraction: 0.05,
      spreadLimitBps: 3
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
      autonomyEnabled: realPaperAutopilot,
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
      autonomyEnabled: realPaperAutopilot,
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
      autonomyEnabled: realPaperAutopilot,
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
      autonomyEnabled: realPaperAutopilot,
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
      autonomyEnabled: realPaperAutopilot,
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
      autonomyEnabled: realPaperAutopilot,
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
      autonomyEnabled: realPaperAutopilot,
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
      autonomyEnabled: realPaperAutopilot,
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
      autonomyEnabled: realPaperAutopilot,
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
      autonomyEnabled: realPaperAutopilot,
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
      autonomyEnabled: realPaperAutopilot,
      focus: 'Gold reversion after risk-off spikes.',
      targetBps: 18,
      stopBps: 12,
      maxHoldTicks: 15,
      cooldownTicks: 5,
      sizeFraction: 0.05,
      spreadLimitBps: 3
    },
    {
      id: 'agent-oil-momentum',
      name: 'Crude Oil Momentum',
      symbol: 'WTICO_USD',
      broker: 'oanda-rest',
      assetClass: 'commodity',
      style: 'momentum',
      executionMode: 'broker-paper',
      autonomyEnabled: realPaperAutopilot,
      focus: 'WTI crude momentum on supply/demand regime shifts.',
      targetBps: 20,
      stopBps: 14,
      maxHoldTicks: 12,
      cooldownTicks: 4,
      sizeFraction: 0.05,
      spreadLimitBps: 4
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
