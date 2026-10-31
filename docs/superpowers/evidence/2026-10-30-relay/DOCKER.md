# Relay: Docker proof

Run by hand on 2026-10-30 (Linux, Docker 29.9 / Compose v5.6), from this
branch, as the plan's Task 10 step 4 asks. CI builds the image, starts it and
checks its size on every PR (`relay-image` job in `.github/workflows/ci.yml`).

```sh
RELAY_PUBLIC_URL=http://127.0.0.1:18787 RELAY_INSECURE_HTTP=1 RELAY_PORT=18787 \
  docker compose -p relayproof -f apps/relay/compose.yaml up -d --build
```

1. **Health.** `curl -H 'x-tandemise-relay-api: 1' localhost:18787/relay/v1/health`
   → `{"ok":true,"apiVersion":"1"}`. `docker inspect` → `healthy` (the image's
   own `HEALTHCHECK`).
2. **The invite is in the log, once**, with the insecure-HTTP warning (this
   run used plain HTTP on loopback with `RELAY_INSECURE_HTTP=1`, because the
   container binds `0.0.0.0`):
   ```
   WARNING: RELAY_INSECURE_HTTP=1. This relay serves http://127.0.0.1:18787 unencrypted; …
   Admin invite: TRI-5T4QG-4VWJ7-101WK-0FRWC-QY8JKJ
   ```
3. **One daemon connects and a claim round-trips.**
   `node scratch/relay-docker-proof.mjs connect <invite>` started a daemon from
   this checkout in a fresh home, connected it through
   `POST /v1/coordination/connect`, and started a mission linked to
   `acme/app#42`:
   ```
   connect: 200 connected Team
   start: 200
   relay claim: Ana on github:acme/app#42 (active)
   ```
4. **`docker compose down && up -d` keeps the data** (it is on the
   `relay-data` volume): `node scratch/relay-docker-proof.mjs check`, with the
   same device token, → `after restart: 200 Ana still on github:acme/app#42`.
5. **Size and memory.** Compressed (what a pull downloads):
   `docker save | gzip | wc -c` → 83,994,248 bytes (84 MB; Docker Desktop
   reports content size 84.5 MB), under the 120 MB target. Unpacked on disk it is
   352 MB, most of it the `node:22-bookworm-slim` base (see RULINGS.md). RSS at
   idle, `docker stats` after the round-trip: **30.8 MiB**, under 60 MB.

Torn down with `docker compose -p relayproof -f apps/relay/compose.yaml down -v`.
