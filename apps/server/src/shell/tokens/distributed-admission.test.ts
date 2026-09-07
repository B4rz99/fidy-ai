import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Config, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/unstable/http";
import { MigrationSqlClient, MigratorLive } from "~/shell/db/client";
import { patPairingUnavailableBody } from "~/pat-pairing-api";

const Ready = Schema.Struct({ port: Schema.Int, pid: Schema.Int });
const source = "203.0.113.70";

const startProcess = Effect.gen(function* () {
  const databaseUrl = yield* Config.string("DATABASE_URL");
  const path = yield* Config.string("PATH");
  const ready = Promise.withResolvers<typeof Ready.Type>();
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(["bun", "--no-env-file", "src/shell/testing/pat-admission-process.ts"], {
        // Deliberately do not inherit MIGRATION_DATABASE_URL or provider secrets.
        env: { PATH: path, DATABASE_URL: databaseUrl },
        stdout: "ignore",
        stderr: "inherit",
        ipc(message) {
          try {
            ready.resolve(Schema.decodeUnknownSync(Ready)(message));
          } catch (error) {
            ready.reject(error);
          }
        },
        onExit() {
          ready.reject(new Error("Admission process exited before readiness"));
        },
      })
    ),
    (process) =>
      Effect.gen(function* () {
        process.kill("SIGKILL");
        yield* Effect.tryPromise(() => process.exited).pipe(Effect.orDie);
      })
  );
  const address = yield* Effect.tryPromise(() => ready.promise).pipe(Effect.timeout("10 seconds"));
  return {
    ...address,
    origin: `http://127.0.0.1:${address.port}`,
    stop: Effect.gen(function* () {
      child.kill("SIGKILL");
      yield* Effect.tryPromise(() => child.exited);
    }),
  };
});

type AdmissionProcess = Effect.Success<typeof startProcess>;
const startPairing = Effect.fn(function* (
  process: AdmissionProcess,
  forwardedFor: string = source
) {
  const response = yield* HttpClient.post(`${process.origin}/pat-pairings`, {
    headers: { "x-forwarded-for": forwardedFor },
    body: HttpBody.jsonUnsafe({ recipientLabel: "Distributed admission test", scopes: ["read"] }),
  });
  const body: unknown = yield* response.json;
  return {
    status: response.status,
    retryAfter: Number(response.headers["retry-after"]),
    body,
  };
});

const Harness = Layer.mergeAll(MigrationSqlClient.layer, MigratorLive, FetchHttpClient.layer).pipe(
  Layer.provide(BunServices.layer)
);

layer(Harness, { excludeTestServices: true, timeout: "30 seconds" })(
  "PostgreSQL admission across independent runtime processes",
  (it) => {
    it.effect(
      "shares burst and rolling windows, refuses cheaply, and retains admission after hard restart",
      () =>
        Effect.gen(function* () {
          const sql = yield* MigrationSqlClient;
          yield* sql`DELETE FROM pat_pairing_start_attempts`;
          yield* sql`DELETE FROM pat_pairings WHERE user_id IS NULL`;
          const first = yield* startProcess;
          const second = yield* startProcess;
          expect(first.pid).not.toBe(second.pid);

          // Four successes split across processes, then contend for the single remaining permit.
          for (const process of [first, second, first, second]) {
            expect((yield* startPairing(process)).status).toBe(200);
          }
          const burst = yield* Effect.forEach(
            Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? first : second)),
            (process) => startPairing(process),
            { concurrency: "unbounded" }
          ).pipe(Effect.timeout("5 seconds"));
          expect(burst.filter(({ status }) => status === 200)).toHaveLength(1);
          expect(burst.every(({ status }) => [200, 429, 503].includes(status))).toBe(true);

          for (const process of [first, second]) {
            // A client-controlled left prefix must not buy another source window.
            const rejected = yield* startPairing(process, `198.51.100.1, ${source}`);
            expect(rejected.status).toBe(429);
            expect(rejected.body).toEqual(patPairingUnavailableBody);
            expect(rejected.retryAfter).toBeGreaterThan(0);
            expect(rejected.retryAfter).toBeLessThanOrEqual(60);
          }
          expect(yield* sql`SELECT count(*)::int AS count FROM pat_pairing_start_attempts`).toEqual(
            [{ count: 5 }]
          );
          expect(
            yield* sql`SELECT count(*)::int AS count FROM pat_pairings WHERE user_id IS NULL`
          ).toEqual([{ count: 5 }]);

          yield* first.stop;
          yield* second.stop;
          const restartedFirst = yield* startProcess;
          const restartedSecond = yield* startProcess;
          expect(restartedFirst.pid).not.toBe(first.pid);
          expect(restartedSecond.pid).not.toBe(second.pid);
          for (const process of [restartedFirst, restartedSecond]) {
            expect((yield* startPairing(process)).status).toBe(429);
          }

          // Age real admission evidence rather than waiting minutes or replacing production clocks.
          // Both new processes stay alive while the minute window refills; the ten-minute one remains.
          yield* sql`UPDATE pat_pairing_start_attempts SET attempted_at = attempted_at - interval '61 seconds'`;
          for (const process of [
            restartedFirst,
            restartedSecond,
            restartedFirst,
            restartedSecond,
            restartedFirst,
          ]) {
            expect((yield* startPairing(process)).status).toBe(200);
          }
          yield* sql`UPDATE pat_pairing_start_attempts SET attempted_at = attempted_at - interval '61 seconds'`;
          for (const process of [restartedFirst, restartedSecond]) {
            const rejected = yield* startPairing(process);
            expect(rejected.status).toBe(429);
            expect(rejected.retryAfter).toBeGreaterThan(400);
            expect(rejected.retryAfter).toBeLessThanOrEqual(600);
          }
          expect(yield* sql`SELECT count(*)::int AS count FROM pat_pairing_start_attempts`).toEqual(
            [{ count: 10 }]
          );
          expect(
            yield* sql`SELECT count(*)::int AS count FROM pat_pairings WHERE user_id IS NULL`
          ).toEqual([{ count: 10 }]);

          // Missing or malformed trusted-proxy evidence fails closed, without another pairing.
          for (const forwardedFor of ["", "not-an-address", `not-an-address, ${source}`]) {
            expect((yield* startPairing(restartedSecond, forwardedFor)).status).toBe(503);
          }
          expect(
            yield* sql`SELECT count(*)::int AS count FROM pat_pairings WHERE user_id IS NULL`
          ).toEqual([{ count: 10 }]);
          // A genuinely distinct proxy-observed source has its own allowance.
          expect((yield* startPairing(restartedSecond, "203.0.113.71")).status).toBe(200);

          yield* sql`UPDATE pat_pairing_start_attempts SET attempted_at = attempted_at - interval '10 minutes'`;
          expect((yield* startPairing(restartedFirst)).status).toBe(200);
          expect((yield* startPairing(restartedSecond)).status).toBe(200);
          // Accepted starts run the production expiry path, deleting obsolete counter evidence.
          expect(yield* sql`SELECT count(*)::int AS count FROM pat_pairing_start_attempts`).toEqual(
            [{ count: 2 }]
          );
        }),
      30_000
    );
  }
);
