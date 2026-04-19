/**
 * Exit-Reason Classifier (In-Engine)
 * Phase G3a — Exit-Reason Binary Classifier
 *
 * Classifies live trade exits as "bad-exit" vs "maker-normal" using
 * the same pattern-mapping as the offline relabel script.
 *
 * Provides per-agent running statistics for the learning loop.
 */
/** Pattern → class mapping — mirrors scripts/relabel-from-journal.ts */
const EXIT_REASON_MAP = [
    { pattern: /maker-round-trip/i, class: 'maker-normal' },
    { pattern: /inventory-release-under.*pressure/i, class: 'maker-normal' },
    { pattern: /stop-loss/i, class: 'bad-exit' },
    { pattern: /correlation-break/i, class: 'bad-exit' },
    { pattern: /reversion/i, class: 'bad-exit' },
    { pattern: /broker reconciliation/i, class: 'excluded' },
    { pattern: /external broker flatten/i, class: 'excluded' },
    { pattern: /Alpaca paper order/i, class: 'excluded' },
    { pattern: /coo-manual-flatten/i, class: 'excluded' },
    { pattern: /undefined/i, class: 'other' },
    { pattern: /timeout/i, class: 'other' },
];
export function classifyExit(exitReason) {
    const exitClass = mapExitReasonToClass(exitReason);
    return {
        exitClass,
        binaryLabel: exitClass === 'bad-exit' ? 1 : 0
    };
}
export function mapExitReasonToClass(exitReason) {
    if (!exitReason)
        return 'other';
    for (const { pattern, class: cls } of EXIT_REASON_MAP) {
        if (pattern.test(exitReason))
            return cls;
    }
    return 'other';
}
const agentStats = new Map();
function getOrCreate(agentId) {
    if (!agentStats.has(agentId)) {
        agentStats.set(agentId, { agentId, makerNormal: 0, badExit: 0, other: 0, excluded: 0, totalPnl: 0, totalTrades: 0, wins: 0 });
    }
    return agentStats.get(agentId);
}
export function recordExit(agentId, exitReason, pnl) {
    const { exitClass } = classifyExit(exitReason);
    const s = getOrCreate(agentId);
    s.totalTrades++;
    if (pnl > 0)
        s.wins++;
    s.totalPnl += pnl;
    switch (exitClass) {
        case 'maker-normal':
            s.makerNormal++;
            break;
        case 'bad-exit':
            s.badExit++;
            break;
        case 'other':
            s.other++;
            break;
        case 'excluded':
            s.excluded++;
            break;
    }
}
export function getAgentExitStats(agentId) {
    const s = agentStats.get(agentId);
    if (!s || s.totalTrades === 0)
        return null;
    const total = s.makerNormal + s.badExit + s.other;
    return {
        agentId: s.agentId,
        total,
        makerNormal: s.makerNormal,
        badExit: s.badExit,
        other: s.other,
        excluded: s.excluded,
        winRate: (s.wins / s.totalTrades) * 100,
        avgPnlPerExitType: {
            'maker-normal': total > 0 ? (s.makerNormal > 0 ? s.totalPnl / total : 0) : 0,
            'bad-exit': s.badExit > 0 ? s.totalPnl / s.badExit : 0,
            'other': s.other > 0 ? s.totalPnl / s.other : 0,
        }
    };
}
export function getAllAgentStats() {
    return Array.from(agentStats.values())
        .filter(s => s.totalTrades > 0)
        .map(s => {
        const total = s.makerNormal + s.badExit + s.other;
        return {
            agentId: s.agentId,
            total,
            makerNormal: s.makerNormal,
            badExit: s.badExit,
            other: s.other,
            excluded: s.excluded,
            winRate: (s.wins / s.totalTrades) * 100,
            avgPnlPerExitType: {}
        };
    });
}
export function clearAgentStats(agentId) {
    if (agentId)
        agentStats.delete(agentId);
    else
        agentStats.clear();
}
