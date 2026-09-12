import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { WorkspaceView } from '@tandemise/api-contract';

/**
 * Which project the window is looking at.
 *
 * Everything the daemon stores is already scoped to a workspace - missions,
 * integrations, approvals, artifacts, repositories, roles and routing - so a
 * workspace *is* a project. What was missing was anywhere to say which one, and
 * every screen quietly read the first in the list. That works until an install
 * has two, at which point half the app is looking at one project and half at
 * another.
 *
 * The choice is per machine rather than per daemon: it is a view preference,
 * not state any mission depends on, and storing it in the database would mean
 * two windows on one daemon could not sit on different projects.
 *
 * This module deliberately knows nothing about fetching. `queries.ts` reads the
 * id from here, so having it read the workspace list would be a cycle.
 */
const STORAGE_KEY = 'tandemise.workspace';

interface WorkspaceSelection {
  /** Null only before any workspace exists; the daemon seeds one on first run. */
  readonly id: string | null;
  readonly current: WorkspaceView | null;
  readonly all: readonly WorkspaceView[];
  readonly select: (id: string) => void;
}

const WorkspaceContext = createContext<WorkspaceSelection | null>(null);

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private windows and blocked site data both throw rather than return null.
    return null;
  }
}

export function WorkspaceProvider({
  workspaces,
  children,
}: {
  workspaces: readonly WorkspaceView[];
  children: ReactNode;
}): JSX.Element {
  const [stored, setStored] = useState<string | null>(readStored);

  // A stored id can name a workspace that has since been deleted, or one from
  // another machine's database. Falling back to the first is what keeps the app
  // usable instead of showing an empty project that does not exist.
  const id = workspaces.some((view) => view.workspace.id === stored)
    ? stored
    : workspaces[0]?.workspace.id ?? null;

  useEffect(() => {
    if (id === null || id === stored) return;
    setStored(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch { /* preference only; the app works without it */ }
  }, [id, stored]);

  const select = useCallback((next: string) => {
    setStored(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch { /* preference only */ }
  }, []);

  const value = useMemo<WorkspaceSelection>(
    () => ({
      id,
      current: workspaces.find((view) => view.workspace.id === id) ?? null,
      all: workspaces,
      select,
    }),
    [id, workspaces, select],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceSelection {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error('useWorkspace must be used inside a WorkspaceProvider');
  return value;
}

/**
 * The current workspace id, or undefined before one exists.
 *
 * Undefined is passed straight to the daemon, which reads an absent workspace
 * as "the whole install" - the right answer for the moment before a project has
 * been chosen.
 */
export function useWorkspaceId(): string | undefined {
  return useWorkspace().id ?? undefined;
}
