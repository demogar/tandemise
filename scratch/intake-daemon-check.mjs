// Intake over the wire (spec 2026-10-30-intake-design.md §2, plan Task 3):
// a real daemon from `dist`, a fresh TANDEMISE_HOME and TANDEMISE_OFFLINE=1.
// Custom runners push with an intake token that opens exactly one source's
// push route and nothing else, and the `tandemise` CLI pushes with the
// daemon's own connection file.
//
//   npm run build && node scratch/intake-daemon-check.mjs
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

/** Runs the CLI as its own process, asynchronously, so the in-process daemon keeps answering. */
const cli = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [join(repo, 'apps/daemon/dist/cli.js'), ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
  });
});

section('daemon: intake config, tokens, pushes and the CLI');
{
  const root = mkdtempSync(join(tmpdir(), 'tdi-intake-'));
  const home = join(root, 'h');
  process.env.TANDEMISE_OFFLINE = '1';
  delete process.env.TANDEMISE_CLOCK_OFFSET_MS;
  delete process.env.TANDEMISE_INTAKE_TOKEN;
  delete process.env.TANDEMISE_URL;
  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  let daemon;
  try {
    daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
    const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
    const call = async (method, path, body, bearer = token) => {
      const res = await fetch(`${daemon.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const signal = (over = {}) => ({
      schema: 'tandemise.intake/v1', source: { kind: 'custom', instance: 'custom-feed' }, key: 'h1',
      url: 'https://feed.test/h1', title: 'Pushed over HTTP', ...over,
    });

    const ws = (await call('POST', '/v1/workspaces', { name: 'Intake' })).body?.workspace?.id;
    check('a project exists', typeof ws === 'string', ws);

    // 6. The versions this daemon accepts.
    const schema = await call('GET', '/v1/intake/schema');
    check('GET /v1/intake/schema answers the accepted versions', schema.status === 200 && JSON.stringify(schema.body) === JSON.stringify({ accepted: ['tandemise.intake/v1'] }), schema);

    // With no tracker, a push is refused before anything is recorded.
    const early = await call('POST', `/v1/intake/signals?workspace=${ws}&source=custom-feed`, signal());
    check("a push with no tracker is 409: Set this project's tracker first.", early.status === 409 && early.body?.error?.message === "Set this project's tracker first.", early);

    // 1. The local config: a youtrack tracker and two custom sources.
    const config = {
      tracker: {
        kind: 'youtrack', url: 'https://yt.test', project: 'GAR', board: 'project: GAR #Unresolved',
        states: { ready: ['Open'], in_progress: 'In Progress', done: ['Done'], wont_do: ["Won't fix"] }, onComplete: 'done',
      },
      intake: { sources: [{ id: 'custom-feed', kind: 'custom', instance: 'custom-feed' }, { id: 'other-feed', kind: 'custom', instance: 'other-feed' }] },
    };
    const put = await call('PUT', `/v1/workspaces/${ws}/intake/config`, config);
    check('PUT intake/config stores the tracker and sources', put.status === 200 && put.body?.origin === 'local' && put.body?.tracker?.project === 'GAR' && put.body?.sources?.length === 2 && put.body?.dailyCap === 20, put);
    const got = await call('GET', `/v1/workspaces/${ws}/intake/config`);
    check('GET intake/config reads it back', got.status === 200 && got.body?.sources?.[1]?.id === 'other-feed', got);
    const badPut = await call('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker: { ...config.tracker, url: undefined } });
    check('PUT intake/config refuses a youtrack tracker with no url (400)', badPut.status === 400, badPut);

    // 2. A token for one source, shown once.
    const minted = await call('POST', `/v1/workspaces/${ws}/intake/tokens`, { sourceId: 'custom-feed' });
    const intakeToken = minted.body?.token;
    check('POST intake/tokens answers a tdi_ token, once', minted.status === 200 && typeof intakeToken === 'string' && intakeToken.startsWith('tdi_') && typeof minted.body?.id === 'string', minted);

    // 3. The token pushes to its source.
    const pushed = await call('POST', '/v1/intake/signals', signal(), intakeToken);
    check('POST /v1/intake/signals with the token is 202, received', pushed.status === 202 && pushed.body?.results?.[0]?.status === 'received' && pushed.body.results[0].fingerprint === 'custom:custom-feed:h1', pushed);
    const batch = await call('POST', '/v1/intake/signals', { signals: [signal({ key: 'h2' }), signal({ key: 'h3', priority: 'high' })] }, intakeToken);
    check('a batch answers one result per signal; a bad one is rejected, not the batch', batch.status === 202 && batch.body?.results?.length === 2 && batch.body.results[0].status === 'received' && batch.body.results[1].status === 'rejected' && batch.body.results[1].reason.includes('priority'), batch);

    // 4. ...and to no other.
    const sentence = "This token can only push to 'custom-feed'.";
    const viaQuery = await call('POST', '/v1/intake/signals?source=other-feed', signal(), intakeToken);
    check('the token with ?source=other-feed is 403 with the sentence', viaQuery.status === 403 && viaQuery.body?.error?.message === sentence, viaQuery);
    const viaBody = await call('POST', '/v1/intake/signals', signal({ source: { kind: 'custom', instance: 'other-feed' } }), intakeToken);
    check('the token with a body for another source is 403 with the sentence', viaBody.status === 403 && viaBody.body?.error?.message === sentence, viaBody);

    // 5. An intake token opens nothing else; a random token opens nothing at all.
    const elsewhere = await call('GET', '/v1/workspaces', undefined, intakeToken);
    check('the intake token on /v1/workspaces is 403', elsewhere.status === 403 && elsewhere.body?.error?.message === 'Missing or invalid daemon token.', elsewhere);
    const random = await call('GET', '/v1/workspaces', undefined, 'tdi_' + 'z'.repeat(32));
    check('a random token on /v1/workspaces is 403: Missing or invalid daemon token.', random.status === 403 && random.body?.error?.message === 'Missing or invalid daemon token.', random);
    const randomPush = await call('POST', '/v1/intake/signals', signal(), 'tdi_' + 'z'.repeat(32));
    check('a random token on the push route is 403', randomPush.status === 403, randomPush);

    // The daemon token pushes for a named project and source.
    const own = await call('POST', `/v1/intake/signals?workspace=${ws}&source=other-feed`, signal({ source: { kind: 'custom', instance: 'other-feed' }, key: 'o1' }));
    check('the daemon token pushes with ?workspace=&source=', own.status === 202 && own.body?.results?.[0]?.fingerprint === 'custom:other-feed:o1', own);
    const unnamed = await call('POST', '/v1/intake/signals', signal());
    check('the daemon token without ?workspace=&source= is 400', unnamed.status === 400, unnamed);

    // A revoked token stops working at once.
    const spare = await call('POST', `/v1/workspaces/${ws}/intake/tokens`, { sourceId: 'custom-feed' });
    const revoked = await call('DELETE', `/v1/intake/tokens/${spare.body?.id}`);
    const afterRevoke = await call('POST', '/v1/intake/signals', signal(), spare.body?.token);
    check('DELETE intake/tokens/:id revokes the token', revoked.status === 204 && afterRevoke.status === 403, { revoked, afterRevoke });

    // 7. The CLI, through daemon.json.
    const env = { TANDEMISE_HOME: home };
    const run = await cli(['intake', 'push', '--source', 'custom-feed', '--title', 'T', '--url', 'https://x.test/1', '--key', 'k1'], env);
    check('tandemise intake push exits 0 and prints <fingerprint>: <status>', run.code === 0 && run.stdout.trim() === 'custom:custom-feed:k1: received', run);
    const listed = await call('GET', `/v1/workspaces/${ws}/intake/signals`);
    check('the pushed signal is listed', listed.status === 200 && listed.body?.some((s) => s.fingerprint === 'custom:custom-feed:k1' && s.status === 'received'), listed);
    const rejectedOnly = await call('GET', `/v1/workspaces/${ws}/intake/signals?status=rejected`);
    check('the list filters by status', rejectedOnly.status === 200 && rejectedOnly.body?.length === 1 && rejectedOnly.body[0].fingerprint === 'custom:custom-feed:h3', rejectedOnly);

    // The CLI with an intake token from the environment, and its refusals.
    const withToken = await cli(['intake', 'push', '--source', 'custom-feed', '--title', 'T2', '--url', 'https://x.test/2', '--key', 'k2'], { TANDEMISE_HOME: join(root, 'nowhere'), TANDEMISE_URL: daemon.url, TANDEMISE_INTAKE_TOKEN: intakeToken });
    check('the CLI pushes with TANDEMISE_URL and TANDEMISE_INTAKE_TOKEN', withToken.code === 0 && withToken.stdout.trim() === 'custom:custom-feed:k2: received', withToken);
    const refused = await cli(['intake', 'push', '--source', 'other-feed', '--title', 'T', '--url', 'https://x.test/3', '--key', 'k3'], { TANDEMISE_HOME: join(root, 'nowhere'), TANDEMISE_URL: daemon.url, TANDEMISE_INTAKE_TOKEN: intakeToken });
    check("a refusal exits 1 with the daemon's words", refused.code === 1 && refused.stderr.includes(sentence), refused);
    const usage = await cli(['intake', 'push', '--title', 'T'], env);
    check('a usage error exits 2', usage.code === 2, usage);
    await call('POST', '/v1/workspaces', { name: 'Second' });
    const ambiguous = await cli(['intake', 'push', '--source', 'custom-feed', '--title', 'T', '--url', 'https://x.test/1', '--key', 'k1'], env);
    check('with two projects and no --project: exit 2, Name the project with --project.', ambiguous.code === 2 && ambiguous.stderr.includes('Name the project with --project.'), ambiguous);
    const named = await cli(['intake', 'push', '--project', ws, '--source', 'custom-feed', '--title', 'T', '--url', 'https://x.test/1', '--key', 'k1'], env);
    // k1 was pushed before: since Task 7 its answer carries why it still waits (this daemon has no YouTrack token).
    check('--project names it', named.code === 0 && named.stdout.split('\n')[0] === 'custom:custom-feed:k1: received'
      && /^ {2}Couldn't reach YouTrack: .* Tandemise will try again\.$/.test(named.stdout.split('\n')[1] ?? ''), named);
  } catch (e) {
    check('the daemon section ran', false, String(e?.stack ?? e));
  } finally {
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
