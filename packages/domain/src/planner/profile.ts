import { evaluateGate, type GateFacts, type GatePredicates, type GateValue } from '../gate.js';
import type { PlannerArea, PlannerConfig } from './config.js';
import { matchGlob } from './glob.js';
import {
  atLeast, CONSERVATIVE_PROFILE, maxSensitivity, RISK_LEVELS, TASK_SIZES,
  type ProfileArea, type ProfileInput, type ProfileSignal, type RiskLevel, type TaskProfile, type TaskSize, type TaskType,
} from './types.js';

/**
 * The task profile (#53 §2): a pure function of measured signals and the
 * project's rules. The daemon gathers the signals; this decides. Order is the
 * signals' weight; the sensitivity floor is applied last, so nothing (a rule,
 * the tiebreak, a person's Quick) can put risk under it.
 */
const PREFIX_TYPES: Readonly<Record<string, TaskType>> = {
  fix: 'fix', feat: 'feature', docs: 'docs', chore: 'chore', refactor: 'refactor', test: 'test', build: 'deps',
};

const SOURCE_TYPES: Readonly<Record<string, TaskType>> = {
  sentry: 'fix', posthog: 'fix', dependabot: 'deps', advisory: 'security',
};

/** History raises risk one level when this share of similar tasks were reverted. */
export const HISTORY_REVERT_RATE = 0.2;
/** …or when this share were held by a person. */
export const HISTORY_HOLD_RATE = 0.4;

export function titlePrefix(title: string): string | null {
  const m = /^\s*([a-z]+)(?:\([^)]*\))?!?:\s/i.exec(title);
  return m === null ? null : m[1]!.toLowerCase();
}

/** Areas the paths touch: first matching area per file; unmatched files have none. */
export function matchAreas(paths: readonly string[], areas: readonly PlannerArea[]): { area: PlannerArea; path: string }[] {
  const out: { area: PlannerArea; path: string }[] = [];
  for (const path of paths) {
    const area = areas.find((a) => a.paths.some((p) => matchGlob(p, path)));
    if (area !== undefined && !out.some((o) => o.area.name === area.name)) out.push({ area, path });
  }
  return out;
}

const lower = (xs: readonly string[]): string[] => xs.map((x) => x.toLowerCase());

/** The facts and predicates a planner rule reads, for one input and partial profile. */
export function planRuleContext(input: ProfileInput, profile: Partial<Pick<TaskProfile, 'type' | 'size' | 'risk' | 'areas' | 'repos'>>): {
  facts: GateFacts; predicates: GatePredicates;
} {
  const text = `${input.item.title}\n${input.item.description}`.toLowerCase();
  const strs = (args: readonly GateValue[]): string[] => args.filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase());
  const prefix = titlePrefix(input.item.title);
  const areas = profile.areas ?? [];
  const facts: Record<string, GateValue> = {
    'item.type': input.item.trackerType ?? undefined,
    'item.prefix': prefix ?? undefined,
    'item.criteria': input.item.criteria,
    'profile.type': profile.type,
    'profile.size': profile.size,
    'profile.risk': profile.risk,
    'profile.max_sensitivity': maxSensitivity(areas),
    'profile.repos': profile.repos?.length ?? input.repos.length,
  };
  const predicates: GatePredicates = {
    'item.keywords_any': (args) => strs(args).some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)),
    'item.labels_any': (args) => strs(args).some((l) => lower(input.item.labels).includes(l)),
    'item.source_any': (args) => strs(args).some((s) => lower(input.item.sources).includes(s)),
    'profile.areas_any': (args) => strs(args).some((n) => areas.some((a) => a.name.toLowerCase() === n)),
  };
  return { facts, predicates };
}

export function profileTask(input: ProfileInput, config: PlannerConfig): TaskProfile {
  const signals: ProfileSignal[] = [];
  let type: TaskType | undefined;
  let size: TaskSize | undefined;
  let sizeFrom: 'rule' | 'criteria' | undefined;
  let risk: RiskLevel = 'low';
  const areas: ProfileArea[] = [];
  const addArea = (a: ProfileArea): void => { if (!areas.some((x) => x.name === a.name)) areas.push(a); };

  const proposeType = (t: TaskType, name: string, value: string): void => {
    if (type === undefined) { type = t; signals.push({ name, value, effect: `type ${t}` }); }
    else if (type !== t) signals.push({ name, value, effect: `disagrees: type ${t}, kept ${type}` });
  };

  const prefix = titlePrefix(input.item.title);
  if (prefix !== null && PREFIX_TYPES[prefix] !== undefined) proposeType(PREFIX_TYPES[prefix]!, 'title prefix', `${prefix}:`);

  if (input.item.trackerType !== null) {
    const key = Object.keys(config.trackerTypes).find((k) => k.toLowerCase() === input.item.trackerType!.toLowerCase());
    if (key !== undefined) proposeType(config.trackerTypes[key]!, 'tracker type', input.item.trackerType);
  }
  for (const label of input.item.labels) {
    const key = Object.keys(config.labels).find((k) => k.toLowerCase() === label.toLowerCase());
    if (key !== undefined) proposeType(config.labels[key]!, 'label', label);
  }
  for (const source of input.item.sources) {
    const t = SOURCE_TYPES[source.toLowerCase()];
    if (t !== undefined) proposeType(t, 'source', source);
  }

  // Areas come before the rules so a rule may read profile.areas_any().
  for (const { area, path } of matchAreas(input.paths, config.areas)) {
    addArea({ name: area.name, sensitivity: area.sensitivity });
    signals.push({ name: 'path', value: path, effect: `area ${area.name}${area.sensitivity === 'none' ? ', not sensitive' : `, ${area.sensitivity}`}` });
  }

  const ruleSet = { type: false, size: false, risk: false };
  for (const rule of config.profile.rules) {
    const { facts, predicates } = planRuleContext(input, { type, size, risk, areas, repos: input.repos });
    if (!evaluateGate(rule.when, facts, predicates).passed) continue;
    if (rule.set.type !== undefined && !ruleSet.type) {
      ruleSet.type = true;
      proposeType(rule.set.type, 'rule', rule.when);
    }
    if (rule.set.size !== undefined && !ruleSet.size) {
      ruleSet.size = true;
      size = rule.set.size;
      sizeFrom = 'rule';
      signals.push({ name: 'rule', value: rule.when, effect: `size ${size}` });
    }
    if (rule.set.risk !== undefined && !ruleSet.risk) {
      ruleSet.risk = true;
      // A rule can say a task is riskier, never that it is safer than the base.
      risk = atLeast(RISK_LEVELS, risk, rule.set.risk);
      signals.push({ name: 'rule', value: rule.when, effect: `risk ${risk}` });
    }
  }

  if (size === undefined) {
    const n = input.item.criteria;
    size = n <= 1 ? 's' : n <= 4 ? 'm' : 'l';
    sizeFrom = 'criteria';
    signals.push({ name: 'Done-when lines', value: String(n), effect: `size ${size}` });
  }

  const repos = [...new Set(input.repos)];
  if (repos.length > 1 && atLeast(TASK_SIZES, size, 'm') !== size) {
    size = 'm';
    signals.push({ name: 'repositories', value: repos.join(', '), effect: 'size m' });
  }

  if (input.history !== null && input.history.n > 0) {
    const h = input.history;
    if (sizeFrom === 'criteria' && h.medianSize !== size) {
      const dist = Math.abs(TASK_SIZES.indexOf(h.medianSize) - TASK_SIZES.indexOf(size));
      if (dist > 1) signals.push({ name: 'history', value: `${h.n} similar tasks`, effect: `disagrees: size ${h.medianSize}, kept ${size}` });
      else { size = h.medianSize; signals.push({ name: 'history', value: `${h.n} similar tasks`, effect: `size ${size}` }); }
    }
    if (h.revertRate >= HISTORY_REVERT_RATE || h.holdRate >= HISTORY_HOLD_RATE) {
      risk = RISK_LEVELS[Math.min(RISK_LEVELS.indexOf(risk) + 1, RISK_LEVELS.length - 1)]!;
      signals.push({ name: 'history', value: `${Math.round(h.revertRate * 100)}% reverted, ${Math.round(h.holdRate * 100)}% held`, effect: `risk ${risk}` });
    }
  }

  let source: TaskProfile['source'] = 'rules';
  if (input.tiebreak !== null) {
    const t = input.tiebreak;
    source = 'rules+model';
    if (type === undefined || type === 'unknown') proposeType(t.type, 'tiebreak', t.why);
    for (const n of t.areas) {
      const a = config.areas.find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (a !== undefined && !areas.some((x) => x.name === a.name)) {
        addArea({ name: a.name, sensitivity: a.sensitivity });
        signals.push({ name: 'tiebreak', value: t.why, effect: `area ${a.name}` });
      }
    }
  } else if (input.tiebreakFailed !== undefined && input.tiebreakFailed !== null) {
    size = atLeast(TASK_SIZES, size, CONSERVATIVE_PROFILE.size);
    risk = atLeast(RISK_LEVELS, risk, CONSERVATIVE_PROFILE.risk);
    signals.push({ name: 'tiebreak', value: input.tiebreakFailed, effect: `conservative default: size at least ${CONSERVATIVE_PROFILE.size}, risk at least ${CONSERVATIVE_PROFILE.risk}` });
  }

  if (input.person !== 'auto') {
    source = 'person';
    signals.push({ name: 'your choice', value: input.person, effect: `lane ${input.person}` });
  }

  // The sensitivity floor, last: nothing above may lower risk below it.
  const top = maxSensitivity(areas);
  const floor: RiskLevel = top === 'critical' ? 'high' : top === 'sensitive' ? 'medium' : 'low';
  if (atLeast(RISK_LEVELS, risk, floor) !== risk) {
    risk = floor;
    const which = areas.filter((a) => a.sensitivity === top).map((a) => `${a.name}: ${a.sensitivity}`).join(', ');
    signals.push({ name: 'sensitivity floor', value: which, effect: `risk ${risk}` });
  }

  return {
    type: type ?? 'unknown',
    size,
    risk,
    areas,
    repos,
    signals,
    source,
    basis: input.basis,
  };
}

/**
 * Why the cheap classifier should run, or null when the rules were enough
 * (#53 §2): type still unknown; two signals disagree; or no paths in a
 * project with more than one repository.
 */
export function tiebreakReason(input: ProfileInput, profile: TaskProfile): 'type_unknown' | 'rules_disagree' | 'no_paths_many_repos' | null {
  if (profile.type === 'unknown') return 'type_unknown';
  if (profile.signals.some((s) => s.effect.startsWith('disagrees:'))) return 'rules_disagree';
  if (input.paths.length === 0 && input.projectRepos > 1) return 'no_paths_many_repos';
  return null;
}
