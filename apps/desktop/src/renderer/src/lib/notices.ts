import { useSyncExternalStore } from 'react';
import type { DownstreamImpactView } from '@tandemise/api-contract';

/**
 * One-off messages that must survive a navigation: a mission was created but a
 * follow-up request failed, and the place to say so is the mission itself -
 * staying on the form would invite creating it a second time.
 */
const notices = new Map<string, unknown>();
const listeners = new Set<() => void>();

export function setMissionNotice(missionId: string, error: unknown): void {
  notices.set(missionId, error);
  for (const listener of listeners) listener();
}

export function clearMissionNotice(missionId: string): void {
  notices.delete(missionId);
  for (const listener of listeners) listener();
}

export function useMissionNotice(missionId: string): unknown {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notices.get(missionId),
  );
}

/**
 * One line saying what an action just did, when its result is not where the
 * person is looking: "Round 2 started" after the composer closes, even though
 * the card that sent it moved to another section and remounted.
 */
let flashText: string | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
const flashListeners = new Set<() => void>();

/** How long a flash stays: long enough to read one line, short enough not to become furniture. */
const FLASH_MS = 5000;

export function showFlash(text: string): void {
  flashText = text;
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashText = null;
    for (const listener of flashListeners) listener();
  }, FLASH_MS);
  for (const listener of flashListeners) listener();
}

export function useFlash(): string | null {
  return useSyncExternalStore(
    (listener) => {
      flashListeners.add(listener);
      return () => flashListeners.delete(listener);
    },
    () => flashText,
  );
}

/**
 * The "redo or keep" question, held above any screen. The control that asked
 * for it is usually gone by the time it opens: a decided card leaves "Needs
 * you", an Inbox row disappears, and state kept in either would vanish with it.
 */
export interface ImpactRequest {
  readonly impact: DownstreamImpactView;
  readonly missionId: string;
  readonly recordFor: string | null;
}

let impactRequest: ImpactRequest | null = null;
const impactListeners = new Set<() => void>();

export function openImpact(request: ImpactRequest | null): void {
  impactRequest = request;
  for (const listener of impactListeners) listener();
}

export function useImpactRequest(): ImpactRequest | null {
  return useSyncExternalStore(
    (listener) => {
      impactListeners.add(listener);
      return () => impactListeners.delete(listener);
    },
    () => impactRequest,
  );
}

/**
 * The Request changes composer, held above any screen, and the notes being
 * written in it. A feed card moves between sections as its task runs and
 * finishes, and each section remounts its cards; a composer kept in the card
 * would lose a half-written note the moment the task it is about moved on.
 */
export interface ComposerRequest {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly missionId: string;
  readonly outputs: readonly { readonly id: string; readonly label: string }[];
  readonly about?: string;
}

let composerRequest: ComposerRequest | null = null;
const composerListeners = new Set<() => void>();
/** Unsent text per task: closing the composer by accident and opening it again gives the note back. */
const drafts = new Map<string, string>();

export function openComposer(request: ComposerRequest | null): void {
  composerRequest = request;
  for (const listener of composerListeners) listener();
}

export function useComposerRequest(): ComposerRequest | null {
  return useSyncExternalStore(
    (listener) => {
      composerListeners.add(listener);
      return () => composerListeners.delete(listener);
    },
    () => composerRequest,
  );
}

export function draftFor(taskId: string): string {
  return drafts.get(taskId) ?? '';
}

export function saveDraft(taskId: string, text: string): void {
  if (text === '') drafts.delete(taskId);
  else drafts.set(taskId, text);
}
