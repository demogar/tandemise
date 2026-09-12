import type { Capability, MissionTask, RuntimeCapability } from '@tandemise/domain';

/**
 * Translates the permission vocabulary into the runtime vocabulary.
 *
 * These are two different alphabets on purpose (see `domain/capability.ts`):
 * `shell.exec` is something a worker may be *permitted* to do, `shell` is
 * something a runtime is *able* to do. Routing reads the second, so a task's
 * requirements have to be projected onto it before `RuntimeManager.select` can
 * use them - and the projection has to be conservative, because asking for a
 * capability no runtime offers blocks the task, while forgetting one hands the
 * work to a runtime that cannot do it.
 */
const PREFIX_MAP: ReadonlyArray<readonly [string, RuntimeCapability]> = [
  ['filesystem', 'filesystem'],
  ['repository.read', 'filesystem'],
  ['artifact.write', 'filesystem'],
  ['shell', 'shell'],
  ['tests', 'shell'],
  ['git', 'git'],
  ['browser', 'browser'],
  ['web', 'web'],
  ['desktop', 'computer_use'],
  ['mcp', 'mcp'],
  ['github', 'mcp'],
];

export function runtimeCapabilityFor(capability: Capability): RuntimeCapability | undefined {
  for (const [prefix, runtime] of PREFIX_MAP) {
    if (capability === prefix || capability.startsWith(`${prefix}.`)) return runtime;
  }
  return undefined;
}

/**
 * Every runtime capability a task needs. `reasoning` is always required: a
 * worker that cannot reason cannot do organizational work, whatever else it
 * offers.
 */
export function runtimeCapabilitiesFor(task: MissionTask): readonly RuntimeCapability[] {
  const out = new Set<RuntimeCapability>(['reasoning']);
  for (const capability of [...task.requiredCapabilities, ...task.executionPolicy.capabilities]) {
    const mapped = runtimeCapabilityFor(capability);
    if (mapped !== undefined) out.add(mapped);
  }
  return [...out];
}

/**
 * Capabilities a plan may require, given the runtimes and target kinds this
 * installation actually has. `validateMissionPlan` rejects a plan that asks for
 * anything outside this set, so a mission fails at planning time rather than
 * three tasks in (MVP.md §9.3).
 */
export function satisfiableCapabilities(
  offered: readonly RuntimeCapability[],
  known: readonly Capability[],
): ReadonlySet<Capability> {
  const available = new Set(offered);
  return new Set(known.filter((c) => {
    const needed = runtimeCapabilityFor(c);
    return needed === undefined || available.has(needed);
  }));
}
