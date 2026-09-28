/**
 * Model routing (P12): which model a run is given, and why.
 *
 * A model is a plain string the person typed (a short alias, a full model id, a
 * vendor alias). Tandemise never ships a list of them: it passes the name
 * through verbatim and records it, so the only knowledge of what a name means
 * lives with the runtime that receives it.
 *
 * The whole precedence is `resolveModel`, one pure function. The executor
 * gathers its inputs and records its answer on the run; nothing else decides.
 */

/** The longest ladder a step or role may name. */
export const MAX_LADDER = 5;
/** The longest model name accepted. */
export const MAX_MODEL_NAME = 100;

/** What a workflow step says about models. Every field optional; null on a task means "nothing". */
export interface ModelPolicy {
  /** This step's model, over the role's and the profile's. */
  readonly model?: string;
  /** Attempt 2 uses the first, attempt 3 the second, later attempts the last. */
  readonly escalate?: readonly string[];
  /** Key of an upstream step whose run this step's run must differ from (fact `review.independent`). */
  readonly independentOf?: string;
  /** Set only by eval trials: the step's model beats economy mode so limit pressure can't mask a candidate. */
  readonly pinned?: boolean;
}

/** What a role says about models (Team → Roles). */
export interface RoleModels {
  readonly model: string | null;
  readonly escalate: readonly string[];
  /** Used for new runs once a limit on the mission or the month is past its warning level (P8). */
  readonly economyModel: string | null;
}

export const NO_ROLE_MODELS: RoleModels = { model: null, escalate: [], economyModel: null };

/** A limit at or past its warning level: the one the economy rule reads. */
export interface LimitPressure {
  readonly percent: number;
  readonly scope: 'mission' | 'month';
}

export interface ModelContext {
  readonly step: ModelPolicy | null;
  readonly role: RoleModels | null;
  /** The runtime profile's `model` setting. */
  readonly profileModel: string | null;
  /** The attempt the run belongs to; 1 is the first. */
  readonly attempt: number;
  readonly pressure: LimitPressure | null;
  /** False for a runtime that cannot be given a model at all. */
  readonly runtimeTakesModel: boolean;
}

export type ModelSource = 'runtime' | 'escalation' | 'pinned' | 'economy' | 'step' | 'role' | 'profile';

export interface ResolvedModel {
  /** Null: the runtime's own default (nothing is passed). */
  readonly model: string | null;
  /** What the person reads: "step override", "retry escalation (attempt 2)", "economy: 85% of limit". */
  readonly reason: string;
  readonly source: ModelSource;
}

export const RUNTIME_DEFAULT_REASON = 'runtime default';

function name(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

function ladder(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((v) => name(v)).filter((v): v is string => v !== null);
}

/**
 * The model for one run. First match wins:
 *
 *  R1 runtime cannot take a model → none, "runtime default"
 *  R2 attempt ≥ 2 and a ladder (the step's, else the role's) → its rung, "retry escalation (attempt N)"
 *  R2b a pinned step model (eval trials only) → it, "pinned step model (eval trial)"
 *  R3 a limit past its warning level and a role economy model → it, "economy: N% of limit"
 *  R4 step model → "step override"
 *  R5 role model → "role model"
 *  R6 profile model → "runtime profile default"
 *  R7 none → "runtime default"
 */
export function resolveModel(ctx: ModelContext): ResolvedModel {
  if (!ctx.runtimeTakesModel) return { model: null, reason: RUNTIME_DEFAULT_REASON, source: 'runtime' };

  if (ctx.attempt >= 2) {
    const stepLadder = ladder(ctx.step?.escalate);
    const rungs = stepLadder.length > 0 ? stepLadder : ladder(ctx.role?.escalate);
    if (rungs.length > 0) {
      const rung = rungs[Math.min(ctx.attempt - 2, rungs.length - 1)]!;
      return { model: rung, reason: `retry escalation (attempt ${ctx.attempt})`, source: 'escalation' };
    }
  }

  // An eval trial pins the candidate's model so a limit past its warning level
  // cannot quietly swap it for the economy model and score the wrong setup.
  const pinned = name(ctx.step?.model);
  if (ctx.step?.pinned === true && pinned !== null) {
    return { model: pinned, reason: 'pinned step model (eval trial)', source: 'pinned' };
  }

  const economy = name(ctx.role?.economyModel);
  if (ctx.pressure !== null && economy !== null) {
    const percent = Math.floor(ctx.pressure.percent);
    return {
      model: economy,
      reason: `economy: ${percent}% of ${ctx.pressure.scope === 'month' ? 'monthly limit' : 'limit'}`,
      source: 'economy',
    };
  }

  const step = name(ctx.step?.model);
  if (step !== null) return { model: step, reason: 'step override', source: 'step' };
  const role = name(ctx.role?.model);
  if (role !== null) return { model: role, reason: 'role model', source: 'role' };
  const profile = name(ctx.profileModel);
  if (profile !== null) return { model: profile, reason: 'runtime profile default', source: 'profile' };
  return { model: null, reason: RUNTIME_DEFAULT_REASON, source: 'runtime' };
}

/** One side of an independence comparison: which runtime ran it, on which model. */
export interface ModelIdentity {
  readonly adapterId: string;
  readonly model: string | null;
}

/**
 * Whether a reviewing run is independent of the run it reviews: a different
 * runtime, or the same runtime on two known, different models. A model left to
 * the runtime's default cannot be shown to differ from anything on that same
 * runtime, so it is not independent.
 */
export function modelsIndependent(reviewing: ModelIdentity, reviewed: ModelIdentity): boolean {
  if (reviewing.adapterId !== reviewed.adapterId) return true;
  if (reviewing.model === null || reviewed.model === null) return false;
  return reviewing.model !== reviewed.model;
}

/** "Model: strong-model · retry escalation (attempt 2)"; "Model: runtime default"; "Model: not recorded" before P12. */
export function modelLabel(run: { readonly model?: string | null; readonly modelReason?: string | null }): string {
  if (run.modelReason === null || run.modelReason === undefined) return 'Model: not recorded';
  if (run.model === null || run.model === undefined) return `Model: ${run.modelReason}`;
  return `Model: ${run.model} · ${run.modelReason}`;
}

/** Null when `value` is a usable model name; otherwise what is wrong with it. */
export function modelProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'A model name cannot be empty.';
  if (trimmed.length > MAX_MODEL_NAME) return `A model name is at most ${MAX_MODEL_NAME} characters.`;
  if (/\s/.test(trimmed)) return `"${trimmed}" has a space in it; a model name is passed to the runtime as one word.`;
  return null;
}

/** A step's policy with blanks dropped, or null when nothing is left. */
export function normalizeModelPolicy(policy: ModelPolicy | null | undefined): ModelPolicy | null {
  if (policy === null || policy === undefined) return null;
  const model = name(policy.model);
  const escalate = ladder(policy.escalate);
  const independentOf = name(policy.independentOf);
  const out: { model?: string; escalate?: string[]; independentOf?: string } = {};
  if (model !== null) out.model = model;
  if (escalate.length > 0) out.escalate = escalate;
  if (independentOf !== null) out.independentOf = independentOf;
  return Object.keys(out).length === 0 ? null : out;
}

/** A role's models with blanks dropped. */
export function normalizeRoleModels(models: Partial<RoleModels> | null | undefined): RoleModels {
  return {
    model: name(models?.model ?? null),
    escalate: ladder(models?.escalate),
    economyModel: name(models?.economyModel ?? null),
  };
}

/** Whether a role says anything about models. */
export function hasRoleModels(models: RoleModels | null | undefined): boolean {
  return models !== null && models !== undefined
    && (models.model !== null || models.escalate.length > 0 || models.economyModel !== null);
}

/** The step drawer's line about a step's own settings: "This step: model fast-model · retries use strong-model · must differ from implement". */
export function modelPolicyLabel(policy: ModelPolicy | null | undefined): string | null {
  const p = normalizeModelPolicy(policy);
  if (p === null) return null;
  const parts: string[] = [];
  if (p.model !== undefined) parts.push(`model ${p.model}`);
  if (p.escalate !== undefined) parts.push(`retries use ${p.escalate.join(', then ')}`);
  if (p.independentOf !== undefined) parts.push(`must differ from ${p.independentOf}`);
  return `This step: ${parts.join(' · ')}`;
}
