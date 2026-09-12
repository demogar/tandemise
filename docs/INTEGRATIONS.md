# Integrations

An integration is a tool your project already uses — Figma, Linear, Supabase,
GitHub — that workers may use on your behalf. Every one arrives as brokered
tools, so policy, risk classification, approval and the audit trail apply the
same way no matter who wrote the tool.

| Transport | What it is | How you connect it |
| --- | --- | --- |
| `mcp` (hosted) | A vendor's MCP server over HTTPS | **Connect** — sign in and allow access in your browser |
| `mcp` (local) | An MCP server run as a process | **Custom server → Run a command** |
| `cli` | A CLI that is already logged in — `gh` | **Use gh login** |
| `browser` | A real browser session, allowlisted per domain | Built in |
| `desktop` | macOS app control | Built in |

## Connecting an app

Open **Integrations**, pick an app, press **Connect**. Your browser opens the
app's own sign-in page; when you allow access, the app shows as connected. No
token is pasted, and nothing has to be registered with the vendor first.

| App | Used by | Capability |
| --- | --- | --- |
| Figma, Canva | Designers | `design` |
| Linear, Notion, Jira & Confluence | Product, architecture, release | `planning` |
| Supabase | Developers (reviewers read) | `database` |
| Vercel | Release (QA reads) | `deploy` |
| Sentry | Release (developers and QA read) | `monitoring` |

Every connector was checked against the live server before it was added.

### How it works

The flow follows the MCP authorization spec — OAuth 2.1 authorization code with
PKCE — and discovers everything instead of configuring it:

1. An unauthenticated request to the server is answered `401` with a challenge
   naming its protected-resource metadata (RFC 9728).
2. That names the authorization server, whose metadata gives the endpoints
   (RFC 8414 / OpenID discovery).
3. Tandemise registers itself as a client on the spot (RFC 7591). This is why no
   client id ships with the app and none is set up per vendor.
4. You consent in the browser. The redirect lands on a **loopback listener that
   exists for that one attempt** (RFC 8252) — never on the daemon's API port,
   whose routes all require the desktop's bearer token. A request without the
   attempt's unguessable `state` is refused and does not end the attempt.
5. The code is exchanged with the PKCE verifier; the token is bound to the
   server with `resource` (RFC 8707).

The credential — access token, refresh token, the registered client — is one
entry in the macOS Keychain. The database row holds only its reference. Access
tokens are refreshed a minute before they lapse, once per integration even when
several tool calls hit an expired token at the same moment (a server that
rotates refresh tokens would otherwise disconnect itself). A server that rejects
a token mid-call gets one refresh and one retry. If the refresh token is revoked,
the integration shows **Reconnect**, which keeps the same row and name.

### Who can use what

Connecting Figma gives the designer Figma — not every worker. A connector
publishes its tools under one capability, and only the roles that do that kind
of work hold it. Tools the server marks read-only (`readOnlyHint`) are published
under `<capability>.read` at risk `read`, so reading a Linear issue never stops
for approval; anything that changes data follows the project's autonomy setting
for external writes.

The read-only split is trusted only for curated connectors. A custom server's
annotations are its own unverified claims, so every one of its tools counts as
a change.

### A server that is not in the catalog

**Custom server** takes any hosted MCP server that supports OAuth with dynamic
registration: its URL, a short name (tools appear as `name.tool`), and who uses
it — which decides the capability, and so which workers see it.

## Local MCP servers, by configuration

Tandemise speaks MCP in both directions: it *serves* a worker its granted tools,
and it *connects* to servers other people wrote. A server run as a process is
added by configuration:

```jsonc
{
  "providerId": "mcp",
  "name": "supabase",
  "config": {
    "command": "npx",
    "args": ["-y", "@supabase/mcp-server-supabase@latest", "--read-only",
             "--project-ref=<your-project-ref>"],
    "capability": "database",
    "risk": "read"
  }
}
```

Tools are discovered at the health check and published as
`<integration name>.<tool name>`, with the server's own parameter schema
preserved. `risk` is one of `read`, `write_reversible`, `external_side_effect`,
`destructive`, `financial`, `release`.

## GitHub

The `cli` transport, through `gh`, deliberately: the CLI is already signed in on
most developers' machines, so Tandemise never holds a GitHub token. GitHub's
hosted MCP server does not allow dynamic registration, so it cannot be a
one-click connector anyway. Run `gh auth login`, then **Use gh login**.

Who may use it is a decision, not a side effect: **development** may push a
branch, open a pull request and comment on one; **review** may read and comment;
**release** may push and open a pull request. Every one of those is an external
write, so the *Writes that leave this machine* autonomy setting decides whether
each call asks you first - set it to Ask or Deny to keep every push and PR
behind a click.

## Design tools

Designers produce the design itself. The Product Designer role holds `design`,
sees whichever of Figma and Canva are connected, and asks you with `ask_human`
which to use when more than one fits — or, when none is connected, whether to
connect one or write a detailed brief instead.

Claude Design publishes no MCP server that could be verified, so it is not a
connector. The designer can drive it through the `browser` integration.
