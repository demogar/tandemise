import { CORE_CAPABILITIES } from '../capability.js';
import { evaluateGate, type GateFacts, type GatePredicates } from '../gate.js';
import type { MissionPlan, PlannedTask } from '../plan.js';
import { parseSkillRef, type SkillRef } from '../entities/skill.js';
import { DEFAULT_RETRY_POLICY } from '../entities/task.js';
import { defaultOutputs, type ModuleStep, type PlannerModule } from './config.js';

/**
 * Modules only add (#53 §5.2). A module may insert a step, add a gate clause
 * with `&&`, add an approval, add skills or raise attempts. It can never remove
 * a step, a clause, an approval or a skill: every edit below is a superset of
 * what it started with, and `gateImplies` holds for every step.
 */
export interface ModulesResult {
  readonly plan: MissionPlan;
  readonly applied: readonly string[];
  readonly dropped: readonly { readonly name: string; readonly why: string }[];
}

const READ_ONLY = [CORE_CAPABILITIES.repositoryRead, CORE_CAPABILITIES.filesystemRead, CORE_CAPABILITIES.artifactWrite];
const WRITE_CODE = [...READ_ONLY, CORE_CAPABILITIES.filesystemWrite, CORE_CAPABILITIES.shell, CORE_CAPABILITIES.git, CORE_CAPABILITIES.gitCommit, CORE_CAPABILITIES.testsRun];

/** A step a module inserts, built from its few fields with the class's defaults. */
export function moduleStepTask(step: ModuleStep, moduleName: string): PlannedTask {
  const cls = step.class ?? 'review';
  const writes = cls === 'implement' || cls === 'resolve_conflicts';
  const outputs = step.outputs ?? defaultOutputs(cls);
  const caps = writes ? WRITE_CODE : [...READ_ONLY, CORE_CAPABILITIES.shell];
  const skillRefs = step.skills.map((s) => parseSkillRef(s)).filter((s): s is SkillRef => s !== null);
  return {
    key: step.key,
    title: step.title ?? step.key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    objective: step.objective ?? `Added by the ${moduleName} rule: ${cls === 'review'
      ? 'review the diff for the risks this rule exists for, and report blocking findings.'
      : 'do this step for the risks this rule exists for.'}`,
    roleId: step.role,
    executor: 'agent',
    stepClass: cls,
    dependsOn: [step.after],
    requiredCapabilities: writes ? WRITE_CODE : READ_ONLY,
    inputArtifacts: cls === 'review' || cls === 'verify' ? [{ type: 'ChangeSet', required: false }] : [],
    expectedOutputs: outputs,
    executionPolicy: { isolation: 'worktree', maxWallTimeMs: 1_800_000, capabilities: caps },
    approvalPolicy: { beforeStart: false, onCompletion: false },
    retryPolicy: DEFAULT_RETRY_POLICY,
    completionGate: step.gate ?? (outputs.length > 0 ? outputs.map((o) => `artifact.${o}.exists`).join(' && ') : null),
    ...(skillRefs.length > 0 ? { skillRefs } : {}),
  };
}

/** `(<gate>) && <clause>`, or the clause alone when there was no gate. Idempotent. */
export function addGateClause(gate: string | null, clause: string): string {
  if (gate === null || gate.trim() === '') return clause;
  if (gate === clause || gate.endsWith(` && ${clause}`)) return gate;
  return `(${gate}) && ${clause}`;
}

/**
 * True when `after` keeps everything `before` demanded: the same gate, or the
 * old gate wrapped and `&&`-extended (possibly several times).
 */
export function gateImplies(before: string | null, after: string | null): boolean {
  if (before === null || before.trim() === '') return true;
  if (after === null) return false;
  let current = after;
  for (;;) {
    if (current === before) return true;
    const m = /^\((.*)\) && .+$/s.exec(current);
    if (m === null) return false;
    // Peel one wrapper: `(<inner>) && <clause>`. Inner may itself contain ")" so
    // try every split where the parenthesised prefix balances.
    const inner = balancedPrefix(current);
    if (inner === null) return false;
    current = inner;
  }
}

function balancedPrefix(text: string): string | null {
  if (!text.startsWith('(')) return null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(i + 1).startsWith(' && ') ? text.slice(1, i) : null;
    }
  }
  return null;
}

function sameSkill(a: SkillRef, b: SkillRef): boolean {
  return a.name === b.name && a.version === b.version;
}

export function applyModules(plan: MissionPlan, modules: readonly PlannerModule[], facts: GateFacts, predicates: GatePredicates): ModulesResult {
  let tasks: PlannedTask[] = [...plan.tasks];
  const applied: string[] = [];
  const dropped: { name: string; why: string }[] = [];
  const find = (key: string): number => tasks.findIndex((t) => t.key === key);

  for (const module of modules) {
    if (!evaluateGate(module.when, facts, predicates).passed) continue;
    const add = module.add;
    const problems: string[] = [];
    const targets = [add.gateClause?.step, add.approval?.step, add.skills?.step, add.maxAttempts?.step, add.step?.after]
      .filter((k): k is string => k !== undefined);
    for (const key of targets) if (find(key) === -1 && key !== add.step?.key) problems.push(`this plan has no '${key}' step`);
    if (problems.length > 0) { dropped.push({ name: module.name, why: problems[0]! }); continue; }

    if (add.step !== undefined && find(add.step.key) === -1) {
      const step = moduleStepTask(add.step, module.name);
      const after = add.step.after;
      tasks = tasks.map((t) => (t.dependsOn.includes(after) ? { ...t, dependsOn: [...t.dependsOn, step.key] } : t));
      const at = find(after);
      tasks.splice(at + 1, 0, step);
    }
    const edit = (key: string, fn: (t: PlannedTask) => PlannedTask): void => {
      const i = find(key);
      if (i >= 0) tasks[i] = fn(tasks[i]!);
    };
    if (add.gateClause !== undefined) {
      const clause = add.gateClause.clause;
      edit(add.gateClause.step, (t) => ({ ...t, completionGate: addGateClause(t.completionGate, clause) }));
    }
    if (add.approval !== undefined) {
      const { when, reason } = add.approval;
      edit(add.approval.step, (t) => ({
        ...t,
        approvalPolicy: {
          beforeStart: t.approvalPolicy.beforeStart || when === 'before',
          onCompletion: t.approvalPolicy.onCompletion || when === 'after',
          reason: t.approvalPolicy.reason ?? reason,
        },
      }));
    }
    if (add.skills !== undefined) {
      const refs = add.skills.skills.map((s) => parseSkillRef(s)).filter((s): s is SkillRef => s !== null);
      edit(add.skills.step, (t) => ({ ...t, skillRefs: addSkillRefs(t.skillRefs ?? [], refs) }));
    }
    if (add.maxAttempts !== undefined) {
      const floor = add.maxAttempts.atLeast;
      edit(add.maxAttempts.step, (t) => ({ ...t, retryPolicy: { ...t.retryPolicy, maxAttempts: Math.max(t.retryPolicy.maxAttempts, floor) } }));
    }
    applied.push(module.name);
  }
  return { plan: { ...plan, tasks }, applied, dropped };
}

/** Skills only grow. */
export function addSkillRefs(current: readonly SkillRef[], more: readonly SkillRef[]): SkillRef[] {
  const out = [...current];
  for (const ref of more) if (!out.some((r) => sameSkill(r, ref) || r.name === ref.name)) out.push(ref);
  return out;
}
