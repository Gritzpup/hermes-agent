#!/usr/bin/env npx tsx
/**
 * Helper script to generate a signed live-canary-approval.json file.
 * Usage: npx tsx scripts/approve-live-canary.ts <operator-name> [maxNotionalUsd] [approvalFilePath]
 * 
 * Requires LIVE_APPROVAL_SALT env to be set (the same salt used by the broker-router).
 * 
 * Example:
 *   LIVE_APPROVAL_SALT=my-secret-salt npx tsx scripts/approve-live-canary.ts "alice@firm.com" 100
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

interface LiveCanaryApproval {
  operator: string;
  approvedAt: string;
  maxNotionalUsd: number;
  signature: string;
}

function computeSignature(operator: string, approvedAt: string, maxNotionalUsd: number, salt: string): string {
  const payload = `${operator}${approvedAt}${maxNotionalUsd}${salt}`;
  return createHash('sha256').update(payload).digest('hex');
}

function main() {
  const args = process.argv.slice(2);
  
  // Parse arguments
  const operator = args[0];
  const maxNotionalUsd = args[1] ? parseFloat(args[1]) : 100;
  const outputPath = args[2] ?? path.join(process.cwd(), 'services', 'broker-router', '.runtime', 'live-canary-approval.json');
  
  // Validate inputs
  const salt = process.env.LIVE_APPROVAL_SALT;
  if (!salt) {
    console.error('❌ ERROR: LIVE_APPROVAL_SALT env is required');
    console.error('   Usage: LIVE_APPROVAL_SALT=<secret> npx tsx scripts/approve-live-canary.ts <operator> [maxNotionalUsd]');
    process.exit(1);
  }
  
  if (!operator || operator.trim() === '') {
    console.error('❌ ERROR: Operator name is required');
    console.error('   Usage: npx tsx scripts/approve-live-canary.ts <operator> [maxNotionalUsd]');
    process.exit(1);
  }
  
  if (isNaN(maxNotionalUsd) || maxNotionalUsd <= 0) {
    console.error('❌ ERROR: maxNotionalUsd must be a positive number');
    process.exit(1);
  }

  // Create approval record
  const approvedAt = new Date().toISOString();
  const signature = computeSignature(operator.trim(), approvedAt, maxNotionalUsd, salt);
  
  const approval: LiveCanaryApproval = {
    operator: operator.trim(),
    approvedAt,
    maxNotionalUsd,
    signature
  };

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  
  // Write the approval file
  fs.writeFileSync(outputPath, JSON.stringify(approval, null, 2) + '\n');
  
  console.log('✅ Live canary approval created successfully');
  console.log(`   File: ${outputPath}`);
  console.log(`   Operator: ${approval.operator}`);
  console.log(`   Approved at: ${approval.approvedAt}`);
  console.log(`   Max notional: $${approval.maxNotionalUsd}`);
  console.log(`   Signature: ${approval.signature.substring(0, 16)}...`);
  console.log('');
  console.log('⚠️  This approval is valid for 24 hours.');
  console.log('⚠️  Keep the approval file secure — it grants live trading access.');
}

main();
