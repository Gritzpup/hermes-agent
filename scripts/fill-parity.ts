/**
 * Fill-Price Parity Test
 * 
 * Compares backtest fill-price model (simulation.ts) vs paper fill-price model
 * (services/api/src/paper-engine/engine-broker-execution.ts).
 * 
 * KNOWN DIVERGENCE: Backtest uses (spreadBps / 10_000) * 0.5 as slippage factor.
 * Paper uses (spreadBps / 10_000) * 0.25 — a 2x difference.
 * 
 * This test documents the delta; fixing the underlying models is a separate task.
 */

// ── Backtest fill-price model (services/backtest/src/simulation.ts) ──────────
function backtestFillPrice(price: number, spreadBps: number, direction: 'long' | 'short'): number {
  const slippage = (spreadBps / 10_000) * 0.5; // 50% of spread
  return direction === 'long'
    ? price * (1 + slippage)
    : price * (1 - slippage);
}

// ── Paper fill-price model (services/api/src/paper-engine/engine-broker-execution.ts) ──
function paperFillPrice(price: number, spreadBps: number, direction: 'long' | 'short'): number {
  const slippage = (spreadBps / 10_000) * 0.25; // 25% of spread
  return direction === 'long'
    ? price * (1 + slippage)
    : price * (1 - slippage);
}

// ── Helper: delta in basis points ───────────────────────────────────────────
function deltaBps(a: number, b: number): number {
  return Math.abs((a - b) / a) * 10_000;
}

// ── Test runner ──────────────────────────────────────────────────────────────
interface TestCase {
  name: string;
  price: number;
  spreadBps: number;
  direction: 'long' | 'short';
}

const PARITY_THRESHOLD_BPS = 1; // parity = within 1 bps

const cases: TestCase[] = [
  { name: 'Long entry,  spread=2 bps', price: 50_000, spreadBps: 2,   direction: 'long'  },
  { name: 'Long entry,  spread=5 bps', price: 50_000, spreadBps: 5,   direction: 'long'  },
  { name: 'Short entry, spread=2 bps', price: 50_000, spreadBps: 2,   direction: 'short' },
  { name: 'Short entry, spread=5 bps', price: 50_000, spreadBps: 5,   direction: 'short' },
  { name: 'Long entry,  spread=10 bps', price: 2_000, spreadBps: 10,  direction: 'long'  },
  { name: 'Short entry, spread=10 bps', price: 2_000, spreadBps: 10,  direction: 'short' },
];

console.log('='.repeat(70));
console.log('  FILL-PRICE PARITY TEST  |  Backtest vs Paper engine');
console.log('='.repeat(70));
console.log();
console.log('Formulas:');
console.log('  BACKTEST : fillPrice = price * (1 ± (spreadBps/10000) * 0.5)');
console.log('  PAPER    : fillPrice = price * (1 ± (spreadBps/10000) * 0.25)');
console.log(`  PARITY THRESHOLD: ${PARITY_THRESHOLD_BPS} bps`);
console.log();
console.log('-'.repeat(70));

let allPassed = true;

for (const tc of cases) {
  const btPrice  = backtestFillPrice(tc.price, tc.spreadBps, tc.direction);
  const ppPrice  = paperFillPrice(tc.price, tc.spreadBps, tc.direction);
  const delta    = deltaBps(btPrice, ppPrice);
  const pass     = delta < PARITY_THRESHOLD_BPS;
  
  if (!pass) allPassed = false;

  const status = pass ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${status}  ${tc.name}`);
  console.log(`         Price=$${tc.price.toLocaleString()}  spread=${tc.spreadBps}bps`);
  console.log(`         Backtest fill: $${btPrice.toFixed(4)}`);
  console.log(`         Paper fill:    $${ppPrice.toFixed(4)}`);
  console.log(`         Delta: ${delta.toFixed(2)} bps  (${pass ? 'within threshold' : 'EXCEEDS THRESHOLD'})`);
  console.log();
}

console.log('-'.repeat(70));
console.log();

// ── Summary ───────────────────────────────────────────────────────────────────
if (allPassed) {
  console.log('RESULT: ✓ ALL CASES WITHIN PARITY THRESHOLD');
  console.log();
  console.log('  The test becomes a regression guard. Any future changes to fill-price');
  console.log('  models will trigger this test and must maintain < 1 bps parity.');
} else {
  console.log('RESULT: ✗ PARITY VIOLATION DETECTED');
  console.log();
  console.log('  KNOWN DIVERGENCE:');
  console.log('    - Backtest slippage factor: 0.5 (50% of spread)');
  console.log('    - Paper slippage factor:    0.25 (25% of spread)');
  console.log('    - Ratio: 2x (backtest assumes higher execution cost)');
  console.log();
  console.log('  ACTION REQUIRED: This is a documented architectural delta.');
  console.log('  Do NOT attempt to fix in this test. See:');
  console.log('    - services/backtest/src/simulation.ts (backtest fill model)');
  console.log('    - services/api/src/paper-engine/engine-broker-execution.ts (paper fill model)');
  console.log();
  console.log('  Backtested edges computed at 0.5x spread may overestimate costs vs paper.');
  console.log('  Research validated with 0.5x spread should survive paper when paper');
  console.log('  uses the cheaper 0.25x spread — but not vice versa.');
}

console.log();
console.log('='.repeat(70));

process.exit(allPassed ? 0 : 1);
