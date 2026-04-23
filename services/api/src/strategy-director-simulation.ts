/**
 * Strategy Director — Forward-simulation utilities.
 * Extracted from strategy-director.ts for maintainability.
 */

import type { PaperEngineInterface } from './strategy-director.js';

const BACKTEST_URL = process.env.BACKTEST_URL ?? 'http://127.0.0.1:4305';

export async function runForwardSimulation(
  proposed: Record<string, unknown>,
  engine: PaperEngineInterface
): Promise<{ currentSharpe: number; proposedSharpe: number; improved: boolean } | null> {
  const currentConfigMap = new Map<string, Record<string, unknown>>();
  for (const agentConfig of engine.getAgentConfigs()) {
    currentConfigMap.set(agentConfig.agentId, agentConfig.config as Record<string, unknown>);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const resp = await fetch(`${BACKTEST_URL}/quarter-outlook`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;

    const outlook = await resp.json() as Record<string, unknown>;
    const overall = outlook.overall as Record<string, unknown> | undefined;
    if (!overall) return null;

    const lastQ = overall.lastQuarter as Record<string, unknown> | undefined;
    const nextQ = overall.nextQuarter as Record<string, unknown> | undefined;
    if (!lastQ || !nextQ) return null;

    const currentSharpe = Number(lastQ.strategyReturnPct ?? 0) / Math.max(Number(lastQ.strategyMaxDrawdownPct ?? 1), 0.1);
    const nextMedian = Number(nextQ.strategyMedianReturnPct ?? 0);
    const nextDD = Number(nextQ.strategyP25ReturnPct ?? -1);
    const proposedSharpe = nextMedian / Math.max(Math.abs(nextDD), 0.1);

    const adjustments = Array.isArray(proposed.agentAdjustments) ? proposed.agentAdjustments : [];
    const hasDefensiveChanges = adjustments.some((a: Record<string, unknown>) => {
      const agentId = String(a.agentId ?? '');
      const field = String(a.field ?? '');
      const newVal = Number(a.newValue ?? 0);
      const currentAgentConfig = currentConfigMap.get(agentId);
      const currentVal = currentAgentConfig ? Number(currentAgentConfig[field] ?? 0) : 0;
      return field === 'sizeFraction' && newVal < currentVal && newVal < 0.03;
    });

    const improved = proposedSharpe >= currentSharpe * 0.9 || hasDefensiveChanges;
    return { currentSharpe, proposedSharpe, improved };
  } catch {
    return null;
  }
}
