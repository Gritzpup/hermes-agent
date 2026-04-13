// @ts-nocheck
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import type {
  VenueId,
  SyncStatus,
  BrokerAccountSnapshot,
  BrokerRuntimeState,
  BrokerRouteReport
} from './broker-types.js';

import { emptyBrokerSnapshot } from './broker-utils.js';
import { syncAlpaca } from './alpaca-handler.js';
import { syncCoinbase } from './coinbase-handler.js';
import { syncOanda } from './oanda-handler.js';

// ── Module state ────────────────────────────────────────────────────

let statePath = '';
let reportsPath = '';
let syncIntervalMs = 5_000;
let runtimeState: BrokerRuntimeState;
const syncInFlight = new Map<VenueId, Promise<BrokerAccountSnapshot>>();
let initialSyncStarted = false;

// ── Init (must be called before anything else) ──────────────────────

export function initState(opts: {
  statePath: string;
  reportsPath: string;
  syncIntervalMs: number;
}): BrokerRuntimeState {
  statePath = opts.statePath;
  reportsPath = opts.reportsPath;
  syncIntervalMs = opts.syncIntervalMs;

  runtimeState = loadState();
  if (!runtimeState.brokers['oanda-rest']) {
    runtimeState.brokers['oanda-rest'] = emptyBrokerSnapshot('oanda-rest', 'oanda' as 'alpaca' | 'coinbase');
  }
  return runtimeState;
}

export function getState(): BrokerRuntimeState {
  return runtimeState;
}

// ── Load / persist ──────────────────────────────────────────────────

function loadState(): BrokerRuntimeState {
  try {
    if (statePath && fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8')) as BrokerRuntimeState;
    }
  } catch (error) {
    console.error('[broker-router] failed to load state', error);
  }

  return {
    asOf: new Date().toISOString(),
    lastSyncAt: null,
    brokers: {
      'alpaca-paper': emptyBrokerSnapshot('alpaca-paper', 'alpaca'),
      'coinbase-live': emptyBrokerSnapshot('coinbase-live', 'coinbase'),
      'oanda-rest': emptyBrokerSnapshot('oanda-rest', 'oanda')
    },
    reports: []
  };
}

let isPersisting = false;
let pendingPersist = false;

export async function persistState(): Promise<void> {
  if (!statePath) return;
  if (isPersisting) {
    pendingPersist = true;
    return;
  }
  isPersisting = true;
  pendingPersist = false;
  try {
    const stateToSave = {
      ...runtimeState,
      reports: runtimeState.reports.map(r => ({
        ...r,
        accountSnapshot: undefined,
        positionsSnapshot: undefined,
        fillsSnapshot: undefined,
        ordersSnapshot: undefined
      }))
    };
    await fs.promises.writeFile(statePath, `${JSON.stringify(stateToSave, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('[broker-router] failed to persist state', error);
  } finally {
    isPersisting = false;
    if (pendingPersist) {
      setTimeout(() => persistState(), 500);
    }
  }
}

export function recordReport(report: BrokerRouteReport): void {
  appendJsonl(reportsPath, report);

  const leanReport: BrokerRouteReport = {
    ...report,
    accountSnapshot: null,
    positionsSnapshot: [],
    fillsSnapshot: [],
    ordersSnapshot: []
  };

  runtimeState.reports.push(leanReport);
  if (runtimeState.reports.length > 50) {
    runtimeState.reports.splice(0, runtimeState.reports.length - 50);
  }
  runtimeState.asOf = new Date().toISOString();
  void persistState();
}

// ── Sync loop ───────────────────────────────────────────────────────

export async function startSyncLoop(): Promise<void> {
  if (initialSyncStarted) return;
  initialSyncStarted = true;
  await syncAll('startup');
  setInterval(() => {
    void syncAll('interval');
  }, syncIntervalMs);
}

export async function maybeRefreshSnapshots(): Promise<void> {
  const lastSyncAt = runtimeState.lastSyncAt ? new Date(runtimeState.lastSyncAt).getTime() : 0;
  if (!lastSyncAt || Date.now() - lastSyncAt > Math.max(15_000, syncIntervalMs / 2)) {
    void syncAll('on-read');
  }
}

async function syncAll(trigger: string): Promise<void> {
  await Promise.all([
    syncVenue('alpaca-paper', trigger),
    syncVenue('coinbase-live', trigger),
    syncVenue('oanda-rest', trigger)
  ]);
  runtimeState.lastSyncAt = new Date().toISOString();
  runtimeState.asOf = runtimeState.lastSyncAt;
  persistState();
}

export async function syncVenue(broker: VenueId, trigger: string): Promise<BrokerAccountSnapshot> {
  if (syncInFlight.has(broker)) {
    return syncInFlight.get(broker)!;
  }

  const promise = (async () => {
    try {
      const snapshot = broker === 'alpaca-paper'
        ? await syncAlpaca(broker)
        : broker === 'coinbase-live'
          ? await syncCoinbase(broker)
          : await syncOanda(broker);
      runtimeState.brokers[broker] = snapshot;
      runtimeState.asOf = new Date().toISOString();
      recordReport({
        id: randomUUID(),
        orderId: `sync-${broker}-${trigger}`,
        broker,
        brokerMode: broker,
        venue: broker === 'alpaca-paper' ? 'alpaca' : broker === 'coinbase-live' ? 'coinbase' : 'oanda',
        symbol: broker === 'alpaca-paper' ? 'ALPACA-PAPER' : broker === 'coinbase-live' ? 'COINBASE-LIVE' : 'OANDA-REST',
        status: snapshot.status === 'missing-credentials' ? 'rejected' : 'accepted',
        mode: broker === 'alpaca-paper' ? 'paper' : broker === 'oanda-rest' ? 'paper' : 'live',
        source: 'broker',
        filledQty: 0,
        avgFillPrice: 0,
        slippageBps: 0,
        latencyMs: 0,
        message: snapshot.status === 'healthy'
          ? `${broker} synced successfully.`
          : snapshot.errors.at(-1) ?? `${broker} sync returned ${snapshot.status}.`,
        timestamp: snapshot.asOf,
        riskCheck: null,
        eventSource: 'sync',
        details: `Sync trigger: ${trigger}`,
        errors: snapshot.errors,
        accountSnapshot: snapshot.account,
        positionsSnapshot: snapshot.positions,
        fillsSnapshot: snapshot.fills,
        ordersSnapshot: snapshot.orders
      });
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown sync error';
      const prevSnapshot = runtimeState.brokers[broker] || emptyBrokerSnapshot(broker, broker === 'alpaca-paper' ? 'alpaca' : 'coinbase');
      const snapshot = {
        ...prevSnapshot,
        status: 'error' as SyncStatus,
        asOf: new Date().toISOString(),
        errors: [...(prevSnapshot.errors || []), message].slice(-10)
      };
      runtimeState.brokers[broker] = snapshot;
      runtimeState.asOf = snapshot.asOf;
      recordReport({
        id: randomUUID(),
        orderId: `sync-${broker}-${trigger}`,
        broker,
        brokerMode: broker,
        venue: broker === 'alpaca-paper' ? 'alpaca' : 'coinbase',
        symbol: broker,
        status: 'rejected',
        mode: broker === 'alpaca-paper' ? 'paper' : 'live',
        source: 'broker',
        filledQty: 0,
        avgFillPrice: 0,
        slippageBps: 0,
        latencyMs: 0,
        message,
        timestamp: snapshot.asOf,
        riskCheck: null,
        eventSource: 'sync',
        details: `Sync failed during ${trigger}.`,
        errors: [message],
        accountSnapshot: snapshot.account,
        positionsSnapshot: snapshot.positions,
        fillsSnapshot: snapshot.fills,
        ordersSnapshot: snapshot.orders
      });
      return snapshot;
    } finally {
      syncInFlight.delete(broker);
      persistState();
    }
  })();

  syncInFlight.set(broker, promise);
  return promise;
}

// ── Helpers ─────────────────────────────────────────────────────────

function appendJsonl(filePath: string, payload: unknown): void {
  if (!filePath) return;
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (error) {
    console.error('[broker-router] failed to append report', error);
  }
}
