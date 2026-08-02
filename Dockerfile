FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app
RUN chown bun:bun /app

USER bun

COPY --chown=bun:bun package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --chown=bun:bun tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts/provision-runtime-role.ts scripts/migrate.ts ./scripts/
COPY --chown=bun:bun public ./public

ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "src/main.ts"]
