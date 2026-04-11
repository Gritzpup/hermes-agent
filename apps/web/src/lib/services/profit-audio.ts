import type { AgentFillEvent, PaperDeskSnapshot } from '@hermes/contracts';

const PROFIT_SOUND_URL = '/sounds/coins_cave01.wav';
const LOSS_SOUND_URL = '/sounds/stab.wav';
const BREAKEVEN_SOUND_URL = '/sounds/itemclth.wav';

const seenFillIds = new Set<string>();
let armed = false;

function classifyOutcome(fill: AgentFillEvent): 'profit' | 'loss' | 'breakeven' | null {
  // Include both broker fills and simulated fills (Coinbase paper)
  if (fill.status !== 'filled' || !Number.isFinite(fill.pnlImpact)) {
    return null;
  }
  // Only classify exit fills (side=sell for longs, side=buy for shorts)
  if (fill.pnlImpact === 0 && fill.side === 'buy') return null; // entry fill, skip
  if (fill.pnlImpact > 0.005) return 'profit';
  if (fill.pnlImpact < -0.005) return 'loss';
  if (fill.side === 'sell' || fill.side === 'buy') return 'breakeven'; // exit with near-zero PnL
  return null;
}

function playOutcomeSound(outcome: 'profit' | 'loss' | 'breakeven'): void {
  if (typeof window === 'undefined') {
    return;
  }

  const url = outcome === 'profit' ? PROFIT_SOUND_URL : outcome === 'loss' ? LOSS_SOUND_URL : BREAKEVEN_SOUND_URL;
  const audio = new Audio(url);
  audio.preload = 'auto';
  audio.volume = outcome === 'profit' ? 0.9 : outcome === 'loss' ? 0.75 : 0.6;
  void audio.play().catch(() => {
    // Ignore autoplay failures until the user has interacted with the app.
  });
}

export function primeProfitAudio(snapshot: PaperDeskSnapshot): void {
  seenFillIds.clear();
  for (const fill of snapshot.fills) {
    seenFillIds.add(fill.id);
  }
  armed = true;
}

export function syncProfitAudio(snapshot: PaperDeskSnapshot): void {
  const newOutcomes = snapshot.fills
    .filter((fill) => !seenFillIds.has(fill.id))
    .map((fill) => classifyOutcome(fill))
    .filter((outcome): outcome is 'profit' | 'loss' | 'breakeven' => outcome !== null);

  for (const fill of snapshot.fills) {
    seenFillIds.add(fill.id);
  }

  if (armed && newOutcomes.length > 0) {
    playOutcomeSound(newOutcomes[newOutcomes.length - 1]!);
  }
}
