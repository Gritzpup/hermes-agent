/**
 * Tool: get_compliance_status
 * Reads compliance state from Redis hermes:compliance:* keys.
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { ToolContext, ToolDef } from './index.js';

export interface ComplianceRule {
  ruleId: string;
  status: 'active' | 'paused' | 'violated';
  description: string;
  triggeredAt?: string;
}

export interface ComplianceStatus {
  overall: 'compliant' | 'warning' | 'violation';
  rules: ComplianceRule[];
  lastCheck: string;
  violations: string[];
}

export interface GetComplianceStatusResult {
  status: ComplianceStatus;
  ts: string;
}

async function getComplianceStatus(
  _ctx: ToolContext,
  _args: Record<string, unknown>,
): Promise<GetComplianceStatusResult> {
  const rules: ComplianceRule[] = [];
  let overall: ComplianceStatus['overall'] = 'compliant';
  const violations: string[] = [];

  try {
    const stream = redis.scanStream({ match: 'hermes:compliance:*', count: 100 });
    for await (const keys of stream) {
      for (const key of keys) {
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const ruleId = String(parsed.ruleId ?? key.replace('hermes:compliance:', ''));
          const status = (parsed.status as ComplianceRule['status']) ?? 'active';

          const rule: { ruleId: string; status: ComplianceRule['status']; description: string; triggeredAt?: string } = {
            ruleId,
            status,
            description: String(parsed.description ?? ''),
          };
          if (parsed.triggeredAt) rule.triggeredAt = parsed.triggeredAt as string;
          rules.push(rule as ComplianceRule);

          if (status === 'violated') {
            violations.push(ruleId);
            overall = 'violation';
          } else if (status === 'paused' && overall !== 'violation') {
            overall = 'warning';
          }
        } catch { /* skip corrupt key */ }
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'get_compliance_status: scan failed');
  }

  return {
    status: { overall, rules, lastCheck: new Date().toISOString(), violations },
    ts: new Date().toISOString(),
  };
}

export const GET_COMPLIANCE_STATUS_TOOL: ToolDef = {
  name: 'get_compliance_status',
  description: 'Read current compliance state from Redis hermes:compliance:* keys. Returns overall status (compliant/warning/violation) and per-rule details.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  fn: getComplianceStatus,
};
