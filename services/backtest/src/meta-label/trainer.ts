/**
 * Meta-Label Model Trainer
 *
 * Pure-TS logistic regression on triple-barrier labels.
 * Features: [pnlBps, holdTicks, entryConfidence, sessionQuality, regime, realizedCostBps]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LABEL_PATH = process.env.TRIPLE_BARRIER_OUTPUT_PATH
  ?? path.resolve(MODULE_DIR, '../../../api/.runtime/paper-ledger/triple-barrier.jsonl');
const DEFAULT_OUTPUT_PATH = process.env.META_LABEL_MODEL_PATH
  ?? path.resolve(MODULE_DIR, '../../../api/.runtime/paper-ledger/meta-label-model.json');
const MIN_SAMPLES = 300;
const NEUTRAL_THRESHOLD = 0.95; // if >95% neutral, skip training

export interface TripleBarrierRecord {
  features: { pnlBps: number; holdTicks: number; entryConfidence: number; sessionQuality: number; regime: number; realizedCostBps: number };
  label: 1 | -1 | 0;
}

export interface TrainedModel {
  coefficients: number[];   // [w0, w1, w2, w3, w4, w5, w6] for 6 features + bias
  featureMeans: number[];
  featureStds: number[];
  version: string;
  trainedAt: string;
  trainAccuracy: number;
  testAccuracy: number;
  samples: number;
  labelDist: { positives: number; negatives: number; neutrals: number };
}

/** Compute mean and std for a feature column */
function computeStats(values: number[]): { mean: number; std: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 1 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance) || 1;
  return { mean, std };
}

/** Logistic regression with gradient descent (binary: +1 vs -1) */
function trainLogisticRegression(
  X: number[][],   // features (already standardized)
  y: number[],    // labels: +1 or -1
  iterations: number = 1000,
  lr: number = 0.1
): number[] {
  const nFeatures = X[0]!.length;
  const nSamples = X.length;
  // Initialize weights + bias (6 total: bias + 5 features)
  const weights = new Array(nFeatures + 1).fill(0);
  // Inline sigmoid
  const sig = (v: number) => (v > 20 ? 0.999999999 : v < -20 ? 0.000000001 : 1 / (1 + Math.exp(-v)));

  for (let iter = 0; iter < iterations; iter++) {
    const gradients = new Array(nFeatures + 1).fill(0);

    for (let i = 0; i < nSamples; i++) {
      const xi = X[i]!;
      const label = y[i]!;
      const z = weights[0]! + xi.reduce((s, x, j) => s + weights[j + 1]! * x, 0);
      const pred = sig(label * z);

      // Gradients
      gradients[0]! += (pred - 0.5) * label;
      for (let j = 0; j < nFeatures; j++) {
        gradients[j + 1]! += (pred - 0.5) * label * xi[j]!;
      }
    }

    // Update weights
    for (let j = 0; j <= nFeatures; j++) {
      weights[j]! -= (lr / nSamples) * gradients[j]!;
    }
  }

  return weights;
}

/** Standardize a single feature vector */
function standardize(features: number[], means: number[], stds: number[]): number[] {
  return features.map((f, i) => (f - means[i]!) / stds[i]!);
}

/** Predict binary label (+1/-1) using trained weights */
function predictBinary(X: number[][], weights: number[]): number[] {
  return X.map((xi) => {
    const z = weights[0]! + xi.reduce((s, x, j) => s + weights[j + 1]! * x, 0);
    return z >= 0 ? 1 : -1;
  });
}

/** Accuracy on held-out set */
function accuracy(yTrue: number[], yPred: number[]): number {
  let correct = 0;
  for (let i = 0; i < yTrue.length; i++) {
    if (yTrue[i] === yPred[i]) correct++;
  }
  return correct / yTrue.length;
}

/** Read labeled records from JSONL */
function readLabels(labelPath: string): TripleBarrierRecord[] {
  if (!fs.existsSync(labelPath)) return [];
  const content = fs.readFileSync(labelPath, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TripleBarrierRecord);
}

/** Shuffle array (Fisher-Yates) */
function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

/**
 * Train meta-label model on triple-barrier labels.
 * Requires ≥300 records with both +1 and -1 labels.
 * Returns early (trained=false) if label distribution is too skewed.
 */
export async function trainMetaLabelModel(
  labelPath: string = DEFAULT_LABEL_PATH,
  outputPath: string = DEFAULT_OUTPUT_PATH
): Promise<{ trained: boolean; samples: number; accuracy?: number; reason?: string }> {
  const records = readLabels(labelPath);

  if (records.length === 0) {
    return { trained: false, samples: 0, reason: 'no labeled records found' };
  }

  // Count label distribution
  const positives = records.filter((r) => r.label === 1).length;
  const negatives = records.filter((r) => r.label === -1).length;
  const neutrals = records.filter((r) => r.label === 0).length;
  const total = records.length;

  // Check for minimum samples
  if (total < MIN_SAMPLES) {
    return {
      trained: false,
      samples: total,
      reason: `insufficient samples (${total} < ${MIN_SAMPLES})`
    };
  }

  // Check for minimum label diversity
  if (positives < 10 || negatives < 10) {
    return {
      trained: false,
      samples: total,
      reason: `insufficient label diversity (${positives} positives, ${negatives} negatives — need ≥10 each)`
    };
  }

  // Check for skew (>95% neutral = too skewed)
  if (neutrals / total > NEUTRAL_THRESHOLD) {
    return {
      trained: false,
      samples: total,
      reason: `insufficient label diversity (${((neutrals / total) * 100).toFixed(1)}% neutral — need more TP/SL barrier hits)`
    };
  }

  // Filter to only +1 and -1 for binary classification
  const binaryRecords = records.filter((r) => r.label !== 0);
  shuffle(binaryRecords as unknown[] as TripleBarrierRecord[]);

  // Split: 80% train, 20% test
  const splitIdx = Math.floor(binaryRecords.length * 0.8);
  const trainRecords = binaryRecords.slice(0, splitIdx);
  const testRecords = binaryRecords.slice(splitIdx);

  // Extract features
  const FEATURE_NAMES = ['pnlBps', 'holdTicks', 'entryConfidence', 'sessionQuality', 'regime', 'realizedCostBps'] as const;
  const extractFeatures = (r: TripleBarrierRecord): number[] => [
    r.features.pnlBps,
    r.features.holdTicks,
    r.features.entryConfidence,
    r.features.sessionQuality,
    r.features.regime,
    r.features.realizedCostBps,
  ];

  const trainFeatures = trainRecords.map(extractFeatures);
  const testFeatures = testRecords.map(extractFeatures);
  const trainLabels = trainRecords.map((r) => r.label as number);
  const testLabels = testRecords.map((r) => r.label as number);

  // Compute and apply standardization
  const stats = FEATURE_NAMES.map((_, i) => {
    const vals = trainFeatures.map((f) => f[i]!);
    return computeStats(vals);
  });
  const means = stats.map((s) => s.mean);
  const stds = stats.map((s) => s.std);

  const Xtrain = trainFeatures.map((f) => standardize(f, means, stds));
  const Xtest = testFeatures.map((f) => standardize(f, means, stds));

  // Train logistic regression
  const weights = trainLogisticRegression(Xtrain, trainLabels, 1000, 0.1);

  // Evaluate
  const yTrainPred = predictBinary(Xtrain, weights);
  const yTestPred = predictBinary(Xtest, weights);
  const trainAcc = accuracy(trainLabels, yTrainPred);
  const testAcc = accuracy(testLabels, yTestPred);

  // Save model
  const model: TrainedModel = {
    coefficients: weights,
    featureMeans: means,
    featureStds: stds,
    version: '1.0.0',
    trainedAt: new Date().toISOString(),
    trainAccuracy: trainAcc,
    testAccuracy: testAcc,
    samples: binaryRecords.length,
    labelDist: { positives, negatives, neutrals },
  };

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(model, null, 2), 'utf8');

  console.log(`[meta-label-trainer] trained model: ${binaryRecords.length} samples, test accuracy ${(testAcc * 100).toFixed(1)}%, saved to ${outputPath}`);

  return { trained: true, samples: binaryRecords.length, accuracy: testAcc };
}
