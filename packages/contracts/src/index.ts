export type BrokerId = 'alpaca-paper' | 'coinbase-live' | 'oanda-rest';
export type AssetClass = 'crypto' | 'equity' | 'commodity-proxy' | 'forex' | 'bond' | 'commodity';
export type StrategyMode = 'scalping' | 'recovery' | 'pairs' | 'grid' | 'maker' | 'arbitrage' | 'copy';
export type PromotionStage = 'replay' | 'backtest' | 'walk-forward' | 'paper' | 'shadow-live' | 'live';
export type ServiceHealthStatus = 'healthy' | 'warning' | 'critical';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'accepted' | 'filled' | 'rejected' | 'canceled';
export type RiskStatus = 'approved' | 'review' | 'blocked';
export type AgentStatus = 'watching' | 'in-trade' | 'cooldown';
export type AiProviderId = 'claude' | 'codex' | 'gemini' | 'rules';
export type AiDecisionAction = 'approve' | 'reject' | 'review';
export type MarketSession = 'regular' | 'extended' | 'unknown';

export interface ServiceHealth {
  name: string;
  port: number;
  status: ServiceHealthStatus;
  message: string;
}

export interface BrokerHeat {
  broker: BrokerId;
  equity: number;
  cash: number;
  allocatedPct: number;
  realizedPnl: number;
  status: 'connected' | 'degraded' | 'disconnected' | string;
  mode: 'paper' | 'live';
  updatedAt: string;
}

export interface OverviewSnapshot {
  asOf: string;
  nav: number;
  dailyPnl: number;
  dailyPnlPct: number;
  drawdownPct: number;
  activeRiskBudgetPct: number;
  realizedPnl30d: number;
  winRate30d: number;
  expectancyR: number;
  navSparkline: number[];
  drawdownSparkline: number[];
  heatByBroker: BrokerHeat[];
  brokerAccounts: BrokerAccountSnapshot[];
  serviceHealth: ServiceHealth[];
}

export interface PositionSnapshot {
  id: string;
  broker: BrokerId;
  symbol: string;
  strategy: string;
  assetClass: AssetClass;
  quantity: number;
  avgEntry: number;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  thesis: string;
  openedAt: string;
  source?: 'paper-engine' | 'broker' | 'mock';
}

export interface OrderIntent {
  id: string;
  symbol: string;
  broker: BrokerId;
  side: OrderSide;
  orderType: OrderType;
  notional: number;
  quantity: number;
  limitPrice?: number;
  timeInForce?: 'day' | 'gtc' | 'ioc' | 'fok';
  postOnly?: boolean;
  strategy: string;
  mode: 'paper' | 'live';
  thesis: string;
}

export interface ExecutionReport {
  id: string;
  orderId: string;
  broker: BrokerId;
  symbol: string;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  slippageBps: number;
  latencyMs: number;
  message: string;
  timestamp: string;
  mode?: 'paper' | 'live';
  source?: 'broker' | 'simulated' | 'mock';
  rawStatus?: string;
}

export interface BrokerAccountSnapshot {
  broker: BrokerId;
  mode: 'paper' | 'live';
  accountId: string;
  currency: string;
  cash: number;
  buyingPower: number;
  equity: number;
  status: 'connected' | 'degraded' | 'disconnected' | string;
  source?: 'broker' | 'mock';
  updatedAt: string;
  availableToTrade?: number;
}

export interface BrokerRouteSnapshot {
  asOf: string;
  accounts: BrokerAccountSnapshot[];
  positions: PositionSnapshot[];
  reports: ExecutionReport[];
}

export interface RiskCheck {
  allowed: boolean;
  reason: string;
  maxNotional: number;
  maxDailyLoss: number;
  killSwitchArmed: boolean;
  blockedReasons?: string[];
  currentDayLoss?: number;
}

export interface RiskEngineState {
  asOf: string;
  killSwitchArmed: boolean;
  blockedReasons: string[];
  currentDayLoss: number;
  maxDailyLoss: number;
  maxTradeNotional: number;
  maxSymbolExposurePct: number;
  maxStrategyExposurePct: number;
  blockedSymbols?: string[];
  dailyRealizedPnl?: number;
  openNotional?: number;
  lastReason?: string;
}

export interface StrategyReview {
  id: string;
  strategy: string;
  stage: PromotionStage;
  pnl30d: number;
  winRate: number;
  expectancy: number;
  recommendation: string;
  proposedChanges: string[];
  updatedAt: string;
}

export interface TradeJournalEntry {
  id: string;
  symbol: string;
  assetClass?: AssetClass;
  broker: BrokerId;
  strategy: string;
  strategyId?: string;
  lane?: StrategyMode;
  thesis: string;
  entryAt: string;
  entryTimestamp?: string;
  exitAt: string;
  realizedPnl: number;
  realizedPnlPct: number;
  slippageBps: number;
  spreadBps: number;
  latencyMs?: number;
  holdTicks?: number;
  confidencePct?: number;
  regime?: string;
  newsBias?: string;
  orderFlowBias?: string;
  macroVeto?: boolean;
  embargoed?: boolean;
  tags?: string[];
  entryScore?: number;
  entryHeuristicProbability?: number;
  entryContextualProbability?: number;
  entryTrainedProbability?: number;
  entryApprove?: boolean;
  entryReason?: string;
  entryConfidencePct?: number;
  entryRegime?: string;
  entryNewsBias?: string;
  entryOrderFlowBias?: string;
  entryMacroVeto?: boolean;
  entryEmbargoed?: boolean;
  entryTags?: string[];
  estimatedCostBps?: number;
  expectedGrossEdgeBps?: number;
  expectedNetEdgeBps?: number;
  aiComment: string;
  exitReason: string;
  verdict: 'winner' | 'loser' | 'scratch';
  source?: 'broker' | 'simulated' | 'mock';
}

export interface MarketSnapshot {
  symbol: string;
  broker: BrokerId;
  assetClass: AssetClass;
  lastPrice: number;
  changePct: number;
  volume: number;
  spreadBps: number;
  liquidityScore: number;
  status: 'live' | 'delayed' | 'stale';
  source?: 'broker' | 'service' | 'simulated' | 'mock';
  session?: MarketSession;
  tradable?: boolean;
  qualityFlags?: string[];
  updatedAt?: string;
}

export interface MarketDataSourceState {
  venue: BrokerId;
  symbols: string[];
  status: 'live' | 'degraded' | 'stale';
  detail: string;
  updatedAt: string;
}

export interface MarketDataSnapshotResponse {
  asOf: string;
  universe: string[];
  snapshots: MarketSnapshot[];
  sources: MarketDataSourceState[];
}

export interface ResearchCandidate {
  id: string;
  symbol: string;
  strategy: string;
  score: number;
  expectedEdgeBps: number;
  catalyst: string;
  aiVerdict: string;
  riskStatus: RiskStatus;
  broker: BrokerId;
}

export interface StrategySnapshot {
  id: string;
  name: string;
  lane: StrategyMode;
  stage: PromotionStage;
  mode: 'paper' | 'live';
  broker: BrokerId;
  symbols: string[];
  status: 'active' | 'warming' | 'blocked';
  dailyPnl: number;
  lastReviewAt: string;
  summary: string;
}

export interface StrategyOpportunity {
  id: string;
  strategyId: string;
  strategy: string;
  lane: StrategyMode;
  symbols: string[];
  assetClass?: AssetClass;
  venue: BrokerId;
  direction: 'buy' | 'sell' | 'long' | 'short' | 'neutral';
  expectedGrossEdgeBps: number;
  estimatedCostBps: number;
  expectedNetEdgeBps: number;
  confidencePct: number;
  support: number;
  sampleCount: number;
  recentWinRate: number;
  profitFactor: number;
  expectancy: number;
  regime: string;
  newsBias: string;
  orderFlowBias: string;
  macroVeto: boolean;
  embargoed: boolean;
  enabled: boolean;
  selected: boolean;
  allocationMultiplier: number;
  reason: string;
  updatedAt: string;
}

export interface StrategyRoutePlan {
  asOf: string;
  selectedOverallId?: string | null;
  selectedByLane: Partial<Record<StrategyMode, string>>;
  selectedByAssetClass: Partial<Record<AssetClass, string>>;
  candidates: StrategyOpportunity[];
}

// --------------- Copy Sleeve / Public Manager Replication ---------------

export type CopySleeveManagerId = 'berkshire-hathaway';

export interface CopySleeveManagerConfig {
  id: CopySleeveManagerId;
  name: string;
  cik: string;
  benchmarkSymbol: string;
}

export interface CopySleeveHolding {
  issuerName: string;
  titleOfClass?: string | undefined;
  cusip?: string | undefined;
  symbol?: string | undefined;
  valueUsd: number;
  shares: number;
  weightPct: number;
  resolved: boolean;
  resolutionMethod: 'manual-map' | 'openfigi' | 'unresolved';
  reason?: string | undefined;
}

export interface CopySleeveFilingSnapshot {
  accessionNumber: string;
  filingDate: string;
  availableAt?: string;
  reportDate?: string;
  filingHref: string;
  totalValueUsd: number;
  holdings: CopySleeveHolding[];
  resolvedWeightPct: number;
  unresolvedWeightPct: number;
}

export interface CopySleevePortfolioSnapshot {
  asOf: string;
  managerId: CopySleeveManagerId;
  managerName: string;
  benchmarkSymbol: string;
  latestFiling: CopySleeveFilingSnapshot | null;
  recentFilings: CopySleeveFilingSnapshot[];
  notes: string[];
}

export interface CopySleeveBacktestRequest {
  managerId: CopySleeveManagerId;
  startDate?: string;
  endDate?: string;
  capital?: number;
  benchmarkSymbol?: string;
}

export interface CopySleeveBacktestPeriod {
  startDate: string;
  endDate: string;
  filingDate: string;
  accessionNumber: string;
  resolvedWeightPct: number;
  unresolvedWeightPct: number;
  turnoverPct: number;
  grossReturnPct: number;
  netReturnPct: number;
  feesUsd: number;
  notes: string[];
  holdings: Array<{
    issuerName: string;
    symbol: string;
    weightPct: number;
    returnPct: number;
    contributionPct: number;
    estimatedCostBps: number;
  }>;
}

export interface CopySleeveBacktestResult {
  id: string;
  managerId: CopySleeveManagerId;
  managerName: string;
  benchmarkSymbol: string;
  capital: number;
  startDate: string;
  endDate: string;
  totalReturnPct: number;
  grossReturnPct: number;
  netReturnPct: number;
  benchmarkReturnPct: number;
  totalPnL: number;
  totalFeesUsd: number;
  maxDrawdownPct: number;
  rebalances: number;
  resolvedCoveragePct: number;
  unresolvedWeightPct: number;
  periods: CopySleeveBacktestPeriod[];
  curve: number[];
  notes: string[];
}

// --------------- Macro Preservation Sleeve ---------------

export type MacroPreservationAssetSymbol = 'GLD' | 'SLV' | 'USO' | 'DBC' | 'BIL';
export type MacroPreservationRegime = 'cash' | 'inflation' | 'stagflation' | 'cooling';

export interface MacroPreservationCpiObservation {
  observationDate: string;
  availableAt: string;
  cpi: number;
  yoyPct: number;
  momentumPct: number;
}

export interface MacroPreservationAllocation {
  symbol: MacroPreservationAssetSymbol;
  name: string;
  weightPct: number;
  trailingReturnPct: number;
  score: number;
  estimatedCostBps: number;
  reason: string;
}

export interface MacroPreservationPortfolioSnapshot {
  asOf: string;
  benchmarkSymbol: string;
  cashSymbol: MacroPreservationAssetSymbol;
  inflationThresholdPct: number;
  latestObservation: MacroPreservationCpiObservation | null;
  recentObservations: MacroPreservationCpiObservation[];
  regime: MacroPreservationRegime;
  inflationHot: boolean;
  selectedAllocations: MacroPreservationAllocation[];
  notes: string[];
}

export interface MacroPreservationBacktestRequest {
  startDate?: string;
  endDate?: string;
  capital?: number;
  benchmarkSymbol?: string;
  cashSymbol?: MacroPreservationAssetSymbol;
  inflationThresholdPct?: number;
}

export interface MacroPreservationBacktestPeriod {
  startDate: string;
  endDate: string;
  decisionAt: string;
  regime: MacroPreservationRegime;
  inflationObservationDate: string | null;
  inflationYoY: number;
  inflationMomentumPct: number;
  sleeveReturnPct: number;
  benchmarkReturnPct: number;
  cashReturnPct: number;
  turnoverPct: number;
  feesUsd: number;
  notes: string[];
  allocations: Array<{
    symbol: MacroPreservationAssetSymbol;
    name: string;
    weightPct: number;
    trailingReturnPct: number;
    returnPct: number;
    contributionPct: number;
    score: number;
    estimatedCostBps: number;
    reason: string;
  }>;
}

export interface MacroPreservationBacktestResult {
  id: string;
  capital: number;
  startDate: string;
  endDate: string;
  benchmarkSymbol: string;
  cashSymbol: MacroPreservationAssetSymbol;
  inflationThresholdPct: number;
  totalReturnPct: number;
  grossReturnPct: number;
  netReturnPct: number;
  benchmarkReturnPct: number;
  cashReturnPct: number;
  inflationReturnPct: number;
  inflationBenchmarkReturnPct: number;
  inflationCashReturnPct: number;
  inflationPeriodCount: number;
  totalPnL: number;
  totalFeesUsd: number;
  maxDrawdownPct: number;
  periods: MacroPreservationBacktestPeriod[];
  inflationPeriods: MacroPreservationBacktestPeriod[];
  curve: number[];
  benchmarkCurve: number[];
  cashCurve: number[];
  notes: string[];
}

// --------------- Capital Allocation Program ---------------

export type CapitalSleeveKind = 'scalping' | 'pairs' | 'grid' | 'maker' | 'copy' | 'macro' | 'cash';
export type CapitalSleeveStatus = 'live' | 'paper' | 'staged' | 'blocked' | 'cash';

export interface CapitalSleeveAllocation {
  id: string;
  name: string;
  kind: CapitalSleeveKind;
  assetClass?: AssetClass | undefined;
  symbols: string[];
  venue: BrokerId | 'mixed' | 'multi';
  status: CapitalSleeveStatus;
  liveEligible: boolean;
  paperOnly: boolean;
  staged: boolean;
  confidencePct: number;
  expectedNetEdgeBps: number;
  score: number;
  kpiRatio: number;
  targetWeightPct: number;
  maxWeightPct: number;
  reason: string;
  notes: string[];
}

export interface CapitalAllocatorSnapshot {
  asOf: string;
  capital: number;
  deployablePct: number;
  reservePct: number;
  firmKpiRatio: number;
  sleeves: CapitalSleeveAllocation[];
  notes: string[];
}

export interface SystemSettings {
  paperBroker: BrokerId;
  liveBroker: BrokerId;
  universe: string[];
  riskCaps: {
    maxTradeNotional: number;
    maxDailyLoss: number;
    maxStrategyExposurePct: number;
    maxSymbolExposurePct: number;
    maxDrawdownPct: number;
    maxSlippageBps: number;
  };
  killSwitches: string[];
  notes: string[];
}

export interface ReviewLoopSnapshot {
  asOf: string;
  reviews: StrategyReview[];
  journal: TradeJournalEntry[];
}

export interface PaperAgentSnapshot {
  id: string;
  name: string;
  lane: StrategyMode;
  broker: BrokerId;
  status: AgentStatus;
  equity: number;
  dayPnl: number;
  realizedPnl: number;
  feesPaid?: number;
  returnPct: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  lastAction: string;
  lastSymbol: string;
  focus: string;
  lastExitPnl: number;
  directionBias?: 'long' | 'short' | 'neutral';
  executionQualityScore?: number;
  sessionKpiGate?: string;
  symbolKillSwitchUntil?: string | null;
  curve: number[];
}

export interface AgentFillEvent {
  id: string;
  orderId?: string;
  agentId: string;
  agentName: string;
  symbol: string;
  side: OrderSide;
  status: OrderStatus;
  price: number;
  pnlImpact: number;
  note: string;
  source?: 'simulated' | 'broker';
  councilAction?: string | undefined;
  councilConfidence?: number | undefined;
  councilReason?: string | undefined;
  timestamp: string;
}

export interface DataSourceStatus {
  id: string;
  label: string;
  mode: 'simulated' | 'mock' | 'service' | 'live';
  detail: string;
}

export interface PaperCandle {
  index: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PaperTradeMarker {
  id: string;
  symbol: string;
  side: OrderSide;
  status: OrderStatus;
  price: number;
  agentName: string;
  timestamp: string;
}

export interface PaperTapeSnapshot {
  symbol: string;
  broker: BrokerId;
  assetClass: AssetClass;
  status: 'live' | 'delayed' | 'stale';
  source?: 'broker' | 'service' | 'simulated' | 'mock';
  updatedAt?: string;
  session?: MarketSession;
  tradable?: boolean;
  qualityFlags?: string[];
  lastPrice: number;
  changePct: number;
  spreadBps: number;
  liquidityScore: number;
  candles: PaperCandle[];
  markers: PaperTradeMarker[];
}

export interface PaperExecutionBand {
  agentId: string;
  agentName: string;
  symbol: string;
  status: AgentStatus;
  entryPrice: number | null;
  currentPrice: number;
  stopPrice: number | null;
  targetPrice: number | null;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  lastAction: string;
}

export interface PaperStrategyTelemetry {
  agentId: string;
  agentName: string;
  symbol: string;
  style: string;
  expectancy: number;
  profitFactor: number;
  avgWinner: number;
  avgLoser: number;
  avgHoldTicks: number;
  winRate: number;
  targetBps: number;
  stopBps: number;
  maxHoldTicks: number;
  spreadLimitBps: number;
  sizeFractionPct: number;
  lastAdjustment: string;
  improvementBias: 'tighten-risk' | 'press-edge' | 'hold-steady';
  mistakeSummary?: string;
  mistakeScore?: number;
  mistakeTrend?: 'improving' | 'worsening' | 'stable';
  mistakeDelta?: number;
  performanceTrend?: 'improving' | 'worsening' | 'stable';
  performanceDeltaPct?: number;
  lastAdjustmentImproved?: boolean;
  allocationMultiplier?: number;
  allocationScore?: number;
  allocationReason?: string;
}

export interface PaperDeskAnalytics {
  profitFactor: number;
  avgWinner: number;
  avgLoser: number;
  avgHoldTicks: number;
  recentWinRate: number;
  totalOpenRisk: number;
  adaptiveMode: string;
  verificationNote: string;
  executionQuality?: Array<{
    broker: BrokerId;
    score: number;
    avgSlippageBps: number;
    avgLatencyMs: number;
    partialFillRatePct: number;
    rejectRatePct: number;
    sampleCount: number;
  }>;
  portfolioRisk?: {
    totalOpenNotional: number;
    budgetPct: number;
    openRiskPct: number;
    byCluster: Array<{ cluster: string; openNotional: number; pct: number; limitPct: number }>;
  };
}

export interface PaperDeskSnapshot {
  asOf: string;
  chartWindow: string;
  startingEquity: number;
  totalEquity: number;
  totalDayPnl: number;
  totalReturnPct: number;
  realizedPnl: number;
  realizedGrossPnl: number;
  realizedFeesUsd: number;
  realizedReturnPct: number;
  totalTrades: number;
  winRate: number;
  activeAgents: number;
  deskCurve: number[];
  benchmarkCurve: number[];
  agents: PaperAgentSnapshot[];
  fills: AgentFillEvent[];
  marketFocus: MarketSnapshot[];
  aiCouncil: AiCouncilDecision[];
  analytics: PaperDeskAnalytics;
  executionBands: PaperExecutionBand[];
  tuning: PaperStrategyTelemetry[];
  marketTape: PaperTapeSnapshot[];
  sources: DataSourceStatus[];
  signals: CrossAssetSignal[];
  weeklyReportPath?: string | null;
  weeklyReportAsOf?: string | null;
}

export interface ReadinessGate {
  name: string;
  passed: boolean;
  actual: string;
  required: string;
  severity: 'info' | 'warning' | 'blocker';
}

export interface AgentLiveReadiness {
  agentId: string;
  agentName: string;
  symbol: string;
  eligible: boolean;
  mode: 'candidate' | 'paper-only' | 'blocked';
  realizedPnl: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  kpiRatio: number;
  lastAdjustment: string;
  gates: ReadinessGate[];
}

export interface LiveReadinessReport {
  asOf: string;
  broker: string;
  overallEligible: boolean;
  summary: string;
  blockers: string[];
  nextActions: string[];
  agents: AgentLiveReadiness[];
}

export interface AiProviderDecision {
  provider: AiProviderId;
  source: 'api' | 'cli' | 'rules';
  action: AiDecisionAction;
  confidence: number;
  thesis: string;
  riskNote: string;
  latencyMs: number;
  timestamp: string;
}

// --------------- Cross-Asset Signal Bus ---------------

export type CrossAssetSignalType = 'volatility-spike' | 'correlation-break' | 'momentum-regime' | 'risk-off' | 'spread-expansion';

export interface CrossAssetSignal {
  type: CrossAssetSignalType;
  symbol: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// --------------- Backtest ---------------

export interface BacktestCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestFill {
  timestamp: string;
  side: OrderSide;
  price: number;
  pnl: number;
  reason: string;
}

export interface BacktestAgentConfig {
  style: 'momentum' | 'mean-reversion' | 'breakout';
  targetBps: number;
  stopBps: number;
  maxHoldTicks: number;
  cooldownTicks: number;
  sizeFraction: number;
  spreadLimitBps: number;
  entryThresholdMultiplier?: number;
  exitThresholdMultiplier?: number;
}

export interface BacktestRequest {
  agentConfig: BacktestAgentConfig;
  symbol: string;
  startDate: string;
  endDate: string;
}

export interface BacktestResult {
  id: string;
  symbol: string;
  startDate: string;
  endDate: string;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  totalReturn: number;
  totalReturnPct: number;
  equityCurve: number[];
  fills: BacktestFill[];
}

// --------------- Quarter Outlook ---------------

export type QuarterSimulationClassKey = 'crypto' | 'stocks' | 'forex' | 'bond';

export interface QuarterSimulationLastQuarterSummary {
  strategyReturnPct: number;
  strategyMaxDrawdownPct: number;
  benchmarkReturnPct: number;
  benchmarkMaxDrawdownPct: number;
  winRate: number;
  trades: number;
}

export interface QuarterSimulationNextQuarterSummary {
  strategyMedianReturnPct: number;
  strategyP25ReturnPct: number;
  strategyP75ReturnPct: number;
  strategyMedianMaxDrawdownPct: number;
  strategyPositivePct: number;
  benchmarkMedianReturnPct: number;
  benchmarkP25ReturnPct: number;
  benchmarkP75ReturnPct: number;
  benchmarkMedianMaxDrawdownPct: number;
  benchmarkPositivePct: number;
}

export interface QuarterSimulationSymbolSummary {
  symbol: string;
  strategyReturnPct: number;
  strategyWinRate: number;
  strategyProfitFactor: number;
  strategyMaxDrawdownPct: number;
  strategyTrades: number;
  benchmarkReturnPct: number;
  benchmarkMaxDrawdownPct: number;
}

export interface QuarterSimulationClassSummary {
  classKey: QuarterSimulationClassKey;
  symbols: string[];
  accuracyPct: number;
  lastQuarter: QuarterSimulationLastQuarterSummary;
  nextQuarter: QuarterSimulationNextQuarterSummary;
  perSymbol: QuarterSimulationSymbolSummary[];
}

export interface QuarterSimulationReport {
  asOf: string;
  generatedAt: string;
  capital: number;
  startDate: string;
  endDate: string;
  interval: string;
  overall: {
    lastQuarter: QuarterSimulationLastQuarterSummary;
    nextQuarter: QuarterSimulationNextQuarterSummary;
    strategyCurve: number[];
    benchmarkCurve: number[];
  };
  classSummaries: QuarterSimulationClassSummary[];
  notes: string[];
}

// --------------- Strategy Lab ---------------

export interface StrategyGenome {
  id: string;
  style: 'momentum' | 'mean-reversion' | 'breakout';
  targetBps: number;
  stopBps: number;
  maxHoldTicks: number;
  cooldownTicks: number;
  sizeFraction: number;
  spreadLimitBps: number;
  entryThresholdMultiplier: number;
  exitThresholdMultiplier: number;
  fitness?: number;
  generation?: number;
}

export interface EvolutionRunRequest {
  symbol: string;
  populationSize?: number;
  generations?: number;
  startDate: string;
  endDate: string;
}

export interface EvolutionStatus {
  id: string;
  symbol: string;
  status: 'running' | 'complete' | 'error';
  currentGeneration: number;
  totalGenerations: number;
  bestFitness: number;
  bestGenome: StrategyGenome | null;
  startedAt: string;
  completedAt?: string;
}

// --------------- Pairs Trading ---------------

export interface PairsTradeState {
  legA: string;
  legB: string;
  ratio: number;
  meanRatio: number;
  stdRatio: number;
  zScore: number;
  position: 'long-spread' | 'short-spread' | 'flat';
  entryZScore: number;
  entryRatio: number;
  unrealizedPnl: number;
  hedgeRatio?: number;
  correlation?: number;
  spread?: number;
  spreadMean?: number;
  spreadStd?: number;
}

// --------------- Grid Trading ---------------

export interface GridLevel {
  price: number;
  side: 'buy' | 'sell';
  filled: boolean;
  filledAt?: string;
  pnl: number;
}

export interface GridState {
  symbol: string;
  centerPrice: number;
  gridSpacingBps: number;
  levels: GridLevel[];
  completedRoundTrips: number;
  totalPnl: number;
}

// --------------- Learning Loop ---------------

export interface LearningDecision {
  timestamp: string;
  agentId: string;
  agentName: string;
  symbol: string;
  action: 'hold' | 'evolve' | 'promote' | 'skip';
  reason: string;
  currentPF: number;
  currentWinRate: number;
  trades: number;
  newConfig?: {
    targetBps: number;
    stopBps: number;
    maxHoldTicks: number;
    cooldownTicks: number;
    sizeFraction: number;
    spreadLimitBps: number;
    style: string;
  };
  backtestResult?: {
    sharpeRatio: number;
    profitFactor: number;
    winRate: number;
    totalReturnPct: number;
  };
}

export interface LaneLearningDecision {
  timestamp: string;
  strategyId: string;
  strategy: string;
  lane: Extract<StrategyMode, 'pairs' | 'grid' | 'maker'>;
  action: 'insufficient-data' | 'hold' | 'de-risk' | 'promote' | 'quarantine';
  enabled: boolean;
  allocationMultiplier: number;
  recentTrades: number;
  posteriorWinRate: number;
  profitFactor: number;
  expectancy: number;
  avgConfidencePct: number;
  avgEstimatedCostBps: number;
  avgExpectedGrossEdgeBps: number;
  avgExpectedNetEdgeBps: number;
  reason: string;
}

// --------------- AI Council ---------------

export interface AiCouncilDecision {
  id: string;
  symbol: string;
  agentId: string;
  agentName: string;
  status: 'queued' | 'evaluating' | 'complete' | 'error';
  finalAction: AiDecisionAction;
  reason: string;
  timestamp: string;
  primary: AiProviderDecision;
  challenger: AiProviderDecision | null;
  panel?: AiProviderDecision[];
}

export interface AiCouncilTrace {
  id: string;
  decisionId: string;
  symbol: string;
  agentId: string;
  agentName: string;
  role: 'claude' | 'codex' | 'gemini';
  transport: 'cli';
  status: 'evaluating' | 'complete' | 'error';
  candidateScore: number;
  prompt: string;
  systemPrompt: string;
  rawOutput: string;
  parsedAction?: AiDecisionAction;
  parsedConfidence?: number;
  parsedThesis?: string;
  parsedRiskNote?: string;
  latencyMs?: number;
  error?: string | undefined;
  timestamp: string;
}

export interface TerminalPane {
  id: string;
  label: string;
  status: ServiceHealthStatus;
  summary: string;
  lines: string[];
}

export interface TerminalSnapshot {
  asOf: string;
  terminals: TerminalPane[];
}

// --------------- Insider Radar ---------------

export interface InsiderTrade {
  symbol: string;
  filerName: string;
  transactionDate: string;
  reportingDate: string;
  transactionType: string;
  securitiesTransacted: number;
  price: number;
  totalValue: number;
  officerTitle?: string;
  description?: string;
  source: 'form4' | 'senate' | 'house';
}

export interface InsiderSignal {
  symbol: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  convictionScore: number; // 0..1
  isCluster: boolean;
  totalValue: number;
  tradeCount: number;
  recentTrades: InsiderTrade[];
  summary: string;
  convictionReason?: string | undefined;
}

export interface InsiderRadarSnapshot {
  timestamp: string;
  signals: InsiderSignal[];
  trades: InsiderTrade[];
}
