import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BacktestResult, EvolutionStatus, StrategyGenome } from '@hermes/contracts';
import { crossover, mutate, randomGenome, toAgentConfig } from './genome.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = process.env.STRATEGY_LAB_RUNTIME_DIR ?? path.resolve(moduleDir, '../.runtime');
const POPULATION_PATH = path.join(RUNTIME_DIR, 'population.json');
const HISTORY_PATH = path.join(RUNTIME_DIR, 'history.json');
const BACKTEST_URL = process.env.BACKTEST_URL ?? 'http://127.0.0.1:4305';
const ELITISM_RATE = 0.1;

interface EvolutionHistory {
  generation: number;
  bestFitness: number;
  avgFitness: number;
  bestGenomeId: string;
  timestamp: string;
}

export class EvolutionEngine {
  private population: StrategyGenome[] = [];
  private history: EvolutionHistory[] = [];
  private currentRun: EvolutionStatus | null = null;

  constructor() {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    this.loadState();
  }

  getPopulation(): StrategyGenome[] {
    return [...this.population].sort((a, b) => (b.fitness ?? -Infinity) - (a.fitness ?? -Infinity));
  }

  getBest(): StrategyGenome | null {
    if (this.population.length === 0) return null;
    return this.getPopulation()[0] ?? null;
  }

  getHistory(): EvolutionHistory[] {
    return [...this.history];
  }

  getCurrentRun(): EvolutionStatus | null {
    return this.currentRun;
  }

  async startRun(symbol: string, populationSize: number, generations: number, startDate: string, endDate: string): Promise<EvolutionStatus> {
    const runId = `evo-${Date.now()}`;
    this.currentRun = {
      id: runId,
      symbol,
      status: 'running',
      currentGeneration: 0,
      totalGenerations: generations,
      bestFitness: -Infinity,
      bestGenome: null,
      startedAt: new Date().toISOString()
    };

    // Initialize population
    this.population = Array.from({ length: populationSize }, (_, i) => randomGenome(0));

    // Run evolution in background
    void this.runEvolution(symbol, generations, startDate, endDate).catch((error) => {
      if (this.currentRun) {
        this.currentRun.status = 'error';
        this.currentRun.completedAt = new Date().toISOString();
      }
      console.error('[strategy-lab] evolution failed', error);
    });

    return this.currentRun;
  }

  private async runEvolution(symbol: string, generations: number, startDate: string, endDate: string): Promise<void> {
    for (let gen = 0; gen < generations; gen++) {
      if (!this.currentRun || this.currentRun.status !== 'running') break;

      // Evaluate
      await this.evaluatePopulation(symbol, startDate, endDate);

      // Record history
      const sorted = this.getPopulation();
      const best = sorted[0];
      const avgFitness = this.population.reduce((sum, g) => sum + (g.fitness ?? 0), 0) / Math.max(this.population.length, 1);

      this.history.push({
        generation: gen,
        bestFitness: best?.fitness ?? 0,
        avgFitness: Number(avgFitness.toFixed(4)),
        bestGenomeId: best?.id ?? '',
        timestamp: new Date().toISOString()
      });

      if (this.currentRun) {
        this.currentRun.currentGeneration = gen;
        this.currentRun.bestFitness = best?.fitness ?? 0;
        this.currentRun.bestGenome = best ?? null;
      }

      this.persistState();

      // Don't evolve on last generation
      if (gen < generations - 1) {
        this.evolveGeneration(gen + 1);
      }
    }

    if (this.currentRun) {
      this.currentRun.status = 'complete';
      this.currentRun.completedAt = new Date().toISOString();
    }
    this.persistState();
  }

  private async evaluatePopulation(symbol: string, startDate: string, endDate: string): Promise<void> {
    for (const genome of this.population) {
      if (typeof genome.fitness === 'number') continue;

      try {
        const response = await fetch(`${BACKTEST_URL}/backtest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentConfig: toAgentConfig(genome),
            symbol,
            startDate,
            endDate
          })
        });

        if (!response.ok) {
          genome.fitness = -999;
          continue;
        }

        const result = await response.json() as BacktestResult;
        genome.fitness = result.sharpeRatio;
      } catch {
        genome.fitness = -999;
      }
    }
  }

  private evolveGeneration(generation: number): void {
    const sorted = this.getPopulation();
    const eliteCount = Math.max(1, Math.floor(sorted.length * ELITISM_RATE));
    const elite = sorted.slice(0, eliteCount);
    const newPopulation: StrategyGenome[] = elite.map((g) => ({ ...g }));

    while (newPopulation.length < sorted.length) {
      const parentA = this.tournamentSelect(sorted);
      const parentB = this.tournamentSelect(sorted);
      let child = crossover(parentA, parentB);
      child = mutate(child);
      child.generation = generation;
      delete (child as Partial<StrategyGenome>).fitness;
      newPopulation.push(child);
    }

    this.population = newPopulation;
  }

  private tournamentSelect(sorted: StrategyGenome[]): StrategyGenome {
    const candidates: StrategyGenome[] = [];
    for (let i = 0; i < 3; i++) {
      candidates.push(sorted[Math.floor(Math.random() * sorted.length)]!);
    }
    return candidates.sort((a, b) => (b.fitness ?? -Infinity) - (a.fitness ?? -Infinity))[0]!;
  }

  private loadState(): void {
    try {
      if (fs.existsSync(POPULATION_PATH)) {
        this.population = JSON.parse(fs.readFileSync(POPULATION_PATH, 'utf8')) as StrategyGenome[];
      }
    } catch { /* ignore */ }

    try {
      if (fs.existsSync(HISTORY_PATH)) {
        this.history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')) as EvolutionHistory[];
      }
    } catch { /* ignore */ }
  }

  private persistState(): void {
    try {
      fs.writeFileSync(POPULATION_PATH, JSON.stringify(this.population, null, 2), 'utf8');
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(this.history, null, 2), 'utf8');
    } catch (error) {
      console.error('[strategy-lab] failed to persist state', error);
    }
  }
}

let engine: EvolutionEngine | undefined;

export function getEvolutionEngine(): EvolutionEngine {
  if (!engine) {
    engine = new EvolutionEngine();
  }
  return engine;
}
