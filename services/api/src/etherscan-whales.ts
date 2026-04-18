/**
 * Etherscan Whale Alerts — on-chain large-transfer detection.
 *
 * Polls Etherscan txlist for Binance/Coinbase/Kraken hot wallets every 10 min.
 * Flags transfers >$10M USD and publishes to Redis topic hermes:onchain:whale.
 * Env: ETHERSCAN_API_KEY
 */

import { redis, TOPICS } from '@hermes/infra';

const ETHERSCAN_BASE = 'https://api.etherscan.io/api';
const POLL_MS = 10 * 60 * 1000; // 10 minutes

// Hot wallets to monitor
const HOT_WALLETS: Record<string, string> = {
  binance:   '0x28c6c06298d514db089934071355e5743bf21d60',
  coinbase:  '0x71660c4005BA85c37ccec55d0C4493E66Fe775d3',
  kraken:    '0x2910543af39aba0cd09dbb2d50200b3e800a63d2',
};

const ETH_PRICE_FALLBACK = 2000; // USD/ETH — used when price lookup fails

export interface WhaleTransfer {
  hash: string;
  from: string;
  to: string;
  valueUsd: number;
  timestamp: string;
  wallet: string;
}

let pollTimer: NodeJS.Timeout | null = null;
let lastTransfers: WhaleTransfer[] = [];

async function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getEthPrice(): Promise<number> {
  try {
    const url = `${ETHERSCAN_BASE}?module=stats&action=ethprice&apikey=${process.env.ETHERSCAN_API_KEY ?? ''}`;
    const resp = await fetchWithTimeout(url, 5000);
    if (!resp.ok) return ETH_PRICE_FALLBACK;
    const data = await resp.json() as { result?: { ethusd?: string } };
    return Number(data.result?.ethusd ?? ETH_PRICE_FALLBACK);
  } catch {
    return ETH_PRICE_FALLBACK;
  }
}

async function fetchWalletTxs(address: string, apiKey: string): Promise<Array<{
  hash: string; from: string; to: string; value: string; timeStamp: string;
}>> {
  const url = `${ETHERSCAN_BASE}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&limit=100&apikey=${apiKey}`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) return [];
  const data = await resp.json() as { status?: string; result?: unknown };
  if (data.status !== '1' || !Array.isArray(data.result)) return [];
  return data.result as Array<{
    hash: string; from: string; to: string; value: string; timeStamp: string;
  }>;
}

const WHALE_THRESHOLD_USD = 10_000_000;

async function pollOnce(): Promise<void> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return;

  const ethPrice = await getEthPrice();
  const newTransfers: WhaleTransfer[] = [];

  // Look back 10 minutes of Unix time
  const since = Math.floor(Date.now() / 1000) - (POLL_MS / 1000);

  for (const [wallet, address] of Object.entries(HOT_WALLETS)) {
    const txs = await fetchWalletTxs(address, apiKey);
    for (const tx of txs) {
      const txTime = Number(tx.timeStamp);
      if (isNaN(txTime) || txTime < since) continue;

      const wei = BigInt(tx.value);
      const eth = Number(wei) / 1e18;
      const valueUsd = eth * ethPrice;

      if (valueUsd >= WHALE_THRESHOLD_USD) {
        const isOut = tx.from.toLowerCase() === address.toLowerCase();
        newTransfers.push({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          valueUsd: Math.round(valueUsd),
          timestamp: new Date(txTime * 1000).toISOString(),
          wallet,
        });

        // Publish to Redis
        try {
          const payload = JSON.stringify({
            type: 'WHALE_TRANSFER',
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            valueUsd: Math.round(valueUsd),
            wallet,
            timestamp: new Date(txTime * 1000).toISOString(),
          });
          await redis.publish(TOPICS.WHALE_TRANSFER, payload);
          console.log(`[etherscan-whales] 🚨 Whale alert: ${(valueUsd / 1e6).toFixed(1)}M ETH tx ${tx.hash.slice(0, 10)}... (${wallet})`);
        } catch (e) {
          console.warn('[etherscan-whales] Redis publish failed:', e);
        }
      }
    }
  }

  lastTransfers = newTransfers;
}

export function startEtherscanWhales(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => { void pollOnce(); }, POLL_MS);
  void pollOnce();
}

export function stopEtherscanWhales(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/**
 * Returns the most recent whale transfers detected in the last poll cycle.
 */
export function getRecentWhaleTransfers(): WhaleTransfer[] {
  return lastTransfers;
}
