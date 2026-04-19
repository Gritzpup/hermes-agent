import { EventEmitter } from 'node:events';
const SIGNAL_LIMIT = 50;
export class SignalBus {
    emitter = new EventEmitter();
    signals = [];
    emit(signal) {
        this.signals.unshift(signal);
        if (this.signals.length > SIGNAL_LIMIT) {
            this.signals.splice(SIGNAL_LIMIT);
        }
        this.emitter.emit('signal', signal);
    }
    getRecent(limit = 20) {
        return this.signals.slice(0, limit);
    }
    onSignal(callback) {
        this.emitter.on('signal', callback);
    }
    hasRecentSignal(type, symbol, withinMs) {
        const cutoff = Date.now() - withinMs;
        for (const signal of this.signals) {
            const ts = Date.parse(signal.timestamp);
            if (ts < cutoff)
                break;
            if (signal.type === type && (symbol === null || signal.symbol === symbol)) {
                return signal;
            }
        }
        return null;
    }
    hasRecentSignalOfType(type, withinMs) {
        return this.hasRecentSignal(type, null, withinMs);
    }
}
let bus;
export function getSignalBus() {
    if (!bus) {
        bus = new SignalBus();
    }
    return bus;
}
