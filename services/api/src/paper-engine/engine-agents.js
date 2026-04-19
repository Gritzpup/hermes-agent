import { round } from '../paper-engine-utils.js';
import { buildAgentConfigs, withAgentConfigDefaults } from '../paper-engine-config.js';
import { REAL_PAPER_AUTOPILOT, STARTING_EQUITY } from './types.js';
export function seedAgents(engine) {
    const overrides = engine.loadAgentConfigOverrides();
    const configs = buildAgentConfigs(REAL_PAPER_AUTOPILOT);
    const allocation = STARTING_EQUITY / configs.length;
    for (const config of configs) {
        const mergedConfig = withAgentConfigDefaults({
            ...config,
            ...(overrides[config.id] ?? {})
        });
        engine.agents.set(config.id, {
            config: { ...mergedConfig },
            baselineConfig: { ...config },
            evaluationWindow: 'legacy',
            startingEquity: allocation,
            cash: allocation,
            realizedPnl: 0,
            feesPaid: 0,
            wins: 0,
            losses: 0,
            trades: 0,
            status: 'watching',
            cooldownRemaining: 0,
            position: null,
            pendingOrderId: null,
            pendingSide: null,
            lastBrokerSyncAt: null,
            lastAction: 'Booting paper scalper.',
            lastSymbol: config.symbol,
            lastExitPnl: 0,
            recentOutcomes: [],
            recentHoldTicks: [],
            baselineExpectancy: 0,
            lastAdjustment: 'Collecting baseline paper samples before tuning.',
            improvementBias: 'hold-steady',
            allocationMultiplier: 1,
            allocationScore: 1,
            allocationReason: 'Neutral initial allocation before live outcomes.',
            deployment: {
                mode: 'stable',
                championConfig: null,
                challengerConfig: null,
                startedAt: null,
                startingTrades: 0,
                startingRealizedPnl: 0,
                startingOutcomeCount: 0,
                probationTradesRequired: 6,
                rollbackLossLimit: 2,
                lastDecision: 'Baseline config active.'
            },
            curve: [allocation]
        });
    }
}
export function rollToLiveSampleWindow(engine, agent, symbol) {
    if (agent.evaluationWindow === 'live-market') {
        return;
    }
    agent.evaluationWindow = 'live-market';
    agent.startingEquity = round(agent.cash, 2);
    agent.realizedPnl = 0;
    agent.wins = 0;
    agent.losses = 0;
    agent.trades = 0;
    agent.recentOutcomes = [];
    agent.recentHoldTicks = [];
    const deskEquity = engine.getDeskEquity();
    agent.curve = Array.from({ length: 12 }, () => deskEquity);
    console.log(`[paper-engine] Filtered agent ${agent.config.id} to live-market evaluation window at equity $${agent.startingEquity}.`);
    engine.recordEvent('evaluation-window-roll', {
        agentId: agent.config.id,
        symbol: agent.config.symbol,
        startingEquity: agent.startingEquity,
        reason: 'First broker-backed paper fill detected.'
    });
}
export function applyAgentConfig(engine, agentId, config) {
    const agent = engine.agents.get(agentId);
    if (!agent)
        return false;
    const championConfig = { ...agent.config };
    const challengerConfig = withAgentConfigDefaults({
        ...agent.config,
        ...config,
        id: agent.config.id,
        name: agent.config.name,
        symbol: agent.config.symbol,
        executionMode: agent.config.executionMode,
        autonomyEnabled: agent.config.autonomyEnabled,
        focus: agent.config.focus
    });
    const walkForward = engine.evaluateWalkForwardPromotion(agent, challengerConfig, championConfig);
    engine.walkForwardResults.set(agentId, walkForward);
    engine.recordEvent('walk-forward', walkForward);
    if (!walkForward.passed) {
        agent.lastAdjustment = `Blocked challenger config: ${walkForward.note}`;
        agent.lastAction = `Walk-forward gate blocked new config on ${agent.config.symbol}.`;
        return false;
    }
    agent.config = challengerConfig;
    agent.deployment = {
        mode: 'challenger-probation',
        championConfig,
        challengerConfig: { ...challengerConfig },
        startedAt: new Date().toISOString(),
        startingTrades: agent.trades,
        startingRealizedPnl: agent.realizedPnl,
        startingOutcomeCount: agent.recentOutcomes.length,
        probationTradesRequired: 6,
        rollbackLossLimit: 2,
        lastDecision: 'Challenger promoted into probation window by learning loop.'
    };
    // Set baseline expectancy (trailing-50 at promotion) for auto-halt evaluation.
    const trailing50 = (agent.recentOutcomes ?? []).slice(-50);
    agent.baselineExpectancy = trailing50.length > 0
        ? trailing50.reduce((s, r) => s + r, 0) / trailing50.length
        : 0;
    agent.lastAdjustment = `Learning loop promoted challenger: target ${agent.config.targetBps}bps, stop ${agent.config.stopBps}bps, hold ${agent.config.maxHoldTicks}, size ${(agent.config.sizeFraction * 100).toFixed(1)}%.`;
    if (!agent.position) {
        agent.lastAction = `Challenger config applied to ${agent.config.symbol} on probation. Waiting for the next clean setup.`;
    }
    engine.recordEvent('config-promote', {
        agentId,
        symbol: agent.config.symbol,
        championConfig,
        challengerConfig
    });
    engine.persistAgentConfigOverrides();
    return true;
}
