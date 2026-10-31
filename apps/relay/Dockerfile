# The optional team relay (docs/superpowers/specs/2026-10-30-relay-design.md, §Deployment).
# Build from the repository root:
#
#   docker build -f apps/relay/Dockerfile -t tandemise-relay .
#
# or `docker compose -f apps/relay/compose.yaml up -d --build`.

# ---- build: compile only what the relay needs
FROM node:22-bookworm AS build
WORKDIR /src
COPY . .
# --ignore-scripts: no Electron or Playwright downloads; nothing here runs them.
RUN npm ci --ignore-scripts --no-audit --no-fund
# api-contract references shared and domain, so tsc builds them too; at run time only its zod-only relay subpath loads.
RUN npx tsc -b packages/api-contract packages/coordination apps/relay
# Every workspace's package.json and nothing else, so the runtime stage's npm can read the lockfile.
RUN mkdir -p /manifests && cp package.json package-lock.json /manifests/ \
 && for f in packages/*/package.json apps/*/package.json; do mkdir -p "/manifests/$(dirname "$f")"; cp "$f" "/manifests/$f"; done

# ---- runtime: production dependencies of three workspaces, no compiler
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Only three workspaces are installed, production dependencies only. better-sqlite3 (13+, N-API)
# carries prebuilt binaries for every platform and libc in its package and loads the matching one,
# so nothing is compiled or downloaded and the image carries no compiler.
COPY --from=build /manifests/ ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
      -w @tandemise/relay -w @tandemise/coordination -w @tandemise/api-contract \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*
COPY --from=build /src/packages/api-contract/dist ./packages/api-contract/dist
COPY --from=build /src/packages/coordination/dist ./packages/coordination/dist
COPY --from=build /src/apps/relay/dist ./apps/relay/dist
RUN mkdir -p /data && chown node:node /data && ln -s /app/apps/relay/dist/cli.js /usr/local/bin/tandemise-relay && chmod +x /app/apps/relay/dist/cli.js

USER node
ENV RELAY_DB=/data/relay.db \
    RELAY_PORT=8787
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8787)+'/relay/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "/app/apps/relay/dist/cli.js"]
CMD ["serve"]
