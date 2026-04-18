/**
 * Coinbase Fee Tier Monitor
 *
 * Verifies the current fee tier nightly (and every 6 hours) to detect
 * account downgrades that would eliminate maker rebates.
 *
 * Problem: Fee model assumes Coinbase maker rebate. If the account was
 * downgraded (stale API key, volume dropped, account status change),
 * taker fees apply — every maker strategy becomes negative.
 */

import { readCoinbaseCredentials, coinbaseHeaders } from './coinbase-handler.js';
import { requestJson } from './broker-utils.js';

export interface CoinbaseFeeTier {
  makerBps: number;
  takerBps: number;
  tierName: string;
  fetchedAt: string;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// Module-level cache — refreshed every 6 hours via setInterval
let cachedTier: CoinbaseFeeTier | null = null;
let lastFetchAt: number = 0;
let refreshIntervalId: ReturnType<typeof setInterval> | null = null;

// Default values matching historical fee model (maker rebate, taker cost)
const DEFAULT_MAKER_BPS = 2.0;
const DEFAULT_TAKER_BPS = 6.0;
const DEFAULT_TIER_NAME = 'default';

/**
 * Fetch the current fee tier from Coinbase Advanced Trade API.
 * Uses /api/v3/brokerage/transaction_summary endpoint.
 */
async function fetchFeeTierFromApi(): Promise<CoinbaseFeeTier> {
  const { apiKey, apiSecret } = readCoinbaseCredentials('sync');
  if (!apiKey || !apiSecret) {
    throw new Error('Coinbase API credentials not available');
  }

  const url = 'https://api.coinbase.com/api/v3/brokerage/transaction_summary';
  const headers = coinbaseHeaders('GET', url, apiKey, apiSecret);

  const response = await requestJson(url, { headers });

  if (!response.ok) {
    throw new Error(`Coinbase fee tier API error: ${JSON.stringify(response.data)}`);
  }

  const data = response.data as Record<string, unknown>;
  const record = data as Record<string, unknown>;

  // Parse fee tier from response
  // Coinbase Advanced Trade fee tiers are in the transaction_summary
  // response under the fee_tier or equivalent field
  const feeTier = record.fee_tier as Record<string, unknown> | undefined;
  const makerBps = feeTier
    ? Number((feeTier.maker_fee_rate as string | number) ?? DEFAULT_MAKER_BPS) * 100
    : DEFAULT_MAKER_BPS;
  const takerBps = feeTier
    ? Number((feeTier.taker_fee_rate as string | number) ?? DEFAULT_TAKER_BPS) * 100
    : DEFAULT_TAKER_BPS;
  const tierName = feeTier
    ? (feeTier.tier_name as string ?? feeTier.name as string ?? DEFAULT_TIER_NAME)
    : DEFAULT_TIER_NAME;

  return {
    makerBps,
    takerBps,
    tierName,
    fetchedAt: new Date().toISOString()
  };
}

/**
 * Refresh the cached fee tier. Logs warnings if maker rebate is gone.
 */
async function refreshFeeTier(): Promise<void> {
  try {
    const tier = await fetchFeeTierFromApi();
    cachedTier = tier;
    lastFetchAt = Date.now();

    // Loud warning if no maker rebate (account downgraded)
    if (tier.makerBps >= tier.takerBps) {
      console.error(
        `[COINBASE-FEE-WATCH] ⚠️  ALERT: Coinbase fee tier DOWNGRADED!` +
        `\n  Tier: ${tier.tierName}` +
        `\n  Maker: ${tier.makerBps}bps | Taker: ${tier.takerBps}bps` +
        `\n  Maker strategies will be BLOCKED until tier is restored.` +
        `\n  Fetched: ${tier.fetchedAt}`
      );
    } else {
      console.log(
        `[COINBASE-FEE-WATCH] Fee tier OK: ${tier.tierName}` +
        ` | Maker: ${tier.makerBps}bps | Taker: ${tier.takerBps}bps` +
        ` | Fetched: ${tier.fetchedAt}`
      );
    }
  } catch (err) {
    console.error(`[COINBASE-FEE-WATCH] Failed to fetch fee tier: ${err instanceof Error ? err.message : String(err)}`);
    // Keep using cached value or defaults on failure
  }
}

/**
 * Initialize the fee tier monitor. Fetches immediately, then every 6 hours.
 * Call once on application startup.
 */
export function startFeeTierMonitor(): void {
  // Immediate first fetch
  refreshFeeTier().catch(console.error);

  // Then refresh every 6 hours
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
  }
  refreshIntervalId = setInterval(refreshFeeTier, SIX_HOURS_MS);

  console.log('[COINBASE-FEE-WATCH] Fee tier monitor started (6-hour refresh interval)');
}

/**
 * Stop the fee tier monitor (for graceful shutdown).
 */
export function stopFeeTierMonitor(): void {
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
}

/**
 * Returns the cached fee tier, or default values if never fetched.
 */
export function getCurrentCoinbaseFeeTier(): CoinbaseFeeTier {
  if (cachedTier) {
    return cachedTier;
  }
  // Return defaults — fee model will use hardcoded values until first successful fetch
  return {
    makerBps: DEFAULT_MAKER_BPS,
    takerBps: DEFAULT_TAKER_BPS,
    tierName: DEFAULT_TIER_NAME,
    fetchedAt: new Date(0).toISOString()
  };
}

/**
 * Returns true if maker strategies should be blocked due to fee tier downgrade.
 * Block condition: makerBps >= takerBps (no rebate or upside-down fees).
 */
export function isMakerStrategiesBlocked(): boolean {
  const tier = getCurrentCoinbaseFeeTier();
  return tier.makerBps >= tier.takerBps;
}

/**
 * Returns the time since last successful fee tier fetch (ms).
 */
export function getTimeSinceLastFetch(): number {
  return lastFetchAt > 0 ? Date.now() - lastFetchAt : Infinity;
}
