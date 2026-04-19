import { asRecord, normalizeArray, textField, numberField, round } from './utils-generic.js';
/**
 * Central helper: returns realizedPnl / unrealizedPnl from a raw broker account record.
 * - OANDA: .pl and .unrealizedPL (strings, via numberField which handles parseFloat)
 * - Alpaca: realized_pnl numeric; unrealized from positions
 * - Coinbase: simulated / zero
 */
export function extractBrokerPnL(account) {
    const realizedPnl = numberField(account, ['pl', 'realized_pl', 'realizedPL', 'realizedPnl']);
    const accountUnrealized = numberField(account, ['unrealizedPL', 'unrealized_pl', 'unrealizedPnl', 'open_pl', 'openPl']);
    return {
        realizedPnl,
        unrealizedPnl: accountUnrealized ?? 0,
    };
}
export function normalizeBrokerAccounts(snapshots) {
    return snapshots.map((snapshot) => {
        const brokerId = snapshot.broker;
        const account = asRecord(snapshot.account);
        const positions = normalizeBrokerPositions([snapshot]);
        const cash = brokerId === 'coinbase-live'
            ? sumCoinbaseCash(account)
            : numberField(account, ['cash', 'buying_power', 'portfolio_cash', 'balance']) ?? 0;
        const equity = brokerId === 'coinbase-live'
            ? round(cash + positions.reduce((sum, position) => sum + position.markPrice * position.quantity, 0), 2)
            : numberField(account, ['equity', 'portfolio_value', 'NAV', 'last_equity', 'value', 'balance']) ?? cash;
        const buyingPower = brokerId === 'coinbase-live'
            ? cash
            : numberField(account, ['buying_power', 'buyingPower', 'cash']) ?? cash;
        const accountMode = brokerId === 'alpaca-paper'
            ? 'paper'
            : brokerId === 'oanda-rest'
                ? 'paper'
                : 'live';
        const { realizedPnl, unrealizedPnl: accountUnrealized } = extractBrokerPnL(account);
        // Alpaca doesn't expose account-level unrealized; sum from positions instead.
        const positionsUnrealized = positions.reduce((sum, pos) => sum + (typeof pos.unrealizedPnl === 'number' ? pos.unrealizedPnl : 0), 0);
        const unrealizedPnl = accountUnrealized !== 0
            ? accountUnrealized
            : (positions.length > 0 ? round(positionsUnrealized, 2) : 0);
        return {
            broker: brokerId,
            mode: accountMode,
            accountId: textField(account, ['id', 'account_number', 'uuid']) ?? brokerId,
            currency: brokerId === 'coinbase-live'
                ? 'USD'
                : textField(account, ['currency']) ?? 'USD',
            cash: round(cash, 2),
            buyingPower: round(buyingPower, 2),
            equity: round(equity, 2),
            status: mapBrokerStatus(snapshot.status),
            source: 'broker',
            updatedAt: snapshot.asOf,
            availableToTrade: round(buyingPower, 2),
            unrealizedPnl: round(unrealizedPnl, 2),
            ...(typeof realizedPnl === 'number' ? { realizedPnl: round(realizedPnl, 2) } : {}),
        };
    });
}
export function normalizeBrokerPositions(snapshots) {
    return snapshots.flatMap((snapshot) => snapshot.positions
        .map((position) => normalizeBrokerPosition(snapshot, position))
        .filter((value) => value !== null));
}
export function normalizeBrokerPosition(snapshot, position) {
    const record = asRecord(position);
    // OANDA returns positions in split format: { instrument, long: { units, averagePrice, unrealizedPL },
    // short: { units, averagePrice, unrealizedPL } }. Detect and collapse into canonical shape before
    // falling through to the other normalization paths.
    const oandaLong = asRecord(record.long);
    const oandaShort = asRecord(record.short);
    const oandaInstrument = textField(record, ['instrument']);
    if (oandaInstrument && (record.long !== undefined || record.short !== undefined)) {
        const longUnits = numberField(oandaLong, ['units']) ?? 0;
        const shortUnits = numberField(oandaShort, ['units']) ?? 0; // OANDA reports short as negative string
        const netUnits = longUnits + shortUnits;
        if (netUnits !== 0) {
            const side = netUnits > 0 ? oandaLong : oandaShort;
            const rawAvgEntry = numberField(side, ['averagePrice']);
            const avgEntry = (typeof rawAvgEntry === 'number' && rawAvgEntry > 0) ? rawAvgEntry : 0;
            const longUnrealized = numberField(oandaLong, ['unrealizedPL']) ?? 0;
            const shortUnrealized = numberField(oandaShort, ['unrealizedPL']) ?? 0;
            const totalUnrealized = longUnrealized + shortUnrealized;
            const notional = avgEntry * Math.abs(netUnits);
            const unrealizedPnlPct = notional > 0 ? (totalUnrealized / notional) * 100 : 0;
            return {
                id: `${snapshot.broker}:${oandaInstrument}`,
                broker: snapshot.broker,
                symbol: oandaInstrument,
                strategy: 'broker-position',
                assetClass: 'forex',
                quantity: Math.abs(netUnits),
                avgEntry,
                markPrice: avgEntry,
                unrealizedPnl: totalUnrealized,
                unrealizedPnlPct,
                thesis: 'Imported from OANDA snapshot.',
                openedAt: snapshot.asOf,
                source: 'broker'
            };
        }
    }
    const existingBroker = textField(record, ['broker']);
    const existingSymbol = textField(record, ['symbol']);
    const existingAssetClass = textField(record, ['assetClass']);
    const existingQty = numberField(record, ['quantity']);
    const existingAvgEntry = numberField(record, ['avgEntry']);
    const existingMark = numberField(record, ['markPrice']);
    if (existingBroker && existingSymbol && existingAssetClass && existingQty !== null && existingAvgEntry !== null && existingMark !== null) {
        return {
            id: textField(record, ['id']) ?? `${existingBroker}:${existingSymbol}`,
            broker: existingBroker,
            symbol: existingSymbol,
            strategy: textField(record, ['strategy']) ?? 'broker-position',
            assetClass: existingAssetClass,
            quantity: existingQty,
            avgEntry: existingAvgEntry,
            markPrice: existingMark,
            unrealizedPnl: numberField(record, ['unrealizedPnl']) ?? 0,
            unrealizedPnlPct: numberField(record, ['unrealizedPnlPct']) ?? 0,
            thesis: textField(record, ['thesis']) ?? 'Imported from broker snapshot.',
            openedAt: textField(record, ['openedAt']) ?? snapshot.asOf,
            source: 'broker'
        };
    }
    const symbol = textField(record, ['symbol']);
    const quantity = Math.abs(numberField(record, ['qty', 'quantity']) ?? 0);
    if (!symbol || quantity <= 0) {
        return null;
    }
    const avgEntry = numberField(record, ['avg_entry_price', 'avgEntry']) ?? 0;
    const markPrice = numberField(record, ['current_price', 'mark_price', 'markPrice']) ?? avgEntry;
    const unrealizedPnl = numberField(record, ['unrealized_pl', 'unrealizedPnl']) ?? 0;
    const rawPct = numberField(record, ['unrealized_plpc', 'unrealizedPnlPct']) ?? 0;
    const unrealizedPnlPct = Math.abs(rawPct) <= 1 ? rawPct * 100 : rawPct;
    const assetClassValue = (textField(record, ['asset_class', 'assetClass']) ?? 'equity').toLowerCase();
    return {
        id: textField(record, ['asset_id', 'id']) ?? `${snapshot.broker}:${symbol}`,
        broker: snapshot.broker,
        symbol,
        strategy: 'broker-position',
        assetClass: assetClassValue.includes('crypto') ? 'crypto' : 'equity',
        quantity,
        avgEntry,
        markPrice,
        unrealizedPnl,
        unrealizedPnlPct,
        thesis: 'Imported from broker snapshot.',
        openedAt: textField(record, ['opened_at', 'openedAt']) ?? snapshot.asOf,
        source: 'broker'
    };
}
export function normalizeBrokerReports(reports) {
    return reports.map((report) => ({
        id: report.id,
        orderId: report.orderId,
        broker: report.broker,
        symbol: report.symbol,
        status: report.status,
        filledQty: report.filledQty,
        avgFillPrice: report.avgFillPrice,
        slippageBps: report.slippageBps,
        latencyMs: report.latencyMs,
        message: report.message,
        timestamp: report.timestamp,
        ...(report.mode ? { mode: report.mode } : {}),
        ...(report.source ? { source: report.source } : {})
    }));
}
export function normalizeBrokerConnectionStatus(status) {
    const s = status?.toLowerCase();
    switch (s) {
        case 'healthy':
        case 'connected':
        case 'ready':
        case 'active':
        case 'ok':
        case 'live':
            return 'connected';
        case 'degraded':
        case 'warning':
        case 'partial':
        case 'stale':
        case 'delayed':
        case 'error':
            return 'degraded';
        default:
            return 'disconnected';
    }
}
export function mapBrokerStatus(status) {
    return normalizeBrokerConnectionStatus(status);
}
export function sumCoinbaseCash(account) {
    const entries = normalizeArray(account.accounts ?? account);
    return entries.reduce((sum, entry) => {
        const record = asRecord(entry);
        const currency = textField(record, ['currency']);
        if (currency !== 'USD' && currency !== 'USDC') {
            return sum;
        }
        return sum + (numberField(record, ['available_balance.value', 'balance.value', 'available_balance', 'balance', 'value']) ?? 0);
    }, 0);
}
export function dedupePositions(positions) {
    const seen = new Set();
    return positions.filter((position) => {
        const key = `${position.broker}:${position.id}:${position.symbol}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
export function dedupeReports(reports) {
    const byId = new Map();
    for (const report of reports) {
        byId.set(`${report.broker}:${report.id}`, report);
    }
    return Array.from(byId.values()).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}
export function dedupeJournal(entries) {
    const byId = new Map();
    for (const entry of entries) {
        byId.set(entry.id, entry);
    }
    return Array.from(byId.values()).sort((left, right) => right.exitAt.localeCompare(left.exitAt));
}
export function dedupeMarketSnapshots(snapshots) {
    const bySymbol = new Map();
    for (const snapshot of snapshots) {
        const existing = bySymbol.get(snapshot.symbol);
        if (!existing || existing.source === 'simulated' || existing.source === 'mock') {
            bySymbol.set(snapshot.symbol, snapshot);
        }
    }
    return Array.from(bySymbol.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}
