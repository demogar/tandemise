// Shared by the P2 scenarios: solo-workspace guards, agents on the scripted runtime, and cleanup.

/** Every C scenario runs for one person with agents: no control asks whose name a note goes on. */
export async function assertSolo(c, ev) {
  const people = (await c.team()).filter((m) => m.kind === 'person');
  ev.check('solo workspace: you are the only person', people.length === 1 && people[0].id === c.me, people.map((p) => p.name));
}

export function noRecordingFor(ev, where, text) {
  ev.check(`no "Recording for" on screen (${where})`, !/Recording for/.test(text));
}

/** An agent member on a runtime profile, reused by name across scenarios. */
export async function agent(c, name, roleIds, profileId) {
  const existing = (await c.team()).find((m) => m.name === name);
  if (existing) {
    await c.api.patch(`/v1/members/${existing.id}`, { roleIds, runtimeProfileIds: [profileId] }).catch(() => undefined);
    return existing.id;
  }
  return (await c.api.post(`/v1/workspaces/${c.env.workspaceId}/members`, { kind: 'agent', name, reportsTo: c.me, roleIds, runtimeProfileIds: [profileId] })).id;
}

/** Staffing for the roles a P2 workflow uses, back to "no agents, no reviews". */
export const resetStaffing = (c) => c.staff({
  product: { assignees: [], reviews: [] },
  design: { assignees: [], reviews: [] },
  development: { assignees: [], reviews: [] },
  review: { assignees: [], reviews: [] },
});

export async function waitTask(c, missionId, key, pred, label, timeoutMs = 90_000) {
  return c.until(async () => { const t = await c.task(missionId, key); return t && pred(t) && t; }, { label, timeoutMs, everyMs: 700 });
}

export async function cancel(c, missionId, id) {
  await c.api.post(`/v1/missions/${missionId}/cancel`, { reason: `acceptance: ${id} proven` }).catch(() => undefined);
}

/** The newest saved prompt that contains `needle`. */
export const lastPromptWith = (c, needle) => c.prompts().filter((p) => p.includes(needle)).pop() ?? '';
