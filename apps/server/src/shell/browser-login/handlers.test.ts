import { expect, layer } from "@effect/vitest";
import { Crypto, DateTime, Effect, Encoding, Fiber, Redacted, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { SqlSchema } from "effect/unstable/sql";
import { StartedBrowserLoginPairing } from "~/core/browser-login/model";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import { purgeBrowserLoginAnonymousEvidence } from "./service";

const resetBrowserLogin = Effect.flatMap(
  MigrationSqlClient,
  (sql) => sql`TRUNCATE browser_login_start_attempts, browser_login_pairings`
);

const StoredPairingProof = Schema.Struct({
  digest: Schema.String,
  verifierOccurrences: Schema.Int,
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "browser login pairing",
  (it) => {
    it.effect(
      "fails excess concurrent starts promptly without starving canonical database work",
      () =>
        Effect.gen(function* () {
          yield* resetBrowserLogin;
          const flood = yield* Effect.all(
            Array.from({ length: 40 }, () => HttpClient.post("/web-auth/pairings")),
            { concurrency: "unbounded" }
          ).pipe(Effect.forkChild);

          const client = yield* ApiHarnessClient;
          expect((yield* client.categories.listCategories()).data).toHaveLength(16);
          const responses = yield* Fiber.join(flood);
          expect(responses.every(({ status }) => [200, 429, 503].includes(status))).toBe(true);
          const sql = yield* MigrationSqlClient;
          const { count } = yield* SqlSchema.findOne({
            Request: Schema.Void,
            Result: Schema.Struct({ count: Schema.Int }),
            execute: () => sql`SELECT count(*)::int AS count FROM browser_login_pairings`,
          })(undefined);
          expect(count).toBeLessThanOrEqual(5);
        })
    );

    it.effect("gives the initiating browser one ten-minute verifier and public code", () =>
      Effect.gen(function* () {
        yield* resetBrowserLogin;
        const startedAt = yield* DateTime.now;
        const response = yield* HttpClient.post("/web-auth/pairings");
        const body = yield* Schema.decodeUnknownEffect(StartedBrowserLoginPairing)(
          yield* response.json
        );

        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(body).toMatchObject({ pollingIntervalSeconds: 5 });
        expect(body.pairingId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        );
        expect(Redacted.value(body.privateVerifier)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(body.publicCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u);
        const lifetimeMillis =
          DateTime.toEpochMillis(body.expiresAt) - DateTime.toEpochMillis(startedAt);
        expect(lifetimeMillis).toBeGreaterThanOrEqual(600_000);
        expect(lifetimeMillis).toBeLessThan(601_000);
      })
    );

    it.effect("bounds anonymous challenge bursts without creating a rejected challenge", () =>
      Effect.gen(function* () {
        yield* resetBrowserLogin;
        const admitted = yield* Effect.forEach(
          [1, 2, 3, 4, 5],
          () => HttpClient.post("/web-auth/pairings"),
          { concurrency: 1 }
        );
        const rejected = yield* HttpClient.post("/web-auth/pairings");
        const body = yield* rejected.json;
        const admin = yield* MigrationSqlClient;
        const counts = yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: Schema.Struct({ pairings: Schema.Int, attempts: Schema.Int }),
          execute: () => admin`
            SELECT
              (SELECT count(*)::int FROM browser_login_pairings) AS pairings,
              (SELECT count(*)::int FROM browser_login_start_attempts) AS attempts
          `,
        })(undefined);

        expect(admitted.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
        expect(rejected.status).toBe(429);
        expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
        expect(body).toEqual({
          error: {
            code: "rate_limited",
            message: "Browser login is temporarily unavailable. Try again later.",
          },
        });
        expect(counts).toEqual({ pairings: 5, attempts: 5 });
      })
    );

    it.effect("enforces ten starts per source over the full rolling window", () =>
      Effect.gen(function* () {
        yield* resetBrowserLogin;
        expect((yield* HttpClient.post("/web-auth/pairings")).status).toBe(200);
        const admin = yield* MigrationSqlClient;
        yield* admin`
          UPDATE browser_login_start_attempts SET attempted_at = now() - interval '2 minutes';
          INSERT INTO browser_login_start_attempts (source_digest, attempted_at)
          SELECT source_digest, now() - interval '2 minutes'
          FROM browser_login_start_attempts, generate_series(1, 9)
        `;

        const rejected = yield* HttpClient.post("/web-auth/pairings");
        const retryAfter = Number(rejected.headers["retry-after"]);
        const rows = yield* admin`SELECT count(*)::int AS count FROM browser_login_pairings`;

        expect(rejected.status).toBe(429);
        expect(retryAfter).toBeGreaterThanOrEqual(470);
        expect(retryAfter).toBeLessThanOrEqual(480);
        expect(rows).toEqual([{ count: 1 }]);
      })
    );

    it.effect("rejects global unbound capacity without creating another pairing", () =>
      Effect.gen(function* () {
        yield* resetBrowserLogin;
        const admin = yield* MigrationSqlClient;
        yield* admin`
          WITH input AS (
            SELECT n, 'BCDFGHJKLMNPQRSTVWXZ'::text AS alphabet, now() AS created_at
            FROM generate_series(0, 9999) AS n
          )
          INSERT INTO browser_login_pairings (
            public_code, verifier_digest, created_at, expires_at
          )
          SELECT
            substr(alphabet, ((n / 1280000000) % 20) + 1, 1) ||
            substr(alphabet, ((n / 64000000) % 20) + 1, 1) ||
            substr(alphabet, ((n / 3200000) % 20) + 1, 1) ||
            substr(alphabet, ((n / 160000) % 20) + 1, 1) || '-' ||
            substr(alphabet, ((n / 8000) % 20) + 1, 1) ||
            substr(alphabet, ((n / 400) % 20) + 1, 1) ||
            substr(alphabet, ((n / 20) % 20) + 1, 1) ||
            substr(alphabet, (n % 20) + 1, 1),
            decode(repeat('00', 32), 'hex'), created_at, created_at + interval '10 minutes'
          FROM input
        `;

        const rejected = yield* HttpClient.post("/web-auth/pairings");
        const body = yield* rejected.json;
        const rows = yield* admin`SELECT count(*)::int AS count FROM browser_login_pairings`;

        expect(rejected.status).toBe(503);
        expect(rejected.headers["retry-after"]).toBeUndefined();
        expect(body).toEqual({
          error: {
            code: "rate_limited",
            message: "Browser login is temporarily unavailable. Try again later.",
          },
        });
        expect(rows).toEqual([{ count: 10_000 }]);
      })
    );

    it.effect("purges stale source evidence without requiring another pairing request", () =>
      Effect.gen(function* () {
        yield* resetBrowserLogin;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          INSERT INTO browser_login_start_attempts (source_digest, attempted_at)
          VALUES (decode(repeat('ab', 32), 'hex'), now() - interval '11 minutes')
        `;
        yield* purgeBrowserLoginAnonymousEvidence();
        const rows = yield* sql`SELECT count(*)::int AS count FROM browser_login_start_attempts`;
        expect(rows).toEqual([{ count: 0 }]);
      })
    );

    it.effect("expires stale challenges and removes anonymous admission evidence", () =>
      Effect.gen(function* () {
        yield* resetBrowserLogin;
        const admin = yield* MigrationSqlClient;
        yield* admin`
          INSERT INTO browser_login_start_attempts (source_digest, attempted_at)
          VALUES (decode(repeat('00', 32), 'hex'), now() - interval '20 minutes');
          INSERT INTO browser_login_pairings (
            public_code, verifier_digest, created_at, expires_at
          ) VALUES (
            'BCDF-GHJK', decode(repeat('00', 32), 'hex'),
            now() - interval '20 minutes', now() - interval '10 minutes'
          )
        `;

        expect((yield* HttpClient.post("/web-auth/pairings")).status).toBe(200);
        const counts = yield* admin`
          SELECT
            (SELECT count(*)::int FROM browser_login_pairings) AS pairings,
            (SELECT count(*)::int FROM browser_login_pairings
              WHERE lifecycle = 'expired') AS expired,
            (SELECT count(*)::int FROM browser_login_start_attempts) AS attempts
        `;
        expect(counts).toEqual([{ pairings: 2, expired: 1, attempts: 1 }]);
      })
    );

    it.effect("persists only the SHA-256 verifier digest", () =>
      Effect.gen(function* () {
        yield* resetBrowserLogin;
        const response = yield* HttpClient.post("/web-auth/pairings");
        const body = yield* Schema.decodeUnknownEffect(StartedBrowserLoginPairing)(
          yield* response.json
        );
        const crypto = yield* Crypto.Crypto;
        const privateVerifier = Redacted.value(body.privateVerifier);
        const expectedDigest = Encoding.encodeHex(
          yield* crypto.digest("SHA-256", new TextEncoder().encode(privateVerifier))
        );
        const admin = yield* MigrationSqlClient;
        const stored = yield* SqlSchema.findOne({
          Request: Schema.String,
          Result: StoredPairingProof,
          execute: (verifier) => admin`
            SELECT encode(verifier_digest, 'hex') AS digest,
              (SELECT count(*)::int FROM browser_login_pairings
                WHERE row_to_json(browser_login_pairings)::text LIKE ${`%${verifier}%`})
                AS "verifierOccurrences"
            FROM browser_login_pairings
          `,
        })(privateVerifier);

        expect(stored).toEqual({ digest: expectedDigest, verifierOccurrences: 0 });
      })
    );
  }
);
