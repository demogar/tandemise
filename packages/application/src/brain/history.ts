import type { EntryBody, Mission, MissionTask, RunScore } from '@tandemise/domain';
import { ENTRY_MAX_CHARS } from '@tandemise/domain';

const OUTCOME: Readonly<Record<string, string>> = { COMPLETE: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' };

/**
 * A finished mission as one history line (#51 spec §5), written by code from
 * the mission record with no model. History is searchable with brain.search
 * but never loads into a prompt by default.
 */
export function historyEntry(
  mission: Pick<Mission, 'title' | 'status'>,
  tasks: readonly Pick<MissionTask, 'key' | 'round'>[],
  runScores: readonly Pick<RunScore, 'taskId' | 'attempt' | 'gatePassed'>[],
  extra: { readonly held?: readonly string[]; readonly prUrls?: readonly string[]; readonly tracker?: string | null; readonly taskKeys?: ReadonlyMap<string, string> } = {},
): EntryBody | null {
  const outcome = OUTCOME[mission.status];
  if (outcome === undefined) return null;
  const changesAsked = tasks.filter((t) => (t.round ?? 1) > 1).map((t) => t.key);
  const byTask = new Map<string, Pick<RunScore, 'attempt' | 'gatePassed'>[]>();
  for (const s of runScores) byTask.set(s.taskId, [...(byTask.get(s.taskId) ?? []), s]);
  const failedThenPassed: string[] = [];
  for (const [taskId, scores] of byTask) {
    const ordered = [...scores].sort((a, b) => a.attempt - b.attempt);
    const firstFail = ordered.findIndex((s) => !s.gatePassed);
    if (firstFail >= 0 && ordered.slice(firstFail + 1).some((s) => s.gatePassed)) failedThenPassed.push(extra.taskKeys?.get(taskId) ?? taskId);
  }
  const clauses = [
    `${mission.title} — ${outcome}.`,
    (extra.held ?? []).length > 0 ? `Held: ${(extra.held ?? []).join(', ')}.` : '',
    changesAsked.length > 0 ? `Changes asked: ${changesAsked.join(', ')}.` : '',
    failedThenPassed.length > 0 ? `Gates that failed then passed: ${failedThenPassed.sort().join(', ')}.` : '',
    (extra.prUrls ?? []).length > 0 ? `PRs: ${(extra.prUrls ?? []).join(', ')}.` : '',
  ].filter(Boolean);
  let text = clauses.join(' ');
  if (text.length > ENTRY_MAX_CHARS) text = `${text.slice(0, ENTRY_MAX_CHARS - 1)}…`;
  return {
    kind: 'history',
    text,
    scope: {},
    source: { signal: 'mission', mission: mission.title, ...(extra.tracker ? { tracker: extra.tracker } : {}) },
    state: 'active',
  };
}
