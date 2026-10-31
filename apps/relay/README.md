# Tandemise relay

An optional, slim, self-hosted server for a team using Tandemise
(design: `docs/superpowers/specs/2026-10-30-relay-design.md`). It tells every
connected daemon who is working on which tracker item, keeps the team's
members and their per-computer tokens, and holds raw webhooks for a daemon
to pull. It runs no agents, stores no work, and is never required: working
solo needs no relay, and losing it never stops local work.

One container, one SQLite file, no other services.

## Bring it up

```sh
cp apps/relay/env.example apps/relay/.env   # set RELAY_PUBLIC_URL (https://) and RELAY_TEAM_NAME
docker compose -f apps/relay/compose.yaml up -d --build
docker compose -f apps/relay/compose.yaml logs relay
```

The first start prints one admin invite, once:

```
Admin invite: TRI-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX
```

In Tandemise: **Settings → Team relay → Connect**, then the relay's address
and that code. **Bring my local data** moves your active claims, webhook
addresses and unread webhooks up to the new relay.

`RELAY_PUBLIC_URL` must be `https://` unless the relay only listens on
loopback. For automatic certificates, set `RELAY_PUBLIC_HOST` and add the
TLS override, which adds Caddy (ports 80 and 443), publishes the relay on
`127.0.0.1` only and has it trust Caddy's `X-Forwarded-For` — by
construction, nothing to remember:

```sh
docker compose -f apps/relay/compose.yaml -f apps/relay/compose.tls.yaml up -d --build
```

A LAN-only setup over plain `http://` needs `RELAY_INSECURE_HTTP=1`; the relay
warns on every start, and each daemon must tick **I understand this is
unencrypted**.

## Invite people

Admins invite from the desktop (**Team → Invite someone**). When the log with
the first code is gone, make another admin invite in the container:

```sh
docker compose -f apps/relay/compose.yaml exec relay tandemise-relay invite --role admin
```

Codes work once and expire after 7 days (`--days 1..30`). Removing a member
or revoking a computer closes its connection at once.

## Back up, restore, upgrade

- **Back up**: the `relay-data` volume, or a JSON-lines export:
  `docker compose -f apps/relay/compose.yaml exec relay tandemise-relay export > relay.jsonl`
- **Restore** into an empty relay: copy the file into the container and run
  `tandemise-relay import <file>`.
- **Upgrade**: pull or rebuild the image and `up -d` again; the schema
  migrates at boot. `docker compose down && up -d` keeps the data (it is on
  the volume).
- **Revoke a computer** from the shell: `tandemise-relay revoke <deviceId>`.

## Configuration

Every variable is in `env.example`, with its default.

## What it stores

Members, a SHA-256 of each device token and invite code, active and ended
claims (tracker key, title and URL; no mission content), presence (online or
away, no activity text), webhook addresses, and webhook requests as received
until a daemon acks them (bodies are deleted on ack). It sends no CORS
headers and never logs a webhook's body or headers.
