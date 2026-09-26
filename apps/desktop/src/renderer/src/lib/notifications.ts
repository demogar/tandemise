import { useEffect } from 'react';
import { useLocation } from 'wouter';
import type { NotificationOpen } from '../../../shared/bridge.js';
import { useWorkspace } from './workspace.js';

/**
 * Where a clicked notification takes the window (P16).
 *
 * The main process may deliver the route while the app is still booting (the
 * window was just re-created from the tray), before the project shell exists
 * to navigate. So the subscription starts at import and keeps the latest
 * target until the shell takes it.
 */
let pending: NotificationOpen | null = null;
const listeners = new Set<() => void>();

try {
  window.tandemise.onNotificationOpen((target) => {
    pending = target;
    for (const listener of listeners) listener();
  });
} catch { /* no bridge (the mock renderer): nothing will ever be clicked */ }

/** Mounted once in the project shell: switches project if needed, then navigates. */
export function useNotificationOpen(): void {
  const [, navigate] = useLocation();
  const { id, all, select } = useWorkspace();

  useEffect(() => {
    const take = (): void => {
      const target = pending;
      pending = null;
      if (target === null) return;
      if (target.workspaceId !== null && target.workspaceId !== id && all.some((w) => w.workspace.id === target.workspaceId)) {
        select(target.workspaceId);
      }
      navigate(target.route);
    };
    take();
    listeners.add(take);
    return () => {
      listeners.delete(take);
    };
  }, [navigate, id, all, select]);
}
