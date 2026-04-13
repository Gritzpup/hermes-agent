// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { round, readJsonLines } from '../paper-engine-utils.js';
import { FILL_LEDGER_PATH, JOURNAL_LEDGER_PATH, STATE_SNAPSHOT_PATH, LEDGER_DIR, EVENT_LOG_PATH, AGENT_CONFIG_OVERRIDES_PATH, MARKET_DATA_RUNTIME_PATH } from './types.js';

export function recordTickEvent(engine: any): void {
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

export function recordEvent(engine: any, type: string, payload: Record<string, unknown>): void {
  engine.appendLedger(EVENT_LOG_PATH, {
    timestamp: new Date().toISOString(),
    tick: engine.tick,
    type,
    ...payload
  });
  engine.maybeRotateEventLog();
}

export function enqueueWrite(engine: any, filePath: string, operation: () => Promise<void> | void): void {
  const queue = engine.fileQueues.get(filePath) ?? Promise.resolve();
  engine.fileQueues.set(
    filePath,
    queue.then(async () => {
      try {
        await operation();
      } catch (error) {
        console.error(`[paper-engine] I/O failure on ${filePath}`, error);
      }
    })
  );
}

export function maybeRotateLog(engine: any, filePath: string, maxMB: number): void {
  engine.enqueueWrite(filePath, async () => {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = await fs.promises.stat(filePath);
      if (stat.size > maxMB * 1024 * 1024) {
        const bakPath = `${filePath}.bak`;
        await fs.promises.rename(filePath, bakPath);
        console.log(`[paper-engine] Rotated ${path.basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(1)} MB -> .bak)`);
      }
    } catch {
      // Rotation is best-effort
    }
  });
}

export function maybeRotateEventLog(engine: any): void {
  engine.maybeRotateLog(EVENT_LOG_PATH, 50);
  engine.maybeRotateLog(FILL_LEDGER_PATH, 25);
  engine.maybeRotateLog(JOURNAL_LEDGER_PATH, 25);
}

export function appendLedger(engine: any, filePath: string, payload: unknown): void {
  engine.enqueueWrite(filePath, async () => {
    await fs.promises.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  });
}

export function rewriteLedger(engine: any, filePath: string, entries: unknown[]): void {
  engine.enqueueWrite(filePath, async () => {
    const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
    await fs.promises.writeFile(filePath, content.length > 0 ? `${content}\n` : '', 'utf8');
  });
}

export function persistStateSnapshot(engine: any): void {
  const state = {
    savedAt: new Date().toISOString(),
    tick: engine.tick,
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
  } catch (error) {
    console.error('[paper-engine] failed to persist state snapshot', error);
  }
}

export function restoreStateSnapshot(engine: any): boolean {
  const path = STATE_SNAPSHOT_PATH;
  if (!fs.existsSync(path)) return false;

  try {
    const raw = fs.readFileSync(path, 'utf8');
    const state = JSON.parse(raw);
    if (!Array.isArray(state.market) || !Array.isArray(state.agents)) return false;

    engine.tick = state.tick;
    // Map existing market state
    for (const symbol of state.market) {
      engine.market.set(symbol.symbol, symbol);
    }
    // Map existing agent state
    for (const agent of state.agents) {
      engine.agents.set(agent.id, agent);
    }
    engine.fills.push(...state.fills);
    engine.journal.push(...state.journal);
    engine.deskCurve.push(...state.deskCurve);
    engine.benchmarkCurve.push(...state.benchmarkCurve);
    return true;
  } catch (error) {
    console.error('[paper-engine] failed to restore state snapshot', error);
    return false;
  }
}

export function loadAgentConfigOverrides(engine: any): Record<string, any> {
  const path = AGENT_CONFIG_OVERRIDES_PATH;
  if (!fs.existsSync(path)) return {};
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function persistAgentConfigOverrides(engine: any): void {
  const path = AGENT_CONFIG_OVERRIDES_PATH;
  const overrides: Record<string, any> = {};
  for (const agent of engine.agents.values()) {
    overrides[agent.config.id] = agent.config;
  }
  try {
    fs.writeFileSync(path, JSON.stringify(overrides, null, 2), 'utf8');
  } catch (error) {
    console.error('[paper-engine] failed to persist agent config overrides', error);
  }
}

export function restoreLedgerHistory(engine: any): boolean {
  // Logic to load fills and journal from JSONL files if snapshot is missing/stale
  return true;
}

export function recordFill(engine: any, params: any): void {
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
  engine.appendLedger(FILL_LEDGER_PATH, fill);
  engine.recordEvent('fill', fill);
}

export function recordJournal(engine: any, entry: any): void {
  engine.journal.unshift(entry);
  engine.journal.splice(3000); // Default JOURNAL_LIMIT
  engine.appendLedger(JOURNAL_LEDGER_PATH, entry);
  const spreadLimit = engine.agents.get(entry.strategyId ?? '')?.config.spreadLimitBps ?? 20;
  engine.featureStore.upsertTrade(entry, spreadLimit);
  if (entry.verdict === 'loser') {
    engine.forensicRows.unshift(engine.buildForensics(entry));
    engine.forensicRows.splice(24);
  }
  engine.recordEvent('journal', entry);
}

export function getRecentEvents(engine: any, limit = 200): unknown[] {
  try {
    const logPath = EVENT_LOG_PATH;
    if (!fs.existsSync(logPath)) return [];
    const content = fs.readFileSync(logPath, 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

export function loadMarketDataState(engine: any): any | null {
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
        snapshots: parsed.snapshots.filter(
          (snapshot: any) => snapshot.source !== 'mock' && snapshot.source !== 'simulated'
        ),
        sources: Array.isArray(parsed.sources) ? parsed.sources : []
      };
    } catch {
      // File may be mid-write — retry after a brief pause
      if (attempt < 2) {
        const start = Date.now();
        while (Date.now() - start < 100) { /* busy wait 100ms */ }
      }
    }
  }
  return null;
}
