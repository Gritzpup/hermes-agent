import { PaperScalpingEngine } from '../paper-engine.js';

let engine: PaperScalpingEngine | undefined;

export function getPaperEngine(): PaperScalpingEngine {
  if (!engine) {
    engine = new PaperScalpingEngine();
    engine.start();
  }

  return engine;
}
