import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_DIR = process.env.PAPER_LEDGER_DIR ?? path.resolve(MODULE_DIR, '../.runtime/paper-ledger');
const EVENT_LOG_PATH = path.join(LEDGER_DIR, 'events.jsonl');
const JOURNAL_LEDGER_PATH = path.join(LEDGER_DIR, 'journal.jsonl');
function readJsonLines(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return [];
        return fs.readFileSync(filePath, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
function matchesFilter(event, filter) {
    if (filter.type && event.type !== filter.type)
        return false;
    if (!filter.strategyId)
        return true;
    if (event.strategyId === filter.strategyId || event.agentId === filter.strategyId)
        return true;
    if (typeof event.strategy === 'string' && event.strategy === filter.strategyId)
        return true;
    return false;
}
export class ReplayEngine {
    getTimeline(limit = 200, filter = {}) {
        const events = readJsonLines(EVENT_LOG_PATH).filter((event) => matchesFilter(event, filter));
        return events.slice(-limit);
    }
    getReconstruction(limit = 1_000) {
        const events = readJsonLines(EVENT_LOG_PATH).slice(-limit);
        const journal = readJsonLines(JOURNAL_LEDGER_PATH).slice(-limit);
        const eventCounts = new Map();
        const agentStates = new Map();
        const strategyStates = new Map();
        const journalSummaries = new Map();
        const strategyNameLookup = new Map();
        const configTransitions = [];
        const allocationTransitions = [];
        const laneLearningTransitions = [];
        let lastTick = null;
        for (const event of events) {
            const type = typeof event.type === 'string' ? event.type : 'unknown';
            eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);
            if (type === 'tick') {
                lastTick = event;
                const agents = Array.isArray(event.agents) ? event.agents : [];
                for (const agent of agents) {
                    const agentId = typeof agent.agentId === 'string' ? agent.agentId : '';
                    if (!agentId)
                        continue;
                    agentStates.set(agentId, {
                        agentId,
                        symbol: agent.symbol,
                        status: agent.status,
                        style: agent.style,
                        executionMode: agent.executionMode,
                        allocationMultiplier: agent.allocationMultiplier,
                        deploymentMode: agent.deploymentMode,
                        trades: agent.trades,
                        realizedPnl: agent.realizedPnl,
                        cooldownRemaining: agent.cooldownRemaining,
                        position: agent.position,
                        config: agent.config,
                        marketIntel: agent.marketIntel,
                        metaLabel: agent.metaLabel,
                        news: agent.news,
                        spreadBps: agent.spreadBps,
                        regime: agent.regime,
                        lastAction: agent.lastAction,
                        lastSeenAt: event.timestamp
                    });
                }
                continue;
            }
            if (type === 'strategy-state') {
                const strategyId = typeof event.strategyId === 'string' ? event.strategyId : '';
                if (!strategyId)
                    continue;
                const strategyName = typeof event.strategy === 'string' ? event.strategy : strategyId;
                const lane = typeof event.lane === 'string' ? event.lane : 'unknown';
                strategyStates.set(strategyId, {
                    strategyId,
                    strategy: strategyName,
                    lane,
                    symbols: event.symbols,
                    control: event.control,
                    state: event.state,
                    stats: event.stats,
                    risk: event.risk,
                    regime: event.regime,
                    lastSeenAt: event.timestamp
                });
                strategyNameLookup.set(strategyName, { strategyId, lane });
                continue;
            }
            if (type === 'config-promote' || type === 'config-rollback' || type === 'config-accept') {
                configTransitions.push(event);
                continue;
            }
            if (type === 'allocation-update') {
                allocationTransitions.push(event);
                continue;
            }
            if (type === 'lane-learning') {
                laneLearningTransitions.push(event);
            }
        }
        for (const entry of journal) {
            const derived = strategyNameLookup.get(entry.strategy);
            const strategyId = entry.strategyId ?? derived?.strategyId ?? entry.strategy;
            const lane = entry.lane ?? derived?.lane ?? 'unknown';
            const summary = journalSummaries.get(strategyId) ?? {
                strategyId,
                strategy: entry.strategy,
                lane,
                trades: 0,
                realizedPnl: 0,
                wins: 0,
                losses: 0,
                lastExitAt: entry.exitAt,
                avgConfidencePct: 0
            };
            summary.trades += 1;
            summary.realizedPnl += entry.realizedPnl;
            summary.wins += entry.realizedPnl > 0 ? 1 : 0;
            summary.losses += entry.realizedPnl < 0 ? 1 : 0;
            summary.lastExitAt = summary.lastExitAt > entry.exitAt ? summary.lastExitAt : entry.exitAt;
            summary.avgConfidencePct += entry.confidencePct ?? 0;
            journalSummaries.set(strategyId, summary);
        }
        const normalizedJournal = Array.from(journalSummaries.values()).map((summary) => ({
            ...summary,
            realizedPnl: Number(summary.realizedPnl.toFixed(2)),
            winRate: summary.trades > 0 ? Number(((summary.wins / summary.trades) * 100).toFixed(1)) : 0,
            avgConfidencePct: summary.trades > 0 ? Number((summary.avgConfidencePct / summary.trades).toFixed(1)) : 0
        })).sort((left, right) => right.lastExitAt.localeCompare(left.lastExitAt));
        return {
            asOf: new Date().toISOString(),
            timelineStart: events[0]?.timestamp ?? null,
            timelineEnd: events.at(-1)?.timestamp ?? null,
            totalEvents: events.length,
            eventCounts: Object.fromEntries(eventCounts.entries()),
            lastTick: lastTick
                ? {
                    timestamp: lastTick.timestamp,
                    tick: lastTick.tick,
                    activeAgents: lastTick.activeAgents,
                    macro: lastTick.macro,
                    embargoes: lastTick.embargoes
                }
                : null,
            agentStates: Array.from(agentStates.values()).sort((left, right) => String(left.agentId).localeCompare(String(right.agentId))),
            strategyStates: Array.from(strategyStates.values()).sort((left, right) => String(left.strategyId).localeCompare(String(right.strategyId))),
            configTransitions: configTransitions.slice(-50),
            allocationTransitions: allocationTransitions.slice(-50),
            laneLearningTransitions: laneLearningTransitions.slice(-50),
            journalSummaries: normalizedJournal
        };
    }
}
let replayEngine;
export function getReplayEngine() {
    if (!replayEngine) {
        replayEngine = new ReplayEngine();
    }
    return replayEngine;
}
