FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS builder

WORKDIR /app
RUN chown bun:bun /app
USER bun

COPY --chown=bun:bun package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY --chown=bun:bun tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts/prepare-sentry-release.ts scripts/provision-runtime-role.ts scripts/migrate.ts ./scripts/
RUN bun run build:production && cp "$(bun -e 'console.log(require("@sentry/cli").getPath())')" dist/commands/sentry-cli

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app
RUN chown bun:bun /app
USER bun

COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun public ./public

ENV NODE_ENV=production
ENV PATH="/app/dist/commands:${PATH}"

EXPOSE 3000

CMD ["sh", "-c", "unset SENTRY_AUTH_TOKEN SENTRY_FORCE_ENV_TOKEN SENTRY_ORG SENTRY_PROJECT SENTRY_URL SENTRY_NON_PRODUCTION_DSN; exec bun --preload ./dist/preload.js dist/main.js"]
