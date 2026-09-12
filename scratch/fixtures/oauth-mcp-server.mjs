/**
 * A hosted MCP server behind an OAuth 2.1 authorization server, both real HTTP,
 * both strict: registration must precede authorization, the PKCE verifier must
 * hash to the challenge, the redirect and resource must match, refresh tokens
 * rotate, and a revoked access token is answered 401 with an RFC 9728 challenge.
 *
 * Built to fail the client in every way a real vendor would, so a passing check
 * means the flow works rather than that the fixture is lenient.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export async function startOAuthMcpServer({ accessTtlSeconds = 3600 } = {}) {
  const clients = new Map();       // client_id -> { redirectUris }
  const codes = new Map();         // code -> { clientId, redirectUri, challenge, resource }
  const access = new Set();
  const refresh = new Map();       // refresh token -> clientId
  const stats = { registrations: 0, authorizations: 0, exchanges: 0, refreshes: 0, toolCalls: 0, unauthorized: 0 };
  let deny = false;
  let claimedResource = null;     // a server lying about which resource it is
  let tokenOutage = false;        // the token endpoint answering 500
  let serverRequestFirst = false; // a server request sharing our id, ahead of the reply
  let base = '';
  const token = () => randomBytes(18).toString('base64url');

  const json = (res, status, body, headers = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const resource = `${base}/mcp`;

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, { resource: claimedResource ?? resource, authorization_servers: [base], scopes_supported: ['read', 'write'] });
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      const body = JSON.parse(await readBody(req));
      if (!Array.isArray(body.redirect_uris) || !body.redirect_uris.every((u) => u.startsWith('http://127.0.0.1:'))) {
        return json(res, 400, { error: 'invalid_redirect_uri' });
      }
      const id = `client_${token()}`;
      clients.set(id, { redirectUris: body.redirect_uris });
      stats.registrations++;
      return json(res, 201, { client_id: id, token_endpoint_auth_method: 'none', redirect_uris: body.redirect_uris });
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const p = url.searchParams;
      const client = clients.get(p.get('client_id'));
      const redirect = p.get('redirect_uri');
      if (!client || !client.redirectUris.includes(redirect)) return json(res, 400, { error: 'unregistered client or redirect' });
      if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return json(res, 400, { error: 'pkce required' });
      if (p.get('resource') !== resource) return json(res, 400, { error: 'invalid_target' });
      const back = new URL(redirect);
      back.searchParams.set('state', p.get('state'));
      if (deny) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = token();
        codes.set(code, { clientId: p.get('client_id'), redirectUri: redirect, challenge: p.get('code_challenge'), resource });
        back.searchParams.set('code', code);
      }
      stats.authorizations++;
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const p = new URLSearchParams(await readBody(req));
      if (tokenOutage) return json(res, 503, { error: 'temporarily_unavailable' });
      if (p.get('resource') !== resource) return json(res, 400, { error: 'invalid_target' });
      const issue = (clientId) => {
        const a = token(); const r = token();
        access.add(a); refresh.set(r, clientId);
        return { access_token: a, token_type: 'Bearer', expires_in: accessTtlSeconds, refresh_token: r, scope: 'read write' };
      };
      if (p.get('grant_type') === 'authorization_code') {
        const code = codes.get(p.get('code'));
        codes.delete(p.get('code'));
        if (!code) return json(res, 400, { error: 'invalid_grant', error_description: 'code unknown or reused' });
        const hashed = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (hashed !== code.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verifier mismatch' });
        if (p.get('redirect_uri') !== code.redirectUri || p.get('client_id') !== code.clientId) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'redirect or client mismatch' });
        }
        stats.exchanges++;
        return json(res, 200, issue(code.clientId));
      }
      if (p.get('grant_type') === 'refresh_token') {
        const clientId = refresh.get(p.get('refresh_token'));
        // Rotation: a refresh token works exactly once.
        refresh.delete(p.get('refresh_token'));
        if (!clientId || clientId !== p.get('client_id')) return json(res, 400, { error: 'invalid_grant' });
        stats.refreshes++;
        return json(res, 200, issue(clientId));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/mcp') {
      if (req.method === 'DELETE') return res.writeHead(204).end();
      const auth = req.headers.authorization ?? '';
      if (!access.has(auth.replace(/^Bearer /, ''))) {
        stats.unauthorized++;
        return json(res, 401, { error: 'invalid_token' }, {
          'www-authenticate': `Bearer realm="OAuth", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
        });
      }
      const msg = JSON.parse(await readBody(req));
      if (msg.id === undefined) return res.writeHead(202).end();
      const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
      if (msg.method === 'initialize') {
        return json(res, 200, reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture-tracker', version: '2.0.0' } }),
          { 'mcp-session-id': 'sess-1' });
      }
      if (req.headers['mcp-session-id'] !== 'sess-1') return json(res, 400, { error: 'missing session' });
      if (msg.method === 'tools/list') {
        const page2 = msg.params?.cursor === 'p2';
        return json(res, 200, reply(page2
          ? { tools: [{ name: 'create_issue', description: 'Create an issue.', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }] }
          : { tools: [{ name: 'list_issues', description: 'List issues.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }], nextCursor: 'p2' }));
      }
      if (msg.method === 'tools/call') {
        stats.toolCalls++;
        // Streamed, with a notification ahead of the answer, as hosted servers do.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (serverRequestFirst) {
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, method: 'ping' })}\n\n`);
        }
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
        res.end(`event: message\ndata: ${JSON.stringify(reply({ content: [{ type: 'text', text: `${msg.params.name} ok: ${JSON.stringify(msg.params.arguments)}` }] }))}\n\n`);
        return;
      }
      return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } });
    }
    res.writeHead(404).end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, url: `${base}/mcp`, stats,
    revokeAccessTokens: () => access.clear(),
    revokeRefreshTokens: () => refresh.clear(),
    setDeny: (v) => { deny = v; },
    claimResource: (v) => { claimedResource = v; },
    setTokenOutage: (v) => { tokenOutage = v; },
    setServerRequestFirst: (v) => { serverRequestFirst = v; },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}
