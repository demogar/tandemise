import { createSecretStore } from '../apps/daemon/dist/secrets.js';
import { createLogger } from '@tandemise/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tandemise-secrets-'));
process.env.TANDEMISE_HOME = home;
const store = createSecretStore({ home, log: createLogger({ level: 'warn' }) });
let fail = 0;
const ok = (n, c, d='') => { if (c) console.log(`  ok   ${n}`, d); else { fail++; console.log(`  FAIL ${n}`, d); } };

console.log('── secret store:', store.backend);
const secret = 'ghp_' + 'x'.repeat(36);
const ref = await store.store('e2e-test-token', secret);
ok('store returns an opaque reference', typeof ref === 'string' && !ref.includes(secret), ref);
ok('the reference does not contain the secret', !ref.includes('ghp_'));
const back = await store.resolve(ref);
ok('resolve returns the original value', back === secret);
ok('the reference is listed', (await store.list()).includes(ref));
await store.remove(ref);
ok('resolve after remove returns undefined', (await store.resolve(ref)) === undefined);
ok('unknown reference resolves undefined, not a throw', (await store.resolve('keychain:nope:nope')) === undefined);
console.log(fail ? `\n${fail} FAILED` : '\nALL SECRET STORE CHECKS PASSED');
process.exit(fail?1:0);
