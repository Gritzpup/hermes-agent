// Reasons that indicate synthetic/reconciliation entries, NOT real closed trades.
// These are quarantined from analytics to avoid KPI pollution.
export const QUARANTINED_EXIT_REASONS = new Set([
    'broker reconciliation',
    'external broker flatten'
]);
// --------------- Persistence & Database exports ---------------
import { PrismaClient } from '@prisma/client';
/**
 * Shared Prisma client for all Hermes services.
 * Note: DATABASE_URL must be provided in the environment.
 */
export const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});
export * from '@prisma/client';
