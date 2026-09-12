import type { RunEventRecord, TandemiseEventBody } from '@tandemise/domain';
import { isSemanticEvent } from '@tandemise/domain';
import type { IconName } from '../components/Icon.js';
import { humanizeStatus, pluralize, titleCase, type Tone } from './format.js';

export interface TimelineItem {
  readonly key: string;
  readonly icon: IconName;
  readonly tone: Tone;
  /** The one-line status-report phrasing (MVP.md §23.3). */
  readonly title: string;
  readonly detail: string | null;
  readonly role: string | null;
  readonly at: string;
  readonly sequence: number;
  /** Set when the entry links somewhere - an artifact, an approval. */
  readonly link: { readonly kind: 'artifact' | 'approval'; readonly id: string } | null;
}

/**
 * Turns the raw event log into the semantic feed (MVP.md §23.3).
 *
 * Two things happen here that are easy to get wrong. First, `raw` and tool
 * chatter are dropped: the default surface must read like a status report, not
 * a terminal. Second, runs of `file.changed` events collapse into one line -
 * "Developer changed 8 files" is the sentence the spec asks for, and emitting
 * eight lines instead would bury every other event in the mission.
 */
export function buildTimeline(records: readonly RunEventRecord[], roleNames: ReadonlyMap<string, string>): readonly TimelineItem[] {
  const items: TimelineItem[] = [];
  let index = 0;

  while (index < records.length) {
    const record = records[index];
    if (!record) break;
    if (!isSemanticEvent(record.body)) {
      index += 1;
      continue;
    }

    if (record.body.type === 'file.changed') {
      let end = index;
      const paths: string[] = [];
      while (end < records.length) {
        const candidate = records[end];
        if (!candidate || candidate.body.type !== 'file.changed' || candidate.runId !== record.runId) break;
        paths.push(candidate.body.path);
        end += 1;
      }
      const last = records[end - 1] ?? record;
      items.push({
        key: `${record.id}-files`,
        icon: 'filePlus',
        tone: 'running',
        title: `${roleLabel(record.roleId, roleNames)} changed ${pluralize(paths.length, 'file')}`,
        detail: paths.slice(0, 6).join(', ') + (paths.length > 6 ? `, +${paths.length - 6} more` : ''),
        role: roleLabel(record.roleId, roleNames),
        at: last.createdAt,
        sequence: last.sequence,
        link: null,
      });
      index = end;
      continue;
    }

    items.push(describe(record, roleNames));
    index += 1;
  }

  return items;
}

function describe(record: RunEventRecord, roleNames: ReadonlyMap<string, string>): TimelineItem {
  const role = roleLabel(record.roleId, roleNames);
  const base = { key: record.id, role, at: record.createdAt, sequence: record.sequence } as const;
  const body = record.body;

  switch (body.type) {
    case 'message':
      return { ...base, icon: 'message', tone: 'pending', title: `${role} reported`, detail: body.text, link: null };
    case 'thinking_summary':
      return { ...base, icon: 'sparkle', tone: 'pending', title: `${role} is thinking`, detail: body.text, link: null };
    case 'tool.started':
      return {
        ...base,
        icon: 'wrench',
        tone: 'running',
        title: `${role} used ${titleCase(body.tool)}`,
        detail: body.inputSummary || null,
        link: null,
      };
    case 'tool.completed':
      return {
        ...base,
        icon: body.outcome === 'ok' ? 'check' : 'alertCircle',
        tone: body.outcome === 'ok' ? 'succeeded' : 'failed',
        title: `${titleCase(body.tool)} ${body.outcome === 'ok' ? 'finished' : 'failed'}`,
        detail: body.outputSummary ?? null,
        link: null,
      };
    case 'file.changed':
      return { ...base, icon: 'filePlus', tone: 'running', title: `${role} ${body.change === 'delete' ? 'deleted' : 'changed'} ${body.path}`, detail: null, link: null };
    case 'artifact.created':
      return {
        ...base,
        icon: 'file',
        tone: 'succeeded',
        title: `${role} produced an artifact`,
        detail: null,
        link: { kind: 'artifact', id: body.artifactId },
      };
    case 'approval.requested':
      return {
        ...base,
        icon: 'shield',
        tone: 'blocked',
        title: 'Waiting for your approval',
        detail: 'The mission is paused until you decide.',
        link: { kind: 'approval', id: body.approvalId },
      };
    case 'usage':
      return { ...base, icon: 'gauge', tone: 'pending', title: 'Usage reported', detail: usageDetail(body), link: null };
    case 'checkpoint':
      return { ...base, icon: 'target', tone: 'pending', title: body.label ?? 'Checkpoint saved', detail: null, link: null };
    case 'completed':
      return { ...base, icon: 'check', tone: 'succeeded', title: `${role} finished`, detail: body.summary ?? null, link: null };
    case 'failed':
      return { ...base, icon: 'alertCircle', tone: 'failed', title: `${role} failed`, detail: `${body.code}: ${body.message}`, link: null };
    case 'raw':
      return { ...base, icon: 'terminal', tone: 'pending', title: body.channel, detail: body.text, link: null };

    case 'mission.status':
      return {
        ...base,
        icon: 'flag',
        tone: 'running',
        title: `Mission moved to ${humanizeStatus(body.to)}`,
        detail: body.reason ?? null,
        link: null,
      };
    case 'task.status':
      return {
        ...base,
        icon: 'layers',
        tone: 'pending',
        title: `${role} task is now ${humanizeStatus(body.to)}`,
        detail: body.reason ?? null,
        link: null,
      };
    case 'run.started':
      return {
        ...base,
        icon: 'play',
        tone: 'running',
        title: `${role} started${body.attempt > 1 ? ` (attempt ${body.attempt})` : ''}`,
        detail: `${body.runtime} on ${body.target}`,
        link: null,
      };
    case 'run.finished':
      return {
        ...base,
        icon: body.status === 'SUCCEEDED' ? 'check' : 'stop',
        tone: body.status === 'SUCCEEDED' ? 'succeeded' : body.status === 'FAILED' ? 'failed' : 'pending',
        title: `${role} run ${body.status.toLowerCase()}`,
        detail: `Took ${Math.round(body.durationMs / 1000)}s`,
        link: null,
      };
    case 'check.result':
      return {
        ...base,
        icon: body.outcome === 'PASS' ? 'check' : body.outcome === 'FAIL' ? 'x' : 'info',
        tone: body.outcome === 'PASS' ? 'succeeded' : body.outcome === 'FAIL' ? 'failed' : 'pending',
        title: `${titleCase(body.name.replace(/^checks\./, ''))} ${body.outcome === 'PASS' ? 'passed' : body.outcome === 'FAIL' ? 'failed' : 'skipped'}`,
        detail: body.detail ?? null,
        link: null,
      };
    case 'gate.evaluated':
      return {
        ...base,
        icon: body.passed ? 'shield' : 'alert',
        tone: body.passed ? 'succeeded' : 'blocked',
        title: body.passed ? 'Quality gate passed' : 'Quality gate blocked the task',
        detail: body.detail ?? body.gate,
        link: null,
      };
    case 'approval.resolved':
      return {
        ...base,
        icon: body.status === 'APPROVED' ? 'check' : 'x',
        tone: body.status === 'APPROVED' ? 'succeeded' : 'failed',
        title: `Approval ${body.status.toLowerCase()}`,
        detail: body.option ? `You chose "${body.option}".` : null,
        link: { kind: 'approval', id: body.approvalId },
      };
    case 'policy.denied':
      return {
        ...base,
        icon: 'shield',
        tone: 'blocked',
        title: `Policy denied ${body.capability}`,
        detail: body.reason,
        link: null,
      };
    case 'note':
      return {
        ...base,
        icon: body.level === 'error' ? 'alertCircle' : body.level === 'warn' ? 'alert' : 'info',
        tone: body.level === 'error' ? 'failed' : body.level === 'warn' ? 'blocked' : 'pending',
        title: body.text,
        detail: null,
        link: null,
      };
  }
}

function usageDetail(body: Extract<TandemiseEventBody, { type: 'usage' }>): string {
  const parts: string[] = [];
  if (body.inputTokens !== undefined) parts.push(`${body.inputTokens.toLocaleString()} in`);
  if (body.outputTokens !== undefined) parts.push(`${body.outputTokens.toLocaleString()} out`);
  return parts.length > 0 ? `${parts.join(' / ')} tokens` : 'No token counts reported';
}

function roleLabel(roleId: string | null, roleNames: ReadonlyMap<string, string>): string {
  if (!roleId) return 'Tandemise';
  return roleNames.get(roleId) ?? titleCase(roleId);
}

/** The raw log view: every event, unedited, newest last (MVP.md §23.3). */
export function rawLines(records: readonly RunEventRecord[]): readonly { seq: number; text: string }[] {
  return records.map((record) => ({ seq: record.sequence, text: rawText(record.body) }));
}

function rawText(body: TandemiseEventBody): string {
  if (body.type === 'raw') return `[${body.channel}] ${body.text}`;
  const { type, ...rest } = body as { type: string } & Record<string, unknown>;
  return `${type} ${JSON.stringify(rest)}`;
}
