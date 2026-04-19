// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { round, readJsonLines } from '../paper-engine-utils.js';
import { FILL_LEDGER_PATH, JOURNAL_LEDGER_PATH, STATE_SNAPSHOT_PATH, LEDGER_DIR, EVENT_LOG_PATH, AGENT_CONFIG_OVERRIDES_PATH, MARKET_DATA_RUNTIME_PATH, STATE_PERSIST_INTERVAL_TICKS } from './types.js';
import { enqueueAppendPaired, replayOrphanedPairs } from './write-queue.js';
// Call replayOrphanedPairs() on startup to handle crash-safe recovery
replayOrphanedPairs();
export function recordTickEvent(engine) {
    const macro = engine.newsIntel.getMacroSignal();
    const embargoes = engine.eventCalendar.getSnapshot().activeEmbargoes;
    const payload = {
        tick: engine.tick,
        prices: Array.from(engine.market.values()).reduce((acc, symbol) => {
            acc[symbol.symbol] = {
                price: round(symbol.price, 4),
                spreadBps: round(symbol.spreadBps, 2),
                status: symbol.marketStatus,
                regime: engine.classifySymbolRegime(symbol)
            };
            return acc;
        }, {}),
        activeAgents: Array.from(engine.agents.values()).filter((agent) => agent.status === 'in-trade').map((agent) => agent.config.id),
        signals: engine.signalBus.getRecent(12),
        macro: {
            direction: macro.direction,
            confidence: macro.confidence,
            veto: macro.veto,
            reasons: macro.reasons.slice(0, 3)
        },
        embargoes,
        agents: Array.from(engine.agents.values()).map((agent) => {
            const symbol = engine.market.get(agent.config.symbol);
            const intel = engine.marketIntel.getCompositeSignal(agent.config.symbol);
            const news = engine.newsIntel.getSignal(agent.config.symbol);
            const shortReturn = symbol ? engine.relativeMove(symbol.history, 4) : 0;
            const mediumReturn = symbol ? engine.relativeMove(symbol.history, 8) : 0;
            const score = symbol ? engine.getEntryScore(agent.config.style, shortReturn, mediumReturn, symbol) : 0;
            const safeScore = Number.isFinite(score) ? score : 0;
            const meta = symbol ? engine.getMetaLabelDecision(agent, symbol, safeScore, intel) : {
                approve: false,
                probability: 0,
                reason: 'Missing market state.'
            };
            return {
                agentId: agent.config.id,
                symbol: agent.config.symbol,
                status: agent.status,
                style: agent.config.style,
                executionMode: agent.config.executionMode,
                allocationMultiplier: round(agent.allocationMultiplier, 3),
                deploymentMode: agent.deployment.mode,
                lastAction: agent.lastAction,
                cooldownRemaining: agent.cooldownRemaining,
                realizedPnl: round(agent.realizedPnl, 2),
                trades: agent.trades,
                position: agent.position ? {
                    entryPrice: round(agent.position.entryPrice, 4),
                    quantity: round(agent.position.quantity, 6),
                    entryTick: agent.position.entryTick,
                    stopPrice: round(agent.position.stopPrice, 4),
                    targetPrice: round(agent.position.targetPrice, 4)
                } : null,
                spreadBps: round(symbol?.spreadBps ?? 0, 2),
                regime: symbol ? engine.classifySymbolRegime(symbol) : 'unknown'
            };
        })
    };
    engine.recordEvent('tick', payload);
}
export function recordEvent(engine, type, payload) {
    engine.appendLedger(EVENT_LOG_PATH, {
        timestamp: new Date().toISOString(),
        tick: engine.tick,
        type,
        ...payload
    });
    engine.maybeRotateEventLog();
}
export function enqueueWrite(engine, filePath, operation) {
    const queue = engine.fileQueues.get(filePath) ?? Promise.resolve();
    engine.fileQueues.set(filePath, queue.then(async () => {
        try {
            await operation();
        }
        catch (error) {
            console.error(`[paper-engine] I/O failure on ${filePath}`, error);
        }
    }));
}
export function maybeRotateLog(engine, filePath, maxMB) {
    engine.enqueueWrite(filePath, async () => {
        try {
            if (!fs.existsSync(filePath))
                return;
            const stat = await fs.promises.stat(filePath);
            if (stat.size > maxMB * 1024 * 1024) {
                const bakPath = `${filePath}.bak`;
                await fs.promises.rename(filePath, bakPath);
                console.log(`[paper-engine] Rotated ${path.basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(1)} MB -> .bak)`);
            }
        }
        catch {
            // Rotation is best-effort
        }
    });
}
export function maybeRotateEventLog(engine) {
    engine.maybeRotateLog(EVENT_LOG_PATH, 50);
    engine.maybeRotateLog(FILL_LEDGER_PATH, 25);
    engine.maybeRotateLog(JOURNAL_LEDGER_PATH, 25);
}
export function appendLedger(engine, filePath, payload) {
    engine.enqueueWrite(filePath, async () => {
        await fs.promises.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    });
}
export function rewriteLedger(engine, filePath, entries) {
    engine.enqueueWrite(filePath, async () => {
        const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
        await fs.promises.writeFile(filePath, content.length > 0 ? `${content}\n` : '', 'utf8');
    });
}
export function persistStateSnapshot(engine, force = false) {
    // Skip if not at persist interval (persist every N ticks instead of every tick)
    // Q23b FIX: `force` bypasses the modulo guard so position-change callers (openPosition,
    // closePosition) can snapshot immediately. Otherwise a restart between intervals loses
    // any open position that was created off-interval.
    if (!force && engine.tick % STATE_PERSIST_INTERVAL_TICKS !== 0)
        return;
    // COO FIX: equityHighWaterMark was not persisted — circuit breaker HWM would reset
    // to $300K on every engine restart, causing incorrect drawdown calculations.
    const state = {
        savedAt: new Date().toISOString(),
        tick: engine.tick,
        equityHighWaterMark: engine.equityHighWaterMark,
        market: Array.from(engine.market.values()),
        agents: Array.from(engine.agents.values()).map((agent) => ({
            ...agent,
            curve: agent.curve || []
        })),
        fills: [...engine.fills],
        journal: [...engine.journal],
        deskCurve: [...engine.deskCurve],
        benchmarkCurve: [...engine.benchmarkCurve]
    };
    try {
        const tempPath = `${STATE_SNAPSHOT_PATH}.tmp`;
        const finalPath = STATE_SNAPSHOT_PATH;
        fs.writeFileSync(tempPath, JSON.stringify(state), 'utf8');
        fs.renameSync(tempPath, finalPath);
    }
    catch (error) {
        console.error('[paper-engine] failed to persist state snapshot', error);
    }
}
export function restoreStateSnapshot(engine) {
    const path = STATE_SNAPSHOT_PATH;
    if (!fs.existsSync(path))
        return false;
    try {
        const raw = fs.readFileSync(path, 'utf8');
        const state = JSON.parse(raw);
        if (!Array.isArray(state.market) || !Array.isArray(state.agents))
            return false;
        engine.tick = state.tick;
        // COO FIX: Restore equityHighWaterMark from snapshot so circuit breaker uses correct peak.
        if (typeof state.equityHighWaterMark === 'number' && state.equityHighWaterMark > 0) {
            engine.equityHighWaterMark = state.equityHighWaterMark;
        }
        // Map existing market state
        for (const symbol of state.market) {
            engine.market.set(symbol.symbol, symbol);
        }
        // Map existing agent state — use config.id as key (agent.id is undefined on seeded agents)
        for (const agent of state.agents) {
            engine.agents.set(agent.config?.id ?? agent.id, agent);
        }
        engine.fills.push(...state.fills);
        engine.journal.push(...state.journal);
        engine.deskCurve.push(...state.deskCurve);
        engine.benchmarkCurve.push(...state.benchmarkCurve);
        return true;
    }
    catch (error) {
        console.error('[paper-engine] failed to restore state snapshot', error);
        return false;
    }
}
export function loadAgentConfigOverrides(engine) {
    const path = AGENT_CONFIG_OVERRIDES_PATH;
    if (!fs.existsSync(path))
        return {};
    try {
        return JSON.parse(fs.readFileSync(path, 'utf8'));
    }
    catch {
        return {};
    }
}
export function persistAgentConfigOverrides(engine) {
    const path = AGENT_CONFIG_OVERRIDES_PATH;
    const overrides = {};
    for (const agent of engine.agents.values()) {
        overrides[agent.config.id] = agent.config;
    }
    try {
        fs.writeFileSync(path, JSON.stringify(overrides, null, 2), 'utf8');
    }
    catch (error) {
        console.error('[paper-engine] failed to persist agent config overrides', error);
    }
}
export function restoreLedgerHistory(engine) {
    try {
        // Hydrate engine.fills and engine.journal from disk if they are empty
        if (engine.fills && engine.fills.length === 0) {
            try {
                const diskFills = readJsonLines(FILL_LEDGER_PATH);
                if (diskFills.length > 0) {
                    engine.fills = diskFills;
                }
            }
            catch { /* FILL_LEDGER_PATH may not exist yet */ }
        }
        if (engine.journal && engine.journal.length === 0) {
            try {
                const diskJournal = readJsonLines(JOURNAL_LEDGER_PATH);
                if (diskJournal.length > 0) {
                    engine.journal = diskJournal;
                }
            }
            catch { /* JOURNAL_LEDGER_PATH may not exist yet */ }
        }
        // For each broker-paper agent, sum realized PnL from journal entries where strategyId matches agent.config.id
        for (const agent of engine.agents.values()) {
            if (agent.config.executionMode !== 'broker-paper')
                continue;
            const pnlEntries = (engine.journal ?? []).filter((entry) => entry.strategyId === agent.config.id);
            const realizedPnl = pnlEntries.reduce((sum, entry) => sum + (entry.realizedPnl ?? 0), 0);
            agent.realizedPnl = round(realizedPnl, 2);
            agent.cash = round(agent.startingEquity + agent.realizedPnl, 2);
        }
        return true;
    }
    catch {
        return false;
    }
}
export function recordFill(engine, params) {
    const fill = {
        id: `paper-fill-${Date.now()}-${params.agent.config.id}-${params.side}-${randomUUID()}`,
        agentId: params.agent.config.id,
        agentName: params.agent.config.name,
        symbol: params.symbol.symbol,
        side: params.side,
        status: params.status,
        price: round(params.price, 2),
        pnlImpact: round(params.pnlImpact, 2),
        note: params.note,
        source: params.source ?? 'simulated',
        councilAction: params.councilAction,
        councilConfidence: params.councilConfidence,
        councilReason: params.councilReason,
        ...(params.orderId ? { orderId: params.orderId } : {}),
        timestamp: new Date().toISOString()
    };
    engine.fills.unshift(fill);
    engine.fills.splice(1000); // Default FILL_LIMIT
    // PAIRED WRITE: fill + event written atomically via write-queue
    const fillLine = JSON.stringify(fill);
    const eventPayload = JSON.stringify({
        timestamp: new Date().toISOString(),
        tick: engine.tick,
        type: 'fill',
        ...fill
    });
    enqueueAppendPaired(FILL_LEDGER_PATH, fillLine, EVENT_LOG_PATH, eventPayload);
}
export function recordJournal(engine, entry) {
    engine.journal.unshift(entry);
    engine.journal.splice(3000); // Default JOURNAL_LIMIT
    const spreadLimit = engine.agents.get(entry.strategyId ?? '')?.config.spreadLimitBps ?? 20;
    engine.featureStore.upsertTrade(entry, spreadLimit);
    if (entry.verdict === 'loser') {
        engine.forensicRows.unshift(engine.buildForensics(entry));
        engine.forensicRows.splice(24);
    }
    // PAIRED WRITE: journal + event written atomically via write-queue
    const journalLine = JSON.stringify(entry);
    const eventPayload = JSON.stringify({
        timestamp: new Date().toISOString(),
        tick: engine.tick,
        type: 'journal',
        ...entry
    });
    enqueueAppendPaired(JOURNAL_LEDGER_PATH, journalLine, EVENT_LOG_PATH, eventPayload);
}
export function getRecentEvents(engine, limit = 200) {
    try {
        const logPath = EVENT_LOG_PATH;
        if (!fs.existsSync(logPath))
            return [];
        const content = fs.readFileSync(logPath, 'utf8');
        return content
            .split('\n')
            .filter(Boolean)
            .slice(-limit)
            .map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
export function loadMarketDataState(engine) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (!fs.existsSync(MARKET_DATA_RUNTIME_PATH)) {
                return null;
            }
            const raw = fs.readFileSync(MARKET_DATA_RUNTIME_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed.snapshots)) {
                return null;
            }
            return {
                asOf: typeof parsed.asOf === 'string' ? parsed.asOf : new Date().toISOString(),
                snapshots: parsed.snapshots.filter((snapshot) => snapshot.source !== 'mock' && snapshot.source !== 'simulated'),
                sources: Array.isArray(parsed.sources) ? parsed.sources : []
            };
        }
        catch {
            // File may be mid-write — retry after a brief pause
            if (attempt < 2) {
                const start = Date.now();
                while (Date.now() - start < 100) { /* busy wait 100ms */ }
            }
        }
    }
    return null;
}
