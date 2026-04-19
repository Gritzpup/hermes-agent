/**
 * Tests for Human-in-the-Loop Live Canary Approval
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Mock process.env before importing
const mockEnv: Record<string, string | undefined> = {
  LIVE_APPROVAL_SALT: 'test-salt-12345'
};

vi.stubGlobal('process', {
  ...process,
  env: mockEnv
});

// Import after mocking
import {
  computeSignature,
  validateLiveCanaryApproval,
  isTimestampValid,
  getApprovalPath,
  type LiveCanaryApproval
} from './live-canary-approval.js';

describe('Live Canary Approval Validation', () => {
  const testSalt = 'test-salt-12345';
  const testRuntimeDir = '/tmp/hermes-test-runtime';
  const testApprovalPath = path.join(testRuntimeDir, 'live-canary-approval.json');

  function createValidApproval(overrides: Partial<LiveCanaryApproval> = {}): LiveCanaryApproval {
    const operator = 'alice@firm.com';
    const approvedAt = new Date().toISOString();
    const maxNotionalUsd = 100;
    const signature = computeSignature(operator, approvedAt, maxNotionalUsd, testSalt);
    
    return {
      operator,
      approvedAt,
      maxNotionalUsd,
      signature,
      ...overrides
    };
  }

  function writeApproval(approval: LiveCanaryApproval) {
    fs.mkdirSync(testRuntimeDir, { recursive: true });
    fs.writeFileSync(testApprovalPath, JSON.stringify(approval, null, 2));
  }

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testRuntimeDir)) {
      fs.rmSync(testRuntimeDir, { recursive: true });
    }
    // Ensure runtime dir resolution points to test location
    mockEnv.LIVE_APPROVAL_SALT = testSalt;
  });

  describe('computeSignature', () => {
    it('should produce consistent SHA-256 signature', () => {
      const operator = 'alice@firm.com';
      const approvedAt = '2024-01-15T10:00:00.000Z';
      const maxNotionalUsd = 100;
      
      const sig1 = computeSignature(operator, approvedAt, maxNotionalUsd, testSalt);
      const sig2 = computeSignature(operator, approvedAt, maxNotionalUsd, testSalt);
      
      expect(sig1).toBe(sig2);
      expect(sig1).toHaveLength(64); // SHA-256 hex
    });

    it('should produce different signatures for different inputs', () => {
      const sig1 = computeSignature('alice', '2024-01-15T10:00:00.000Z', 100, testSalt);
      const sig2 = computeSignature('bob', '2024-01-15T10:00:00.000Z', 100, testSalt);
      
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('isTimestampValid', () => {
    it('should accept timestamp within last 24 hours', () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
      expect(isTimestampValid(recent)).toBe(true);
    });

    it('should reject timestamp older than 24 hours', () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
      expect(isTimestampValid(old)).toBe(false);
    });

    it('should reject invalid timestamps', () => {
      expect(isTimestampValid('not-a-date')).toBe(false);
      expect(isTimestampValid('')).toBe(false);
    });
  });

  describe('validateLiveCanaryApproval', () => {
    it('should REFUSE when LIVE_APPROVAL_SALT env is unset', () => {
      mockEnv.LIVE_APPROVAL_SALT = undefined;
      
      const result = validateLiveCanaryApproval(100);
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('LIVE_APPROVAL_SALT');
    });

    it('should REFUSE when approval file is missing', () => {
      const result = validateLiveCanaryApproval(100);
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('should REFUSE when approvedAt is older than 24h', () => {
      const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const approval = createValidApproval({ approvedAt: oldTimestamp });
      writeApproval(approval);
      
      const result = validateLiveCanaryApproval(100);
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('older than');
    });

    it('should REFUSE when signature mismatches (tampered)', () => {
      const approval = createValidApproval();
      approval.signature = 'tampered-signature-that-is-not-valid';
      writeApproval(approval);
      
      const result = validateLiveCanaryApproval(100);
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('signature mismatch');
    });

    it('should REFUSE when operator field is empty', () => {
      const approval = createValidApproval({ operator: '   ' });
      writeApproval(approval);
      
      const result = validateLiveCanaryApproval(100);
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('operator');
    });

    it('should REFUSE when maxNotionalUsd is less than order notional', () => {
      const approval = createValidApproval({ maxNotionalUsd: 50 });
      writeApproval(approval);
      
      const result = validateLiveCanaryApproval(100); // asking for $100
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('less than');
    });

    it('should ACCEPT with valid correctly-signed approval file', () => {
      const approval = createValidApproval();
      writeApproval(approval);
      
      const result = validateLiveCanaryApproval(100);
      
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should ACCEPT when order notional <= maxNotionalUsd in approval', () => {
      const approval = createValidApproval({ maxNotionalUsd: 150 });
      writeApproval(approval);
      
      const result = validateLiveCanaryApproval(100); // asking for $100, cap is $150
      
      expect(result.allowed).toBe(true);
    });
  });
});
