import {
  addGateClause, chooseRung, maxSensitivity, normalizeModelPolicy, stepClassFor,
  type Lane, type MissionPlan, type ModelPolicy, type OutcomeStats, type PlannerConfig, type RoutingConfig, type TaskProfile,
} from '@tandemise/domain';

/**
 * Model routing and plan-time approvals for a factory plan (#53 §6.2, §5.3),
 * from the outcome fold. Routing only chooses among the models the owner put
 * on a ladder; an approval is only ever added, for this task.
 */
export function routePlan(plan: MissionPlan, ctx: {
  readonly profile: TaskProfile;
  readonly lane: Lane;
  readonly routing: RoutingConfig;
  readonly stats: OutcomeStats;
  readonly holdApproval: PlannerConfig['holdApproval'];
}): MissionPlan {
  const sensitivity = maxSensitivity(ctx.profile.areas);
  const tasks = plan.tasks.map((task) => {
    if ((task.executor ?? 'agent') !== 'agent') return task;
    const cls = stepClassFor(task);
    let next = task;
    // A model someone wrote on the step stays theirs.
    if (task.modelPolicy?.model === undefined) {
      const bucket = `${cls}|${ctx.lane}|${sensitivity}`;
      const measured = Object.values(ctx.stats.buckets[bucket] ?? {}).reduce((n, s) => n + s.n, 0);
      const rung = chooseRung({ cls, bucket, risk: ctx.profile.risk, config: ctx.routing, stats: ctx.stats, taskOrdinal: measured + 1 });
      if (rung !== null) {
        const independentOf = ctx.routing.classes[cls]?.independentOf;
        const target = independentOf !== undefined && plan.tasks.some((t) => t.key === independentOf) ? independentOf : undefined;
        next = {
          ...next,
          modelPolicy: normalizeModelPolicy({ ...(task.modelPolicy ?? {}), model: rung.model, escalate: [...rung.escalate], reason: rung.reason, ...(target === undefined ? {} : { independentOf: target }) }),
          ...(target === undefined ? {} : { completionGate: addGateClause(next.completionGate, 'review.independent') }),
        };
      }
    }
    for (const area of ctx.profile.areas) {
      const recent = (ctx.stats.steppedIn[`${cls}|${area.name}`] ?? []).slice(-ctx.holdApproval.minTasks);
      const stepped = recent.filter(Boolean).length;
      if (recent.length >= ctx.holdApproval.minTasks && stepped / recent.length >= ctx.holdApproval.rate && !next.approvalPolicy.onCompletion) {
        next = {
          ...next,
          approvalPolicy: {
            ...next.approvalPolicy,
            onCompletion: true,
            reason: `People stepped in on ${stepped} of the last ${recent.length} ${area.name} ${cls} steps, so you'll look at this one before it moves on.`,
          },
        };
        break;
      }
    }
    return next;
  });
  return { ...plan, tasks };
}

/**
 * A reviewer sending work back is a failure of that rung (#53 §6.3): a routed
 * implement step's next run starts one rung up. A model a person pinned (no
 * `routed:` reason) is left alone.
 */
export function moveUpAfterChanges(policy: ModelPolicy): ModelPolicy {
  if (policy.reason === undefined || !policy.reason.startsWith('routed:')) return policy;
  const [next, ...rest] = policy.escalate ?? [];
  if (next === undefined) return policy;
  return { ...policy, model: next, escalate: rest, reason: 'moved up after changes were requested' };
}
