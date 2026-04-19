function text(value) {
    return typeof value === 'string' ? value : '';
}
function round(value, decimals) {
    return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}
function normalizeCoinbaseOrderStatus(value) {
    const status = value.toUpperCase();
    if (status.includes('FILLED'))
        return 'filled';
    if (status.includes('CANCEL'))
        return 'canceled';
    if (status.includes('REJECT') || status.includes('FAILED') || status.includes('EXPIRE'))
        return 'rejected';
    if (status.includes('OPEN') || status.includes('PENDING') || status.includes('ACTIVE'))
        return 'working';
    return 'working';
}
export function reconcileWithBroker(current, brokerOrders) {
    const match = brokerOrders.find((order) => text(order.order_id) === (current.brokerOrderId ?? '')
        || text(order.client_order_id) === current.clientOrderId);
    if (!match) {
        return current;
    }
    const brokerStatus = text(match.status);
    const normalizedStatus = normalizeCoinbaseOrderStatus(brokerStatus);
    return {
        ...current,
        ...(text(match.order_id) ? { brokerOrderId: text(match.order_id) } : {}),
        status: normalizedStatus,
        brokerStatus: brokerStatus || current.brokerStatus,
        updatedAt: text(match.last_update_time) || current.updatedAt,
        reason: brokerStatus ? `Broker reports ${brokerStatus}.` : current.reason,
        awaitingFillReconciliation: normalizedStatus === 'filled'
            ? (current.awaitingFillReconciliation ?? true)
            : false
    };
}
export function extractExternalFills(orders, symbol, brokerFills, processedFillIds) {
    const activeOrders = orders.filter((order) => order !== null && order.live);
    const externalFills = [];
    for (const order of activeOrders) {
        const relevant = brokerFills.filter((fill) => text(fill.order_id) === (order.brokerOrderId ?? ''));
        let matched = false;
        for (const fill of relevant) {
            const entryId = text(fill.entry_id);
            if (!entryId || processedFillIds.has(entryId)) {
                continue;
            }
            const price = Number(fill.price ?? 0);
            const rawSize = Number(fill.size ?? 0);
            const sizeInQuote = fill.size_in_quote === true;
            const quantity = sizeInQuote && price > 0 ? rawSize / price : rawSize;
            if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
                continue;
            }
            const fee = Number(fill.commission ?? 0);
            const side = text(fill.side).toUpperCase() === 'SELL' ? 'sell' : 'buy';
            externalFills.push({
                id: `maker-broker-fill-${entryId}`,
                symbol,
                side,
                price,
                quantity: round(quantity, 6),
                fee: Number.isFinite(fee) ? fee : 0,
                timestamp: text(fill.trade_time) || new Date().toISOString(),
                reason: 'broker-maker-fill'
            });
            processedFillIds.add(entryId);
            matched = true;
        }
        if (matched) {
            order.awaitingFillReconciliation = false;
        }
    }
    return externalFills;
}
export async function routeBrokerOrder(order, brokerRouterUrl, liveSymbols) {
    const { randomUUID } = await import('node:crypto');
    const clientOrderId = `maker-${order.symbol}-${order.side}-${randomUUID()}`;
    if (!liveSymbols.includes(order.symbol.toUpperCase())) {
        return {
            side: order.side,
            symbol: order.symbol,
            clientOrderId,
            price: order.price,
            quantity: order.quantity,
            status: 'rejected',
            brokerStatus: 'SYMBOL_NOT_ALLOWED',
            live: true,
            reason: `Live maker rollout only allows ${liveSymbols.join(', ')}.`,
            updatedAt: new Date().toISOString()
        };
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        const response = await fetch(`${brokerRouterUrl}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: clientOrderId,
                symbol: order.symbol,
                broker: 'coinbase-live',
                side: order.side,
                orderType: 'limit',
                notional: round(order.price * order.quantity, 2),
                quantity: order.quantity,
                limitPrice: order.price,
                timeInForce: order.timeInForce,
                postOnly: true,
                strategy: order.strategy,
                mode: 'live',
                thesis: order.reason
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const report = await response.json();
        const brokerStatus = text(report.status).toUpperCase();
        const normalizedStatus = response.ok && (brokerStatus === 'ACCEPTED' || brokerStatus === 'FILLED')
            ? (brokerStatus === 'FILLED' ? 'filled' : 'working')
            : 'rejected';
        return {
            side: order.side,
            symbol: order.symbol,
            clientOrderId,
            ...(report.orderId ? { brokerOrderId: report.orderId } : {}),
            price: order.price,
            quantity: order.quantity,
            status: normalizedStatus,
            brokerStatus: brokerStatus || 'REJECTED',
            live: true,
            reason: report.message ?? order.reason,
            updatedAt: new Date().toISOString(),
            awaitingFillReconciliation: normalizedStatus === 'filled'
        };
    }
    catch (error) {
        return {
            side: order.side,
            symbol: order.symbol,
            clientOrderId,
            price: order.price,
            quantity: order.quantity,
            status: 'rejected',
            brokerStatus: 'ROUTE_ERROR',
            live: true,
            reason: error instanceof Error ? error.message : 'unknown broker route error',
            updatedAt: new Date().toISOString()
        };
    }
}
export async function cancelBrokerOrder(orderId, symbol, brokerRouterUrl) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        await fetch(`${brokerRouterUrl}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ broker: 'coinbase-live', orderId, symbol }),
            signal: controller.signal
        });
        clearTimeout(timeout);
    }
    catch {
        // Non-critical in maker preview mode.
    }
}
export async function fetchCoinbaseBrokerData(brokerRouterUrl) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        const response = await fetch(`${brokerRouterUrl}/account?broker=coinbase-live`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok)
            return { orders: [], fills: [], balances: {} };
        const body = await response.json();
        const broker = Array.isArray(body.brokers)
            ? body.brokers.find((entry) => entry?.broker === 'coinbase-live')
            : undefined;
        return {
            orders: Array.isArray(broker?.orders)
                ? broker.orders.filter((order) => !!order && typeof order === 'object')
                : [],
            fills: Array.isArray(broker?.fills)
                ? broker.fills.filter((fill) => !!fill && typeof fill === 'object')
                : [],
            balances: extractBalances(broker?.account)
        };
    }
    catch {
        return { orders: [], fills: [], balances: {} };
    }
}
export function extractBalances(account) {
    const balances = {};
    const records = account && typeof account === 'object' && Array.isArray(account.accounts)
        ? account.accounts
        : [];
    for (const entry of records) {
        if (!entry || typeof entry !== 'object')
            continue;
        const record = entry;
        const currency = typeof record.currency === 'string' ? record.currency.toUpperCase() : '';
        const raw = typeof record.available_balance === 'object' && record.available_balance !== null
            ? record.available_balance.value
            : typeof record.balance === 'object' && record.balance !== null
                ? record.balance.value
                : record.balance;
        const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
        if (currency && Number.isFinite(value)) {
            balances[currency] = value;
        }
    }
    return balances;
}
export function getFundingBlockReason(symbol, desiredBid, desiredAsk, balances) {
    const [baseCurrency = '', quoteCurrency = ''] = symbol.toUpperCase().split('-');
    if (desiredBid) {
        const availableQuote = balances[quoteCurrency] ?? 0;
        const requiredQuote = desiredBid.price * desiredBid.quantity * 1.01;
        if (availableQuote + 1e-8 < requiredQuote) {
            return `Need about ${round(requiredQuote, 2)} ${quoteCurrency} for ${symbol} maker bid, but only ${round(availableQuote, 2)} is available.`;
        }
    }
    if (desiredAsk) {
        const availableBase = balances[baseCurrency] ?? 0;
        if (availableBase + 1e-8 < desiredAsk.quantity) {
            return `Need ${round(desiredAsk.quantity, 6)} ${baseCurrency} for ${symbol} maker ask, but only ${round(availableBase, 6)} is available.`;
        }
    }
    return null;
}
export function isFatalRouteRejection(order) {
    const reason = `${order.brokerStatus} ${order.reason}`.toLowerCase();
    return reason.includes('missing required scopes')
        || reason.includes('permission')
        || reason.includes('scope')
        || reason.includes('symbol_not_allowed')
        || reason.includes('symbol not allowed')
        || reason.includes('insufficient_fund')
        || reason.includes('insufficient fund')
        || reason.includes('insufficient balance');
}
export function isCredentialScopeRejection(order) {
    const reason = `${order.brokerStatus} ${order.reason}`.toLowerCase();
    return reason.includes('missing required scopes')
        || reason.includes('permission')
        || reason.includes('scope');
}
