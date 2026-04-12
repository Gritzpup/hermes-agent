/**
 * Engine Context Interface
 *
 * Defines the shape of the PaperScalpingEngine instance that extracted
 * functions need access to. This avoids importing the full engine class
 * and prevents circular dependencies.
 */

import type { AgentFillEvent, TradeJournalEntry, BrokerId, AssetClass, MarketSnapshot } from '@hermes/contracts';
import type {
  AgentState, AgentConfig, SymbolState, PositionState, PositionDirection,
  PositionEntryMetaState, BrokerRouteResponse, BrokerPaperAccountState,
  ScalpRouteState, PerformanceSummary, SymbolGuardState, PersistedMarketDataState,
  STARTING_EQUITY, FILL_LEDGER_PATH, BROKER_ROUTER_URL
} from './types.js';

/**
 * Read-only context that extracted functions can use to access engine state.
 * Methods that need to MUTATE state still live on the class.
 */
export interface EngineReadContext {
  readonly tick: number;
  readonly market: Map<string, SymbolState>;
  readonly agents: Map<string, AgentState>;
  readonly fills: AgentFillEvent[];
  readonly journal: TradeJournalEntry[];
  readonly marketIntel: any; // MarketIntelligence
  readonly newsIntel: any;
  readonly eventCalendar: any;
  readonly insiderRadar: any;
  readonly derivativesIntel: any;
  readonly signalBus: any;
  readonly aiCouncil: any;
  readonly featureStore: any;

  // Delegate methods the extracted functions may need to call back
  getAgentEquity(agent: AgentState): number;
  getDeskEquity(): number;
  getPositionDirection(position: PositionState | null | undefined): PositionDirection;
  getMetaJournalEntries(limit?: number): TradeJournalEntry[];
  classifySymbolRegime(symbol: SymbolState): string;
  hasTradableTape(symbol: SymbolState): boolean;
}
