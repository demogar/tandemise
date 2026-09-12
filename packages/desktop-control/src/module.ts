import { defineModule, type Resolver, type Token } from '@tandemise/kernel';
import { TandemiseError, nullLogger, systemClock, type Clock, type Logger } from '@tandemise/shared';
import { CLOCK, INTEGRATION_PROVIDERS, LOGGER } from '@tandemise/integrations-core';
import { MacOSHelperClient } from './client.js';
import { DesktopIntegrationProvider } from './provider.js';
import { HELPER_BINARY_PATH, HELPER_SPAWN, MACOS_HELPER_CLIENT } from './tokens.js';

/**
 * Contributes macOS desktop control.
 *
 * The helper client is a singleton: one subprocess serves the whole daemon, and
 * it is disposed with the container so a shutdown never leaves it orphaned.
 * Both of its collaborators - the binary path and the spawn function - are
 * required rather than defaulted, because guessing either one would turn a
 * composition mistake into a runtime mystery.
 */
export const desktopControlModule = defineModule('desktop-control', (container) => {
  container.bind(
    MACOS_HELPER_CLIENT,
    (r) =>
      new MacOSHelperClient({
        binaryPath: required(r, HELPER_BINARY_PATH, 'the path to the tandemise-helper binary'),
        spawn: required(r, HELPER_SPAWN, 'a spawn function, e.g. (cmd, args) => spawn(cmd, args)'),
        logger: log(r).child({ component: 'macos-helper' }),
      }),
    { source: 'desktop-control', dispose: (client) => client.stop() },
  );

  container.contribute(
    INTEGRATION_PROVIDERS,
    (r) => new DesktopIntegrationProvider(r.resolve(MACOS_HELPER_CLIENT), clock(r)),
    { source: 'desktop-control' },
  );
});

function required<T>(r: Resolver, t: Token<T>, what: string): T {
  const value = r.tryResolve(t);
  if (value === undefined) {
    throw new TandemiseError(
      'PRECONDITION_FAILED',
      `desktop-control needs ${what}: bind ${t.description} in the composition root`,
    );
  }
  return value;
}

function log(r: Resolver): Logger {
  return r.tryResolve(LOGGER) ?? nullLogger;
}

function clock(r: Resolver): Clock {
  return r.tryResolve(CLOCK) ?? systemClock;
}
