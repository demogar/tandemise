# Integrations

An integration is a service a mission may reach. Every one of them arrives as
brokered tools, so policy, risk classification, approval and the audit trail
apply the same way regardless of who wrote the tool.

| Transport | What it is | Status |
| --- | --- | --- |
| `cli` | A CLI that is already logged in — `gh` | GitHub |
| `mcp` | Any MCP server | Generic |
| `browser` | A real browser session, allowlisted per domain | Built in |
| `desktop` | macOS app control | Built in |

## MCP: any server, by configuration

Tandemise speaks MCP in both directions. It *serves* a worker its granted tools,
and it *connects* to servers other people wrote. The second is what makes an
integration list you control rather than one this repository controls.

```jsonc
{
  "providerId": "mcp",
  "name": "supabase",
  "config": {
    "command": "npx",
    "args": ["-y", "@supabase/mcp-server-supabase@latest", "--read-only",
             "--project-ref=<your-project-ref>"],
    "env": { "SUPABASE_ACCESS_TOKEN": "..." },
    "capability": "supabase.call",
    "risk": "read"
  }
}
```

Tools are discovered when the integration is health-checked and published under
`<integration name>.<tool name>` — so the example above gives a worker
`supabase.list_tables`, with the server's own parameter schema preserved rather
than flattened to "an object".

**One capability per server, not per tool.** The person granting access is
deciding about the server — "this mission may talk to Supabase" — and a
capability per tool would be a permission surface nobody could reason about. Set
`risk` to what the server can actually do: `read` for a read-only connection,
`external_write` when it can change something.

## GitHub

Already the `cli` transport, through `gh`, deliberately: the CLI is already
authenticated, so Tandemise never holds a GitHub token. Tools today are
`github.repo.view`, `github.issue.list`, `github.issue.view`,
`github.issue.create`, `github.pr.list`, `github.pr.view`, `github.pr.create`,
`github.pr.comment` and `github.checks.list`.

If you want something `gh` can do that is not in that list, an `mcp` integration
pointed at the GitHub MCP server covers it without waiting for a provider here.

## Design tools

There is no Figma or Canva provider, and for most design work there should not
be: a `human` step in a workflow is the honest model — you make the design in
the tool you already prefer and paste back the link, which becomes the artifact
the next task reads. Where a design tool does publish an MCP server, add it as
one and the tools appear like any other.

## Secrets

A raw secret is never stored in the database. `secretRef` names an entry in the
OS credential store. Note the limit today: the `mcp` transport passes `env` from
the config, which is the right place for a project ref or a region and the wrong
place for a token — see `KNOWN_LIMITATIONS.md`.
