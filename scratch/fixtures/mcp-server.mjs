#!/usr/bin/env node
/**
 * A minimal but genuine MCP server, for driving the client against real wire
 * traffic rather than a mock of it. Speaks newline-delimited JSON-RPC on stdio:
 * initialize, tools/list, tools/call.
 */
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(JSON.parse(line));
    nl = buffer.indexOf('\n');
  }
});

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

const TOOLS = [
  {
    name: 'list_tables',
    description: 'List the tables in a schema.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'string', description: 'Schema name' },
        limit: { type: 'integer', description: 'Max rows' },
        verbose: { type: 'boolean' },
        mode: { enum: ['fast', 'full'] },
      },
      required: ['schema'],
    },
  },
  { name: 'ping', description: 'Health probe.', inputSchema: { type: 'object', properties: {} } },
];

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-db', version: '9.9.9' },
      });
    case 'notifications/initialized':
      return;
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args } = params ?? {};
      if (name === 'boom') return reply(id, { content: [{ type: 'text', text: 'it exploded' }], isError: true });
      if (name === 'ping') return reply(id, { content: [{ type: 'text', text: 'pong' }] });
      return reply(id, { content: [{ type: 'text', text: `tables in ${args?.schema}: users, rides` }] });
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } });
  }
}
