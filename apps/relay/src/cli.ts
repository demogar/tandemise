#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { CoordinationStore, CoordError, exportLines, importLines } from '@tandemise/coordination';
import { loadRelayConfig } from './config.js';
import { openRelayDb } from './db.js';
import { startRelay } from './main.js';

/**
 * tandemise-relay: the relay's admin CLI, for bootstrap and recovery only. It
 * opens RELAY_DB directly, so it works through `docker compose exec relay
 * tandemise-relay …`; shell access to the container is the root of trust.
 *
 *   tandemise-relay [serve]
 *   tandemise-relay invite --role admin|member [--name <n>] [--days <d>]
 *   tandemise-relay export [--out <file>]
 *   tandemise-relay import <file>
 *   tandemise-relay revoke <deviceId>
 */
const USAGE = `Usage:
  tandemise-relay [serve]
  tandemise-relay invite --role admin|member [--name <name>] [--days <1-30>]
  tandemise-relay export [--out <file>]
  tandemise-relay import <file>
  tandemise-relay revoke <deviceId>`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function openStore(): { store: CoordinationStore; close: () => void } {
  const config = loadRelayConfig({ ...process.env, RELAY_PUBLIC_URL: process.env['RELAY_PUBLIC_URL'] || 'http://127.0.0.1', RELAY_HOST: '127.0.0.1' });
  const db = openRelayDb(config.dbPath);
  const store = new CoordinationStore(db.handle);
  store.hooksBase = config.publicUrl;
  return { store, close: db.close };
}

async function main(argv: string[]): Promise<number> {
  const [cmd = 'serve', ...args] = argv;
  switch (cmd) {
    case 'serve': {
      const relay = await startRelay(loadRelayConfig(process.env));
      const stop = (): void => { void relay.close().then(() => process.exit(0)); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return -1;
    }
    case 'invite': {
      const role = flag(args, 'role');
      if (role !== 'admin' && role !== 'member') { console.error('--role must be admin or member.'); return 2; }
      const days = flag(args, 'days');
      const expiresInDays = days === undefined ? undefined : Number(days);
      if (expiresInDays !== undefined && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30)) { console.error('--days must be 1 to 30.'); return 2; }
      const { store, close } = openStore();
      try {
        if (store.team() === null) store.ensureTeam(process.env['RELAY_TEAM_NAME']?.trim() || 'Team');
        const { code } = store.createInvite({ role, displayName: flag(args, 'name') ?? (role === 'admin' ? 'Admin' : 'Member'), createdBy: null, ...(expiresInDays === undefined ? {} : { expiresInDays }) });
        console.log(code);
      } finally {
        close();
      }
      return 0;
    }
    case 'export': {
      const { store, close } = openStore();
      try {
        const text = `${exportLines(store).join('\n')}\n`;
        const out = flag(args, 'out');
        if (out) writeFileSync(out, text, { mode: 0o600 });
        else process.stdout.write(text);
      } finally {
        close();
      }
      return 0;
    }
    case 'import': {
      const file = args[0];
      if (!file) { console.error(USAGE); return 2; }
      const { store, close } = openStore();
      try {
        const report = importLines(store, readFileSync(file, 'utf8').split('\n'), 'empty', null);
        console.log(JSON.stringify(report));
      } finally {
        close();
      }
      return 0;
    }
    case 'revoke': {
      const id = args[0];
      if (!id) { console.error(USAGE); return 2; }
      const { store, close } = openStore();
      try {
        store.revokeDevice(id);
        console.log(`Revoked ${id}. Its next request is refused.`);
      } finally {
        close();
      }
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => { if (code >= 0) process.exit(code); },
  (e: unknown) => {
    console.error(e instanceof CoordError || e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
