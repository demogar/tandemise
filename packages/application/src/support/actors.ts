import type { ArtifactManifest, MemberRepositoryPort } from '@tandemise/domain';
import { RUNTIME_ACTOR, SYSTEM_ACTOR } from '@tandemise/domain';
import type { ActorRef, ArtifactView } from '@tandemise/api-contract';
import { asId } from '@tandemise/shared';

export interface ActorDeps {
  readonly members: Pick<MemberRepositoryPort, 'get'>;
}

/**
 * Names whoever an actor column holds: a member, or one of the system actors.
 *
 * An id that no longer resolves - a member row lost to a restore, say - is
 * still shown rather than dropped, because "someone we cannot name did this"
 * is more honest on a decision record than a blank.
 */
export function actorRef(deps: ActorDeps, id: string | null | undefined): ActorRef | null {
  if (id === null || id === undefined) return null;
  if (id === SYSTEM_ACTOR) return { id, name: 'Tandemise', kind: 'system' };
  if (id === RUNTIME_ACTOR) return { id, name: 'Runtime', kind: 'system' };
  const member = deps.members.get(asId<'MemberId'>(id));
  if (member === undefined) return { id, name: id, kind: 'person' };
  return { id, name: member.name, kind: member.kind };
}

/** Like `actorRef`, for lists, dropping nothing but the empty. */
export function actorRefs(deps: ActorDeps, ids: readonly string[] | undefined): readonly ActorRef[] {
  return (ids ?? []).map((id) => actorRef(deps, id)).filter((r): r is ActorRef => r !== null);
}

export function toArtifactView(deps: ActorDeps, manifest: ArtifactManifest): ArtifactView {
  return {
    ...manifest,
    author: actorRef(deps, manifest.authorId),
    responsible: actorRef(deps, manifest.responsibleId),
    recordedByRef: actorRef(deps, manifest.recordedBy),
  };
}
