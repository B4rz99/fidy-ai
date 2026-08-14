import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Config, DateTime, Effect, Layer, Option } from "effect";
import { TokenBearer } from "~/core/tokens/model";
import { authenticateTokenBearer } from "~/shell/_shared/authz-live";
import { findUser } from "~/shell/identity/repo";
import { PgLive } from "./client";
import { defaultUserId } from "./development-seed";

const localDatabaseUrl = Config.string("DATABASE_URL");

const testPublicNamespace = {
  PUBLIC_WEB_ORIGIN: "https://fidyapp.com",
  PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
  INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio-test",
} as const;

const runSeedCommand = (
  databaseUrl: string,
  environment: Readonly<Record<string, string>> = {}
): Effect.Effect<{ exitCode: number; stdout: string; stderr: string }> =>
  Effect.gen(function* () {
    const child = yield* Effect.sync(() =>
      Bun.spawn(["bun", "scripts/seed-development.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...testPublicNamespace,
          ...environment,
          DATABASE_URL: databaseUrl,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
    );
    const [exitCode, stdout, stderr] = yield* Effect.all([
      Effect.promise(() => child.exited),
      Effect.promise(() => new Response(child.stdout).text()),
      Effect.promise(() => new Response(child.stderr).text()),
    ]);

    return { exitCode, stdout, stderr };
  });

layer(Layer.merge(PgLive, BunServices.layer), {
  excludeTestServices: true,
  timeout: "30 seconds",
})("development identity seed command", (it) => {
  it.effect("rotates the all-scopes bearer through one terminal-only disclosure", () =>
    Effect.gen(function* () {
      const databaseUrl = yield* localDatabaseUrl;
      const first = yield* runSeedCommand(databaseUrl);
      const second = yield* runSeedCommand(databaseUrl);
      const firstBearer = TokenBearer.make(first.stdout.trim());
      const secondBearer = TokenBearer.make(second.stdout.trim());
      const usedAt = yield* DateTime.now;
      const firstResolution = yield* authenticateTokenBearer(firstBearer, usedAt);
      const secondResolution = yield* authenticateTokenBearer(secondBearer, usedAt);

      expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
      expect(firstBearer).not.toBe(secondBearer);
      expect(first.stderr).not.toContain("fin_");
      expect(second.stderr).not.toContain("fin_");
      expect(Option.isNone(firstResolution)).toBe(true);
      expect(Option.isSome(secondResolution)).toBe(true);
      expect(Option.getOrThrow(yield* findUser(defaultUserId)).paidTier).toBe("pro");
    })
  );

  it.effect("refuses to seed a non-local PostgreSQL database", () =>
    Effect.gen(function* () {
      const result = yield* runSeedCommand(
        "postgres://fidy:fidy@database.example.invalid:5432/fidy"
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("fin_");
      expect(result.stderr).not.toContain("fin_");
    })
  );

  it.effect("refuses a connection-string host override without rotating the local bearer", () =>
    Effect.gen(function* () {
      const databaseUrl = yield* localDatabaseUrl;
      const seeded = yield* runSeedCommand(databaseUrl);
      const bearer = TokenBearer.make(seeded.stdout.trim());
      const result = yield* runSeedCommand(`${databaseUrl}?host=127.0.0.1`);
      const resolution = yield* authenticateTokenBearer(bearer, yield* DateTime.now);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("fin_");
      expect(result.stderr).not.toContain("fin_");
      expect(Option.isSome(resolution)).toBe(true);
    })
  );

  it.effect("refuses to seed a production runtime even with local PostgreSQL", () =>
    Effect.gen(function* () {
      const databaseUrl = yield* localDatabaseUrl;
      const result = yield* runSeedCommand(databaseUrl, { NODE_ENV: "production" });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("fin_");
      expect(result.stderr).not.toContain("fin_");
    })
  );
});
