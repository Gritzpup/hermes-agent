import type { AiCouncilDecision, AiProviderDecision } from '@hermes/contracts';

export const councilSources = ['api', 'cli', 'rules'] as const;
export type CouncilSource = (typeof councilSources)[number];
export type CouncilVote = AiProviderDecision;

export interface CouncilSourceCounts {
  api: number;
  cli: number;
  rules: number;
  totalVotes: number;
  totalDecisions: number;
}

export type CouncilSourceSummary = {
  label: string;
  tone: 'healthy' | 'warning' | 'critical';
  fallback: boolean;
  sources: CouncilVote['source'][];
};

type CouncilDecisionLike = Pick<AiCouncilDecision, 'status' | 'primary' | 'challenger' | 'panel'>;

export function getCouncilVotes(decision: CouncilDecisionLike): CouncilVote[] {
  if (decision.status !== 'verified') {
    return [];
  }

  return decision.panel?.length
    ? decision.panel
    : [decision.primary, decision.challenger].filter((vote): vote is CouncilVote => Boolean(vote));
}

export function getCouncilSourceCounts(decisions: Array<CouncilDecisionLike>): CouncilSourceCounts {
  const counts: CouncilSourceCounts = {
    api: 0,
    cli: 0,
    rules: 0,
    totalVotes: 0,
    totalDecisions: 0,
  };

  for (const decision of decisions) {
    if (decision.status !== 'complete') {
      continue;
    }

    counts.totalDecisions += 1;
    for (const vote of getCouncilVotes(decision)) {
      counts[vote.source] += 1;
      counts.totalVotes += 1;
    }
  }

  return counts;
}

export function formatCouncilVoteLabel(vote: CouncilVote): string {
  if (vote.source === 'rules') return 'rules';
  return `${vote.provider}/${vote.source}`;
}

export function formatCouncilSource(source: CouncilSource): string {
  if (source === 'api') return 'API';
  if (source === 'cli') return 'CLI';
  return 'Rules';
}

export function getCouncilSourceSummary(decision: CouncilDecisionLike): CouncilSourceSummary {
  if (decision.status === 'queued') {
    return { label: 'Queued', tone: 'warning', fallback: false, sources: [] };
  }

  if (decision.status === 'evaluating') {
    return { label: 'Evaluating', tone: 'warning', fallback: false, sources: [] };
  }

  if (decision.status === 'error') {
    return { label: 'Error', tone: 'critical', fallback: false, sources: [] };
  }

  const sources = [...new Set(getCouncilVotes(decision).map((vote) => vote.source))];

  if (sources.length === 0) {
    return { label: 'No votes', tone: 'warning', fallback: false, sources };
  }

  if (sources.every((source) => source === 'cli')) {
    return { label: 'CLI only', tone: 'healthy', fallback: false, sources };
  }

  const transportSources = sources.filter((source) => source === 'cli');
  const fallbackSources = sources.filter((source) => source === 'api' || source === 'rules');

  if (fallbackSources.length === 0 && transportSources.length > 0) {
    return {
      label: transportSources.map(formatCouncilSource).join(' + '),
      tone: 'healthy',
      fallback: false,
      sources,
    };
  }

  const label = `Fallback: ${fallbackSources.map(formatCouncilSource).join(' + ')}`;
  const tone = fallbackSources.includes('rules') ? 'critical' : 'warning';

  return { label, tone, fallback: true, sources };
}
