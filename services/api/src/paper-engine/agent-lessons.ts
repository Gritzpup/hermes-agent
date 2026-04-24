// @ts-nocheck
/**
 * Durable agent memory via PostgreSQL lessons store.
 *
 * Agents record lessons from trades (mistakes, patterns, successes).
 * Lessons are queryable by agentId/symbol/strategy for context injection.
 */

import { db } from '@hermes/infra';

export type LessonType = 'mistake' | 'pattern' | 'success' | 'sizing' | 'risk';
export type LessonSeverity = 'low' | 'medium' | 'high' | 'critical';

interface LessonRecord {
  id: string;
  agentId: string;
  symbol: string | null;
  strategy: string | null;
  lessonType: LessonType;
  severity: LessonSeverity;
  description: string;
  tick: number | null;
  pnlImpact: number | null;
  tags: string[];
  useful: boolean;
  createdAt: string;
}

function generateUlid(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ts}${rand}`;
}

export async function recordLesson(input: {
  agentId: string;
  symbol?: string | null;
  strategy?: string | null;
  lessonType: LessonType;
  severity: LessonSeverity;
  description: string;
  tick?: number | null;
  pnlImpact?: number | null;
  tags?: string[];
  useful?: boolean;
}): Promise<void> {
  const pool = db();
  const id = generateUlid();
  try {
    await pool.query(
      `INSERT INTO "AgentLesson"
        (id,agentId,symbol,strategy,lessonType,severity,description,tick,pnlImpact,tags,useful,createdAt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        input.agentId,
        input.symbol ?? null,
        input.strategy ?? null,
        input.lessonType,
        input.severity,
        input.description,
        input.tick ?? null,
        input.pnlImpact ?? null,
        JSON.stringify(input.tags ?? []),
        input.useful ?? true,
        new Date().toISOString(),
      ]
    );
  } catch (err) {
    console.error('[agent-lessons] failed to record:', err instanceof Error ? err.message : String(err));
  }
}

export async function getLessonsForAgent(
  agentId: string,
  options?: {
    symbol?: string;
    strategy?: string;
    lessonType?: LessonType;
    limit?: number;
    useful?: boolean;
  }
): Promise<LessonRecord[]> {
  const pool = db();
  const limit = options?.limit ?? 50;
  const result = await pool.query(
    `SELECT * FROM "AgentLesson" WHERE agentId = $1 ORDER BY createdAt DESC LIMIT $2`,
    [agentId, limit]
  );
  let rows = result.rows as LessonRecord[];
  if (options?.symbol)     rows = rows.filter(r => r.symbol === options.symbol);
  if (options?.strategy)    rows = rows.filter(r => r.strategy === options.strategy);
  if (options?.lessonType)  rows = rows.filter(r => r.lessonType === options.lessonType);
  if (options?.useful !== undefined) rows = rows.filter(r => r.useful === options.useful);
  return rows.slice(0, limit);
}

export async function markLessonUseful(id: string, useful: boolean): Promise<void> {
  const pool = db();
  await pool.query(`UPDATE "AgentLesson" SET useful = $1 WHERE id = $2`, [useful, id]);
}
