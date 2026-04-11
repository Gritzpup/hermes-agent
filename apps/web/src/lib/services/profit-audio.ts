import type { AgentFillEvent, PaperDeskSnapshot } from '@hermes/contracts';

const PROFIT_SOUND_URL = '/sounds/coins_cave01.wav';
const LOSS_SOUND_URL = '/sounds/stab.wav';

const seenFillIds = new Set<string>();
let armed = false;

function classifyOutcome(fill: AgentFillEvent): 'profit' | 'loss' | null {
  if (fill.source !== 'broker' || fill.status !== 'filled' || !Number.isFinite(fill.pnlImpact) || fill.pnlImpact === 0) {
    return null;
  }
  return fill.pnlImpact > 0 ? 'profit' : 'loss';
}

function playOutcomeSound(outcome: 'profit' | 'loss'): void {
  if (typeof window === 'undefined') {
    return;
  }

  const audio = new Audio(outcome === 'profit' ? PROFIT_SOUND_URL : LOSS_SOUND_URL);
  audio.preload = 'auto';
  audio.volume = outcome === 'profit' ? 0.9 : 0.75;
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
    .filter((outcome): outcome is 'profit' | 'loss' => outcome !== null);

  for (const fill of snapshot.fills) {
    seenFillIds.add(fill.id);
  }

  if (armed && newOutcomes.length > 0) {
    playOutcomeSound(newOutcomes[newOutcomes.length - 1]!);
  }
}
