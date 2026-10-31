import { defineModule, token } from '@tandemise/kernel';
import { PtyHost } from './pty-host.js';

export const TERMINAL_HOST = token<PtyHost>('terminal/pty-host');

/**
 * The PTY host for held tasks. The daemon binds the domain's interactive-sessions
 * port to this same instance; the socket resolves it directly to attach windows.
 */
export const terminalModule = defineModule('terminal', (c) => {
  c.bind(TERMINAL_HOST, () => new PtyHost(), {
    source: 'terminal',
    dispose: (host) => host.endAll(),
  });
});
