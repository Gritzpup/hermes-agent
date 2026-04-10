import type { AgentFillEvent, PaperDeskSnapshot } from '@hermes/contracts';

const PROFIT_SOUND_URL = '/sounds/coins_cave01.wav';

const seenFillIds = new Set<string>();
let armed = false;

function isProfitableFill(fill: AgentFillEvent): boolean {
  return (
    fill.source === 'broker'
    && fill.status === 'filled'
    && fill.side === 'sell'
    && fill.pnlImpact > 0
  );
}

function playProfitSound(): void {
  if (typeof window === 'undefined') {
    return;
  }

  const audio = new Audio(PROFIT_SOUND_URL);
  audio.preload = 'auto';
  audio.volume = 0.9;
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
  const newProfits = snapshot.fills.filter((fill) => !seenFillIds.has(fill.id) && isProfitableFill(fill));

  for (const fill of snapshot.fills) {
    seenFillIds.add(fill.id);
  }

  if (armed && newProfits.length > 0) {
    playProfitSound();
  }
}
