# syntax=docker/dockerfile:1.7
# ArdentStudio service image. Repository root context; only public package inputs.
# State lives in the /data volume (studio.sqlite and blobs/), which is the one backup unit.
ARG NODE_IMAGE=node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${NODE_IMAGE} AS build
WORKDIR /build
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json tsconfig.build.json README.md LICENSE NOTICE ./
COPY src ./src
COPY docs/openapi-browser.json ./docs/openapi-browser.json
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 \
    && npm run build \
    && npm prune --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
    && node -e "const D=require('better-sqlite3'); new D(':memory:').close()"

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="ardent-studio" \
      org.opencontainers.image.description="Ardent Project Studio: team assignment, conversation room and deliverable review for Ardent agents" \
      org.opencontainers.image.source="https://github.com/ChefTaco/ArdentStudio" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production ARDENT_STUDIO_HOST=0.0.0.0 ARDENT_STUDIO_PORT=8097 ARDENT_STUDIO_DATA=/data
# The runtime never invokes a package manager: drop the bundled npm, npx, corepack and yarn and the
# apt tooling so their unpatched copies do not ship. dpkg and its database stay for package inventory.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && dpkg --purge --force-remove-protected --force-remove-essential apt libapt-pkg6.0 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/log/apt \
 && mkdir /data && chown node:node /data && chmod 0700 /data
WORKDIR /app
COPY --from=build --chown=node:node /build/package.json ./package.json
COPY --from=build --chown=node:node /build/node_modules ./node_modules
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
