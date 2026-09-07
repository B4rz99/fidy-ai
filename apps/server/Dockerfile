FROM oven/bun:1.4.1-alpine@sha256:2ef545220f7a886f22fcb3f2309bbd6bcf1c0aa04b7d79c31765c7aa4a13aac1 AS builder

WORKDIR /app
RUN chown bun:bun /app
USER bun

COPY --chown=bun:bun package.json bun.lock bunfig.toml ./
COPY --chown=bun:bun apps/server/package.json ./apps/server/package.json
COPY --chown=bun:bun apps/web/package.json ./apps/web/package.json
RUN bun install --frozen-lockfile --ignore-scripts

COPY --chown=bun:bun tsconfig.json tsconfig.base.json ./
COPY --chown=bun:bun apps/server ./apps/server
RUN bun run build:production && cp -L "$(bun --cwd apps/server -e 'console.log(require("@sentry/cli").SentryCli.getPath())')" apps/server/dist/commands/sentry-cli

FROM oven/bun:1.4.1-alpine@sha256:2ef545220f7a886f22fcb3f2309bbd6bcf1c0aa04b7d79c31765c7aa4a13aac1

WORKDIR /app
RUN chown bun:bun /app
USER bun

COPY --from=builder --chown=bun:bun /app/apps/server/dist ./dist

ENV NODE_ENV=production
ENV PATH="/app/dist/commands:${PATH}"

EXPOSE 3000

CMD ["sh", "-c", ": \"${RAILWAY_GIT_COMMIT_SHA:?RAILWAY_GIT_COMMIT_SHA is required}\"; printf '%s' \"${RAILWAY_GIT_COMMIT_SHA}\" | grep -Eq '^[0-9a-f]{40}$' || { echo 'RAILWAY_GIT_COMMIT_SHA must be a full lowercase Git SHA.' >&2; exit 1; }; export SENTRY_RELEASE=\"fidy@${RAILWAY_GIT_COMMIT_SHA}\"; unset SENTRY_AUTH_TOKEN SENTRY_FORCE_ENV_TOKEN SENTRY_ORG SENTRY_PROJECT SENTRY_URL SENTRY_NON_PRODUCTION_DSN; exec bun --preload ./dist/preload.js dist/main.js"]
