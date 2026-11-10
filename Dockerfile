# syntax=docker/dockerfile:1.7
# ArdentStudio service image. Repository root context; only public package inputs.
# State lives in the /data volume (studio.sqlite and blobs/), which is the one backup unit.
ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.0-1@sha256:48948514bce59a27f8ee2a3eabaea0a04cbfa87e087297a52f8501c0d465c84f
ARG NODE_IMAGE=node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${NODE_IMAGE} AS build
WORKDIR /build
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json tsconfig.build.json README.md LICENSE NOTICE ./
COPY src ./src
COPY docs/openapi-browser.json ./docs/openapi-browser.json
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
    && node -e "const {DatabaseSync}=require('@photostructure/sqlite'); new DatabaseSync(':memory:').close()"

FROM ${RUNTIME_IMAGE} AS runtime
USER root
LABEL org.opencontainers.image.title="ardent-studio" \
      org.opencontainers.image.description="Ardent Project Studio: team assignment, conversation room and deliverable review for Ardent agents" \
      org.opencontainers.image.source="https://github.com/ChefTaco/ArdentStudio" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production ARDENT_STUDIO_HOST=0.0.0.0 ARDENT_STUDIO_PORT=8097 ARDENT_STUDIO_DATA=/data
# The shared glibc runtime supplies patched libraries without build tools or npm.
RUN mkdir /data && chown node:node /data && chmod 0700 /data
WORKDIR /app
COPY --from=build --chown=node:node /build/package.json ./package.json
COPY --from=build --chown=node:node /build/node_modules ./node_modules
# Execute the native addon against the final runtime's Node and glibc on each architecture.
RUN node -e "const {DatabaseSync}=require('@photostructure/sqlite'); const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE proof (value TEXT)'); db.prepare('INSERT INTO proof VALUES (?)').run('synthetic'); if(db.prepare('SELECT value FROM proof').get().value !== 'synthetic') process.exit(1); db.close()"
COPY --from=build --chown=node:node /build/dist ./dist
COPY --from=build --chown=node:node /build/docs/openapi-browser.json ./docs/openapi-browser.json
COPY LICENSE NOTICE ./
COPY scripts/container-health.mjs ./healthcheck.mjs
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 CMD ["node", "/app/healthcheck.mjs"]
USER node
VOLUME ["/data"]
EXPOSE 8097
ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["serve"]
