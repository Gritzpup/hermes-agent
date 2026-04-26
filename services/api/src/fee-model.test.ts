/**
 * fee-model.test.ts
 *
 * Unit tests for the tiered Coinbase Advanced fee schedule.
 * Covers each tier boundary, each venue, and the HERMES_FEE_MODEL v1/v2 toggle.
 * Uses modelOverride parameter on feeBps/getCoinbaseTier to avoid process.env
 * isolation issues between test suites.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { feeBps, getCoinbaseTier } from './fee-model.js';

// ── v2 (tiered) — default ──────────────────────────────────────────────────

describe('feeBps — HERMES_FEE_MODEL=v2 (tiered, default)', () => {

  describe('coinbase — Tier 1 (volume30d < $10K or unknown)', () => {
    it('defaults to Tier 1 when volume30d is undefined', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', undefined, 'v2'), 60);
      assert.strictEqual(feeBps('coinbase', 'taker', undefined, 'v2'), 80);
    });

    it('defaults to Tier 1 when volume30d is negative', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', -5000, 'v2'), 60);
      assert.strictEqual(feeBps('coinbase', 'taker', -1, 'v2'), 80);
    });

    it('Tier 1 boundary: $0 inclusive, $9,999 inclusive → Tier 1', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', 0, 'v2'), 60);
      assert.strictEqual(feeBps('coinbase', 'maker', 9_999, 'v2'), 60);
      assert.strictEqual(feeBps('coinbase', 'taker', 9_999, 'v2'), 80);
    });
  });

  describe('coinbase — Tier 2 ($10K–$50K)', () => {
    it('Tier 2: $10,000 inclusive → Tier 2', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', 10_000, 'v2'), 40);
      assert.strictEqual(feeBps('coinbase', 'taker', 10_000, 'v2'), 60);
    });

    it('Tier 2 upper bound: $49,999 → Tier 2', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', 49_999, 'v2'), 40);
      assert.strictEqual(feeBps('coinbase', 'taker', 49_999, 'v2'), 60);
    });
  });

  describe('coinbase — Tier 3 ($50K–$100K)', () => {
    it('Tier 3: $50,000 inclusive → Tier 3', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', 50_000, 'v2'), 25);
      assert.strictEqual(feeBps('coinbase', 'taker', 50_000, 'v2'), 40);
    });

    it('Tier 3 upper bound: $99,999 → Tier 3', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', 99_999, 'v2'), 25);
      assert.strictEqual(feeBps('coinbase', 'taker', 99_999, 'v2'), 40);
    });
  });

  describe('coinbase — Tier 4 ($100K–$1M)', () => {
    it('Tier 4: $100,000 inclusive → Tier 4', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', 100_000, 'v2'), 20);
      assert.strictEqual(feeBps('coinbase', 'taker', 100_000, 'v2'), 35);
    });

    it('Tier 4 upper bound: $999,999 → Tier 4', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', 999_999, 'v2'), 20);
      assert.strictEqual(feeBps('coinbase', 'taker', 999_999, 'v2'), 35);
    });
  });

  describe('coinbase — Tier 5 ($1M–$15M)', () => {
    it('Tier 5: $1,000,000 inclusive → Tier 5', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', 1_000_000, 'v2'), 18);
      assert.strictEqual(feeBps('coinbase', 'taker', 1_000_000, 'v2'), 30);
    });

    it('Tier 5 upper bound: $14,999,999 → Tier 5', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', 14_999_999, 'v2'), 18);
      assert.strictEqual(feeBps('coinbase', 'taker', 14_999_999, 'v2'), 30);
    });

    it('Beyond $15M: falls back to Tier 5 (highest tier)', () => {
      assert.strictEqual(feeBps('coinbase', 'maker', 100_000_000, 'v2'), 18);
      assert.strictEqual(feeBps('coinbase', 'taker', 100_000_000, 'v2'), 30);
    });
  });

  describe('oanda (forex)', () => {
    it('maker and taker both return 5 bps with TODO marker', () => {
      // TODO: verify with actual OANDA forex commission schedule
      assert.strictEqual(feeBps('oanda', 'maker', undefined, 'v2'), 5);
      assert.strictEqual(feeBps('oanda', 'taker', undefined, 'v2'), 5);
    });

    it('volume30d parameter is ignored for OANDA (no volume tiers)', () => {
      assert.strictEqual(feeBps('oanda', 'maker', 1_000_000, 'v2'), 5);
      assert.strictEqual(feeBps('oanda', 'taker', 50_000, 'v2'), 5);
    });
  });

  describe('alpaca (equity)', () => {
    it('maker and taker both return 1 bps with TODO marker', () => {
      // TODO: verify with actual Alpaca equity subscription pricing
      assert.strictEqual(feeBps('alpaca', 'maker', undefined, 'v2'), 1);
      assert.strictEqual(feeBps('alpaca', 'taker', undefined, 'v2'), 1);
    });

    it('volume30d parameter is ignored for Alpaca (no volume tiers)', () => {
      assert.strictEqual(feeBps('alpaca', 'maker', 1_000_000, 'v2'), 1);
      assert.strictEqual(feeBps('alpaca', 'taker', 50_000, 'v2'), 1);
    });
  });

  describe('default (no HERMES_FEE_MODEL set, no modelOverride)', () => {
    it('defaults to tiered v2 behavior when no override is passed', () => {
      // Pass undefined for modelOverride — should behave as v2
      assert.strictEqual(feeBps('coinbase', 'maker'), 60);
      assert.strictEqual(feeBps('coinbase', 'taker'), 80);
    });
  });
});

// ── v1 (legacy flat) ───────────────────────────────────────────────────────

describe('feeBps — HERMES_FEE_MODEL=v1 (legacy flat)', () => {
  it('coinbase: 2 bps maker / 6 bps taker', () => {
    assert.strictEqual(feeBps('coinbase', 'maker', undefined, 'v1'), 2);
    assert.strictEqual(feeBps('coinbase', 'taker', undefined, 'v1'), 6);
    assert.strictEqual(feeBps('coinbase', 'maker', 10_000, 'v1'), 2); // volume ignored in v1
    assert.strictEqual(feeBps('coinbase', 'taker', 1_000_000, 'v1'), 6);
  });

  it('oanda: 5 bps flat (legacy)', () => {
    assert.strictEqual(feeBps('oanda', 'maker', undefined, 'v1'), 5);
    assert.strictEqual(feeBps('oanda', 'taker', undefined, 'v1'), 5);
  });

  it('alpaca: 1 bps flat (legacy)', () => {
    assert.strictEqual(feeBps('alpaca', 'maker', undefined, 'v1'), 1);
    assert.strictEqual(feeBps('alpaca', 'taker', undefined, 'v1'), 1);
  });

  it('unknown venue returns 0', () => {
    // @ts-expect-error testing invalid venue
    assert.strictEqual(feeBps('unknown' as any, 'maker', undefined, 'v1'), 0);
    // @ts-expect-error testing invalid side
    assert.strictEqual(feeBps('coinbase', 'both' as any, undefined, 'v1'), 0);
  });
});

// ── getCoinbaseTier ─────────────────────────────────────────────────────────

describe('getCoinbaseTier', () => {
  it('returns correct tier metadata for each volume band', () => {
    assert.deepStrictEqual(getCoinbaseTier(undefined), { makerBps: 60, takerBps: 80, tierName: 'Tier 1 (default)' });
    assert.deepStrictEqual(getCoinbaseTier(5_000),      { makerBps: 60, takerBps: 80, tierName: 'Tier 1' });
    assert.deepStrictEqual(getCoinbaseTier(10_000),     { makerBps: 40, takerBps: 60, tierName: 'Tier 2' });
    assert.deepStrictEqual(getCoinbaseTier(50_000),    { makerBps: 25, takerBps: 40, tierName: 'Tier 3' });
    assert.deepStrictEqual(getCoinbaseTier(100_000),   { makerBps: 20, takerBps: 35, tierName: 'Tier 4' });
    assert.deepStrictEqual(getCoinbaseTier(1_000_000), { makerBps: 18, takerBps: 30, tierName: 'Tier 5' });
  });

  it('negative volume returns Tier 1 (default)', () => {
    assert.deepStrictEqual(getCoinbaseTier(-1), { makerBps: 60, takerBps: 80, tierName: 'Tier 1 (default)' });
  });
});
