import { defineModule, token, type Resolver } from '@tandemise/kernel';
import { createPaths, nullLogger, type Logger } from '@tandemise/shared';
import {
  BACKGROUND_PROCESS_LAUNCHER, INTEGRATION_PROVIDERS, LOGGER,
} from '@tandemise/integrations-core';
import { BROWSER_OPTIONS, browserOptionsFrom } from './options.js';
import { BrowserProfileManager } from './profiles.js';
import { BrowserSessionManager } from './session-manager.js';
import { BrowserIntegrationProvider } from './provider.js';
import { DevServerController } from './dev-server.js';

export const BROWSER_PROFILE_MANAGER = token<BrowserProfileManager>('browser/profile-manager');
export const BROWSER_SESSION_MANAGER = token<BrowserSessionManager>('browser/session-manager');
export const DEV_SERVER_CONTROLLER = token<DevServerController>('browser/dev-server-controller');

/**
 * Binds browser control and contributes the browser integration provider.
 *
 * Chromium is never launched at registration: the session manager opens a
 * profile on first use, so composing this module on a machine with no browser
 * installed costs nothing and fails only where it can be reported usefully -
 * in `healthCheck`.
 */
export const browserIntegrationModule = defineModule('browser', (container) => {
  container.bind(
    BROWSER_PROFILE_MANAGER,
    (r) => new BrowserProfileManager(log(r).child({ component: 'browser-profiles' })),
    { source: 'browser', dispose: (m) => m.closeAll() },
  );

  container.bind(
    BROWSER_SESSION_MANAGER,
    (r) => new BrowserSessionManager(
      r.resolve(BROWSER_PROFILE_MANAGER),
      r.tryResolve(BROWSER_OPTIONS) ?? browserOptionsFrom(createPaths()),
      log(r).child({ component: 'browser' }),
    ),
    { source: 'browser', dispose: (m) => m.closeAll() },
  );

  container.bind(
    DEV_SERVER_CONTROLLER,
    (r) => new DevServerController(
      requireLauncher(r),
      log(r).child({ component: 'dev-server' }),
    ),
    { source: 'browser', dispose: (c) => c.stopAll() },
  );

  container.contribute(
    INTEGRATION_PROVIDERS,
    (r) => new BrowserIntegrationProvider(r.resolve(BROWSER_SESSION_MANAGER)),
    { source: 'browser' },
  );
});

function log(r: Resolver): Logger {
  return r.tryResolve(LOGGER) ?? nullLogger;
}

/**
 * Resolved rather than defaulted: there is no sane fallback for "start a child
 * process" in a package that must not import `child_process`, and a controller
 * that silently could not start anything would be worse than a missing binding.
 */
function requireLauncher(r: Resolver) {
  return r.resolve(BACKGROUND_PROCESS_LAUNCHER);
}
