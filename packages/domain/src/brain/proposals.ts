import type { PlannerConfig } from '../planner/config.js';
import type { RoutingConfig } from '../planner/routing.js';
import { wilsonLowerBound } from '../planner/routing.js';
import type { MergePolicy, MergePolicyOrError } from '../merge/policy.js';
import type { OutcomeEvent, OutcomeStats } from './outcomes.js';

/**
 * Proposals the factory drafts from outcomes (#53 §9.2): code, not a model,
 * and only ever tighter. Each is one edit to one factory file with its
 * evidence; it reaches the project as a pull request a person merges. Nothing
 * here loosens a rule, raises `autoMergeAtMost` or lowers a score's points:
 * loosening is a person's edit.
 */
export const PROPOSE_NEVER_AFTER_REVERTS = 2;
export const PROMOTION_MIN_MISSIONS = 3;

export interface Proposal {
  /** Stable for the same change, so a closed one isn't proposed again with the same evidence. */
  readonly id: string;
  readonly file: 'planner' | 'routing' | 'merge';
  readonly edit: { readonly path: string; readonly from: unknown; readonly to: unknown };
  readonly kind: 'tighten' | 'loosen';
  readonly evidence: { readonly outcomeIds: readonly string[]; readonly missions: readonly string[] };
  readonly title: string;
}

/** What happened to earlier proposals: a closed-unmerged one remembers how much evidence it had. */
export type ProposalHistory = Readonly<Record<string, { readonly state: 'open' | 'merged' | 'closed'; readonly evidence: number }>>;

const KEY_FOR_CLASS: Readonly<Record<string, string>> = { implement: 'implement', review: 'review', verify: 'verify' };

export function draftProposals(
  stats: OutcomeStats,
  events: readonly OutcomeEvent[],
  current: { readonly planner: PlannerConfig; readonly routing: RoutingConfig; readonly merge: MergePolicyOrError },
  prior: ProposalHistory,
): Proposal[] {
  const out: Proposal[] = [];
  const keep = (p: Proposal): void => {
    const before = prior[p.id];
    if (before === undefined) { out.push(p); return; }
    // Open or merged: nothing to do. Closed unmerged: only when the evidence has doubled.
    if (before.state === 'closed' && p.evidence.outcomeIds.length >= before.evidence * 2) out.push(p);
  };

  // Reverts in an area → never auto-merge it.
  if (!('error' in current.merge)) {
    const merge: MergePolicy = current.merge;
    for (const [area, a] of Object.entries(stats.areas)) {
      if (a.reverts90d < PROPOSE_NEVER_AFTER_REVERTS) continue;
      if (merge.never.some((r) => 'areas' in r && r.areas.includes(area))) continue;
      const ev = events.filter((o) => (o.kind === 'reverted' || o.kind === 'broke_main') && o.profile.areas.includes(area));
      keep({
        id: `never-area-${slug(area)}`, file: 'merge', kind: 'tighten',
        edit: { path: 'never', from: merge.never, to: [...merge.never, { areas: [area] }] },
        evidence: { outcomeIds: ev.map((o) => o.id), missions: [...new Set(ev.map((o) => o.mission))] },
        title: `chore: never auto-merge changes in ${area} after ${a.reverts90d} reverts`,
      });
    }
  }

  // People keep stepping in on a class of step in an area → a look after it, for good.
  const { minTasks, rate } = current.planner.holdApproval;
  for (const [key, history] of Object.entries(stats.steppedIn)) {
    const [cls, area] = key.split('|') as [string, string];
    const step = KEY_FOR_CLASS[cls];
    if (step === undefined) continue;
    const recent = history.slice(-minTasks);
    const stepped = recent.filter(Boolean).length;
    if (recent.length < minTasks || stepped / recent.length < rate) continue;
    const ev = events.filter((o) => (o.kind === 'held' || o.kind === 'changes_requested') && o.step?.class === cls && o.profile.areas.includes(area));
    const missions = [...new Set(ev.map((o) => o.mission))];
    if (missions.length < PROMOTION_MIN_MISSIONS) continue;
    const name = `look-after-${slug(area)}-${cls}`;
    if (current.planner.modules.some((m) => m.name === name)) continue;
    const module = { name, when: `profile.areas_any("${area}")`, add: { approval: { step, when: 'after', reason: `People kept stepping in on ${area} ${cls} steps.` } } };
    keep({
      id: name, file: 'planner', kind: 'tighten',
      edit: { path: 'modules', from: current.planner.modules, to: [...current.planner.modules, module] },
      evidence: { outcomeIds: ev.map((o) => o.id), missions },
      title: `chore: a person looks at ${area} ${cls} steps after people stepped in on ${stepped} of ${recent.length}`,
    });
  }

  // A rung that keeps failing comes off the ladder (never the class's default).
  for (const [cls, routing] of Object.entries(current.routing.classes)) {
    if (routing === undefined || routing.ladder.length < 2) continue;
    for (const model of routing.ladder) {
      if (model === routing.default) continue;
      let n = 0; let success = 0;
      for (const [bucket, byModel] of Object.entries(stats.buckets)) {
        if (!bucket.startsWith(`${cls}|`)) continue;
        const s = byModel[model];
        if (s !== undefined) { n += s.n; success += s.success; }
      }
      if (n < current.routing.minSamples || wilsonLowerBound(success, n) >= current.routing.target / 2) continue;
      const ev = events.filter((o) => o.kind === 'step_result' && o.step?.class === cls && o.step.model === model);
      keep({
        id: `ladder-${cls}-drop-${slug(model)}`, file: 'routing', kind: 'tighten',
        edit: { path: `classes.${cls}.ladder`, from: routing.ladder, to: routing.ladder.filter((m) => m !== model) },
        evidence: { outcomeIds: ev.map((o) => o.id), missions: [...new Set(ev.map((o) => o.mission))] },
        title: `chore: take ${model} off the ${cls} ladder after ${success} of ${n} first-time passes`,
      });
    }
  }
  return out;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Applies a proposal's edit to a raw factory file (dotted path, replacing the value). */
export function applyProposal(raw: Readonly<Record<string, unknown>>, edit: Proposal['edit']): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(raw) as Record<string, unknown>;
  const keys = edit.path.split('.');
  let at: Record<string, unknown> = out;
  for (const key of keys.slice(0, -1)) {
    at[key] = typeof at[key] === 'object' && at[key] !== null ? at[key] : {};
    at = at[key] as Record<string, unknown>;
  }
  at[keys.at(-1)!] = edit.to;
  return out;
}
