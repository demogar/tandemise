import type { Integration } from '@tandemise/domain';
import { token } from '@tandemise/kernel';

/**
 * What an integration authenticates with, once connected.
 *
 * `accessToken` is the only field anything outside the provider reads. `data`
 * is the provider's own - refresh token, the client it registered, the token
 * endpoint - and is opaque to the core, which stores and returns it whole. The
 * whole object lives in the OS credential store and never in the database: the
 * row carries only a reference to it (MVP.md §P8).
 */
export interface IntegrationCredential {
  readonly accessToken: string;
  /** ISO timestamp, or null when the server did not say. */
  readonly expiresAt: string | null;
  /** The account connected, for the UI - "demogar@acme", never a secret. */
  readonly account: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A connect attempt the provider has started and the user has not finished. */
export interface AuthorizationStart {
  /** Where the user's browser goes to consent. */
  readonly authorizationUrl: string;
  /**
   * Everything needed to finish the exchange - PKCE verifier, registered client,
   * endpoints. Held in memory for the life of the attempt, never persisted and
   * never sent to the renderer.
   */
  readonly session: Readonly<Record<string, unknown>>;
}

export interface AuthorizationRequest {
  readonly config: Readonly<Record<string, unknown>>;
  /** A loopback URL owned by this attempt alone (RFC 8252 §7.3). */
  readonly redirectUri: string;
  /** Unguessable, single-use; the callback must echo it back. */
  readonly state: string;
  readonly signal: AbortSignal;
}

/**
 * How a provider connects an account by sending the user through a consent
 * screen, rather than asking them to paste a token (OAuth 2.1 authorization code
 * with PKCE).
 *
 * The provider owns the protocol; the application owns the attempt - the
 * callback listener, the state, where the credential is kept. That split is
 * what lets "Connect Figma" and "Connect Linear" be one flow in the service
 * without the service knowing either exists.
 */
export interface IntegrationAuthorizer {
  begin(request: AuthorizationRequest): Promise<AuthorizationStart>;
  /** Exchanges the callback for a credential. Throws with a readable message on refusal. */
  complete(
    session: Readonly<Record<string, unknown>>,
    callback: URLSearchParams,
    signal: AbortSignal,
  ): Promise<IntegrationCredential>;
  /** Null when the credential cannot be refreshed and the user must reconnect. */
  refresh(credential: IntegrationCredential, signal: AbortSignal): Promise<IntegrationCredential | null>;
}

/**
 * A ready-made integration a person can connect with one click.
 *
 * The configuration is fixed and known to work; what the user supplies is
 * consent, not settings. A connector is the difference between "configure an
 * MCP server" and "Connect Figma".
 */
export interface IntegrationConnector {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Groups the gallery: design, planning, build, deploy, observe. */
  readonly category: string;
  /** Provider that runs it, e.g. `mcp`. */
  readonly providerId: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Whether connecting sends the user through a consent screen. */
  readonly authorization: 'oauth' | 'none';
  /** Which workers can use it, in words: "Designers". Shown on the card. */
  readonly usedBy: string;
  readonly homepage: string;
}

/**
 * A usable access token for an integration, refreshed when it is about to lapse.
 *
 * Providers resolve this rather than reading the credential store, so no
 * provider ever sees a refresh token or needs to know where secrets live.
 * Null means the integration holds no credential - it reuses a logged-in CLI,
 * or the user has not connected it.
 */
export interface IntegrationCredentialSource {
  accessToken(integration: Integration, signal: AbortSignal): Promise<string | null>;
  /** Forces the next `accessToken` to refresh, after a server rejected the current one. */
  invalidate(integration: Integration): void;
}

export const INTEGRATION_CREDENTIALS =
  token<IntegrationCredentialSource>('integrations/credential-source');

/** Thrown by a provider when a server refuses the credential, so the caller can refresh once. */
export class IntegrationUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationUnauthorizedError';
  }
}
