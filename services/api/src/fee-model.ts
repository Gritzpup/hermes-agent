import type { AssetClass, BrokerId } from '@hermes/contracts';

// Coinbase fee tier integration — lazily imported to avoid circular deps
// and to gracefully handle environments where broker-router isn't available.
let _getCoinbaseFeeTier: (() => { makerBps: number; takerBps: number; tierName: string; fetchedAt: string }) | null = null;
try {
  // Only import at runtime when the module is loaded; broker-router must be built first.
  const mod = await import('@hermes/broker-router').catch(() => null);
  if (mod && typeof mod.getCurrentCoinbaseFeeTier === 'function') {
    _getCoinbaseFeeTier = mod.getCurrentCoinbaseFeeTier;
  }
} catch {
  // broker-router not available — fee model will fall back to env defaults
}

/**
 * Returns Coinbase fee tier from broker-router if available.
 * Falls back to defaults if broker-router hasn't been initialized or fetch never succeeded.
 */
function getCoinbaseFeeTier(): { makerBps: number; takerBps: number; tierName: string; fetchedAt: string } {
  if (_getCoinbaseFeeTier) {
    const tier = _getCoinbaseFeeTier();
    // If never successfully fetched (epoch timestamp), fall back to defaults
    if (tier.fetchedAt === new Date(0).toISOString()) {
      return { makerBps: 2.0, takerBps: 6.0, tierName: 'default', fetchedAt: tier.fetchedAt };
    }
    return tier;
  }
  return { makerBps: 2.0, takerBps: 6.0, tierName: 'default', fetchedAt: new Date(0).toISOString() };
}

export type OrderType = 'market' | 'limit';

export interface FeeEstimateInput {
  assetClass: AssetClass;
  broker: BrokerId;
  spreadBps: number;
  orderType: OrderType;
  postOnly?: boolean | undefined;
  adverseSelectionRisk?: number | undefined;
  quoteStabilityMs?: number | undefined;
  shortSide?: boolean | undefined;
  holdTicks?: number | undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function inferAssetClassFromSymbol(symbol: string): AssetClass {
  const normalized = symbol.toUpperCase();
  if (normalized.endsWith('-USD')) {
    const base = normalized.split('-')[0] ?? '';
    if (['BTC', 'ETH', 'SOL', 'XRP'].includes(base)) return 'crypto';
    if (base === 'PAXG') return 'commodity-proxy';
    if (base === 'BCO' || base === 'WTICO') return 'commodity';
    return 'commodity-proxy';
  }
  if (normalized.includes('_')) {
    if (normalized.startsWith('USB')) return 'bond';
    if (normalized.startsWith('BCO') || normalized.startsWith('WTICO')) return 'commodity';
    return 'forex';
  }
  return 'equity';
}

function feePerSideBps(assetClass: AssetClass, broker: BrokerId, orderType: OrderType, postOnly: boolean): number {
  const maker = postOnly || orderType === 'limit';
  if (assetClass === 'crypto') {
    if (broker === 'coinbase-live') {
      // Use live fee tier from Coinbase if available; otherwise fall back to env or hardcoded defaults.
      const tier = getCoinbaseFeeTier();
      const makerFee = tier.makerBps;
      const takerFee = tier.takerBps;
      return maker ? makerFee : takerFee;
    }
    const makerFee = envNumber('HERMES_CRYPTO_MAKER_FEE_BPS', 2.0);
    const takerFee = envNumber('HERMES_CRYPTO_TAKER_FEE_BPS', 6.0);
    return maker ? makerFee : takerFee;
  }

  if (assetClass === 'equity') {
    const makerFee = envNumber('HERMES_EQUITY_MAKER_FEE_BPS', 0.0);
    const takerFee = envNumber('HERMES_EQUITY_TAKER_FEE_BPS', 0.0);
    return maker ? makerFee : takerFee;
  }

  if (assetClass === 'forex') {
    const makerFee = envNumber('HERMES_FOREX_MAKER_FEE_BPS', 0.0);
    const takerFee = envNumber('HERMES_FOREX_TAKER_FEE_BPS', 0.0);
    return maker ? makerFee : takerFee;
  }

  if (assetClass === 'bond') {
    const makerFee = envNumber('HERMES_BOND_MAKER_FEE_BPS', 0.0);
    const takerFee = envNumber('HERMES_BOND_TAKER_FEE_BPS', 0.0);
    return maker ? makerFee : takerFee;
  }

  const makerFee = envNumber('HERMES_COMMODITY_MAKER_FEE_BPS', 0.0);
  const takerFee = envNumber('HERMES_COMMODITY_TAKER_FEE_BPS', 0.0);
  return maker ? makerFee : takerFee;
}

function spreadCaptureBps(spreadBps: number, orderType: OrderType, postOnly: boolean): number {
  if (spreadBps <= 0) return 0;
  if (postOnly || orderType === 'limit') {
    return spreadBps * 0.35;
  }
  return spreadBps;
}

function slippageBufferBps(assetClass: AssetClass, adverseSelectionRisk?: number, quoteStabilityMs?: number): number {
  const base = assetClass === 'crypto'
    ? envNumber('HERMES_CRYPTO_SLIPPAGE_BPS', 1.8)
    : assetClass === 'equity'
      ? envNumber('HERMES_EQUITY_SLIPPAGE_BPS', 0.8)
      : assetClass === 'forex'
        ? envNumber('HERMES_FOREX_SLIPPAGE_BPS', 0.7)
        : assetClass === 'bond'
          ? envNumber('HERMES_BOND_SLIPPAGE_BPS', 0.8)
          : envNumber('HERMES_COMMODITY_SLIPPAGE_BPS', 1.0);
  const adverse = clamp((adverseSelectionRisk ?? 0) * 0.035, 0, assetClass === 'crypto' ? 5.0 : 3.0);
  const unstableQuote = quoteStabilityMs !== undefined
    ? quoteStabilityMs < 1_500 ? 1.6 : quoteStabilityMs < 2_500 ? 0.8 : 0
    : 0;
  return round(base + adverse + unstableQuote, 3);
}

function carryCostBps(assetClass: AssetClass, shortSide?: boolean, holdTicks?: number): number {
  if (!shortSide) {
    return 0;
  }

  const holdPenalty = holdTicks !== undefined && holdTicks > 120 ? 0.6 : holdTicks !== undefined && holdTicks > 30 ? 0.2 : 0;
  if (assetClass === 'equity') {
    return envNumber('HERMES_EQUITY_BORROW_BPS', 0.35) + holdPenalty;
  }
  if (assetClass === 'forex') {
    return envNumber('HERMES_FOREX_CARRY_BPS', 0.15) + holdPenalty;
  }
  if (assetClass === 'bond') {
    return envNumber('HERMES_BOND_CARRY_BPS', 0.1) + holdPenalty;
  }
  if (assetClass === 'commodity') {
    return envNumber('HERMES_COMMODITY_CARRY_BPS', 0.2) + holdPenalty;
  }
  return envNumber('HERMES_CRYPTO_BORROW_BPS', 0.2) + holdPenalty;
}

export function estimateRoundTripCostBps(input: FeeEstimateInput): number {
  const postOnly = input.postOnly === true;
  const perSideFee = feePerSideBps(input.assetClass, input.broker, input.orderType, postOnly);
  const spread = spreadCaptureBps(input.spreadBps, input.orderType, postOnly);
  const slippage = slippageBufferBps(input.assetClass, input.adverseSelectionRisk, input.quoteStabilityMs);
  const carry = carryCostBps(input.assetClass, input.shortSide, input.holdTicks);
  return round((perSideFee * 2) + spread + slippage + carry, 3);
}

export function estimateExpectedGrossEdgeBps(probabilityPct: number, targetBps: number, stopBps: number): number {
  const probability = clamp(probabilityPct / 100, 0.01, 0.99);
  return round((probability * targetBps) - ((1 - probability) * stopBps), 3);
}

export function estimateExpectedNetEdgeBps(input: FeeEstimateInput & { probabilityPct: number; targetBps: number; stopBps: number }): number {
  const gross = estimateExpectedGrossEdgeBps(input.probabilityPct, input.targetBps, input.stopBps);
  const cost = estimateRoundTripCostBps(input);
  return round(gross - cost, 3);
}
