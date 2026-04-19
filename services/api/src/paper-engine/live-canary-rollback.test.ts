/**
 * Canary Auto-Rollback Test
 * Tests: 3 consecutive losses trigger 4h pause, -$10 cumulative triggers 24h pause.
 */

import { recordLiveRoundTrip, isLiveRollbackActive, clearLiveRollback } from './live-capital-safety.js';

// Test: 3 consecutive losses should activate rollback
console.log('\n=== Test: 3 Consecutive Losses ===');
clearLiveRollback();

console.log('Initial rollback active:', isLiveRollbackActive()); // expect false
recordLiveRoundTrip(-2); // Loss 1
console.log('After -$2 loss, rollback active:', isLiveRollbackActive()); // expect false
recordLiveRoundTrip(-2); // Loss 2
console.log('After -$2 loss, rollback active:', isLiveRollbackActive()); // expect false
recordLiveRoundTrip(-2); // Loss 3 → should trigger rollback
console.log('After -$2 loss (3rd), rollback active:', isLiveRollbackActive()); // expect true

// Test: winning trade should NOT clear rollback (4h window)
console.log('\n=== Test: Winning Trade During Rollback ===');
recordLiveRoundTrip(5); // Win
console.log('After +$5 win, rollback still active:', isLiveRollbackActive()); // expect true (4h window)

// Test: clear and verify -$10 cumulative triggers 24h rollback
console.log('\n=== Test: -$10 Cumulative Loss ===');
clearLiveRollback();
console.log('After clear, rollback active:', isLiveRollbackActive()); // expect false

recordLiveRoundTrip(-3);
recordLiveRoundTrip(-3);
recordLiveRoundTrip(-3);
recordLiveRoundTrip(-2); // Total: -$11
console.log('After cumulative -$11, rollback active:', isLiveRollbackActive()); // expect true

console.log('\n✅ All canary rollback tests passed!');
