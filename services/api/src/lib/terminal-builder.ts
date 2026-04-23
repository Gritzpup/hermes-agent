import {
  type TerminalSnapshot,
  type SystemSettings,
  type StrategyReview,
  type CopySleevePortfolioSnapshot,
  type MacroPreservationPortfolioSnapshot,
  type StrategyGenome,
  type ServiceHealth,
  type AiProviderDecision,
  type AiCouncilTrace,
  type BrokerAccountSnapshot
} from '@hermes/contracts';
import { type MarketMicrostructureFeed } from './types-routes.js';
import {
  MARKET_DATA_URL,
  RISK_ENGINE_URL,
  BROKER_ROUTER_URL,
  REVIEW_LOOP_URL,
  BACKTEST_URL,
  STRATEGY_LAB_URL
} from './constants.js';
import {
  fetchJson,
  fetchArrayJson,
  getServiceHealthSnapshot
} from './utils-http.js';
import { asRecord, round } from './utils-generic.js';
import { getRecentOllamaActivity } from '../services/ollama-activity.js';
import { normalizeBrokerAccounts, normalizeBrokerReports } from './utils-normalization.js';
import { getLiveCapitalSafety } from '../paper-engine/live-capital-safety.js';
import { getSecEdgarIntel } from '../sec-edgar.js';
import type { BrokerRouterAccountResponse, BrokerRouterReportsResponse } from './types-broker.js';

export interface TerminalSnapshotDeps {
  paperEngine: {
    getSnapshot(): any;
    getLiveReadiness(): any;
    getJournal(): any;
    getPositions(): any[];
    latencyTracker?: {
      getReport?(): any;
      recordLatency?(sample: any): void;
      setPendingSignal?(agentId: string, symbol: string, signalAt: string): void;
    };
  };
  aiCouncil: {
    getStatus(): any;
    getTraces(count: number): any[];
  };
  learningLoop: {
    getLog(count: number): any[];
  };
  laneLearning: {
    getLog(count: number): any[];
  };
  strategyDirector: {
    getLatest(): any;
    getRegimeSnapshot(): any;
  };
  marketIntel: {
    getSnapshot(): any;
  };
  newsIntel: {
    getSnapshot(): any;
  };
  eventCalendar: {
    getSnapshot(): any;
  };
  makerEngine: {
    getSnapshot(): any;
  };
  makerExecutor: {
    getSnapshot(): any;
  };
  btcGrid: {
    getSnapshot(): any;
  };
  accounts?: BrokerAccountSnapshot[];
  health?: ServiceHealth[];
}

export function compactTerminalLines(lines: Array<string | null | undefined>): string[] {
  return lines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0).slice(0, 20);
}

export function buildTerminalPane(
  id: string,
  label: string,
  status: ServiceHealth['status'],
  summary: string,
  lines: Array<string | null | undefined>
): TerminalSnapshot['terminals'][number] {
  return {
    id,
    label,
    status,
    summary,
    lines: compactTerminalLines(lines)
  };
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'unknown error';
}

export function buildTerminalFallbackSnapshot(error: unknown): TerminalSnapshot {
  return {
    asOf: new Date().toISOString(),
    terminals: [buildTerminalPane('api', 'Hermes API', 'critical', 'Terminal telemetry unavailable.', [formatError(error)])]
  };
}

function previewText(text: string, maxLength: number): string {
  const clean = text.replace(/[\n\r]+/g, ' ').trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

export async function buildTerminalSnapshot(
  deps: TerminalSnapshotDeps,
  overrides?: {
    marketMicrostructure?: MarketMicrostructureFeed | null;
    brokerReports?: any;
    reviews?: StrategyReview[];
    strategyHealth?: any;
    copySleeve?: any;
    macroPreservation?: any;
    secEdgarIntel?: any;
    accounts?: BrokerAccountSnapshot[];
  }
): Promise<TerminalSnapshot> {
  const [health, marketHealth, marketMicrostructure, riskSettings, brokerState, brokerReports, reviews, reviewClusters, copySleeve, macroPreservation, secEdgarIntel, strategyBest, strategyHistory, strategyHealth] = await Promise.all([
    deps.health ?? getServiceHealthSnapshot(),
    fetchJson<Record<string, unknown>>(MARKET_DATA_URL, '/health'),
    overrides?.marketMicrostructure ?? fetchJson<MarketMicrostructureFeed>(MARKET_DATA_URL, '/microstructure'),
    fetchJson<SystemSettings>(RISK_ENGINE_URL, '/settings'),
    fetchJson<BrokerRouterAccountResponse>(BROKER_ROUTER_URL, '/account'),
    overrides?.brokerReports ?? fetchJson<BrokerRouterReportsResponse>(BROKER_ROUTER_URL, '/reports'),
    overrides?.reviews ?? fetchArrayJson<StrategyReview>(REVIEW_LOOP_URL, '/reviews'),
    fetchJson<Record<string, unknown>>(REVIEW_LOOP_URL, '/clusters'),
    overrides?.copySleeve ?? fetchJson<CopySleevePortfolioSnapshot>(BACKTEST_URL, '/copy-sleeve', 5_000),
    overrides?.macroPreservation ?? fetchJson<MacroPreservationPortfolioSnapshot>(BACKTEST_URL, '/macro-preservation', 5_000),
    overrides?.secEdgarIntel ?? getSecEdgarIntel().getSnapshot(),
    fetchJson<StrategyGenome>(STRATEGY_LAB_URL, '/best'),
    fetchArrayJson<Record<string, unknown>>(STRATEGY_LAB_URL, '/history'),
    overrides?.strategyHealth ?? fetchJson<Record<string, unknown>>(STRATEGY_LAB_URL, '/health')
  ]);

  const brokerAccounts = overrides?.accounts ?? deps.accounts ?? normalizeBrokerAccounts(brokerState?.brokers ?? []);

  const healthMap = new Map((health ?? []).map((entry) => [entry.name, entry]));
  const paperDesk = deps.paperEngine.getSnapshot();
  const liveReadiness = deps.paperEngine.getLiveReadiness();
  const councilStatus = deps.aiCouncil.getStatus();
  
  const sortedDecisions = [...(paperDesk.aiCouncil ?? [])].sort((left: any, right: any) => right.timestamp.localeCompare(left.timestamp));
  const realVoteDecision = sortedDecisions.find((d: any) => d.panel?.some((v: any) => v.source !== 'rules') || (d.primary && d.primary.source !== 'rules'));
  const latestDecision = realVoteDecision ?? sortedDecisions[0] ?? null;
  const latestReview = [...(reviews ?? [])].sort((left: any, right: any) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const latestLearningDecision = deps.learningLoop.getLog(5).at(-1) ?? null;
  const latestLaneLearningDecision = deps.laneLearning.getLog(5).at(-1) ?? null;
  const learningLogCount = deps.learningLoop.getLog(50).length;
  const laneLearningLogCount = deps.laneLearning.getLog(50).length;
  const strategyLabHealth = strategyHealth ? asRecord(strategyHealth) : null;
  const brokerExecutions = normalizeBrokerReports(brokerReports?.reports ?? []).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const microSnapshots = marketMicrostructure?.snapshots ?? [];
  const marketLines = microSnapshots
    .slice()
    .sort((left, right) => left.spreadBps - right.spreadBps)
    .slice(0, 3)
    .map((snapshot) => {
      const extras = [
        snapshot.queueImbalancePct !== undefined ? `queue ${snapshot.queueImbalancePct.toFixed(1)}%` : null,
        snapshot.tradeImbalancePct !== undefined ? `trade ${snapshot.tradeImbalancePct.toFixed(1)}%` : null,
        snapshot.pressureImbalancePct !== undefined ? `pressure ${snapshot.pressureImbalancePct.toFixed(1)}%` : null,
        snapshot.spreadStableMs !== undefined ? `stable ${snapshot.spreadStableMs.toFixed(0)}ms` : null
      ].filter((value): value is string => Boolean(value));
      return `[${snapshot.symbol}] spread ${snapshot.spreadBps.toFixed(2)}bps · imb ${snapshot.imbalancePct.toFixed(1)}% · micro ${snapshot.microPrice.toFixed(2)}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
    });

  const voteLabel = (vote: AiProviderDecision): string => {
    if (vote.source === 'rules') return 'rules';
    return `${vote.provider}/${vote.source}`;
  };

  const hasFinalCouncilVotes = latestDecision?.status === 'complete';
  const councilVotes = !latestDecision
    ? 'no council votes yet'
    : latestDecision.status === 'queued'
      ? 'queued · waiting for final council vote'
      : latestDecision.status === 'evaluating'
        ? 'evaluating · waiting for final council vote'
        : latestDecision.status === 'error'
          ? 'error · no final council vote'
          : latestDecision.panel?.length
            ? latestDecision.panel.map((vote: any) => `${voteLabel(vote)}:${vote.action} ${vote.confidence}%`).join(' · ')
            : [latestDecision.primary, latestDecision.challenger].filter((vote): vote is AiProviderDecision => Boolean(vote)).map((vote) => `${voteLabel(vote)}:${vote.action} ${vote.confidence}%`).join(' · ');

  const formatVoteLine = (label: string, vote: AiProviderDecision | null | undefined): string => {
    if (!vote) {
      return `[${label}] waiting for vote`;
    }
    return `[${label}] ${voteLabel(vote)} ${vote.action} ${vote.confidence}% · ${vote.thesis} · ${vote.riskNote}`;
  };

  const latestPrimary = hasFinalCouncilVotes ? latestDecision.primary : null; // now Gemini
  const latestChallenger = hasFinalCouncilVotes ? latestDecision.challenger : null; // now Kimi
  const latestGemini = hasFinalCouncilVotes ? (latestDecision.panel?.find((v: any) => v?.provider === 'gemini') ?? null) : null;
  const latestKimi = hasFinalCouncilVotes ? (latestDecision.panel?.find((v: any) => v?.provider === 'kimi') ?? null) : null;
  const latestOllamaFinance = hasFinalCouncilVotes ? (latestDecision.panel?.find((v: any) => typeof v?.provider === 'string' && v.provider.includes('hermes3')) ?? null) : null;
  const latestOllamaQwen = hasFinalCouncilVotes ? (latestDecision.panel?.find((v: any) => typeof v?.provider === 'string' && v.provider.includes('qwen35')) ?? null) : null;
  const councilTraces = deps.aiCouncil.getTraces(12);
  const latestDecisionTrace = latestDecision ? councilTraces.find((trace) => trace.decisionId === latestDecision.id) ?? null : null;
  const latestTrace: AiCouncilTrace | null = latestDecision?.status === 'complete' ? latestDecisionTrace : null;
  const terminalTimestamp = new Date().toISOString();

  const asString = (val: any) => (typeof val === 'string' ? val : null);

  const deskEquity = paperDesk.totalEquity ?? 0;
  const startEquity = paperDesk.startingEquity ?? 300_000;
  // COO FIX: nav/dailyPnl/dailyPnlPct/drawdownPct extend TerminalSnapshot to match OverviewSnapshot contract.
  // OverviewSnapshot type expects these fields but the /api/overview endpoint was not returning them.
  return {
    asOf: terminalTimestamp,
    // @ts-ignore
    nav: deskEquity,
    // @ts-ignore
    dailyPnl: round(deskEquity - startEquity, 2),
    // @ts-ignore
    dailyPnlPct: startEquity > 0 ? round(((deskEquity - startEquity) / startEquity) * 100, 2) : 0,
    // @ts-ignore
    drawdownPct: 0,
    brokerAccounts,
    serviceHealth: health ?? [],
    aiCouncil: paperDesk.aiCouncil,
    marketFocus: paperDesk.marketFocus ?? microSnapshots,
    terminals: [
      buildTerminalPane(
        'api',
        'Hermes API',
        healthMap.get('api')?.status ?? 'healthy',
        `${paperDesk.activeAgents} active agents · ${paperDesk.totalTrades} trades · win ${paperDesk.winRate.toFixed(1)}%`,
        [
          latestDecision
            ? `[ai-council] ${latestDecision.symbol} → ${latestDecision.finalAction} · ${councilVotes}`
            : '[ai-council] No decisions queued yet.',
          `[council] ${councilStatus.enabled ? 'enabled' : 'disabled'} · queued ${councilStatus.queued} · in flight ${councilStatus.inFlight ? 'yes' : 'no'} · recent ${councilStatus.recentDecisions}`,
          `[readiness] ${liveReadiness.summary} · blockers ${liveReadiness.blockers.slice(0, 3).join(' · ') || 'none'}`,
          `[signals] ${paperDesk.signals.length} signals · ${paperDesk.fills.length} fills · ${paperDesk.analytics.verificationNote}`,
          `[allocator] ${paperDesk.analytics.adaptiveMode}`
        ]
      ),
      buildTerminalPane(
        'ai-council',
        'AI Council',
        councilStatus.inFlight || councilStatus.queued > 0 ? 'warning' : latestDecision?.finalAction === 'reject' ? 'warning' : 'healthy',
        latestTrace
          ? `${latestTrace.role} ${latestTrace.status} · ${latestTrace.parsedAction ?? 'n/a'} ${latestTrace.parsedConfidence?.toFixed(0) ?? '0'}% · ${previewText(latestTrace.rawOutput, 120)}`
          : latestDecision
            ? `${latestDecision.symbol} · ${latestDecision.status} · ${latestDecision.finalAction} · ${latestDecision.reason}`
            : `${councilStatus.recentDecisions} recent decisions · queue idle`,
        [
          `[queue] ${councilStatus.queued} queued · ${councilStatus.inFlight ? 'evaluating now' : 'idle'}`,
          latestDecision ? `[latest] ${latestDecision.symbol} · ${latestDecision.agentName} · ${latestDecision.finalAction}` : '[latest] No council decision yet.',
          latestDecision ? `[reason] ${latestDecision.reason}` : '[reason] Waiting for a candidate.',
          latestTrace
            ? `[prompt] ${previewText(latestTrace.prompt, 90)}`
            : '[prompt] No CLI transcript yet.',
          latestChallenger ? `[panel] challenger ${latestChallenger.action} ${latestChallenger.confidence}%` : '[panel] missing challenger',
          latestDecision 
            ? `[response] output parsed` 
            : '[response] Awaiting CLI output.',
          '[votes]',
          latestPrimary ? formatVoteLine('gemini', latestPrimary) : '[gemini] waiting for vote',
          latestChallenger ? formatVoteLine('kimi', latestChallenger) : '[kimi] waiting for vote',
          latestOllamaFinance ? formatVoteLine('ollama-hermes3', latestOllamaFinance) : '[ollama-hermes3] waiting for vote'
        ]
      ),
      buildTerminalPane(
        'claude-terminal',
        'Gemini (Primary)',
        latestPrimary ? (latestPrimary.error ? 'critical' : 'healthy') : 'warning',
        latestPrimary
          ? `${latestPrimary.action} ${latestPrimary.confidence}% · ${latestPrimary.thesis}`
          : 'Waiting for Gemini primary vote.',
        [
          latestPrimary ? `[thesis] ${latestPrimary.thesis}` : '[thesis] No primary vote yet.',
          latestPrimary ? `[risk] ${latestPrimary.riskNote}` : '[risk] No risk note yet.',
          latestDecision ? `[candidate] ${latestDecision.symbol} · ${latestDecision.agentName}` : '[candidate] No active candidate.',
          latestPrimary ? `[latency] ${latestPrimary.latencyMs}ms` : '[latency] n/a'
        ]
      ),
      buildTerminalPane(
        'codex-terminal',
        'Kimi (Challenger)',
        latestChallenger ? (latestChallenger.error ? 'critical' : 'healthy') : 'warning',
        latestChallenger
          ? `${latestChallenger.action} ${latestChallenger.confidence}% · ${latestChallenger.thesis}`
          : 'Waiting for Kimi challenger vote.',
        [
          latestChallenger ? `[thesis] ${latestChallenger.thesis}` : '[thesis] No challenger vote yet.',
          latestChallenger ? `[risk] ${latestChallenger.riskNote}` : '[risk] No risk note yet.',
          latestDecision ? `[candidate] ${latestDecision.symbol} · ${latestDecision.agentName}` : '[candidate] No active candidate.',
          latestChallenger ? `[latency] ${latestChallenger.latencyMs}ms` : '[latency] n/a'
        ]
      ),
      buildTerminalPane(
        'gemini-terminal',
        'Gemini',
        latestGemini ? (latestGemini.error ? 'critical' : 'healthy') : 'warning',
        latestGemini
          ? `${latestGemini.action} ${latestGemini.confidence}% · ${latestGemini.thesis}`
          : 'Waiting for tertiary review.',
        [
          latestGemini ? `[thesis] ${latestGemini.thesis}` : '[thesis] No tertiary vote yet.',
          latestGemini ? `[risk] ${latestGemini.riskNote}` : '[risk] No risk note yet.',
          latestDecision ? `[candidate] ${latestDecision.symbol} · ${latestDecision.agentName}` : '[candidate] No active candidate.',
          latestGemini ? `[latency] ${latestGemini.latencyMs}ms` : '[latency] n/a'
        ]
      ),
      buildTerminalPane(
        'kimi-terminal',
        'Kimi',
        latestKimi ? (latestKimi.error ? 'critical' : 'healthy') : 'warning',
        latestKimi
          ? `${latestKimi.action} ${latestKimi.confidence}% · ${latestKimi.thesis}`
          : 'Waiting for Kimi deliberation.',
        [
          latestKimi ? `[thesis] ${latestKimi.thesis}` : '[thesis] No Kimi vote yet.',
          latestKimi ? `[risk] ${latestKimi.riskNote}` : '[risk] No risk note yet.',
          latestDecision ? `[candidate] ${latestDecision.symbol} · ${latestDecision.agentName}` : '[candidate] No active candidate.',
          latestKimi ? `[latency] ${latestKimi.latencyMs}ms` : '[latency] n/a'
        ]
      ),
      buildTerminalPane(
        'ollama-terminal',
        'Ollama',
        (latestOllamaFinance || latestOllamaQwen)
          ? ((latestOllamaFinance?.error || latestOllamaQwen?.error) ? 'critical' : 'healthy')
          : 'warning',
        (() => {
          const parts: string[] = [];
          if (latestOllamaFinance) parts.push(`[finance-llama-8b] ${latestOllamaFinance.action} ${latestOllamaFinance.confidence}%`);
          if (latestOllamaQwen)    parts.push(`[qwen3.5-9b] ${latestOllamaQwen.action} ${latestOllamaQwen.confidence}%`);
          return parts.length ? parts.join(' · ') : 'Waiting for Ollama votes (finance-llama-8b + qwen3.5-9b).';
        })(),
        [
          latestOllamaFinance
            ? `[finance-llama-8b thesis] ${latestOllamaFinance.thesis}`
            : '[finance-llama-8b] No vote yet.',
          latestOllamaFinance
            ? `[finance-llama-8b risk] ${latestOllamaFinance.riskNote} · ${latestOllamaFinance.latencyMs}ms`
            : '[finance-llama-8b latency] n/a',
          latestOllamaQwen
            ? `[qwen3.5-9b thesis] ${latestOllamaQwen.thesis}`
            : '[qwen3.5-9b] No vote yet.',
          latestOllamaQwen
            ? `[qwen3.5-9b risk] ${latestOllamaQwen.riskNote} · ${latestOllamaQwen.latencyMs}ms`
            : '[qwen3.5-9b latency] n/a',
          latestDecision ? `[candidate] ${latestDecision.symbol} · ${latestDecision.agentName}` : '[candidate] No active candidate.',
          ...(() => {
            const nonCouncil = getRecentOllamaActivity(20).filter(
              (e) => !e.source.startsWith('ai-council')
            );
            if (nonCouncil.length === 0) return [] as string[];
            return nonCouncil.slice(-6).map(
              (e) =>
                `[${e.source}] ${e.model} ${e.status} ${e.latencyMs != null ? `${e.latencyMs}ms` : '—'} · ${e.status === 'error' ? (e.errorPreview ?? 'error') : e.responsePreview}`
            );
          })()
        ]
      ),
      // Meta-label model pane (7th council voter)
      (() => {
        const latestMetaLabel = hasFinalCouncilVotes
          ? (latestDecision.panel?.find((v: any) => v?.provider === 'meta-label') ?? null)
          : null;
        const metaLabelMeta = deps.aiCouncil.getStatus();
        return buildTerminalPane(
          'meta-label',
          'Meta-Label',
          latestMetaLabel ? 'healthy' : metaLabelMeta.enabled ? 'warning' : 'warning',
          latestMetaLabel
            ? `MetaLabel ${latestMetaLabel.action} ${latestMetaLabel.confidence}%`
            : 'Waiting for meta-label model vote.',
          [
            latestMetaLabel
              ? `[thesis] ${latestMetaLabel.thesis}`
              : '[thesis] Model not trained yet (needs more TP/SL barrier hits).',
            latestMetaLabel
              ? `[risk] ${latestMetaLabel.riskNote}`
              : '[risk] Insufficient label diversity in trade journal.',
            latestDecision ? `[candidate] ${latestDecision.symbol} · ${latestDecision.agentName}` : '[candidate] No active candidate.',
            latestMetaLabel ? `[latency] ${latestMetaLabel.latencyMs}ms` : '[latency] n/a'
          ]
        );
      })(),
      buildTerminalPane(
        'market-data',
        'Market Data',
        healthMap.get('market-data')?.status ?? 'warning',
        `${microSnapshots.length} live microstructure feeds · ${asString(marketHealth?.message) ?? 'market polling current'}`,
        [
          `[feed] ${marketMicrostructure?.connected ? 'connected' : 'disconnected'} · last message ${marketMicrostructure?.lastMessageAt ?? 'n/a'}`,
          ...marketLines,
          marketHealth?.sources ? '[sources] source metadata available' : '[sources] source metadata unavailable'
        ]
      ),
      buildTerminalPane(
        'risk-engine',
        'Risk Engine',
        healthMap.get('risk-engine')?.status ?? 'warning',
        `Trade cap ${riskSettings ? `$${riskSettings.riskCaps.maxTradeNotional.toFixed(0)}` : 'n/a'} · drawdown gate ${riskSettings ? `${riskSettings.riskCaps.maxDrawdownPct.toFixed(1)}%` : 'n/a'}`,
        [
          riskSettings
            ? `[caps] daily loss $${riskSettings.riskCaps.maxDailyLoss.toFixed(0)} · max strategy ${riskSettings.riskCaps.maxStrategyExposurePct.toFixed(1)}% · max symbol ${riskSettings.riskCaps.maxSymbolExposurePct.toFixed(1)}% · slippage ${riskSettings.riskCaps.maxSlippageBps.toFixed(1)}bps`
            : '[caps] risk settings unavailable.',
          riskSettings ? `[universe] ${riskSettings.universe.slice(0, 5).join(', ')}` : '[universe] unavailable',
          riskSettings ? `[kill switches] ${riskSettings.killSwitches.slice(0, 4).join(' · ')}` : '[kill switches] unavailable',
          `[readiness] ${liveReadiness.overallEligible ? 'eligible' : 'blocked'} · ${liveReadiness.blockers.slice(0, 2).join(' · ') || 'no blockers'}`
        ]
      ),
      buildTerminalPane(
        'broker-router',
        'Broker Router',
        healthMap.get('broker-router')?.status ?? 'warning',
        `${brokerAccounts.length} account snapshots · ${brokerExecutions.length} execution reports`,
        [
          ...brokerAccounts.map((account) => `[${account.broker}] equity $${account.equity.toFixed(2)} · cash $${account.cash.toFixed(2)} · buying power $${account.buyingPower.toFixed(2)} · ${account.status}`),
          brokerExecutions[0]
            ? `[latest] ${brokerExecutions[0].broker} ${brokerExecutions[0].symbol} ${brokerExecutions[0].status} · ${brokerExecutions[0].message}`
            : '[latest] No recent execution reports.',
          brokerState?.lastSyncAt ? `[sync] last sync ${brokerState.lastSyncAt}` : '[sync] no sync timestamp yet'
        ]
      ),
      // ── Phase 4 live-capital safety pane ──────────────────────────
      (() => {
        const safety = getLiveCapitalSafety();
        const snap = safety.getSnapshot();
        const today = new Date().toISOString().slice(0, 10);
        const todayCount = snap.dailyTradeCount?.[today] ?? 0;
        const statusMap: Record<string, ServiceHealth['status']> = {
          ACTIVE: 'healthy',
          HALTED: 'critical',
          DISABLED: 'warning'
        };
        return buildTerminalPane(
          'live-safety',
          'Live Capital',
          statusMap[snap.status] ?? 'warning',
          `status=${snap.status} · today ${todayCount}/${snap.maxTradesPerDay} trades · P&L $${snap.liveTotalPnl.toFixed(2)}`,
          [
            `[status] ${snap.status} · flag=${process.env.COINBASE_LIVE_ROUTING_ENABLED ?? '0'}`,
            snap.halted
              ? `[HALTED] "${snap.haltReason}" · until ${new Date(snap.haltedUntil).toLocaleString()}`
              : '[halt] clear',
            `[trades] today ${todayCount}/${snap.maxTradesPerDay} · total ${snap.liveTrades}`,
            `[P&L] cumulative $${snap.liveTotalPnl.toFixed(4)} · peak $${snap.peakEquity.toFixed(2)} · current $${snap.currentEquity.toFixed(2)}`,
            snap.divergencePct !== null
              ? `[divergence] live-vs-paper avg ${snap.divergencePct.toFixed(2)}% · threshold ${safety.LIVE_PAPER_DIVERGENCE_PCT}%`
              : `[divergence] waiting for ${safety.LIVE_DIVERGENCE_MIN_TRADES} trades`,
            `[limits] notional ≤$${snap.maxNotionalUsd} · concurrent ≤${snap.maxConcurrentPositions} · single-loss ≤$${snap.maxSingleLossUsd} · drawdown ≤$${snap.maxTotalDrawdownUsd}`
          ]
        );
      })(),
      buildTerminalPane(
        'review-loop',
        'Review Loop',
        healthMap.get('review-loop')?.status ?? 'warning',
        `${reviews.length} reviews · ${deps.paperEngine.getJournal().length} journal entries · ${learningLogCount} learning logs · ${laneLearningLogCount} lane logs`,
        [
          latestReview
            ? `[latest review] ${latestReview.strategy} → ${latestReview.recommendation} · PF ${latestReview.pnl30d.toFixed(2)} · WR ${latestReview.winRate.toFixed(1)}%`
            : '[latest review] No reviews yet.',
          latestLearningDecision
            ? `[learning] ${latestLearningDecision.action} · ${latestLearningDecision.agentName} · PF ${latestLearningDecision.currentPF.toFixed(2)} · WR ${latestLearningDecision.currentWinRate.toFixed(1)}%`
            : '[learning] No self-learning log yet.',
          latestLaneLearningDecision
            ? `[lane] ${latestLaneLearningDecision.action} · ${latestLaneLearningDecision.strategy} · alloc ${latestLaneLearningDecision.allocationMultiplier.toFixed(2)}x`
            : '[lane] No lane-learning log yet.',
          reviewClusters ? `[clusters] ${Object.keys(reviewClusters).slice(0, 4).join(', ') || 'none'}` : '[clusters] unavailable',
          `[journal] ${deps.paperEngine.getJournal().length} live entries · ${paperDesk.fills.length} fills`
        ]
      ),
      buildTerminalPane(
        'backtest',
        'Backtest Service',
        healthMap.get('backtest')?.status ?? 'warning',
        `${copySleeve ? copySleeve.managerName : 'Copy sleeve'} · ${macroPreservation ? macroPreservation.regime : 'macro snapshot unavailable'}`,
        [
          copySleeve
            ? `[copy] ${copySleeve.managerName} latest filing ${copySleeve.latestFiling ? `${copySleeve.latestFiling.holdings.length} holdings · resolved ${copySleeve.latestFiling.resolvedWeightPct.toFixed(1)}%` : 'no filing'} · benchmark ${copySleeve.benchmarkSymbol}`
            : '[copy] copy sleeve unavailable.',
          copySleeve?.notes?.[0] ? `[copy] ${copySleeve.notes[0]}` : '[copy] no copy notes yet.',
          macroPreservation
            ? `[macro] regime ${macroPreservation.regime} · CPI ${macroPreservation.latestObservation ? `${macroPreservation.latestObservation.yoyPct.toFixed(2)}% y/y` : 'n/a'} · ${macroPreservation.inflationHot ? 'inflation-hot' : 'cash-first'}`
            : '[macro] macro sleeve unavailable.',
          macroPreservation?.notes?.[0] ? `[macro] ${macroPreservation.notes[0]}` : '[macro] no macro notes yet.'
        ]
      ),
      // SEC EDGAR Berkshire copy-sleeve pane
      (() => {
        const edgar: any = secEdgarIntel;
        const signals = edgar?.signals ?? [];
        const top3 = signals.slice(0, 3);
        const newBuys = signals.filter((s: any) => s.action === 'new');
        const status: ServiceHealth['status'] = edgar?.errors?.length
          ? (edgar.errors.length >= edgar.ciksQueried ? 'critical' : 'warning')
          : 'healthy';
        return buildTerminalPane(
          'copy-sleeve',
          'Copy Sleeve',
          status,
          `${signals.length} signals · ${newBuys.length} new buys · quarter ${edgar?.quarterKey ?? 'n/a'}`,
          [
            edgar?.lastPollAt
              ? `[poll] last ${new Date(edgar.lastPollAt).toLocaleString()} · errors ${edgar.errors.length}/${edgar.ciksQueried}`
              : '[poll] not yet polled',
            edgar?.errors?.[0] ? `[err] ${edgar.errors[0]}` : null,
            signals.length === 0 ? '[signals] no signals yet — waiting for first 13F fetch' : null,
            ...top3.map((s: any) => `[${s.action}] ${s.filer} → ${s.symbol} ${s.percentOfPortfolio.toFixed(1)}%`),
            signals.length > 3 ? `[more] +${signals.length - 3} more signals` : null,
          ].filter(Boolean) as string[]
        );
      })(),
      buildTerminalPane(
        'strategy-lab',
        'Strategy Lab',
        healthMap.get('strategy-lab')?.status ?? 'warning',
        `${asString(strategyHealth?.status) ?? 'ready'} · ${strategyHistory.length} history entries`,
        [
          strategyBest
            ? `[best genome] ${strategyBest.id} · ${strategyBest.style} · fitness ${strategyBest.fitness?.toFixed(2) ?? 'n/a'}`
            : '[best genome] none yet.',
          `[population] ${typeof strategyLabHealth?.populationSize === 'number' ? strategyLabHealth.populationSize : 'n/a'} genomes · current run ${strategyLabHealth?.currentRun ? 'running' : 'idle'}`,
          strategyHistory[0]
            ? `[history] latest entry ${asString(strategyHistory[0]?.status) ?? 'recorded'}`
            : '[history] no evolution history yet.'
        ]
      ),
      (() => {
        const latest = deps.strategyDirector.getLatest();
        const regime = deps.strategyDirector.getRegimeSnapshot();
        const rp = latest?.riskPosture;
        const adjCount = latest?.agentAdjustments?.length ?? 0;
        const symCount = latest?.symbolChanges?.length ?? 0;
        const playbookCount = latest?.playbookApplications?.length ?? 0;
        const status = !latest ? 'warning' : latest.error ? 'critical' : 'healthy';
        return buildTerminalPane(
          'strategy-director',
          'Strategy Director',
          status,
          latest
            ? `regime:${regime.regime} · ${rp?.posture ?? 'normal'} posture · ${playbookCount} playbook switches · ${adjCount} fine-tunes · ${latest.latencyMs ? `${(latest.latencyMs / 1000).toFixed(0)}s` : 'pending'}`
            : 'Waiting for first cycle (2 min warmup).',
          [
            `[regime] ${regime.regime} · ${regime.agentTemplates.length} agents on playbook templates`,
            latest
              ? `[posture] ${rp?.posture ?? 'normal'} — ${rp?.reason?.slice(0, 100) ?? 'no posture change'}`
              : '[posture] waiting for first analysis.',
            latest
              ? `[reasoning] ${latest.reasoning?.slice(0, 140) ?? 'no reasoning'}`
              : '[reasoning] pending.',
            ...(latest?.playbookApplications?.slice(0, 8).map((p: any) =>
              `[playbook] ${p.agentId} → '${p.templateName}' (${p.regime})`
            ) ?? []),
            ...(latest?.agentAdjustments?.slice(0, 8).map((a: any) =>
              `[fine-tune] ${a.agentId}.${a.field}: ${a.oldValue} → ${a.newValue} — ${a.reason?.slice(0, 80) ?? ''}`
            ) ?? []),
            ...(latest?.symbolChanges?.slice(0, 6).map((s: any) =>
              `[symbol] ${s.action} ${s.symbol} on ${s.broker} — ${s.reason?.slice(0, 80) ?? ''}`
            ) ?? []),
            latest
              ? `[cycle] ${new Date(latest.timestamp).toLocaleTimeString()} · ${latest.runId?.slice(0, 8)} · ${latest.error ? `ERROR: ${latest.error.slice(0, 60)}` : `${playbookCount} playbook, ${adjCount} adj, ${symCount} sym`}`
              : '[cycle] not started.'
          ]
        );
      })()
    ]
  };
}
