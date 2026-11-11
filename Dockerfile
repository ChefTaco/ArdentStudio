# syntax=docker/dockerfile:1.7
# ArdentStudio service image. Repository root context; only public package inputs.
# State lives in the /data volume (studio.sqlite and blobs/), which is the one backup unit.
ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.1-1@sha256:7671ab0a702c273c37a84d089ba6fe821c6d85cbeab888e7e43522a057da5e6d
ARG NODE_IMAGE=node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
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
