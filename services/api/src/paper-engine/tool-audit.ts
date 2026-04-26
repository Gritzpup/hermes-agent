// @ts-nocheck
/**
 * Tool call audit logger.
 * Writes to PostgreSQL ToolCallAudit table via @hermes/infra db().
 */
import { db } from '@hermes/infra';
import type { ToolCallAuditInput } from '@hermes/contracts';

const MAX_OUTPUT_LEN = 2000;

function generateUlid(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ts}${rand}`;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '...[truncated]' : str;
}

export async function recordToolCall(input: ToolCallAuditInput): Promise<void> {
  const pool = db();
  const id = generateUlid();
  const inputJson = truncate(JSON.stringify(input.input), 4000);
  const outputJson = input.output !== undefined && input.output !== null
    ? truncate(JSON.stringify(input.output), MAX_OUTPUT_LEN)
    : null;

  try {
    await pool.query(
      `INSERT INTO "ToolCallAudit"
        (id,timestamp,agentId,sessionId,toolName,toolInput,toolOutput,durationMs,success,errorMessage,provider,model,tokensUsed,costUsd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        new Date().toISOString(),
        input.agentId,
        input.sessionId ?? null,
        input.toolName,
        inputJson,
        outputJson,
        input.durationMs ?? null,
        input.success,
        input.errorMessage ?? null,
        input.provider,
        input.model ?? null,
        input.tokensUsed ?? null,
        input.costUsd ?? null,
      ]
    );
  } catch (err) {
    // Never let audit failures affect trading
    console.error('[tool-audit] failed to record:', err instanceof Error ? err.message : String(err));
  }
}
