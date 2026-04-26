/**
 * ConcentrationGuard — unit test (standalone, no external test runner)
 *
 * Covers boundary cases at 30%, 35%, 36%, 50%, 51%.
 *
 * Logic:
 *   halt  : currentShare > 50%
 *   throttle : newShare > 35%   (proposed would push symbol over 35%)
 *   allow : everything else
 *
 * share = abs(symbol_notional) / sum(abs(all_symbol_notionals)) * 100
 */

import { ConcentrationGuard, CONCENTRATION_HALT_PCT, CONCENTRATION_THROTTLE_PCT } from '../concentration-guard.js';
import type { ConcentrationResult } from '../concentration-guard.js';

// ── Redis mock ────────────────────────────────────────────────────────────────

import { redis } from '@hermes/infra';
const realKeys = redis.keys.bind(redis);
const realMget = redis.mget.bind(redis);

let mockActive = false;
let mockKeys: string[] = [];
let mockVals: (string | null)[] = [];

function activateMock(keys: string[], vals: (string | null)[]): void {
  mockActive = true;
  mockKeys = keys;
  mockVals = vals;
  (redis as any).keys = async () => keys;
  (redis as any).mget = async () => vals;
}

function deactivateMock(): void {
  mockActive = false;
  (redis as any).keys = realKeys;
  (redis as any).mget = realMget;
}

// ── Test runner ───────────────────────────────────────────────────────────────

let failures = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    failures++;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

async function evalGuard(symbol: string, proposed: number): Promise<ConcentrationResult> {
  const guard = new ConcentrationGuard();
  return guard.evaluate(symbol, proposed);
}

async function runTests(): Promise<void> {
  console.log('\n=== ConcentrationGuard unit tests ===\n');

  // ── Constants ─────────────────────────────────────────────────────────────
  console.log('--- Constants ---');
  assert(CONCENTRATION_HALT_PCT === 50, `CONCENTRATION_HALT_PCT === 50 (got ${CONCENTRATION_HALT_PCT})`);
  assert(CONCENTRATION_THROTTLE_PCT === 35, `CONCENTRATION_THROTTLE_PCT === 35 (got ${CONCENTRATION_THROTTLE_PCT})`);

  // ── 30% share → allow ─────────────────────────────────────────────────────
  console.log('\n--- 30% share → allow ---');
  activateMock(
    ['hermes:positions:XRP-USD', 'hermes:positions:BTC-USD'],
    ['{"notional":30}', '{"notional":70}']
  );
  {
    const r = await evalGuard('XRP-USD', 0);
    assert(r.action === 'allow', `30% → allow (got ${r.action})`);
    assert(r.share === 30, `share === 30 (got ${r.share})`);
  }
  deactivateMock();

  // ── 35% share → allow (at throttle boundary: >35 required) ───────────────
  console.log('\n--- 35% share → allow (boundary, >35 required) ---');
  activateMock(
    ['hermes:positions:XRP-USD', 'hermes:positions:BTC-USD'],
    ['{"notional":35}', '{"notional":65}']
  );
  {
    const r = await evalGuard('XRP-USD', 0);
    // 35% is NOT > 35%, so newShare = 35% → NOT > 35% → allow
    assert(r.action === 'allow', `35% → allow (got ${r.action})`);
    assert(r.share === 35, `share === 35 (got ${r.share})`);
  }
  deactivateMock();

  // ── 36% share, 0 proposed → throttle (current > 35%) ─────────────────────
  console.log('\n--- 36% share, 0 proposed → throttle ---');
  activateMock(
    ['hermes:positions:XRP-USD', 'hermes:positions:BTC-USD'],
    ['{"notional":36}', '{"notional":64}']
  );
  {
    const r = await evalGuard('XRP-USD', 0);
    // newShare = (36+0)/(100+0) = 36% > 35% → throttle
    assert(r.action === 'throttle', `36% → throttle (got ${r.action})`);
    assert(r.share === 36, `share === 36 (got ${r.share})`);
  }
  deactivateMock();

  // ── 36% share + 5 proposed → throttle ───────────────────────────────────
  console.log('\n--- 36% share + 5 proposed → throttle ---');
  activateMock(
    ['hermes:positions:XRP-USD', 'hermes:positions:BTC-USD'],
    ['{"notional":36}', '{"notional":64}']
  );
  {
    const r = await evalGuard('XRP-USD', 5);
    // newShare = (36+5)/(100+5)*100 ≈ 39.05% > 35% → throttle
    assert(r.action === 'throttle', `36%+5 → throttle (got ${r.action})`);
    assert(r.share > 35, `newShare > 35% (got ${r.share})`);
  }
  deactivateMock();

  // ── 50% share → throttle (newShare = 50% > 35%) ─────────────────────────
  console.log('\n--- 50% share → throttle (newShare > 35%) ---');
  activateMock(
    ['hermes:positions:XRP-USD', 'hermes:positions:BTC-USD'],
    ['{"notional":50}', '{"notional":50}']
  );
  {
    const r = await evalGuard('XRP-USD', 0);
    // newShare = 50% > 35% (throttle) but NOT > 50% (halt) → throttle
    assert(r.action === 'throttle', `50% → throttle (got ${r.action})`);
    assert(r.share === 50, `share === 50 (got ${r.share})`);
  }
  deactivateMock();

  // ── 51% share → halt ─────────────────────────────────────────────────────
  console.log('\n--- 51% share → halt ---');
  activateMock(
    ['hermes:positions:XRP-USD', 'hermes:positions:BTC-USD'],
    ['{"notional":51}', '{"notional":49}']
  );
  {
    const r = await evalGuard('XRP-USD', 0);
    // 51% > 50% → halt
    assert(r.action === 'halt', `51% → halt (got ${r.action})`);
    assert(r.share === 51, `share === 51 (got ${r.share})`);
  }
  deactivateMock();

  // ── halt takes precedence over throttle ─────────────────────────────────
  console.log('\n--- halt precedence over throttle ---');
  activateMock(
    ['hermes:positions:XRP-USD', 'hermes:positions:BTC-USD'],
    ['{"notional":51}', '{"notional":49}']
  );
  {
    const r = await evalGuard('XRP-USD', 10);
    // current 51% > 50% → halt (checked first)
    assert(r.action === 'halt', `halt > throttle (got ${r.action})`);
  }
  deactivateMock();

  // ── single symbol 100% → halt ────────────────────────────────────────────
  console.log('\n--- single symbol 100% → halt ---');
  activateMock(
    ['hermes:positions:XRP-USD'],
    ['{"notional":100}']
  );
  {
    const r = await evalGuard('XRP-USD', 0);
    // 100% > 50% → halt
    assert(r.action === 'halt', `100% → halt (got ${r.action})`);
    assert(r.share === 100, `share === 100 (got ${r.share})`);
  }
  deactivateMock();

  // ── empty positions + proposed → throttle (newShare = 100% > 35%) ─────────
  console.log('\n--- empty positions + proposed → throttle ---');
  activateMock([], []);
  {
    const r = await evalGuard('XRP-USD', 100);
    // total=0, newTotal=100, newShare=100% > 35% → throttle
    assert(r.action === 'throttle', `empty+100 → throttle (got ${r.action})`);
    assert(r.symbolShare === 0, `symbolShare === 0 (got ${r.symbolShare})`);
  }
  deactivateMock();

  // ── new symbol not in positions (50% newShare) → throttle ─────────────────
  console.log('\n--- new symbol 50% newShare → throttle ---');
  activateMock(
    ['hermes:positions:BTC-USD'],
    ['{"notional":100}']
  );
  {
    const r = await evalGuard('XRP-USD', 100);
    // XRP absent, proposed=100, total=100, newShare=100/200=50% > 35% → throttle
    assert(r.action === 'throttle', `new@50% → throttle (got ${r.action})`);
    assert(r.share === 50, `share === 50 (got ${r.share})`);
  }
  deactivateMock();

  // ── new symbol not in positions (small proposed) → allow ─────────────────
  console.log('\n--- new symbol 10% newShare → allow ---');
  activateMock(
    ['hermes:positions:BTC-USD', 'hermes:positions:ETH-USD'],
    ['{"notional":900}', '{"notional":100}']
  );
  {
    const r = await evalGuard('XRP-USD', 100);
    // XRP absent, proposed=100, total=1000, newShare=100/1100≈9.1% → allow
    assert(r.action === 'allow', `new@9% → allow (got ${r.action})`);
    assert(r.share < 10, `share < 10% (got ${r.share})`);
  }
  deactivateMock();

  // ── short position uses abs(notional) ─────────────────────────────────────
  console.log('\n--- short position uses abs(notional) ---');
  activateMock(
    ['hermes:positions:XRP-USD', 'hermes:positions:BTC-USD'],
    ['{"notional":-40}', '{"notional":140}']
  );
  {
    const r = await evalGuard('XRP-USD', 10);
    // abs(-40)=40, newShare=(40+10)/(180)*100≈27.8% → NOT > 35% → allow
    assert(r.action === 'allow', `short -40 + 10 → allow (got ${r.action})`);
    assert(r.symbolShare === Math.round((40 / 180) * 10000) / 100,
      `symbolShare ≈ 22.22% (got ${r.symbolShare})`);
  }
  deactivateMock();

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n========================================');
  if (failures === 0) {
    console.log('All tests passed.');
    process.exit(0);
  } else {
    console.error(`${failures} test(s) failed.`);
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
