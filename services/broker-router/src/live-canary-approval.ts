/**
 * Human-in-the-Loop Approval for Live Canary Routing
 * Requires a signed approval file before any live (non-paper) routing fires.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface LiveCanaryApproval {
  operator: string;
  approvedAt: string;  // ISO timestamp
  maxNotionalUsd: number;
  signature: string;   // SHA-256 of (operator + approvedAt + maxNotionalUsd + secret-salt)
}

const APPROVAL_FILENAME = 'live-canary-approval.json';
const APPROVAL_VALID_HOURS = 24;

/** Resolve path to the runtime directory (parent of src/) */
export function getRuntimeDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '..', '.runtime');
}

/** Resolve path to the approval file */
export function getApprovalPath(): string {
  return path.join(getRuntimeDir(), APPROVAL_FILENAME);
}

/** Compute expected signature for validation */
export function computeSignature(operator: string, approvedAt: string, maxNotionalUsd: number, salt: string): string {
  const payload = `${operator}${approvedAt}${maxNotionalUsd}${salt}`;
  return createHash('sha256').update(payload).digest('hex');
}

/** Verify a signature matches expected value */
export function verifySignature(approval: LiveCanaryApproval, salt: string): boolean {
  const expected = computeSignature(approval.operator, approval.approvedAt, approval.maxNotionalUsd, salt);
  return expected === approval.signature;
}

/** Check if timestamp is within the last N hours */
export function isTimestampValid(approvedAt: string, maxHours: number = APPROVAL_VALID_HOURS): boolean {
  const approvedTime = new Date(approvedAt).getTime();
  if (isNaN(approvedTime)) return false;
  const now = Date.now();
  const maxAgeMs = maxHours * 60 * 60 * 1000;
  return (now - approvedTime) <= maxAgeMs;
}

/**
 * Validate the live canary approval file.
 * Returns { allowed: true } if all checks pass, or { allowed: false, reason: string } on failure.
 */
export function validateLiveCanaryApproval(notional: number = 100): { allowed: boolean; reason?: string } {
  const salt = process.env.LIVE_APPROVAL_SALT ?? '';
  
  // Check 1: Salt must be configured
  if (!salt) {
    return { 
      allowed: false, 
      reason: 'LIVE_APPROVAL_SALT env is not set — cannot validate approval signature' 
    };
  }

  const approvalPath = getApprovalPath();

  // Check 2: Approval file must exist
  if (!fs.existsSync(approvalPath)) {
    return { 
      allowed: false, 
      reason: `Live canary approval file not found at ${approvalPath}` 
    };
  }

  // Parse approval file
  let approval: LiveCanaryApproval;
  try {
    const raw = fs.readFileSync(approvalPath, 'utf-8');
    approval = JSON.parse(raw) as LiveCanaryApproval;
  } catch (err) {
    return { 
      allowed: false, 
      reason: `Failed to parse live-canary-approval.json: ${err instanceof Error ? err.message : String(err)}` 
    };
  }

  // Check 3: All required fields present and valid
  if (!approval.operator || typeof approval.operator !== 'string' || approval.operator.trim() === '') {
    return { allowed: false, reason: 'Approval operator field is missing or empty' };
  }
  if (!approval.approvedAt || typeof approval.approvedAt !== 'string') {
    return { allowed: false, reason: 'Approval approvedAt field is missing or invalid' };
  }
  if (typeof approval.maxNotionalUsd !== 'number' || approval.maxNotionalUsd <= 0) {
    return { allowed: false, reason: 'Approval maxNotionalUsd field is missing or invalid' };
  }
  if (!approval.signature || typeof approval.signature !== 'string') {
    return { allowed: false, reason: 'Approval signature field is missing' };
  }

  // Check 4: Timestamp must be within last 24 hours
  if (!isTimestampValid(approval.approvedAt)) {
    return { 
      allowed: false, 
      reason: `Approval timestamp ${approval.approvedAt} is older than ${APPROVAL_VALID_HOURS}h` 
    };
  }

  // Check 5: Signature must match
  if (!verifySignature(approval, salt)) {
    return { 
      allowed: false, 
      reason: 'Approval signature mismatch — approval may be tampered with' 
    };
  }

  // Check 6: maxNotionalUsd must be >= requested notional (for canary, typically 100)
  if (approval.maxNotionalUsd < notional) {
    return { 
      allowed: false, 
      reason: `Approval maxNotionalUsd ${approval.maxNotionalUsd} is less than order notional ${notional}` 
    };
  }

  return { allowed: true };
}
