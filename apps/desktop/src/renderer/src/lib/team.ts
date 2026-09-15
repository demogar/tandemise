import { useMemo } from 'react';
import type { ActorRef, MemberView } from '@tandemise/api-contract';
import { useMyMemberId, useTeam } from './queries.js';

/** Mirrors `SYSTEM_ACTOR` / `RUNTIME_ACTOR` in the domain; the renderer cannot value-import it. */
const SYSTEM_NAMES: Readonly<Record<string, string>> = { system: 'Tandemise', 'system:runtime': 'Runtime' };

export interface Actors {
  readonly meId: string | null;
  readonly members: readonly MemberView[];
  readonly byId: ReadonlyMap<string, MemberView>;
  /** Active people, me first: who a decision can be recorded for. */
  readonly people: readonly MemberView[];
  readonly agents: readonly MemberView[];
  /** One active person: team-only controls stay out of the way. */
  readonly solo: boolean;
  readonly ref: (id: string | null | undefined) => ActorRef | null;
  /** "You" for the principal, the member's name otherwise. */
  readonly name: (id: string | null | undefined) => string;
}

/**
 * Names for whoever an id points at, from the team the app already has.
 *
 * Views carry `ActorRef`s where the daemon joins them; the artifact reader and
 * the timeline get bare ids, and this is how they say "Ana" instead.
 */
export function useActors(): Actors {
  const team = useTeam();
  const meId = useMyMemberId();
  return useMemo(() => {
    const members = team.data?.members ?? [];
    const byId = new Map(members.map((m) => [m.id as string, m]));
    const people = members
      .filter((m) => m.kind === 'person' && m.active)
      .sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : a.name.localeCompare(b.name)));
    const agents = members.filter((m) => m.kind === 'agent' && m.active);
    const ref = (id: string | null | undefined): ActorRef | null => {
      if (id === null || id === undefined || id === '') return null;
      const system = SYSTEM_NAMES[id];
      if (system !== undefined) return { id, name: system, kind: 'system' };
      const member = byId.get(id);
      return member ? { id, name: member.name, kind: member.kind } : { id, name: 'Someone', kind: 'person' };
    };
    const name = (id: string | null | undefined): string => (id !== null && id !== undefined && id === meId ? 'You' : ref(id)?.name ?? '—');
    return { meId, members, byId, people, agents, solo: people.length <= 1, ref, name };
  }, [team.data, meId]);
}

/**
 * Who a request is for, in one line.
 *
 * You are never folded into "and 1 more": whether a request reached you is the
 * one thing the line must say. You are found by member id - a teammate whose
 * name happens to be "You" is not you - and come first, and only the others
 * collapse: "you, Ana and Maria", "you and 3 others".
 */
export function actorsLine(refs: readonly ActorRef[], meId: string | null, { you = 'you', max = 2 }: { you?: string; max?: number } = {}): string {
  const mine = meId !== null && refs.some((r) => r.id === meId);
  if (!mine) return namesLine(refs.map((r) => r.name), max);
  const others = refs.filter((r) => r.id !== meId).map((r) => r.name);
  if (others.length === 0) return you;
  if (others.length <= max) return `${[you, ...others.slice(0, -1)].join(', ')} and ${others[others.length - 1]}`;
  return `${you} and ${others.length} others`;
}

/** "You", or the actor's name. Kept separate so callers holding a ref need no lookup. */
export function actorLabel(actor: ActorRef | null | undefined, meId: string | null): string {
  if (!actor) return '—';
  return actor.id === meId ? 'You' : actor.name;
}

/** "Ana", "Ana and Bo", "Ana, Bo and 2 more" - a list of names that fits one line. */
export function namesLine(names: readonly string[], max = 2): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}
