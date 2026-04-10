import { EventEmitter } from 'node:events';
import type { CrossAssetSignal, CrossAssetSignalType } from '@hermes/contracts';

const SIGNAL_LIMIT = 50;

export class SignalBus {
  private readonly emitter = new EventEmitter();
  private readonly signals: CrossAssetSignal[] = [];

  emit(signal: CrossAssetSignal): void {
    this.signals.unshift(signal);
    if (this.signals.length > SIGNAL_LIMIT) {
      this.signals.splice(SIGNAL_LIMIT);
    }
    this.emitter.emit('signal', signal);
  }

  getRecent(limit = 20): CrossAssetSignal[] {
    return this.signals.slice(0, limit);
  }

  onSignal(callback: (signal: CrossAssetSignal) => void): void {
    this.emitter.on('signal', callback);
  }

  hasRecentSignal(type: CrossAssetSignalType, symbol: string | null, withinMs: number): CrossAssetSignal | null {
    const cutoff = Date.now() - withinMs;
    for (const signal of this.signals) {
      const ts = Date.parse(signal.timestamp);
      if (ts < cutoff) break;
      if (signal.type === type && (symbol === null || signal.symbol === symbol)) {
        return signal;
      }
    }
    return null;
  }

  hasRecentSignalOfType(type: CrossAssetSignalType, withinMs: number): CrossAssetSignal | null {
    return this.hasRecentSignal(type, null, withinMs);
  }
}

let bus: SignalBus | undefined;

export function getSignalBus(): SignalBus {
  if (!bus) {
    bus = new SignalBus();
  }
  return bus;
}
