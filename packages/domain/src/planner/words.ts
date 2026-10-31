import type { Lane, ProfileSignal, RiskLevel, StepClass, TaskProfile, TaskSize, TaskType } from './types.js';
import type { PlannerModule } from './config.js';

/**
 * The factory's choices in a person's words (#53 §10). Built here so the
 * daemon says them and the renderer only shows them: no raw enum reaches the
 * screen.
 */
const TYPE_WORDS: Readonly<Record<TaskType, string>> = {
  fix: 'Fix', feature: 'Feature', refactor: 'Refactor', chore: 'Chore', docs: 'Docs', deps: 'Dependencies',
  test: 'Tests', security: 'Security', unknown: 'Unclear kind of work',
};
const SIZE_WORDS: Readonly<Record<TaskSize, string>> = { xs: 'tiny', s: 'small', m: 'medium', l: 'large' };
const RISK_WORDS: Readonly<Record<RiskLevel, string>> = { low: 'low risk', medium: 'medium risk', high: 'high risk' };

export function profileChips(profile: Pick<TaskProfile, 'type' | 'size' | 'risk'>): readonly [string, string, string] {
  return [TYPE_WORDS[profile.type], SIZE_WORDS[profile.size], RISK_WORDS[profile.risk]];
}

/** "Fix · tiny · low risk". */
export function profileLine(profile: Pick<TaskProfile, 'type' | 'size' | 'risk'>): string {
  return profileChips(profile).join(' · ');
}

export function laneLine(lane: Lane, steps: number, escalated = false): string {
  if (escalated) {
    return `${lane === 'careful' ? 'Careful' : 'Standard'} lane now: the change turned out riskier than planned, so ${steps - 1} ${steps - 1 === 1 ? 'step runs' : 'steps run'} before a pull request${lane === 'careful' ? ' that always asks for review' : ''}.`;
  }
  switch (lane) {
    case 'quick': return steps <= 2 ? 'Quick lane: one step, then a pull request.' : `Quick lane: ${steps - 1} steps, then a pull request.`;
    case 'standard': return `Standard lane: ${steps - 1} ${steps - 1 === 1 ? 'step' : 'steps'}, then a pull request.`;
    case 'careful': return `Careful lane: ${steps - 1} ${steps - 1 === 1 ? 'step' : 'steps'}, a plan you approve, then a pull request that always asks for review.`;
  }
}

/** A signal as a sentence: "Tracker type Bug → fix". */
export function signalSentence(signal: ProfileSignal): string {
  const name = signal.name.charAt(0).toUpperCase() + signal.name.slice(1);
  if (signal.effect.startsWith('disagrees:')) return `${name} ${signal.value} disagreed (${signal.effect.slice('disagrees:'.length).trim()})`;
  return `${name} ${signal.value} → ${signal.effect}`;
}

const CLASS_WORDS: Readonly<Record<StepClass, string>> = {
  implement: 'Implement', review: 'Review', verify: 'Verify', spec: 'Specify', design: 'Design',
  architecture: 'Plan the approach', investigate: 'Investigate', resolve_conflicts: 'Resolve conflicts', ship: 'Ship',
};

/** A step class in a person's words: "Implement", "Plan the approach". */
export function stepClassWords(cls: StepClass): string {
  return CLASS_WORDS[cls];
}

/**
 * Why routing chose a model, without the machine prefix: "passed 23 of 25
 * similar implement steps first time", "the starting model: only 3 similar
 * implement steps measured". A probe or a person's pin reads as it is.
 */
export function routeReasonWords(reason: string): string {
  const routed = /^routed: \S+ (.*)$/.exec(reason);
  if (routed !== null) return routed[1]!;
  const fallback = /^default: (.*)$/.exec(reason);
  if (fallback !== null) return `the starting model, since ${fallback[1]!}`;
  if (reason === 'step override') return 'set on the step';
  return reason;
}

/**
 * "Implement · sonnet · passed 23 of 25 similar implement steps first time ·
 * if it fails, opus". A step whose key isn't its class (a module's "Security
 * review") goes by its title; a step with no routed model says "role model".
 */
export function stepLine(
  step: { readonly key: string; readonly stepClass: StepClass; readonly model: string | null; readonly reason?: string; readonly escalate?: readonly string[] },
  title?: string,
): string {
  const name = step.key === step.stepClass || title === undefined ? CLASS_WORDS[step.stepClass] : title;
  if (step.model === null) return `${name} · role model`;
  const parts = [name, step.model];
  if (step.reason !== undefined && step.reason !== '' && step.reason !== 'role model') parts.push(routeReasonWords(step.reason));
  const next = step.escalate?.[0];
  if (next !== undefined) parts.push(`if it fails, ${next}`);
  return parts.join(' · ');
}

const LANE_WORDS: Readonly<Record<Lane, string>> = { quick: 'Quick lane', standard: 'Standard lane', careful: 'Careful lane' };
const SENSITIVITY_WORDS: Readonly<Record<string, string>> = { none: 'not sensitive', sensitive: 'sensitive areas', critical: 'critical areas' };

/** A routing bucket (`class|lane|sensitivity`) in words: "Quick lane · not sensitive". */
export function bucketWords(bucket: string): string {
  const [, lane, sensitivity] = bucket.split('|');
  const l = LANE_WORDS[lane as Lane] ?? 'Any lane';
  return `${l} · ${SENSITIVITY_WORDS[sensitivity ?? 'none'] ?? 'not sensitive'}`;
}

/** Why the lane, in words. `because` is a person's choice, the default, or the rule that matched. */
export function laneBecauseSentence(because: string): string {
  if (because === 'you chose it') return 'You chose it.';
  if (because === 'you made it quick') return 'You made it quick.';
  if (because === 'the default' || because === 'no lane rule matched') return 'No lane rule matched it, so it took the default lane.';
  return "The project's lane rules matched it.";
}

const TIEBREAK_WORDS: Readonly<Record<string, string>> = {
  type_unknown: 'from the tracker whether this is a fix or a feature',
  rules_disagree: 'which of its signals to believe',
  no_paths_many_repos: 'which repository it is about',
};

/** "Couldn't tell from the tracker whether this is a fix or a feature; asked haiku (0.2¢): fix." */
export function tiebreakSentence(t: {
  readonly reason: string; readonly model: string | null; readonly costUsd: number | null;
  readonly answer: { readonly type: string } | null; readonly error: string | null;
}): string {
  const what = TIEBREAK_WORDS[t.reason] ?? TIEBREAK_WORDS.type_unknown!;
  const who = t.model ?? 'a quick model';
  // A cost nobody reported is said so, never shown as free.
  const cost = t.costUsd === null ? ' (cost not reported)' : ` (${formatCents(t.costUsd)})`;
  if (t.answer === null) return `Couldn't tell ${what}; asked ${who}${cost}, got no usable answer, so it plans with careful defaults.`;
  return `Couldn't tell ${what}; asked ${who}${cost}: ${TYPE_WORDS[t.answer.type as TaskType]?.toLowerCase() ?? t.answer.type}.`;
}

/** "0.2¢", or "$1.20" from a dollar up. */
export function formatCents(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const cents = usd * 100;
  return `${cents < 10 ? cents.toFixed(1).replace(/\.0$/, '') : Math.round(cents).toString()}¢`;
}

/** What a module adds, as the start of a sentence: "Added a security review". */
function moduleAddition(add: PlannerModule['add']): string {
  if (add.step !== undefined) {
    const title = (add.step.title ?? add.step.key.replace(/_/g, ' ')).toLowerCase();
    return `Added ${/^[aeiou]/.test(title) ? 'an' : 'a'} ${title}`;
  }
  if (add.approval !== undefined) return `Added a look from you ${add.approval.when} the ${add.approval.step} step`;
  if (add.gateClause !== undefined) return `Made the ${add.gateClause.step} step check more before it finishes`;
  if (add.skills !== undefined) return `Gave the ${add.skills.step} step the ${add.skills.skills.join(', ')} ${add.skills.skills.length === 1 ? 'skill' : 'skills'}`;
  if (add.maxAttempts !== undefined) return `Allowed the ${add.maxAttempts.step} step up to ${add.maxAttempts.atLeast} attempts`;
  return 'Applied a rule';
}

/**
 * "Added a security review because it touches auth." The areas named in the
 * module's rule that the task's profile has; otherwise the rule's name.
 */
export function moduleSentence(module: Pick<PlannerModule, 'name' | 'when' | 'add'> | undefined, name: string, profile: Pick<TaskProfile, 'areas'>): string {
  if (module === undefined) return `Applied the ${name} rule.`;
  const named = [...module.when.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const touched = profile.areas.map((a) => a.name).filter((a) => named.includes(a));
  const why = touched.length > 0 ? `because it touches ${touched.join(' and ')}` : `because the ${module.name} rule matched`;
  return `${moduleAddition(module.add)} ${why}.`;
}
