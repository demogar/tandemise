/**
 * The MCP client transport, against a server that really speaks the protocol.
 *
 * The point of this transport is that every MCP server becomes an integration
 * by configuration rather than by someone writing a package here - so the thing
 * worth proving is that a server this repository has never seen is discovered,
 * described and called correctly, and that its failures arrive as failures.
 */
import { join } from 'node:path';

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};

const { McpStdioClient, McpIntegrationProvider, jsonSchemaToZod } =
  await import('../packages/integration-mcp/dist/index.js');
const { nullLogger } = await import('../packages/shared/dist/index.js');

const SERVER = join(process.cwd(), 'scratch/fixtures/mcp-server.mjs');
const spec = { command: process.execPath, args: [SERVER] };

console.log('── talking to a server we did not write');
const client = new McpStdioClient(spec, nullLogger);
await client.connect();
ok('handshake completes', client.serverInfo?.name === 'fixture-db', JSON.stringify(client.serverInfo));
const tools = await client.listTools();
ok('tools are discovered', tools.length === 2, tools.map((t) => t.name).join(', '));
ok('descriptions come through', tools[0].description === 'List the tables in a schema.');
const called = await client.callTool('list_tables', { schema: 'public' });
ok('a call returns flattened text', called.text === 'tables in public: users, rides', called.text);
ok('it is not an error', called.isError === false);
const failed = await client.callTool('boom', {});
ok('a tool-level failure is reported, not thrown', failed.isError === true && failed.text === 'it exploded');
client.close();

console.log('\n── the server\'s schema survives the trip');
const schema = jsonSchemaToZod(tools[0].inputSchema);
ok('a required field is required', !schema.safeParse({}).success);
ok('a valid call parses', schema.safeParse({ schema: 'public' }).success);
ok('optional fields stay optional', schema.safeParse({ schema: 'public', limit: 10 }).success);
ok('a wrong type is caught at the boundary', !schema.safeParse({ schema: 'public', limit: 'ten' }).success);
ok('an enum is enforced', !schema.safeParse({ schema: 'public', mode: 'sideways' }).success
  && schema.safeParse({ schema: 'public', mode: 'full' }).success);
ok('unknown arguments are passed through, not rejected',
  schema.safeParse({ schema: 'public', undocumented: 1 }).success);

console.log('\n── as an integration');
const provider = new McpIntegrationProvider();
const integration = {
  id: 'int_1', workspaceId: 'ws_1', providerId: 'mcp', name: 'supabase',
  transport: 'mcp', config: { command: process.execPath, args: [SERVER], capability: 'supabase.call', risk: 'external_write' },
  secretRef: null, enabledCapabilities: [], enabled: true,
  createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
};
const clock = { now: () => '2026-09-12T00:00:00.000Z', epochMs: () => 0 };

ok('no tools before it has been checked', provider.tools(integration).length === 0);
const health = await provider.healthCheck(integration, { logger: nullLogger, clock, exec: null, signal: new AbortController().signal });
ok('health reports what it found', health.state === 'healthy' && health.detail.includes('list_tables'), health.detail);

const published = provider.tools(integration);
ok('tools appear after discovery', published.length === 2, published.map((t) => t.name).join(', '));
ok('names are namespaced by integration', published[0].name === 'supabase.list_tables', published[0].name);
ok('the configured capability is what is granted', published.every((t) => t.capability === 'supabase.call'));
// `external_write` was never a risk class; rows written with it are read as
// what they meant, so an approval for one of these tools satisfies the schema.
ok('a legacy risk name is read as the real risk class', published.every((t) => t.risk === 'external_side_effect'),
   published.map((t) => t.risk).join(','));

const result = await published[0].execute(
  { logger: nullLogger, signal: new AbortController().signal }, { schema: 'public' },
);
ok('calling the published tool reaches the server',
  result.summary === 'tables in public: users, rides', result.summary);

const broken = await provider.healthCheck(
  { ...integration, id: 'int_2', config: { command: '/nonexistent/server', args: [] } },
  { logger: nullLogger, clock, exec: null, signal: new AbortController().signal },
);
ok('a server that will not start is unavailable, not an exception', broken.state === 'unavailable', broken.detail.slice(0, 60));
ok('a broken integration publishes nothing',
  provider.tools({ ...integration, id: 'int_2' }).length === 0);

console.log('\n' + '─'.repeat(60));
console.log(failures.length === 0
  ? `ALL ${passed} MCP INTEGRATION CHECKS PASSED`
  : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
