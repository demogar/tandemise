import { createHash, randomBytes } from 'node:crypto';
import type {
  AuthorizationRequest, AuthorizationStart, IntegrationAuthorizer, IntegrationCredential,
} from '@tandemise/integrations-core';
import { errorMessage } from '@tandemise/shared';

/**
 * OAuth for hosted MCP servers, the way the MCP authorization spec describes it:
 * OAuth 2.1 authorization code with PKCE, discovered rather than configured.
 *
 *   1. Ask the server. An unauthenticated request is answered 401 with a
 *      `WWW-Authenticate` header naming its protected-resource metadata
 *      (RFC 9728).
 *   2. That metadata names the authorization server, whose own metadata
 *      (RFC 8414, or OpenID discovery) gives the endpoints.
 *   3. Register this install as a client on the spot (RFC 7591). No client id is
 *      shipped with Tandemise and none is set up per vendor - which is what makes
 *      "Connect Figma" one click rather than a developer-portal errand.
 *   4. Send the user to consent with a PKCE challenge, receive the code on a
 *      loopback redirect (RFC 8252), exchange it, and bind the token to the
 *      server with the `resource` parameter (RFC 8707) so it cannot be replayed
 *      against a different one.
 *
 * Verified against the live servers the connectors point at before any of this
 * was written: Figma, Canva, Linear, Notion, Sentry, Supabase, Vercel and
 * Atlassian all publish this chain and accept dynamic registration.
 */

export interface AuthorizationServer {
  /** The canonical resource the token is for. */
  readonly resource: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | null;
  readonly scopes: readonly string[];
  readonly authMethods: readonly string[];
}

/** What the token-bearing credential remembers, so it can be refreshed without the user. */
interface CredentialData {
  readonly refreshToken: string | null;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly authMethod: string;
  readonly resource: string;
  readonly scope: string | null;
}

type Fetch = typeof fetch;

/** A token endpoint's refusal, carrying its OAuth error code when it sent one. */
class TokenEndpointError extends Error {
  constructor(readonly code: string | null, message: string) {
    super(message);
    this.name = 'TokenEndpointError';
  }
}

const CLIENT_NAME = 'Tandemise';

export class McpOAuthAuthorizer implements IntegrationAuthorizer {
  constructor(private readonly fetchImpl: Fetch = fetch) {}

  async begin(request: AuthorizationRequest): Promise<AuthorizationStart> {
    const url = serverUrlOf(request.config);
    const server = await discoverAuthorizationServer(url, this.fetchImpl, request.signal);
    if (server.registrationEndpoint === null) {
      throw new Error(
        `${new URL(url).host} does not let apps register themselves, so it cannot be connected with one click. `
        + 'It needs a client registered with the vendor first.',
      );
    }
    const client = await registerClient(server, request.redirectUri, this.fetchImpl, request.signal);
    const configured = request.config['scopes'];
    const scopes = Array.isArray(configured) ? configured.map(String) : server.scopes;
    const verifier = base64url(randomBytes(32));

    const authorize = new URL(server.authorizationEndpoint);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', client.clientId);
    authorize.searchParams.set('redirect_uri', request.redirectUri);
    authorize.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()));
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', request.state);
    authorize.searchParams.set('resource', server.resource);
    if (scopes.length > 0) authorize.searchParams.set('scope', scopes.join(' '));

    return {
      authorizationUrl: authorize.toString(),
      session: {
        verifier,
        redirectUri: request.redirectUri,
        tokenEndpoint: server.tokenEndpoint,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        authMethod: client.authMethod,
        resource: server.resource,
      },
    };
  }

  async complete(
    session: Readonly<Record<string, unknown>>,
    callback: URLSearchParams,
    signal: AbortSignal,
  ): Promise<IntegrationCredential> {
    const denied = callback.get('error');
    if (denied !== null) {
      const description = callback.get('error_description');
      throw new Error(denied === 'access_denied'
        ? 'You declined access, so nothing was connected.'
        : `The authorization server refused: ${description ?? denied}.`);
    }
    const code = callback.get('code');
    if (code === null) throw new Error('The authorization server returned no code.');

    const data: CredentialData = {
      refreshToken: null,
      tokenEndpoint: str(session['tokenEndpoint']),
      clientId: str(session['clientId']),
      clientSecret: typeof session['clientSecret'] === 'string' ? session['clientSecret'] : null,
      authMethod: str(session['authMethod']),
      resource: str(session['resource']),
      scope: null,
    };
    return this.#token(data, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: str(session['redirectUri']),
      code_verifier: str(session['verifier']),
    }, signal);
  }

  async refresh(credential: IntegrationCredential, signal: AbortSignal): Promise<IntegrationCredential | null> {
    const data = credential.data as unknown as CredentialData;
    if (!data.refreshToken) return null;
    try {
      const refreshed = await this.#token(data, { grant_type: 'refresh_token', refresh_token: data.refreshToken }, signal);
      // Rotation is optional: a server that does not issue a new refresh token
      // expects the old one to keep working.
      const next = refreshed.data as unknown as CredentialData;
      return next.refreshToken === null
        ? { ...refreshed, data: { ...next, refreshToken: data.refreshToken } }
        : refreshed;
    } catch (e) {
      // Only the authorization server saying the grant is dead means "reconnect".
      // A network blip, a 5xx or a timeout is transient, and reporting it as a
      // revoked account would send the user to re-consent for nothing.
      if (e instanceof TokenEndpointError && (e.code === 'invalid_grant' || e.code === 'invalid_client' || e.code === 'unauthorized_client')) {
        return null;
      }
      throw e;
    }
  }

  async #token(data: CredentialData, grant: Record<string, string>, signal: AbortSignal): Promise<IntegrationCredential> {
    const body = new URLSearchParams({ ...grant, resource: data.resource });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (data.clientSecret !== null && data.authMethod === 'client_secret_basic') {
      headers['authorization'] = `Basic ${Buffer.from(
        `${encodeURIComponent(data.clientId)}:${encodeURIComponent(data.clientSecret)}`,
      ).toString('base64')}`;
    } else {
      body.set('client_id', data.clientId);
      if (data.clientSecret !== null) body.set('client_secret', data.clientSecret);
    }

    const response = await this.fetchImpl(data.tokenEndpoint, { method: 'POST', headers, body, signal });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || payload === null || typeof payload['access_token'] !== 'string') {
      const reason = payload?.['error_description'] ?? payload?.['error'] ?? `HTTP ${response.status}`;
      throw new TokenEndpointError(
        typeof payload?.['error'] === 'string' ? payload['error'] : null,
        `The token exchange failed: ${String(reason)}.`,
      );
    }
    const expiresIn = Number(payload['expires_in']);
    return {
      accessToken: payload['access_token'],
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null,
      account: null,
      data: {
        ...data,
        refreshToken: typeof payload['refresh_token'] === 'string' ? payload['refresh_token'] : null,
        scope: typeof payload['scope'] === 'string' ? payload['scope'] : data.scope,
      } satisfies CredentialData,
    };
  }
}

/** Follows a server's advertised metadata to its authorization server. */
export async function discoverAuthorizationServer(
  serverUrl: string,
  fetchImpl: Fetch,
  signal: AbortSignal,
): Promise<AuthorizationServer> {
  const server = new URL(serverUrl);
  const probe = await fetchImpl(serverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    signal,
  }).catch((e: unknown) => {
    throw new Error(`Could not reach ${server.host}: ${errorMessage(e)}`);
  });
  await probe.body?.cancel().catch(() => undefined);
  const challenge = parseChallenge(probe.headers.get('www-authenticate') ?? '');

  const resourceMetadata = await firstJson(fetchImpl, signal, [
    challenge['resource_metadata'],
    wellKnown(server, 'oauth-protected-resource', true),
    wellKnown(server, 'oauth-protected-resource', false),
  ]);
  const issuers = asStrings(resourceMetadata?.['authorization_servers']);
  const issuer = new URL(issuers[0] ?? server.origin);

  const metadata = await firstJson(fetchImpl, signal, [
    wellKnown(issuer, 'oauth-authorization-server', true),
    wellKnown(issuer, 'openid-configuration', true),
    `${issuer.toString().replace(/\/$/, '')}/.well-known/openid-configuration`,
    wellKnown(issuer, 'oauth-authorization-server', false),
  ], (json) => typeof json['authorization_endpoint'] === 'string');
  if (metadata === null) {
    throw new Error(`${server.host} does not publish OAuth metadata, so it cannot be connected this way.`);
  }

  // Everything above is what the server *says*. None of it is trusted until it
  // is checked, because a token is sent wherever this points: a custom server at
  // evil.example that advertised Figma's resource and Figma's authorization
  // server would get the user to consent on the real Figma page and then
  // receive a Figma token as a bearer header.
  const resource = typeof resourceMetadata?.['resource'] === 'string' ? resourceMetadata['resource'] : serverUrl;
  if (!resourceCovers(resource, serverUrl)) {
    throw new Error(`${server.host} claims to be ${resource}, which is not the server being connected. Refusing to connect.`);
  }
  const issuerClaim = metadata['issuer'];
  if (typeof issuerClaim === 'string' && trimSlash(issuerClaim) !== trimSlash(issuer.toString())) {
    throw new Error(`The authorization server's metadata names a different issuer (${issuerClaim}). Refusing to connect.`);
  }
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'] as const) {
    const endpoint = metadata[key];
    if (typeof endpoint === 'string' && !isSecureEndpoint(endpoint)) {
      throw new Error(`${key.replace('_', ' ')} is not https (${endpoint}). Refusing to send credentials to it.`);
    }
  }
  const methods = asStrings(metadata['code_challenge_methods_supported']);
  if (!methods.includes('S256')) {
    throw new Error(`${new URL(String(metadata['authorization_endpoint'])).host} does not support PKCE with S256, which connecting requires.`);
  }

  const challengeScopes = challenge['scope']?.split(' ').filter(Boolean) ?? [];
  return {
    resource,
    authorizationEndpoint: String(metadata['authorization_endpoint']),
    tokenEndpoint: String(metadata['token_endpoint']),
    registrationEndpoint: typeof metadata['registration_endpoint'] === 'string' ? metadata['registration_endpoint'] : null,
    // The scope a server asks for in its challenge is the most specific signal;
    // failing that, what its resource metadata says it supports.
    scopes: challengeScopes.length > 0 ? challengeScopes : asStrings(resourceMetadata?.['scopes_supported']),
    authMethods: asStrings(metadata['token_endpoint_auth_methods_supported']),
  };
}

async function registerClient(
  server: AuthorizationServer,
  redirectUri: string,
  fetchImpl: Fetch,
  signal: AbortSignal,
): Promise<{ clientId: string; clientSecret: string | null; authMethod: string }> {
  // A public client is the honest description of a desktop app: it cannot keep
  // a secret. Ask for one only when the server will not register public clients.
  const publicClient = server.authMethods.length === 0 || server.authMethods.includes('none');
  const response = await fetchImpl(server.registrationEndpoint!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: publicClient ? 'none' : 'client_secret_post',
    }),
    signal,
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || payload === null || typeof payload['client_id'] !== 'string') {
    const reason = payload?.['error_description'] ?? payload?.['error'] ?? `HTTP ${response.status}`;
    throw new Error(`Registering with ${new URL(server.authorizationEndpoint).host} failed: ${String(reason)}.`);
  }
  return {
    clientId: payload['client_id'],
    clientSecret: typeof payload['client_secret'] === 'string' ? payload['client_secret'] : null,
    authMethod: typeof payload['token_endpoint_auth_method'] === 'string'
      ? payload['token_endpoint_auth_method']
      : publicClient ? 'none' : 'client_secret_post',
  };
}

/**
 * Whether a protected-resource identifier covers the server URL (RFC 9728 §3.3).
 * Same origin, and the server's path within the resource's - servers identify
 * as their exact URL or as their origin, and both are accepted.
 */
function resourceCovers(resource: string, serverUrl: string): boolean {
  try {
    const r = new URL(resource);
    const s = new URL(serverUrl);
    const rPath = r.pathname.replace(/\/$/, '');
    const sPath = s.pathname.replace(/\/$/, '');
    return r.origin === s.origin && (sPath === rPath || sPath.startsWith(`${rPath}/`) || rPath === '');
  } catch {
    return false;
  }
}

/** https, or http only to this machine (a local development server). */
function isSecureEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** `Bearer realm="OAuth", resource_metadata="https://…", scope="a b"` → its parameters. */
export function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of header.matchAll(/([a-zA-Z_]+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    out[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return out;
}

/** RFC 8414/9728 place the path after the well-known segment; some servers only serve the root. */
function wellKnown(base: URL, name: string, withPath: boolean): string {
  const path = withPath ? base.pathname.replace(/\/$/, '') : '';
  return `${base.origin}/.well-known/${name}${path}`;
}

async function firstJson(
  fetchImpl: Fetch,
  signal: AbortSignal,
  candidates: readonly (string | undefined)[],
  accept: (json: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown> | null> {
  for (const candidate of new Set(candidates.filter((c): c is string => typeof c === 'string' && c !== ''))) {
    try {
      const response = await fetchImpl(candidate, { headers: { accept: 'application/json' }, signal });
      if (!response.ok) continue;
      const json = await response.json() as unknown;
      if (typeof json === 'object' && json !== null && accept(json as Record<string, unknown>)) {
        return json as Record<string, unknown>;
      }
    } catch (e) {
      if (signal.aborted) throw e;
    }
  }
  return null;
}

function serverUrlOf(config: Readonly<Record<string, unknown>>): string {
  const url = config['url'];
  if (typeof url !== 'string') throw new Error('This integration has no server URL to connect to.');
  return url;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function str(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The connect attempt is missing part of its state.');
  return value;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
