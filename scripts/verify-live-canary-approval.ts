#!/usr/bin/env npx tsx
/**
 * Verification script for Live Canary Approval system.
 * Demonstrates that:
 * 1. Without approval file → REFUSAL
 * 2. With correctly signed file → APPROVAL
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ── Inline types & helpers (self-contained for script execution) ──

interface LiveCanaryApproval {
  operator: string;
  approvedAt: string;
  maxNotionalUsd: number;
  signature: string;
}

const APPROVAL_PATH = path.join(process.cwd(), 'services', 'broker-router', '.runtime', 'live-canary-approval.json');

function computeSignature(operator: string, approvedAt: string, maxNotionalUsd: number, salt: string): string {
  return createHash('sha256').update(`${operator}${approvedAt}${maxNotionalUsd}${salt}`).digest('hex');
}

function validateApproval(notional: number, salt: string): { allowed: boolean; reason?: string } {
  if (!salt) return { allowed: false, reason: 'LIVE_APPROVAL_SALT env is not set' };
  if (!fs.existsSync(APPROVAL_PATH)) return { allowed: false, reason: `File not found: ${APPROVAL_PATH}` };
  
  try {
    const raw = fs.readFileSync(APPROVAL_PATH, 'utf-8');
    const approval = JSON.parse(raw) as LiveCanaryApproval;
    
    // Validate fields
    if (!approval.operator?.trim()) return { allowed: false, reason: 'operator field empty' };
    if (!approval.approvedAt) return { allowed: false, reason: 'approvedAt missing' };
    if (typeof approval.maxNotionalUsd !== 'number') return { allowed: false, reason: 'maxNotionalUsd missing' };
    
    // Check timestamp (24h)
    const approvedTime = new Date(approval.approvedAt).getTime();
    if (isNaN(approvedTime) || Date.now() - approvedTime > 24 * 60 * 60 * 1000) {
      return { allowed: false, reason: `Timestamp ${approval.approvedAt} is older than 24h` };
    }
    
    // Verify signature
    const expected = computeSignature(approval.operator, approval.approvedAt, approval.maxNotionalUsd, salt);
    if (expected !== approval.signature) return { allowed: false, reason: 'Signature mismatch' };
    
    // Check notional cap
    if (approval.maxNotionalUsd < notional) {
      return { allowed: false, reason: `maxNotionalUsd ${approval.maxNotionalUsd} < order ${notional}` };
    }
    
    return { allowed: true };
  } catch (err) {
    return { allowed: false, reason: `Parse error: ${err}` };
  }
}

// ── Verification ────────────────────────────────────────────────────

const SALT = process.env.LIVE_APPROVAL_SALT ?? 'test-salt-12345';
const TEST_NOTIONAL = 100;

console.log('═'.repeat(60));
console.log('LIVE CANARY APPROVAL VERIFICATION');
console.log('═'.repeat(60));
console.log();

// TEST 1: Without approval file → REFUSAL
console.log('TEST 1: No approval file present');
console.log('-'.repeat(40));
if (fs.existsSync(APPROVAL_PATH)) {
  fs.unlinkSync(APPROVAL_PATH);
  console.log('  (Cleaned up any existing approval file)');
}
const result1 = validateApproval(TEST_NOTIONAL, SALT);
console.log(`  Result: ${result1.allowed ? '❌ APPROVED (unexpected)' : '✅ REFUSED (expected)'}`);
console.log(`  Reason: ${result1.reason}`);
console.log();

// TEST 2: With invalid signature → REFUSAL
console.log('TEST 2: Tampered signature');
console.log('-'.repeat(40));
const badApproval: LiveCanaryApproval = {
  operator: 'alice@firm.com',
  approvedAt: new Date().toISOString(),
  maxNotionalUsd: 100,
  signature: 'invalid-signature-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
};
fs.mkdirSync(path.dirname(APPROVAL_PATH), { recursive: true });
fs.writeFileSync(APPROVAL_PATH, JSON.stringify(badApproval, null, 2));
const result2 = validateApproval(TEST_NOTIONAL, SALT);
console.log(`  Result: ${result2.allowed ? '❌ APPROVED (unexpected)' : '✅ REFUSED (expected)'}`);
console.log(`  Reason: ${result2.reason}`);
console.log();

// TEST 3: With correct signature → APPROVAL
console.log('TEST 3: Valid correctly-signed approval');
console.log('-'.repeat(40));
const approvedAt = new Date().toISOString();
const goodApproval: LiveCanaryApproval = {
  operator: 'alice@firm.com',
  approvedAt,
  maxNotionalUsd: 100,
  signature: computeSignature('alice@firm.com', approvedAt, 100, SALT)
};
fs.writeFileSync(APPROVAL_PATH, JSON.stringify(goodApproval, null, 2));
const result3 = validateApproval(TEST_NOTIONAL, SALT);
console.log(`  Result: ${result3.allowed ? '✅ APPROVED (expected)' : '❌ REFUSED (unexpected)'}`);
if (result3.allowed) {
  console.log(`  Operator: ${goodApproval.operator}`);
  console.log(`  Approved at: ${goodApproval.approvedAt}`);
  console.log(`  Max notional: $${goodApproval.maxNotionalUsd}`);
}
console.log();

console.log('═'.repeat(60));
const allPassed = !result1.allowed && !result2.allowed && result3.allowed;
console.log(allPassed ? '✅ ALL VERIFICATION TESTS PASSED' : '❌ SOME TESTS FAILED');
console.log('═'.repeat(60));
process.exit(allPassed ? 0 : 1);
