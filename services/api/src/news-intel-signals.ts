// @ts-nocheck
/**
 * News Intelligence — Signal scoring and generation.
 * Extracted from news-intel.ts
 */

import { ageHours, clamp, freshnessWeight, round, MAX_AGE_HOURS } from './news-intel-parser.js';
import type { NormalizedNewsArticle, SignalSeverity } from './news-intel-parser.js';

export type SignalDirection = 'bullish' | 'bearish' | 'neutral';

export interface NewsSignal {
  symbol: string;
  direction: SignalDirection;
  confidence: number;
  score: number;
  severity: SignalSeverity;
  veto: boolean;
  reasons: string[];
  articleCount: number;
  contradictory: boolean;
}

export function buildSignal(symbol: string, articles: NormalizedNewsArticle[], macroSignal: NewsSignal | null): NewsSignal {
  const recent = articles
    .filter((article) => ageHours(article.publishedAt) <= MAX_AGE_HOURS)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  if (recent.length === 0) {
    return {
      symbol,
      direction: 'neutral',
      confidence: 0,
      score: 0,
      severity: 'info',
      veto: false,
      reasons: [],
      articleCount: 0,
      contradictory: false
    };
  }

  const weightedScore = recent.reduce((sum, article) => {
    const severityMultiplier = article.severity === 'critical' ? 1.4 : article.severity === 'warning' ? 1.15 : 1;
    return sum + article.sentiment * article.trust * freshnessWeight(article.publishedAt) * severityMultiplier;
  }, 0);

  const bullishCount = recent.filter((article) => article.sentiment > 0.15).length;
  const bearishCount = recent.filter((article) => article.sentiment < -0.15).length;
  const contradictory = bullishCount > 0 && bearishCount > 0;

  let direction: SignalDirection = 'neutral';
  if (weightedScore >= 0.45) direction = 'bullish';
  else if (weightedScore <= -0.45) direction = 'bearish';

  const severity: SignalSeverity = recent.some((article) => article.severity === 'critical')
    ? 'critical'
    : recent.some((article) => article.severity === 'warning')
      ? 'warning'
      : 'info';

  const recentCriticalNegativeCount = recent.filter((article) => article.severity === 'critical' && article.sentiment < -0.2 && ageHours(article.publishedAt) <= 4).length;
  const recentCriticalNegative = recentCriticalNegativeCount >= 2;
  const confidence = clamp(Math.round(Math.min(100, Math.abs(weightedScore) * 55 + recent.length * 6 + (severity === 'critical' ? 18 : severity === 'warning' ? 8 : 0))), 0, 100);
  const macroSpecificVeto = symbol === '__macro__' && severity === 'critical' && confidence >= 85 && weightedScore < -0.4;
  const macroRisk = macroSignal?.veto ?? false;
  const veto = recentCriticalNegative || macroSpecificVeto || (macroRisk && isRiskAsset(symbol));
  const reasons = recent.slice(0, 3).map((article) => `${article.source}: ${article.title}`);

  return {
    symbol,
    direction,
    confidence,
    score: round(weightedScore, 3),
    severity,
    veto,
    reasons,
    articleCount: recent.length,
    contradictory
  };
}

export function isRiskAsset(symbol: string): boolean {
  return symbol.endsWith('-USD') || ['SPY', 'QQQ', 'NVDA'].includes(symbol);
}
