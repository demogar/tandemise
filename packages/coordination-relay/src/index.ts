import type { CoordinationStore } from '@tandemise/coordination';
import { RelayClient } from './client.js';
import { RelayCoordination } from './relay-coordination.js';

export * from './client.js';
export * from './stream.js';
export * from './outbox.js';
export * from './mirror.js';
export * from './relay-coordination.js';

/**
 * What the daemon's coordination switch needs to join a relay and then talk to
 * it. The daemon's bootstrap names this provider; nothing else does.
 */
export const relayFactory = {
  redeem(input: { url: string; code: string; displayName: string; deviceLabel: string }) {
    return new RelayClient({ baseUrl: input.url, token: async () => '' })
      .redeem({ code: input.code, displayName: input.displayName, deviceLabel: input.deviceLabel });
  },
  create(input: {
    store: CoordinationStore;
    url: string;
    token: () => Promise<string>;
    settings: { memberId?: string; deviceId?: string; teamName?: string };
    log: { warn(msg: string, fields?: Record<string, unknown>): void };
  }): RelayCoordination {
    return new RelayCoordination({
      store: input.store, url: input.url, token: input.token, log: input.log,
      memberId: input.settings.memberId ?? '', deviceId: input.settings.deviceId ?? '',
      ...(input.settings.teamName === undefined ? {} : { teamName: input.settings.teamName }),
    });
  },
};
