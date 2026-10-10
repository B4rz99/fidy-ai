import { Clock, Data, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import coreWorker from "../core-worker";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";

class TestRuntimeFailed extends Data.TaggedError("TestRuntimeFailed") {}
const awaitPromise = <A>(work: () => Promise<A>): Effect.Effect<A, TestRuntimeFailed> =>
  Effect.tryPromise({ try: work, catch: () => new TestRuntimeFailed() });

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const environment = (DB: D1Database): Parameters<typeof coreWorker.scheduled>[1] => ({
  DB,
  AI: { run: () => Promise.reject(new Error("Unused test binding")) },
  CONTRACT_DIGEST: "a".repeat(64),
  RELEASE_GIT_SHA: "a".repeat(40),
  HOSTED_AI_MODEL: "test",
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  USER_TRANSACTION_COORDINATOR: {
    getByName: () => ({ fetch: () => Promise.reject(new Error("Unused test binding")) }),
  },
  KAPSO_API_KEY: "test",
  KAPSO_WEBHOOK_SECRET: "test",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "test",
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
  CLOUDFLARE_ACCESS_ISSUER: "https://test.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_AUDIENCE: "test",
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "",
  WOMPI_PRIVATE_KEY: "",
  WOMPI_INTEGRITY_SECRET: "",
});

it("refuses a missing maintenance executor without falling back to cleanup on the cron Worker", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* awaitPromise(() => databases.acquire());
      yield* awaitPromise(() =>
        installTestSchema({
          db,
          sources: Array.from(
            new Bun.Glob("*.sql").scanSync({
              cwd: new URL("../migrations/", import.meta.url).pathname,
            })
          )
            .sort()
            .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
        })
      );
      const created = (yield* Clock.currentTimeMillis) - 86_400_000 - 660_000;
      yield* awaitPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,created_at_ms,expires_at_ms) VALUES (?,?,zeroblob(32),?,?)"
            )
            .bind("10000000-0000-4000-8000-000000000001", "AAAA-BBBB", created, created + 600_000),
          db
            .prepare(
              "INSERT INTO provider_authentication_attempts(id,pairing_id,cookie_digest,nonce,intent,created_at_ms,expires_at_ms,state,provider) VALUES (?,?,zeroblob(32),'test','login',?,?,'pending','microsoft')"
            )
            .bind(
              "test-expired-attempt",
              "10000000-0000-4000-8000-000000000001",
              created,
              created + 600_000
            ),
        ])
      );
      const scheduledTime = yield* Clock.currentTimeMillis;
      yield* awaitPromise(() =>
        expect(
          coreWorker.scheduled(
            {
              cron: "* * * * *",
              scheduledTime,
              noRetry: () => undefined,
            },
            environment(db)
          )
        ).rejects.toThrow()
      );
      expect(
        yield* awaitPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM provider_authentication_attempts")
            .first("count")
        )
      ).toBe(1);
    })
  ));

it(
  "runs expired-attempt retention through the native local executor while preserving a live attempt",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { Miniflare } = yield* awaitPromise(() => import("miniflare"));
        const compiled = Bun.spawnSync([
          "bunx",
          "esbuild",
          new URL("../core-worker.test-fixture.ts", import.meta.url).pathname,
          "--bundle",
          "--platform=browser",
          "--format=esm",
          "--conditions=workerd",
          "--external:cloudflare:workers",
          "--external:node:*",
          `--tsconfig=${new URL("../../tsconfig.json", import.meta.url).pathname}`,
        ]);
        if (compiled.exitCode !== 0) {
          throw new Error(compiled.stderr.toString());
        }
        const bindings = {
          CONTRACT_DIGEST: "a".repeat(64),
          RELEASE_GIT_SHA: "a".repeat(40),
          HOSTED_AI_MODEL: "test",
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          KAPSO_API_KEY: "test",
          KAPSO_WEBHOOK_SECRET: "test",
          WHATSAPP_BUSINESS_PORTFOLIO_ID: "test",
          WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
          CLOUDFLARE_ACCESS_ISSUER: "https://test.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUDIENCE: "test",
          WOMPI_ENVIRONMENT: "sandbox",
          WOMPI_PUBLIC_KEY: "",
          WOMPI_PRIVATE_KEY: "",
          WOMPI_INTEGRITY_SECRET: "",
        };
        const runtime = new Miniflare({
          workers: [
            {
              config: {
                name: "core-maintenance-test",
                type: "worker",
                compatibilityDate: "2026-09-08",
                compatibilityFlags: ["nodejs_compat"],
                manifest: {
                  mainModule: "index.mjs",
                  modules: {
                    "index.mjs": {
                      type: "esm",
                      contents:
                        'export { scheduledFixture as default, CoreMaintenanceCoordinator } from "./core.mjs";',
                    },
                    "core.mjs": { type: "esm", contents: compiled.stdout.toString() },
                  },
                },
                exports: {
                  CoreMaintenanceCoordinator: { type: "durable-object", storage: "sqlite" },
                },
                env: {
                  ...Object.fromEntries(
                    Object.entries(bindings).map(([name, value]) => [
                      name,
                      { type: "json" as const, value },
                    ])
                  ),
                  DB: { type: "d1", id: "core-maintenance-test" },
                  CORE_MAINTENANCE: {
                    type: "durable-object",
                    worker: "core-maintenance-test",
                    exportName: "CoreMaintenanceCoordinator",
                  },
                },
              },
            },
          ],
        });
        try {
          const db = yield* awaitPromise(() => runtime.getD1Database("DB"));
          yield* awaitPromise(() =>
            installTestSchema({
              db,
              sources: Array.from(
                new Bun.Glob("*.sql").scanSync({
                  cwd: new URL("../migrations/", import.meta.url).pathname,
                })
              )
                .sort()
                .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
            })
          );
          const now = yield* Clock.currentTimeMillis;
          yield* awaitPromise(() =>
            db.batch(
              (
                [
                  [1, now - 86_400_000 - 660_000, "AAAA-BBBB"],
                  [2, now, "CCCC-DDDD"],
                ] as const
              ).flatMap(([index, created, code]) => {
                const id = `10000000-0000-4000-8000-00000000000${index}`;
                return [
                  db
                    .prepare(
                      "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,created_at_ms,expires_at_ms) VALUES (?,?,zeroblob(32),?,?)"
                    )
                    .bind(id, code, created, created + 600_000),
                  db
                    .prepare(
                      "INSERT INTO provider_authentication_attempts(id,pairing_id,cookie_digest,nonce,intent,created_at_ms,expires_at_ms,state,provider) VALUES (?,?,zeroblob(32),'test','login',?,?,'pending','microsoft')"
                    )
                    .bind(`test-attempt-${index}`, id, created, created + 600_000),
                ];
              })
            )
          );
          const response = yield* awaitPromise(() =>
            runtime.dispatchFetch("https://fixture.invalid/schedule", {
              method: "POST",
            })
          );
          expect(response.status).toBe(204);
          expect(
            (yield* awaitPromise(() =>
              db.prepare("SELECT id FROM provider_authentication_attempts ORDER BY id").all()
            )).results
          ).toEqual([{ id: "test-attempt-2" }]);
          const binding = yield* awaitPromise(() =>
            runtime.getDurableObjectNamespace("CORE_MAINTENANCE")
          );
          const refused = yield* awaitPromise(() =>
            binding.getByName("core-maintenance-v1").fetch("https://maintenance.invalid/tick", {
              method: "POST",
              body: "private-material-sentinel",
            })
          );
          expect(refused.status).toBe(404);
          expect(yield* awaitPromise(() => refused.text())).toBe("");
          const refusals = yield* awaitPromise(() =>
            Promise.all([
              binding
                .getByName("unapproved-executor")
                .fetch("https://maintenance.invalid/tick", { method: "POST" }),
              binding
                .getByName("core-maintenance-v1")
                .fetch("https://maintenance.invalid/tick?credential=private-material-sentinel", {
                  method: "POST",
                }),
              binding.getByName("core-maintenance-v1").fetch("https://maintenance.invalid/tick"),
            ])
          );
          expect(refusals.map((item) => item.status)).toEqual([404, 404, 404]);
          const repeated = yield* awaitPromise(() =>
            Promise.all([
              runtime.dispatchFetch("https://fixture.invalid/schedule", { method: "POST" }),
              runtime.dispatchFetch("https://fixture.invalid/schedule", { method: "POST" }),
            ])
          );
          expect(repeated.map((item) => item.status)).toEqual([204, 204]);
          expect(
            (yield* awaitPromise(() =>
              db.prepare("SELECT id FROM provider_authentication_attempts ORDER BY id").all()
            )).results
          ).toEqual([{ id: "test-attempt-2" }]);
          yield* awaitPromise(() => db.exec("DROP TABLE provider_authentication_attempts"));
          const failed = yield* awaitPromise(() =>
            runtime.dispatchFetch("https://fixture.invalid/schedule", { method: "POST" })
          );
          expect(failed.status).toBe(503);
          expect(yield* awaitPromise(() => failed.text())).toBe("");
        } finally {
          yield* awaitPromise(() => runtime.dispose());
        }
      })
    ),
  30_000
);
