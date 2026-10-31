import type { CredentialOriginPort, IntakeRunner, IntakeSourceConfig, TrackerConfig } from '@tandemise/domain';
import type { WorkspaceId } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';

/**
 * A credential is bound to the address it was saved for (Ruling 23, review
 * fix on PR #73). A project linked to a brain reads `tracker.url` and each
 * source's `api` from the brain's files (Ruling 21), which a teammate, or a
 * compromised brain, can change. Before a locally saved token is sent, the
 * configured origin is compared with the one recorded when it was saved; a
 * different one is refused in plain words until this machine's person
 * confirms it in Settings → Intake.
 */

/** The `intake_credential_origins` key of a project's tracker credential. */
export const TRACKER_CREDENTIAL = 'tracker';

/** The `intake_credential_origins` key of one source's secrets. */
export function sourceCredential(sourceId: string): string {
  return `source:${sourceId}`;
}

/** Scheme, host and port of an address; the address itself when it is not a URL with an origin. */
export function originOf(address: string): string {
  try {
    const origin = new URL(address).origin;
    return origin === 'null' ? address.trim() : origin;
  } catch {
    return address.trim();
  }
}

/**
 * Where the tracker's credential goes: YouTrack's URL. A tracker with no URL
 * (GitHub Issues signs in through `gh`) is named by its kind, so a kind
 * change still counts as a move.
 */
export function trackerOrigin(config: TrackerConfig): string {
  return config.url === undefined ? config.kind : originOf(config.url);
}

/** Where a source's secrets go: its `api`, else its runner's default base, else its kind. */
export function sourceOrigin(source: IntakeSourceConfig, runners: readonly IntakeRunner[]): string {
  const base = source.api ?? runners.find((r) => r.kind === source.kind)?.defaultApi;
  return base === undefined ? source.kind : originOf(base);
}

export function trackerMovedSentence(origin: string): string {
  return `This project's tracker now points at ${origin}. Confirm the new address in Settings → Intake before Tandemise sends your token there.`;
}

export function sourceMovedSentence(origin: string): string {
  return `This source now points at ${origin}. Confirm the new address in Settings → Intake before Tandemise sends your token there.`;
}

/** The configured address and the one the credential was saved for, when they differ. */
export interface OriginMismatch {
  readonly current: string;
  readonly saved: string;
}

/** The mismatch, or null when the credential may go where it is configured to. Reads only. */
export function mismatchOf(store: CredentialOriginPort, workspaceId: WorkspaceId, credential: string, current: string): OriginMismatch | null {
  const saved = store.get(workspaceId, credential);
  return saved === undefined || saved === current ? null : { current, saved };
}

/**
 * Asserts the credential may be sent to `current`, just before it is used.
 * A credential saved before Ruling 23 has no recorded origin and adopts
 * `current` here, on its first use.
 */
export function assertOrigin(store: CredentialOriginPort, workspaceId: WorkspaceId, credential: string, current: string, sentence: (origin: string) => string): void {
  const saved = store.get(workspaceId, credential);
  if (saved === undefined) {
    store.set(workspaceId, credential, current);
    return;
  }
  if (saved !== current) {
    throw new TandemiseError('PRECONDITION_FAILED', sentence(current), { details: { originChanged: true, current, saved } });
  }
}

/** Whether an error is a refusal to send a credential to a moved address. */
export function isOriginChanged(e: unknown): e is TandemiseError {
  return e instanceof TandemiseError && e.details['originChanged'] === true;
}
