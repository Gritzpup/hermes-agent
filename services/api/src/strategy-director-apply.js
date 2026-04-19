// @ts-nocheck
/**
 * Strategy Director — Playbook application and directive execution.
 * Extracted from strategy-director.ts for maintainability.
 */
import { detectFirmRegime, getBestTemplate, } from './strategy-playbook.js';
const BACKTEST_URL = process.env.BACKTEST_URL ?? 'http://127.0.0.1:4305';
/**
 * Build a 30-day window end date (today or recent working day) and start date.
 */
function build30dWindow() {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 30);
    return {
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
    };
}
/**
 * Compute baseline metrics from the paper engine snapshot or recent journal.
 * Prefers lane-level aggregates if available; falls back to desk-level snapshot.
 */
function computeBaseline(engine) {
    const snapshot = engine.getSnapshot();
    // Try lane-level aggregates first
    const lanes = snapshot.lanes;
    if (lanes && lanes.length > 0) {
        let totalWins = 0, totalTrades = 0, totalPnl = 0, peakEquity = snapshot.startingEquity ?? 100_000;
        let maxDd = 0;
        for (const lane of lanes) {
            totalWins += Math.round((lane.winRate ?? 0) / 100 * (lane.totalTrades ?? 0));
            totalTrades += lane.totalTrades ?? 0;
            totalPnl += lane.realizedPnl ?? 0;
            const eq = lane.endingEquity ?? 0;
            if (eq > 0) {
                const dd = ((peakEquity - eq) / peakEquity) * 100;
                maxDd = Math.max(maxDd, dd);
                peakEquity = Math.max(peakEquity, eq);
            }
        }
        const wr = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
        const avgReturn = totalTrades > 0 ? totalPnl / totalTrades / peakEquity : 0;
        const sharpe = Math.abs(avgReturn) > 0 ? avgReturn / 0.02 * Math.sqrt(252) : 0; // rough proxy
        return { sharpe, maxDrawdown: maxDd, winRate: wr, totalTrades };
    }
    // Fallback: desk-level snapshot
    const wr = snapshot.winRate ?? 0;
    const trades = snapshot.totalTrades ?? 0;
    const pnl = snapshot.realizedPnl ?? 0;
    const equity = snapshot.totalEquity ?? snapshot.startingEquity ?? 100_000;
    const starting = snapshot.startingEquity ?? 100_000;
    const ret = trades > 0 ? pnl / trades / starting : 0;
    const sharpe = Math.abs(ret) > 0 ? ret / 0.02 * Math.sqrt(252) : 0;
    const dd = starting > 0 ? ((starting - equity) / starting) * 100 : 0;
    return { sharpe, maxDrawdown: dd, winRate: wr, totalTrades: trades };
}
/**
 * Validate a proposed directive against a backtest run.
 * Builds a candidate config from the directive's agent adjustments, runs a
 * 30-day backtest, and compares Sharpe / drawdown / win-rate vs. baseline.
 * Permissive fallback if the backtest endpoint is unavailable.
 *
 * Gate criteria:
 *   candidate Sharpe >= baseline.sharpe - 0.15
 *   candidate maxDrawdown <= baseline.maxDrawdown + 1%
 *   candidate winRate within 5% of baseline.winRate
 */
export async function validateDirectiveViaBacktest(parsed, engine) {
    const adjustments = Array.isArray(parsed.agentAdjustments) ? parsed.agentAdjustments : [];
    if (adjustments.length === 0) {
        return { pass: true, reason: 'no-agent-adjustments' };
    }
    // Build candidate configs (apply adjustments in memory only — clone, don't touch live engine)
    const baseline = computeBaseline(engine);
    const configs = engine.getAgentConfigs();
    const candidateConfigs = [];
    for (const adj of adjustments) {
        const a = adj;
        const agentId = String(a.agentId ?? '');
        const field = String(a.field ?? '');
        const newValue = a.newValue;
        if (!agentId || !field)
            continue;
        const current = configs.find((c) => c.agentId === agentId);
        if (!current)
            continue;
        const cfg = { ...current.config };
        cfg[field] = newValue;
        candidateConfigs.push({ agentId, symbol: String(cfg.symbol ?? ''), config: cfg });
    }
    if (candidateConfigs.length === 0) {
        return { pass: true, reason: 'no-valid-adjustments' };
    }
    const { startDate, endDate } = build30dWindow();
    // Run backtest for each candidate; aggregate results
    let totalTrades = 0, totalWins = 0, worstDd = 0;
    let sharpeSum = 0, sharpeCount = 0;
    for (const candidate of candidateConfigs) {
        if (!candidate.symbol)
            continue;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20_000);
            const resp = await fetch(`${BACKTEST_URL}/backtest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agentConfig: candidate.config,
                    symbol: candidate.symbol,
                    startDate,
                    endDate,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!resp.ok)
                continue;
            const result = await resp.json();
            const bt = result;
            if (bt.sharpeRatio !== undefined) {
                sharpeSum += bt.sharpeRatio;
                sharpeCount++;
            }
            totalTrades += bt.totalTrades ?? 0;
            totalWins += Math.round((bt.winRate ?? 0) / 100 * (bt.totalTrades ?? 0));
            worstDd = Math.max(worstDd, bt.maxDrawdownPct ?? 0);
        }
        catch {
            // backtest unavailable — permissive fallback
            return { pass: true, reason: 'backtest-unavailable', baseline };
        }
    }
    const candSharpe = sharpeCount > 0 ? sharpeSum / sharpeCount : baseline.sharpe;
    const candWr = totalTrades > 0 ? (totalWins / totalTrades) * 100 : baseline.winRate;
    const backtest = { sharpe: candSharpe, maxDrawdown: worstDd, winRate: candWr, totalTrades };
    // Apply gate criteria
    const sharpeOk = candSharpe >= baseline.sharpe - 0.15;
    const ddOk = worstDd <= baseline.maxDrawdown + 1.0;
    const wrOk = Math.abs(candWr - baseline.winRate) <= 5.0;
    if (!sharpeOk || !ddOk || !wrOk) {
        const reasons = [];
        if (!sharpeOk)
            reasons.push(`sharpe ${candSharpe.toFixed(2)} < ${(baseline.sharpe - 0.15).toFixed(2)}`);
        if (!ddOk)
            reasons.push(`dd ${worstDd.toFixed(1)}% > ${(baseline.maxDrawdown + 1.0).toFixed(1)}%`);
        if (!wrOk)
            reasons.push(`wr ${candWr.toFixed(1)}% vs baseline ${baseline.winRate.toFixed(1)}%`);
        return { pass: false, reason: `gate-rejected: ${reasons.join('; ')}`, backtest, baseline };
    }
    return { pass: true, reason: 'gate-passed', backtest, baseline };
}
/**
 * Detect the firm-wide regime from gathered context.
 */
export function detectRegimeFromContext(ctx) {
    try {
        const market = ctx.market;
        const news = ctx.news;
        // Extract per-symbol regimes from recent journal
        const journal = ctx.recentJournal ?? [];
        const symbolRegimes = {};
        for (const entry of journal) {
            const sym = String(entry.symbol ?? '');
            const regime = String(entry.regime ?? 'unknown');
            if (sym)
                symbolRegimes[sym] = regime;
        }
        // Extract Bollinger squeeze state from market intel if present
        const marketSnap = market;
        const bollingerList = marketSnap?.bollinger ?? [];
        const bollingerSqueeze = {};
        for (const bb of bollingerList) {
            const sym = String(bb.symbol ?? '');
            if (sym)
                bollingerSqueeze[sym] = Boolean(bb.squeeze);
        }
        // Fear & Greed from news snapshot
        const fngRaw = marketSnap?.fearGreed;
        const fearGreedValue = fngRaw?.value !== undefined ? Number(fngRaw.value) : null;
        // News / embargo veto from news snapshot
        const macroSignal = news?.macroSignal;
        const macroVetoActive = Boolean(macroSignal?.veto);
        const newsEmbargoActive = Boolean(macroSignal?.embargoed ?? macroSignal?.veto);
        // Estimate avg volatility from Bollinger data
        const avgVolatility = (() => {
            const volValues = bollingerList.map((b) => {
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
        const lossClusters = ctx.lossClusters;
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
    }
    catch {
        return 'unknown';
    }
}
/**
 * Apply strategy playbook templates to agents based on current regime.
 * Only switches an agent if its template has changed from what it's currently running.
 * Bypasses the 20% clamp — playbook switches are intentional full overrides.
 */
export function applyPlaybookToAgents(regime, engine, agentTemplateMap) {
    if (regime === 'unknown')
        return [];
    const configs = engine.getAgentConfigs();
    const applications = [];
    for (const agentConfig of configs) {
        const agentId = agentConfig.agentId;
        const config = agentConfig.config;
        const assetClass = String(config.assetClass ?? (config.broker === 'oanda-rest' ? 'forex' : 'crypto'));
        // Pick the best template for this regime + asset class
        const template = getBestTemplate(regime, assetClass);
        if (!template)
            continue;
        // Check if this agent is already running this template
        const currentTemplateId = agentTemplateMap.get(agentId);
        if (currentTemplateId === template.id)
            continue; // already on this template, skip
        // Apply the template config override to the paper engine
        const overrideConfig = {
            style: template.style,
            targetBps: template.targetBps,
            stopBps: template.stopBps,
            maxHoldTicks: template.maxHoldTicks,
            cooldownTicks: template.cooldownTicks,
            sizeFraction: template.sizeFraction,
            spreadLimitBps: template.spreadLimitBps,
        };
        const applied = engine.applyAgentConfig(agentId, overrideConfig);
        if (!applied)
            continue;
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
export function applyDirectiveFromParsed(parsed, runId, startedAt, regime, playbookApplications, engine) {
    const configs = engine.getAgentConfigs();
    const appliedAdjustments = [];
    // Apply agent adjustments (incremental fine-tuning on top of playbook)
    const adjustments = Array.isArray(parsed.agentAdjustments) ? parsed.agentAdjustments : [];
    for (const adj of adjustments) {
        const a = adj;
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
        if (!current)
            continue;
        const oldValue = current.config[field];
        if (oldValue === undefined || newValue === undefined)
            continue;
        // Clamp to 20% max change
        const oldNum = Number(oldValue);
        const newNum = Number(newValue);
        if (!Number.isFinite(oldNum) || !Number.isFinite(newNum))
            continue;
        const maxDelta = Math.abs(oldNum) * 0.2;
        const clamped = Math.max(oldNum - maxDelta, Math.min(oldNum + maxDelta, newNum));
        const rounded = Math.round(clamped * 100) / 100;
        if (Math.abs(rounded - oldNum) < 0.001)
            continue; // no meaningful change
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
    const symbolChanges = (Array.isArray(parsed.symbolChanges) ? parsed.symbolChanges : []).map((s) => {
        const sc = s;
        return {
            action: String(sc.action ?? 'watch'),
            symbol: String(sc.symbol ?? ''),
            broker: String(sc.broker ?? ''),
            assetClass: String(sc.assetClass ?? ''),
            reason: String(sc.reason ?? '')
        };
    });
    const allocationShifts = (Array.isArray(parsed.allocationShifts) ? parsed.allocationShifts : []).map((a) => {
        const as_ = a;
        return {
            assetClass: String(as_.assetClass ?? ''),
            newMultiplier: Number(as_.newMultiplier ?? 1),
            reason: String(as_.reason ?? '')
        };
    });
    const rp = parsed.riskPosture;
    const riskPosture = rp ? {
        posture: String(rp.posture ?? 'normal'),
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
