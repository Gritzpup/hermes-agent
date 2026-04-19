import { PaperScalpingEngine } from '../paper-engine.js';
let engine;
export function getPaperEngine() {
    if (!engine) {
        engine = new PaperScalpingEngine();
        engine.start();
    }
    return engine;
}
