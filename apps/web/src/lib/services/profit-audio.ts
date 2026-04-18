import type { AgentFillEvent, PaperDeskSnapshot } from '@hermes/contracts';

const PROFIT_SOUND_URL = '/sounds/coins_cave01.wav';
const LOSS_SOUND_URL = '/sounds/stab.wav';

const seenFillIds = new Set<string>();
let armed = false;
let unlocked = false;

/**
 * Browsers block Audio.play() until the user has interacted with the page.
 * Attach a one-shot listener that plays a silent buffer on the first click /
 * keypress / touch — that "unlocks" subsequent programmatic playback.
 */
function attachUnlockListener(): void {
  if (typeof window === 'undefined' || unlocked) return;
  const unlock = () => {
    if (unlocked) return;
    const a = new Audio(PROFIT_SOUND_URL);
    a.volume = 0;
    a.play().then(() => {
      a.pause();
      a.currentTime = 0;
      unlocked = true;
      console.info('[profit-audio] audio unlocked via user gesture');
    }).catch((err) => {
      console.warn('[profit-audio] unlock attempt failed:', err);
    });
  };
  window.addEventListener('click', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
  window.addEventListener('touchstart', unlock, { once: true, capture: true });
}

function classifyOutcome(fill: AgentFillEvent): 'profit' | 'loss' | null {
  if (fill.status !== 'filled' || !Number.isFinite(fill.pnlImpact)) return null;
  if (fill.pnlImpact === 0 && fill.side === 'buy') return null; // entry fill
  if (fill.pnlImpact >= 0.01) return 'profit';
  if (fill.pnlImpact <= -0.01) return 'loss';
  return null;
}

function playOutcomeSound(outcome: 'profit' | 'loss', pnl: number): void {
  if (typeof window === 'undefined') return;
  const url = outcome === 'profit' ? PROFIT_SOUND_URL : LOSS_SOUND_URL;
  const audio = new Audio(url);
  audio.preload = 'auto';
  audio.volume = outcome === 'profit' ? 0.9 : 0.75;
  audio.play().then(() => {
    console.info(`[profit-audio] played ${outcome} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)})`);
  }).catch((err) => {
    console.warn(`[profit-audio] ${outcome} sound blocked (click anywhere to unlock): ${err?.message ?? err}`);
  });
}

export function primeProfitAudio(snapshot: PaperDeskSnapshot): void {
  seenFillIds.clear();
  for (const fill of snapshot.fills) {
    seenFillIds.add(fill.id);
  }
  armed = true;
  attachUnlockListener();
  console.info(`[profit-audio] primed with ${seenFillIds.size} historical fills; armed=true`);
}

export function syncProfitAudio(snapshot: PaperDeskSnapshot): void {
  const newFills = snapshot.fills.filter((fill) => !seenFillIds.has(fill.id));
  const newOutcomes: Array<{ outcome: 'profit' | 'loss'; pnl: number }> = [];
  for (const fill of newFills) {
    const outcome = classifyOutcome(fill);
    if (outcome) newOutcomes.push({ outcome, pnl: fill.pnlImpact });
  }
  for (const fill of snapshot.fills) seenFillIds.add(fill.id);

  if (armed && newOutcomes.length > 0) {
    const last = newOutcomes[newOutcomes.length - 1]!;
    playOutcomeSound(last.outcome, last.pnl);
  }
}
