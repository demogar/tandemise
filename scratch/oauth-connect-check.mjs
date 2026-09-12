/**
 * Connecting an account by consent, end to end.
 *
 * Real: the container, SQLite, the connect flow, the credential source, the MCP
 * provider and its HTTP transport, and the daemon's own loopback callback
 * listener. The authorization server and MCP server are a strict local fixture
 * (scratch/fixtures/oauth-mcp-server.mjs). The browser is the only stand-in: it
 * is `fetch` following the consent redirect, which is all a browser does once
 * the user clicks Allow.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Container, compose } from '@tandemise/kernel';
import { createLogger, createPaths, systemClock, asId } from '@tandemise/shared';
import { persistenceModule, DATABASE } from '@tandemise/persistence';
import * as persistenceTokens from '@tandemise/persistence';
import { createArtifactsModule, ARTIFACT_STORE as ARTIFACTS_STORE_TOKEN, renderArtifactTemplate, parseArtifact } from '@tandemise/artifacts';
import { policyModule } from '@tandemise/policy';
import { contextModule } from '@tandemise/context';
import { createEvaluationModule } from '@tandemise/evaluation';
import { runtimesCoreModule } from '@tandemise/runtimes-core';
import { genericRuntimeModule } from '@tandemise/runtime-generic';
import { executionCoreModule, CLOCK as EXEC_CLOCK, LOGGER as EXEC_LOGGER, PATHS as EXEC_PATHS } from '@tandemise/execution-core';
import { executionLocalModule } from '@tandemise/execution-local';
import {
  integrationsCoreModule, CLOCK as INT_CLOCK, LOGGER as INT_LOGGER, TOOL_BROKER, TOOL_CATALOG,
  COMMAND_EXECUTOR,
} from '@tandemise/integrations-core';
import { mcpIntegrationModule, discoverAuthorizationServer } from '@tandemise/integration-mcp';
import * as app from '@tandemise/application';
import { applicationModule, createServices, createMemorySettingsStore, describeEnvironment, osProcessLiveness } from '@tandemise/application';
import { oauthCallbacks } from '../apps/daemon/dist/oauth-callback.js';
import { startOAuthMcpServer } from './fixtures/oauth-mcp-server.mjs';

const HOME = mkdtempSync(join(tmpdir(), 'tandemise-oauth-'));
const keepAlive = setInterval(() => {}, 1000);
let passed = 0; let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures++; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};
const head = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(services, id, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const view = services.integrations.connection(id);
    if (!['waiting', 'connecting'].includes(view.status) || Date.now() > end) return view;
    await sleep(25);
  }
}
/** What the browser does after the user clicks Allow: follow the redirect back. */
async function consent(authorizationUrl) {
  const toAuthServer = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = toAuthServer.headers.get('location');
  if (!location) return { status: toAuthServer.status, body: await toAuthServer.text() };
  const back = await fetch(location);
  return { status: back.status, body: await back.text(), location };
}

// ----------------------------------------------------------------- container
const paths = createPaths(HOME);
mkdirSync(paths.root, { recursive: true });
const log = createLogger({ level: 'error', base: { component: 'oauth-check' } });
const container = new Container();
compose(container, persistenceModule({ path: paths.db, logger: log }), createArtifactsModule({ paths }), policyModule,
  contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule, executionCoreModule,
  executionLocalModule, integrationsCoreModule, mcpIntegrationModule, applicationModule);
for (const [t, v] of [[EXEC_CLOCK, systemClock], [EXEC_LOGGER, log], [EXEC_PATHS, paths], [INT_CLOCK, systemClock], [INT_LOGGER, log]]) {
  container.bind(t, () => v, { source: 'check' });
}
const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
for (const name of Object.keys(app)) {
  const appToken = app[name]; const provider = persistenceTokens[name];
  if (!isToken(appToken) || !isToken(provider) || !container.has(provider) || container.has(appToken)) continue;
  container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
}
const secretValues = new Map();
let secretSeq = 0;
container.bind(app.ARTIFACT_STORE, (r) => r.resolve(ARTIFACTS_STORE_TOKEN), { source: 'alias' });
container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: renderArtifactTemplate }), { source: 'check' });
container.bind(app.ARTIFACT_PARSER, () => ({ parse: parseArtifact }), { source: 'check' });
container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
container.bind(app.SECRET_STORE, () => ({
  backend: 'memory',
  store: async (name, value) => { const ref = `mem:${name}:${++secretSeq}`; secretValues.set(ref, value); return ref; },
  // Real keychain reads shell out and take tens of milliseconds; an instant
  // store hides the window in which concurrent refreshes slipped through.
  resolve: async (ref) => { await sleep(30); return secretValues.get(ref); },
  remove: async (ref) => { secretValues.delete(ref); },
  list: async () => [...secretValues.keys()],
}), { source: 'check' });
container.bind(app.SETTINGS_STORE, () => createMemorySettingsStore(), { source: 'check' });
container.bind(app.SYSTEM_ENVIRONMENT, () => describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
container.bind(app.PROCESS_LIVENESS, () => osProcessLiveness, { source: 'check' });
container.bind(app.OAUTH_CALLBACK, () => oauthCallbacks, { source: 'check' });
container.bind(COMMAND_EXECUTOR, () => ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });

const services = createServices(container);
const db = container.resolve(DATABASE);
db.handle.exec(`INSERT INTO workspaces (id,name,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
  VALUES ('ws1','Beveloce','{}','{}','{}','balanced','{}','2026-01-01','2026-01-01');`);
const integrations = container.resolve(app.INTEGRATION_REPOSITORY);

const fixture = await startOAuthMcpServer({ accessTtlSeconds: 3600 });
const request = { workspaceId: 'ws1', providerId: 'mcp', name: 'tracker',
  config: { url: fixture.url, auth: 'oauth', capability: 'planning', risk: 'external_side_effect', trustAnnotations: true } };

try {
  head('The gallery');
  const connectors = services.integrations.listConnectors();
  ok('the curated connectors are offered', ['figma', 'canva', 'linear', 'notion', 'atlassian', 'supabase', 'vercel', 'sentry']
    .every((id) => connectors.some((c) => c.id === id)), connectors.map((c) => c.id).join(','));
  ok('Figma and Canva are for designers', connectors.filter((c) => c.category === 'design').map((c) => c.id).join() === 'figma,canva');
  ok('no connector exposes its configuration to the renderer', connectors.every((c) => !('config' in c)));

  head('Discovery follows the server\'s own metadata');
  const discovered = await discoverAuthorizationServer(fixture.url, fetch, AbortSignal.timeout(5000));
  ok('the 401 challenge leads to the authorization server', discovered.tokenEndpoint === `${fixture.base}/token`);
  ok('dynamic registration is found', discovered.registrationEndpoint === `${fixture.base}/register`);
  ok('the token is bound to the MCP resource', discovered.resource === fixture.url);

  head('Connect: consent in the browser, and the account is connected');
  const attempt = await services.integrations.connect(request);
  ok('the attempt waits on the person', attempt.status === 'waiting');
  const authUrl = new URL(attempt.authorizationUrl);
  const redirect = new URL(authUrl.searchParams.get('redirect_uri'));
  ok('the redirect is a loopback listener for this attempt', redirect.hostname === '127.0.0.1' && redirect.pathname === '/callback');
  ok('PKCE S256 is used', authUrl.searchParams.get('code_challenge_method') === 'S256');
  ok('the client was registered on the spot, not shipped', fixture.stats.registrations === 1);
  ok('no verifier or client secret reaches the view', !JSON.stringify(attempt).includes('verifier'));

  // A stray request to the listener must neither finish nor end the attempt.
  const stray = await fetch(`${redirect.origin}/callback?state=forged&code=nope`);
  ok('a callback with the wrong state is refused', stray.status === 400);
  ok('and the attempt is still waiting', services.integrations.connection(attempt.id).status === 'waiting');

  const browser = await consent(attempt.authorizationUrl);
  ok('the browser tab says it is connected', browser.status === 200 && browser.body.includes('is connected'), `${browser.status}`);
  const done = await settle(services, attempt.id);
  ok('the attempt settles as connected', done.status === 'connected', `${done.status} ${done.error ?? ''}`);
  ok('the code was exchanged with a verifier the server accepted', fixture.stats.exchanges === 1);
  ok('the URL is withdrawn once settled', done.authorizationUrl === null);

  const row = integrations.get(asId(done.integrationId));
  ok('an integration row exists', row !== undefined);
  ok('it holds a reference, not a token', row?.credentialRef?.startsWith('mem:') && !JSON.stringify(row).includes('access_token'));
  const stored = JSON.parse(secretValues.get(row.credentialRef));
  ok('the credential store holds access and refresh tokens', typeof stored.accessToken === 'string' && typeof stored.data.refreshToken === 'string');
  const listener = await fetch(`${redirect.origin}/callback?state=x`).then(() => 'open', () => 'closed');
  ok('the loopback listener is closed afterwards', listener === 'closed');

  head('Its tools reach workers, split by what they do');
  const [view] = await services.integrations.list('ws1');
  ok('health is healthy', view.health.state === 'healthy', view.health.detail);
  ok('every page of tools was discovered', /2 tools/.test(view.health.detail), view.health.detail);
  ok('the view says it can be reconnected', view.reconnectable === true);
  const catalog = container.resolve(TOOL_CATALOG);
  const list = catalog.find('tracker.list_issues');
  const create = catalog.find('tracker.create_issue');
  ok('a read-only tool is published under planning.read at risk read', list?.capability === 'planning.read' && list?.risk === 'read');
  ok('a write is published under planning', create?.capability === 'planning' && create?.risk === 'external_side_effect');

  const ctx = { assignment: {}, assignmentId: 'a', runId: null, workingDirectory: HOME, logger: log, exec: null, signal: new AbortController().signal };
  const first = await create.execute(ctx, { title: 'Passkeys' });
  ok('a tool call goes through with the bearer token, over SSE', first.summary.startsWith('create_issue ok'), first.summary);

  head('An expired token is renewed without the person');
  fixture.revokeAccessTokens();
  const before = fixture.stats.refreshes;
  const second = await create.execute(ctx, { title: 'After expiry' });
  ok('the call still succeeds', second.summary.startsWith('create_issue ok'), second.summary);
  ok('by refreshing once', fixture.stats.refreshes === before + 1);
  const rotatedRef = integrations.get(row.id).credentialRef;
  ok('the rotated credential replaced the old one', rotatedRef !== row.credentialRef && !secretValues.has(row.credentialRef));

  head('Parallel calls on a lapsed token refresh once, not three times');
  fixture.revokeAccessTokens();
  const beforeParallel = fixture.stats.refreshes;
  const results = await Promise.allSettled([1, 2, 3].map((n) => create.execute(ctx, { title: `p${n}` })));
  ok('all three succeed', results.every((r) => r.status === 'fulfilled'), results.map((r) => r.status).join(','));
  ok('with a single refresh - rotation would disconnect a second one', fixture.stats.refreshes === beforeParallel + 1,
     `${fixture.stats.refreshes - beforeParallel} refreshes`);

  head('A server request on the stream is not mistaken for the reply');
  fixture.setServerRequestFirst(true);
  const streamed = await create.execute(ctx, { title: 'with ping first' }).then((r) => r, (e) => e);
  fixture.setServerRequestFirst(false);
  ok('a ping with our id ahead of the answer is skipped', streamed?.summary?.startsWith('create_issue ok'), streamed?.summary ?? streamed?.message);

  head('A token endpoint outage is not reported as a revoked account');
  fixture.revokeAccessTokens();
  fixture.setTokenOutage(true);
  const outage = await create.execute(ctx, { title: 'during outage' }).then(() => null, (e) => e);
  fixture.setTokenOutage(false);
  ok('the call fails', outage !== null);
  ok('without telling the person to reconnect', !/[Rr]econnect/.test(outage?.message ?? ''), outage?.message);
  const recovered = await create.execute(ctx, { title: 'after outage' }).then((r) => r.summary, (e) => e.message);
  ok('and works once the endpoint is back, with the same refresh token', recovered.startsWith('create_issue ok'), recovered);

  head('A cancelled call abandons its wait without cancelling the shared refresh');
  fixture.revokeAccessTokens();
  const cancelledCtl = new AbortController();
  const refreshesBefore = fixture.stats.refreshes;
  const doomed = create.execute({ ...ctx, signal: cancelledCtl.signal }, { title: 'cancelled' }).then(() => 'ok', () => 'aborted');
  const survivor = create.execute(ctx, { title: 'survivor' }).then((r) => r.summary, (e) => e.message);
  cancelledCtl.abort();
  ok('the cancelled call stops', (await doomed) === 'aborted');
  ok('the other call still gets a refreshed token', (await survivor).startsWith('create_issue ok'), await survivor);
  ok('from one refresh', fixture.stats.refreshes === refreshesBefore + 1, `${fixture.stats.refreshes - refreshesBefore}`);

  head('A revoked refresh token asks the person to reconnect, readably');
  fixture.revokeAccessTokens();
  fixture.revokeRefreshTokens();
  const failed = await create.execute(ctx, { title: 'no' }).then(() => null, (e) => e);
  ok('the call fails', failed !== null);
  ok('saying to reconnect', /[Rr]econnect/.test(failed?.message ?? ''), failed?.message);
  const [unhealthy] = await services.integrations.list('ws1');
  ok('health reports it unavailable, not a crash', unhealthy.health.state === 'unavailable', unhealthy.health.detail);

  head('Reconnect keeps the integration');
  const again = await services.integrations.connect({ workspaceId: 'ws1', integrationId: row.id });
  await consent(again.authorizationUrl);
  const reconnected = await settle(services, again.id);
  ok('reconnecting succeeds', reconnected.status === 'connected', reconnected.error ?? '');
  ok('onto the same row', reconnected.integrationId === row.id && (await services.integrations.list('ws1')).length === 1);
  ok('and it works again', (await create.execute(ctx, { title: 'back' })).summary.startsWith('create_issue ok'));

  head('A server claiming to be a different resource is refused');
  fixture.claimResource('https://mcp.figma.com/mcp');
  const spoof = await services.integrations.connect({ ...request, name: 'spoof' }).then(() => null, (e) => e);
  fixture.claimResource(null);
  ok('connect refuses before any consent page is shown', spoof !== null && /Refusing/.test(spoof.message ?? ''), spoof?.message);

  head('Declining at the consent screen');
  fixture.setDeny(true);
  const declined = await services.integrations.connect({ ...request, name: 'tracker' });
  const tab = await consent(declined.authorizationUrl);
  const declinedView = await settle(services, declined.id);
  fixture.setDeny(false);
  ok('the attempt fails', declinedView.status === 'failed');
  ok('saying you declined', /declined/.test(declinedView.error ?? ''), declinedView.error);
  ok('the tab says so too', tab.body.includes('was not connected'));
  ok('no integration is created', (await services.integrations.list('ws1')).length === 1);

  head('A second account gets its own name, so tools do not collide');
  const second_ = await services.integrations.connect(request);
  await consent(second_.authorizationUrl);
  const secondDone = await settle(services, second_.id);
  ok('named tracker-2', integrations.get(asId(secondDone.integrationId))?.name === 'tracker-2');

  head('Cancelling an attempt closes its listener');
  const cancelled = await services.integrations.connect(request);
  const cancelRedirect = new URL(new URL(cancelled.authorizationUrl).searchParams.get('redirect_uri'));
  services.integrations.cancelConnection(cancelled.id);
  await sleep(50);
  ok('the attempt is cancelled', services.integrations.connection(cancelled.id).status === 'cancelled');
  ok('the listener is gone', await fetch(`${cancelRedirect.origin}/callback`).then(() => false, () => true));

  head('Removing the integration removes the credential');
  const refBeforeRemove = integrations.get(row.id).credentialRef;
  services.integrations.remove(row.id);
  await sleep(20);
  ok('the secret is gone from the store', !secretValues.has(refBeforeRemove));
} finally {
  await fixture.close();
  clearInterval(keepAlive);
  rmSync(HOME, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
