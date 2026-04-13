// @ts-nocheck
/**
 * Strategy Director — Playbook application and directive execution.
 * Extracted from strategy-director.ts for maintainability.
 */

import {
  detectFirmRegime,
  getBestTemplate,
  type MarketRegime,
} from './strategy-playbook.js';
import type {
  DirectorDirective,
  PlaybookApplication,
  PaperEngineInterface,
  AgentAdjustment,
  SymbolChange,
  AllocationShift,
  RiskPosture,
} from './strategy-director.js';

/**
 * Detect the firm-wide regime from gathered context.
 */
export function detectRegimeFromContext(ctx: Record<string, unknown>): MarketRegime {
  try {
    const market = ctx.market as Record<string, unknown> | null;
    const news = ctx.news as Record<string, unknown> | null;

    // Extract per-symbol regimes from recent journal
    const journal = ctx.recentJournal as Array<Record<string, unknown>> | null ?? [];
    const symbolRegimes: Record<string, string> = {};
    for (const entry of journal) {
      const sym = String(entry.symbol ?? '');
      const regime = String(entry.regime ?? 'unknown');
      if (sym) symbolRegimes[sym] = regime;
    }

    // Extract Bollinger squeeze state from market intel if present
    const marketSnap = market as Record<string, unknown> | null;
    const bollingerList = (marketSnap?.bollinger as Array<Record<string, unknown>>) ?? [];
    const bollingerSqueeze: Record<string, boolean> = {};
    for (const bb of bollingerList) {
      const sym = String(bb.symbol ?? '');
      if (sym) bollingerSqueeze[sym] = Boolean(bb.squeeze);
    }

    // Fear & Greed from news snapshot
    const fngRaw = (marketSnap?.fearGreed as Record<string, unknown> | null);
    const fearGreedValue: number | null = fngRaw?.value !== undefined ? Number(fngRaw.value) : null;

    // News / embargo veto from news snapshot
    const macroSignal = news?.macroSignal as Record<string, unknown> | null;
    const macroVetoActive = Boolean(macroSignal?.veto);
    const newsEmbargoActive = Boolean(macroSignal?.embargoed ?? macroSignal?.veto);

    // Estimate avg volatility from Bollinger data
    const avgVolatility = (() => {
      const volValues = (bollingerList as Array<Record<string, unknown>>).map((b) => {
        const bw = Number(b.bandwidth ?? 0);
        const mid = Number(b.middle ?? 1);
        return mid > 0 ? bw / mid : 0;
      });
      return volValues.length > 0
        ? volValues.reduce((s, v) => s + v, 0) / volValues.length
        : 0;
    })();

    // Estimate avgRecentMove from journal entries
    const avgRecentMove = (() => {
      const pnls = journal.map((j) => Math.abs(Number(j.realizedPnl ?? 0)));
      return pnls.length > 0
        ? pnls.reduce((s, v) => s + v, 0) / pnls.length / 100 // rough proxy
        : 0;
    })();

    // Risk-off: check lossClusters context or news macro
    const lossClusters = (ctx.lossClusters as Record<string, unknown> | null);
    const riskOffActive = Boolean(lossClusters?.riskOff ?? (macroVetoActive && fearGreedValue !== null && fearGreedValue < 25));

    return detectFirmRegime({
      symbolRegimes,
      bollingerSqueeze,
      fearGreedValue,
      riskOffActive,
      newsEmbargoActive,
      macroVetoActive,
      avgVolatility,
      avgRecentMove,
    });
  } catch {
    return 'unknown';
  }
}

/**
 * Apply strategy playbook templates to agents based on current regime.
 * Only switches an agent if its template has changed from what it's currently running.
 * Bypasses the 20% clamp — playbook switches are intentional full overrides.
 */
export function applyPlaybookToAgents(
  regime: MarketRegime,
  engine: PaperEngineInterface,
  agentTemplateMap: Map<string, string>
): PlaybookApplication[] {
  if (regime === 'unknown') return [];

  const configs = engine.getAgentConfigs();
  const applications: PlaybookApplication[] = [];

  for (const agentConfig of configs) {
    const agentId = agentConfig.agentId;
    const config = agentConfig.config as Record<string, unknown>;
    const assetClass = String(config.assetClass ?? (config.broker === 'oanda-rest' ? 'forex' : 'crypto')) as 'crypto' | 'equity' | 'forex' | 'bond' | 'commodity';

    // Pick the best template for this regime + asset class
    const template = getBestTemplate(regime, assetClass);
    if (!template) continue;

    // Check if this agent is already running this template
    const currentTemplateId = agentTemplateMap.get(agentId);
    if (currentTemplateId === template.id) continue; // already on this template, skip

    // Apply the template config override to the paper engine
    const overrideConfig: Record<string, unknown> = {
      style: template.style,
      targetBps: template.targetBps,
      stopBps: template.stopBps,
      maxHoldTicks: template.maxHoldTicks,
      cooldownTicks: template.cooldownTicks,
      sizeFraction: template.sizeFraction,
      spreadLimitBps: template.spreadLimitBps,
    };

    const applied = engine.applyAgentConfig(agentId, overrideConfig);
    if (!applied) continue;

    // Record the switch
    agentTemplateMap.set(agentId, template.id);
    const fieldsApplied = Object.keys(overrideConfig);
    applications.push({
      agentId,
      templateId: template.id,
      templateName: template.name,
      regime,
      fieldsApplied,
      reason: template.rationale,
    });

    console.log(`[strategy-director] Playbook: ${agentId} → '${template.name}' (${regime}) — ${template.rationale.slice(0, 80)}`);
  }

  return applications;
}

/**
 * Apply Claude's incremental fine-tuning adjustments and build the final directive.
 */
export function applyDirectiveFromParsed(
  parsed: Record<string, unknown>,
  runId: string,
  startedAt: number,
  regime: MarketRegime,
  playbookApplications: PlaybookApplication[],
  engine: PaperEngineInterface
): DirectorDirective {
  const configs = engine.getAgentConfigs();
  const appliedAdjustments: AgentAdjustment[] = [];

  // Apply agent adjustments (incremental fine-tuning on top of playbook)
  const adjustments = Array.isArray(parsed.agentAdjustments) ? parsed.agentAdjustments : [];
  for (const adj of adjustments) {
    const a = adj as Record<string, unknown>;
    const agentId = String(a.agentId ?? '');
    const field = String(a.field ?? '');
    const newValue = a.newValue;
    const reason = String(a.reason ?? '');

    // Block style overrides from Claude — playbook owns style switching
    if (field === 'style') {
      console.log(`[strategy-director] Blocked style override from Claude for ${agentId} — playbook owns style switching`);
      continue;
    }

    const current = configs.find((c) => c.agentId === agentId);
    if (!current) continue;

    const oldValue = (current.config as Record<string, unknown>)[field];
    if (oldValue === undefined || newValue === undefined) continue;

    // Clamp to 20% max change
    const oldNum = Number(oldValue);
    const newNum = Number(newValue);
    if (!Number.isFinite(oldNum) || !Number.isFinite(newNum)) continue;

    const maxDelta = Math.abs(oldNum) * 0.2;
    const clamped = Math.max(oldNum - maxDelta, Math.min(oldNum + maxDelta, newNum));
    const rounded = Math.round(clamped * 100) / 100;

    if (Math.abs(rounded - oldNum) < 0.001) continue; // no meaningful change

    const applied = engine.applyAgentConfig(agentId, { [field]: rounded });
    if (applied) {
      appliedAdjustments.push({
        agentId, field,
        oldValue: oldNum,
        newValue: rounded,
        reason,
        backtestValidated: false
      });
      console.log(`[strategy-director] Fine-tune: ${agentId}.${field}: ${oldNum} → ${rounded} (${reason})`);
    }
  }

  // Parse other fields
  const symbolChanges: SymbolChange[] = (Array.isArray(parsed.symbolChanges) ? parsed.symbolChanges : []).map((s) => {
    const sc = s as Record<string, unknown>;
    return {
      action: String(sc.action ?? 'watch') as 'add' | 'remove' | 'watch',
      symbol: String(sc.symbol ?? ''),
      broker: String(sc.broker ?? ''),
      assetClass: String(sc.assetClass ?? ''),
      reason: String(sc.reason ?? '')
    };
  });

  const allocationShifts: AllocationShift[] = (Array.isArray(parsed.allocationShifts) ? parsed.allocationShifts : []).map((a) => {
    const as_ = a as Record<string, unknown>;
    return {
      assetClass: String(as_.assetClass ?? ''),
      newMultiplier: Number(as_.newMultiplier ?? 1),
      reason: String(as_.reason ?? '')
    };
  });

  const rp = parsed.riskPosture as Record<string, unknown> | null;
  const riskPosture: RiskPosture | null = rp ? {
    posture: String(rp.posture ?? 'normal') as RiskPosture['posture'],
    reason: String(rp.reason ?? '')
  } : null;

  // Log symbol change recommendations
  for (const sc of symbolChanges) {
    console.log(`[strategy-director] Symbol recommendation: ${sc.action} ${sc.symbol} on ${sc.broker} (${sc.reason})`);
  }

  if (riskPosture && riskPosture.posture !== 'normal') {
    console.log(`[strategy-director] Risk posture: ${riskPosture.posture} (${riskPosture.reason})`);
  }

  return {
    timestamp: new Date().toISOString(),
    runId,
    latencyMs: Date.now() - startedAt,
    detectedRegime: regime,
    symbolChanges,
    agentAdjustments: appliedAdjustments,
    playbookApplications,
    allocationShifts,
    riskPosture,
    reasoning: String(parsed.reasoning ?? '')
  };
}
