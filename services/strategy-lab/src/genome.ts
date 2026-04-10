import { randomUUID } from 'node:crypto';
import type { BacktestAgentConfig, StrategyGenome } from '@hermes/contracts';

type Style = 'momentum' | 'mean-reversion' | 'breakout';
const STYLES: Style[] = ['momentum', 'mean-reversion', 'breakout'];

interface ParamBounds { min: number; max: number }

const PARAM_KEYS = [
  'targetBps', 'stopBps', 'maxHoldTicks', 'cooldownTicks',
  'sizeFraction', 'spreadLimitBps', 'entryThresholdMultiplier', 'exitThresholdMultiplier'
] as const;

type ParamKey = typeof PARAM_KEYS[number];

const BOUNDS: Record<ParamKey, ParamBounds> = {
  targetBps: { min: 8, max: 80 },
  stopBps: { min: 5, max: 40 },
  maxHoldTicks: { min: 3, max: 30 },
  cooldownTicks: { min: 1, max: 8 },
  sizeFraction: { min: 0.03, max: 0.15 },
  spreadLimitBps: { min: 1.5, max: 8 },
  entryThresholdMultiplier: { min: 0.5, max: 2.0 },
  exitThresholdMultiplier: { min: 0.3, max: 2.0 }
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function getParam(genome: StrategyGenome, key: ParamKey): number {
  return genome[key];
}

function setParam(genome: StrategyGenome, key: ParamKey, value: number): void {
  (genome as unknown as Record<ParamKey, number>)[key] = value;
}

export function randomGenome(generation = 0): StrategyGenome {
  return {
    id: randomUUID(),
    style: STYLES[Math.floor(Math.random() * STYLES.length)]!,
    targetBps: round(randBetween(BOUNDS.targetBps.min, BOUNDS.targetBps.max), 1),
    stopBps: round(randBetween(BOUNDS.stopBps.min, BOUNDS.stopBps.max), 1),
    maxHoldTicks: Math.round(randBetween(BOUNDS.maxHoldTicks.min, BOUNDS.maxHoldTicks.max)),
    cooldownTicks: Math.round(randBetween(BOUNDS.cooldownTicks.min, BOUNDS.cooldownTicks.max)),
    sizeFraction: round(randBetween(BOUNDS.sizeFraction.min, BOUNDS.sizeFraction.max), 3),
    spreadLimitBps: round(randBetween(BOUNDS.spreadLimitBps.min, BOUNDS.spreadLimitBps.max), 1),
    entryThresholdMultiplier: round(randBetween(BOUNDS.entryThresholdMultiplier.min, BOUNDS.entryThresholdMultiplier.max), 2),
    exitThresholdMultiplier: round(randBetween(BOUNDS.exitThresholdMultiplier.min, BOUNDS.exitThresholdMultiplier.max), 2),
    generation
  };
}

export function mutate(genome: StrategyGenome): StrategyGenome {
  const child: StrategyGenome = { ...genome, id: randomUUID() };
  delete (child as Partial<StrategyGenome>).fitness;
  const mutationCount = 1 + Math.floor(Math.random() * 3);
  const selected = new Set<ParamKey>();

  while (selected.size < mutationCount) {
    selected.add(PARAM_KEYS[Math.floor(Math.random() * PARAM_KEYS.length)]!);
  }

  for (const key of selected) {
    const bounds = BOUNDS[key];
    const current = getParam(child, key);
    const factor = 1 + (Math.random() * 0.6 - 0.3);
    let newValue = current * factor;
    if (key === 'maxHoldTicks' || key === 'cooldownTicks') {
      newValue = Math.round(newValue);
    } else {
      newValue = round(newValue, key === 'sizeFraction' ? 3 : key.endsWith('Multiplier') ? 2 : 1);
    }
    setParam(child, key, clamp(newValue, bounds.min, bounds.max));
  }

  if (Math.random() < 0.1) {
    child.style = STYLES[Math.floor(Math.random() * STYLES.length)]!;
  }

  return child;
}

export function crossover(a: StrategyGenome, b: StrategyGenome): StrategyGenome {
  const child: StrategyGenome = { ...a, id: randomUUID() };
  delete (child as Partial<StrategyGenome>).fitness;
  child.style = Math.random() < 0.5 ? a.style : b.style;

  for (const key of PARAM_KEYS) {
    const aVal = getParam(a, key);
    const bVal = getParam(b, key);
    let value = Math.random() < 0.5 ? aVal : bVal;
    if (key === 'maxHoldTicks' || key === 'cooldownTicks') {
      value = Math.round(value);
    }
    setParam(child, key, value);
  }

  return child;
}

export function toAgentConfig(genome: StrategyGenome): BacktestAgentConfig {
  return {
    style: genome.style,
    targetBps: genome.targetBps,
    stopBps: genome.stopBps,
    maxHoldTicks: genome.maxHoldTicks,
    cooldownTicks: genome.cooldownTicks,
    sizeFraction: genome.sizeFraction,
    spreadLimitBps: genome.spreadLimitBps,
    entryThresholdMultiplier: genome.entryThresholdMultiplier,
    exitThresholdMultiplier: genome.exitThresholdMultiplier
  };
}
