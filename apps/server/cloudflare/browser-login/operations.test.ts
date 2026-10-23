import { HttpClient } from "effect/http";
import { Clock, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { afterAll, expect, it, vi } from "vitest";
import { installTestSchema, isolatedTestDatabases, observeRetentionCost } from "../d1-test-fixture";
import { retainedRecoveryPairingsQuery } from "../recovery/operations";
import { documentedSqlBlock } from "../schema-cutover.test-fixture";
import { makeWebSessionErasureStores } from "../web-session/runtime";
import { startBrowserPairing } from "./operations";
import { handleWebAuthentication } from "../web-authentication/operations";
import {
  DisabledTelemetryResource,
  makeTelemetryService,
} from "../../src/shell/observability/operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const telemetry = makeTelemetryService(DisabledTelemetryResource.adapter);
const support = {
  CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_AUDIENCE: "support",
};
const pairingId = "30000000-0000-4000-8000-000000000001";

it("cancels a stalled browser redemption body when authentication is interrupted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const reading = yield* Deferred.make<void>();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (): void => {
            Deferred.doneUnsafe(reading, Effect.void);
          },
          cancel,
        },
        { highWaterMark: 0 }
      );
      const fiber = yield* Effect.forkChild(
        handleWebAuthentication({
          request: new Request("https://api.fidyapp.com/web/pairings/redeem", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
          db,
          support,
          telemetry,
          publish: () => {},
        })
      );
      yield* Deferred.await(reading);
      yield* Fiber.interrupt(fiber);
      expect(body.locked).toBe(false);
      expect(cancel).toHaveBeenCalledOnce();
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Authentication must not perform outbound HTTP."))
      )
    )
  ));

it("reports corrupt retained pairing expiry as unavailable without consuming the pairing or creating a session", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const privateVerifier = "q".repeat(43);
      const digest = new Uint8Array(
        yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(privateVerifier))
        )
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE browser_login_pairings (id TEXT, state TEXT, user_id TEXT, expires_at_ms INTEGER, wrong_attempts INTEGER, verifier_digest BLOB, last_poll_at_ms INTEGER, minimum_poll_interval_seconds INTEGER)"
          ),
          db
            .prepare("INSERT INTO browser_login_pairings VALUES (?, 'ready', ?, ?, 0, ?, NULL, 5)")
            .bind(pairingId, "10000000-0000-4000-8000-000000000001", 8_640_000_000_000_001, digest),
          db.prepare("CREATE TABLE web_sessions (id TEXT)"),
        ])
      );
      const response = yield* handleWebAuthentication({
        request: new Request("https://api.fidyapp.com/web/pairings/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
            )
          )({ pairingId, privateVerifier }),
        }),
        db,
        support,
        telemetry,
        publish: () => {},
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM browser_login_pairings").first()
        )
      ).toEqual({ state: "ready" });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM web_sessions").first()
        )
      ).toEqual({ total: 0 });
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Authentication must not perform outbound HTTP."))
      )
    )
  ));

it("prunes at most 32 expired pairings through the expiry index while retaining session and recovery evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const current = yield* Clock.currentTimeMillis;
      const userId = "10000000-0000-4000-8000-000000000001";
      const id = (index: number): string =>
        `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
            )
            .bind(userId, current - 700000),
          ...Array.from({ length: 70 }, (_, index) =>
            db
              .prepare(
                "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,?,randomblob(32),?,?,?,?)"
              )
              .bind(
                id(index),
                String(index).padStart(9, "B"),
                index < 2 ? userId : null,
                index < 2 ? "consumed" : "pending_approval",
                index < 67 ? current - 700000 : current,
                index < 67 ? current - 100000 : current + 600000
              )
          ),
          db
            .prepare(
              "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms,revoked_at_ms) VALUES(?,?,?,randomblob(32),?,?,?,?,?)"
            )
            .bind(
              "20000000-0000-4000-8000-000000000001",
              id(0),
              userId,
              current - 200000,
              current + 400000,
              current + 100000,
              current - 200000 + 7776000000,
              current - 100000
            ),
          db
            .prepare(
              "INSERT INTO support_recovery_cases(id,user_id,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms) VALUES('retained-case',?,?,'issuer','operator',1,?,?,'approved',?)"
            )
            .bind(userId, id(1), current - 300000, current - 100000, current - 200000),
        ])
      );
      const retainedQuery = db
        .prepare("SELECT rowid,* FROM browser_login_pairings WHERE id IN(?,?,?,?,?) ORDER BY id")
        .bind(id(0), id(1), id(67), id(68), id(69));
      const snapshot = (): Promise<ReadonlyArray<D1Result>> =>
        db.batch([
          db.prepare("SELECT rowid,* FROM browser_login_pairings ORDER BY id"),
          db.prepare("SELECT rowid,* FROM web_sessions ORDER BY id"),
          db.prepare("SELECT rowid,* FROM support_recovery_cases ORDER BY id"),
        ]);
      const before = yield* Effect.tryPromise(snapshot);
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("DROP INDEX browser_login_pairings_retention"),
          db.prepare("DROP INDEX web_sessions_by_user"),
        ])
      );
      const guide = yield* Effect.tryPromise(() =>
        Bun.file(
          new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
        ).text()
      );
      const indexStatements = documentedSqlBlock({ guide, marker: "browser-session-index" });
      yield* Effect.tryPromise(() =>
        expect(
          db.batch([
            ...indexStatements.map((sql) => db.prepare(sql)),
            db.prepare(
              "INSERT INTO sql_assertions(scope,accepted) VALUES('browser-session-cutover-fault',0)"
            ),
          ])
        ).rejects.toThrow("CHECK constraint failed")
      );
      expect((yield* Effect.tryPromise(snapshot)).map((table) => table.results)).toEqual(
        before.map((table) => table.results)
      );
      yield* Effect.tryPromise(() => db.batch(indexStatements.map((sql) => db.prepare(sql))));
      expect((yield* Effect.tryPromise(snapshot)).map((table) => table.results)).toEqual(
        before.map((table) => table.results)
      );
      const retained = yield* Effect.tryPromise(() => retainedQuery.all());
      for (const remaining of [33, 1]) {
        const observed = observeRetentionCost(db);
        expect(
          (yield* startBrowserPairing({
            db: observed.database,
            retainedPairings: retainedRecoveryPairingsQuery(),
          })).status
        ).toBe(200);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT count(*) AS count FROM browser_login_pairings WHERE state='pending_approval' AND expires_at_ms<=?"
              )
              .bind(current)
              .first("count")
          )
        ).toBe(remaining);
        const plans = yield* Effect.tryPromise(observed.plans);
        expect(
          plans.some(
            (plan) =>
              plan.includes("browser_login_pairings_retention") && plan.includes("expires_at_ms<?")
          )
        ).toBe(true);
        expect(plans.some((plan) => plan.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(false);
        expect((yield* Effect.tryPromise(() => retainedQuery.all())).results).toEqual(
          retained.results
        );
      }
      const observedOwner = observeRetentionCost(db);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('session-archive',?,?,'Draining')"
            )
            .bind(userId, current),
          db.prepare(
            "INSERT INTO erasure_steps(request_id,store_id) VALUES('session-archive','web_sessions')"
          ),
          db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id='session-archive'"),
        ])
      );
      const store = Option.getOrThrow(
        Option.fromUndefinedOr(makeWebSessionErasureStores(observedOwner.database)[0])
      );

      expect(yield* store.remove({ userId, reference: "session-archive" })).toBe(true);
      expect(
        (yield* Effect.tryPromise(observedOwner.plans)).some(
          (plan) => plan.includes("web_sessions_by_user") && plan.includes("user_id=?")
        )
      ).toBe(true);
    })
  ));
