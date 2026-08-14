FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS builder

WORKDIR /app
RUN chown bun:bun /app
USER bun

COPY --chown=bun:bun package.json bun.lock bunfig.toml ./
COPY --chown=bun:bun apps/server/package.json ./apps/server/package.json
COPY --chown=bun:bun apps/web/package.json ./apps/web/package.json
RUN bun install --frozen-lockfile --ignore-scripts

COPY --chown=bun:bun tsconfig.json tsconfig.base.json ./
COPY --chown=bun:bun apps/server ./apps/server
RUN bun run build:production && cp "$(bun --cwd apps/server -e 'console.log(require("@sentry/cli").SentryCli.getPath())')" apps/server/dist/commands/sentry-cli

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app
RUN chown bun:bun /app
USER bun

COPY --from=builder --chown=bun:bun /app/apps/server/dist ./dist

ENV NODE_ENV=production
ENV PATH="/app/dist/commands:${PATH}"

EXPOSE 3000

CMD ["sh", "-c", ": \"${RAILWAY_GIT_COMMIT_SHA:?RAILWAY_GIT_COMMIT_SHA is required}\"; export SENTRY_RELEASE=\"fidy@${RAILWAY_GIT_COMMIT_SHA}\"; unset SENTRY_AUTH_TOKEN SENTRY_FORCE_ENV_TOKEN SENTRY_ORG SENTRY_PROJECT SENTRY_URL SENTRY_NON_PRODUCTION_DSN; exec bun --preload ./dist/preload.js dist/main.js"]
