import { HttpClient } from "effect/http";
import { Clock, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { afterAll, expect, it, vi } from "vitest";
import { installTestSchema, isolatedTestDatabases, observeRetentionCost } from "../d1-test-fixture";
import { retainedRecoveryPairingsQuery } from "../recovery/operations";
import { makeWebSessionErasureStores } from "../web-session/runtime";
import { makeBrowserLoginErasureStores } from "./runtime";
import {
  approveBrowserPairing,
  prepareProvedBrowserPairingApproval,
  prepareRecoveryBrowserPairingApproval,
  redeemBrowserPairing,
  startBrowserPairing,
} from "./operations";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
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

const approvalTime = 1_800_000_000_000;
const approvalUser = "10000000-0000-4000-8000-000000000001";
const newerPairing = "30000000-0000-4000-8000-000000000002";
const approvalFixture = (): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const disclosure = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
        currentDisclosureFor()
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?,'portfolio','CO.Person1',?)"
            )
            .bind(approvalUser, approvalTime, approvalTime),
          db
            .prepare(
              "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant','grant',?,?,'disclosed','accepted',?,?)"
            )
            .bind(approvalUser, disclosure, approvalTime, approvalTime),
          ...[pairingId, newerPairing].map((id, index) =>
            db
              .prepare(
                "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,created_at_ms,expires_at_ms) VALUES(?,?,randomblob(32),?,?)"
              )
              .bind(
                id,
                index === 0 ? "BCDF-GHJK" : "BCDF-GHJL",
                approvalTime,
                approvalTime + 600_000
              )
          ),
        ])
      );
      return db;
    })
  );
const approvalStatement = (
  db: D1Database,
  id: string,
  { channel, current = approvalTime }: Readonly<{ channel: "proved" | "recovery"; current: number }>
): D1PreparedStatement =>
  channel === "proved"
    ? prepareProvedBrowserPairingApproval({
        db,
        pairingId: id,
        subject: { sql: "SELECT ? AS userId", params: [approvalUser] },
        current,
      })
    : prepareRecoveryBrowserPairingApproval({
        db,
        subject: { sql: "SELECT ? AS pairingId,? AS userId", params: [id, approvalUser] },
        current,
      });
const approvePairing = (
  db: D1Database,
  id: string,
  {
    channel,
    current = approvalTime,
  }: Readonly<{ channel: "proved" | "recovery" | "whatsapp"; current: number }>
): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return channel === "whatsapp"
        ? (yield* approveBrowserPairing({
            db,
            input: {
              portfolioId: "portfolio",
              bsuid: "CO.Person1",
              messageId: id,
              publicCode: id === pairingId ? "BCDF-GHJK" : "BCDF-GHJL",
              occurredAtMs: current,
              receivedAtMs: current,
            },
          })).status === 200
        : (yield* Effect.tryPromise(() => approvalStatement(db, id, { channel, current }).run()))
            .meta.changes > 0;
    })
  );
const pairingStates = (db: D1Database): Promise<ReadonlyArray<unknown>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return (yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT id,state,user_id AS userId FROM browser_login_pairings ORDER BY rowid")
          .all()
      )).results;
    })
  );

it.each(["proved", "recovery", "whatsapp"] as const)(
  "%s approval refuses older work after a newer pairing is ready",
  (channel) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => approvalFixture());
        expect(
          yield* Effect.tryPromise(() =>
            approvePairing(db, newerPairing, { channel, current: approvalTime })
          )
        ).toBe(true);
        expect(
          yield* Effect.tryPromise(() =>
            approvePairing(db, pairingId, { channel, current: approvalTime })
          )
        ).toBe(false);
        expect(yield* Effect.tryPromise(() => pairingStates(db))).toEqual([
          { id: pairingId, state: "pending_approval", userId: null },
          { id: newerPairing, state: "ready", userId: approvalUser },
        ]);
      })
    )
);

it.each(["proved", "recovery", "whatsapp"] as const)(
  "%s approval supersedes older ready work without creating a session",
  (channel) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => approvalFixture());
        expect(
          yield* Effect.tryPromise(() =>
            approvePairing(db, pairingId, { channel, current: approvalTime })
          )
        ).toBe(true);
        expect(
          yield* Effect.tryPromise(() =>
            approvePairing(db, newerPairing, { channel, current: approvalTime })
          )
        ).toBe(true);
        expect(yield* Effect.tryPromise(() => pairingStates(db))).toEqual([
          { id: pairingId, state: "invalidated", userId: null },
          { id: newerPairing, state: "ready", userId: approvalUser },
        ]);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS total FROM web_sessions").first()
          )
        ).toEqual({
          total: 0,
        });
      })
    )
);

it("rolls supersession back with a rejected proof in the same native batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => approvalFixture());
      expect(
        yield* Effect.tryPromise(() =>
          approvePairing(db, pairingId, { channel: "proved", current: approvalTime })
        )
      ).toBe(true);
      yield* Effect.tryPromise(() =>
        expect(
          db.batch([
            approvalStatement(db, newerPairing, { channel: "proved", current: approvalTime }),
            db.prepare("INSERT INTO sql_assertions(scope,accepted) VALUES('refused-proof',0)"),
          ])
        ).rejects.toThrow()
      );
      expect(yield* Effect.tryPromise(() => pairingStates(db))).toEqual([
        { id: pairingId, state: "ready", userId: approvalUser },
        { id: newerPairing, state: "pending_approval", userId: null },
      ]);
      const proofBatch = yield* Effect.tryPromise(() =>
        db.batch([
          approvalStatement(db, newerPairing, { channel: "proved", current: approvalTime }),
          db.prepare(
            "INSERT INTO sql_assertions(scope,accepted) VALUES('accepted-proof',changes()=1)"
          ),
          db.prepare("DELETE FROM sql_assertions WHERE scope='accepted-proof'"),
        ])
      );
      expect(proofBatch[1]?.meta.changes).toBe(1);
      expect(yield* Effect.tryPromise(() => pairingStates(db))).toEqual([
        { id: pairingId, state: "invalidated", userId: null },
        { id: newerPairing, state: "ready", userId: approvalUser },
      ]);
    })
  ));

it.each(["proved", "recovery", "whatsapp"] as const)(
  "%s approval refuses the original deadline without replacing ready work",
  (channel) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => approvalFixture());
        expect(
          yield* Effect.tryPromise(() =>
            approvePairing(db, pairingId, { channel, current: approvalTime })
          )
        ).toBe(true);
        expect(
          yield* Effect.tryPromise(() =>
            approvePairing(db, newerPairing, { channel, current: approvalTime + 600_000 })
          )
        ).toBe(false);
        expect(yield* Effect.tryPromise(() => pairingStates(db))).toEqual([
          { id: pairingId, state: "ready", userId: approvalUser },
          { id: newerPairing, state: "pending_approval", userId: null },
        ]);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS total FROM web_sessions").first()
          )
        ).toEqual({
          total: 0,
        });
      })
    )
);

it("keeps another User's ready pairing and does not supersede on creation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => approvalFixture());
      expect(
        yield* Effect.tryPromise(() =>
          approvePairing(db, pairingId, { channel: "proved", current: approvalTime })
        )
      ).toBe(true);
      expect(
        (yield* startBrowserPairing({ db, retainedPairings: retainedRecoveryPairingsQuery() }))
          .status
      ).toBe(200);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state,user_id AS userId FROM browser_login_pairings WHERE id=?")
            .bind(pairingId)
            .first()
        )
      ).toEqual({ state: "ready", userId: approvalUser });
      const otherUser = "10000000-0000-4000-8000-000000000002";
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(otherUser, approvalTime)
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          prepareProvedBrowserPairingApproval({
            db,
            pairingId: newerPairing,
            subject: { sql: "SELECT ? AS userId", params: [otherUser] },
            current: approvalTime,
          }).run()
        )).meta.changes
      ).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state,user_id AS userId FROM browser_login_pairings WHERE id=?")
            .bind(pairingId)
            .first()
        )
      ).toEqual({ state: "ready", userId: approvalUser });
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare("UPDATE browser_login_pairings SET rowid=rowid+100 WHERE id=?")
            .bind(pairingId)
            .run()
        ).rejects.toThrow()
      );
    })
  ));

const redeem = (db: D1Database, privateVerifier: string): Promise<Response> =>
  Effect.runPromise(
    redeemBrowserPairing({
      db,
      request: new Request("https://api.fidyapp.com/web/pairings/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairingId, privateVerifier }),
      }),
    })
  );

it("erases superseded WhatsApp approval metadata only for the requested User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(approvalFixture);
      expect(
        yield* Effect.tryPromise(() =>
          approvePairing(db, pairingId, { channel: "whatsapp", current: approvalTime })
        )
      ).toBe(true);
      expect(
        yield* Effect.tryPromise(() =>
          approvePairing(db, newerPairing, { channel: "whatsapp", current: approvalTime })
        )
      ).toBe(true);
      const reference = "pairing-erasure";
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,?,'Draining')"
            )
            .bind(reference, approvalUser, approvalTime),
          db
            .prepare(
              "INSERT INTO erasure_steps(request_id,store_id) VALUES(?,'browser_login_pairings')"
            )
            .bind(reference),
          db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?").bind(reference),
        ])
      );
      const store = Option.getOrThrow(Option.fromUndefinedOr(makeBrowserLoginErasureStores(db)[0]));
      expect(
        (yield* Effect.result(
          store.remove({ reference, userId: "10000000-0000-4000-8000-000000000002" })
        ))._tag
      ).toBe("Failure");
      expect((yield* Effect.tryPromise(() => pairingStates(db))).length).toBe(2);
      expect(yield* store.remove({ reference, userId: approvalUser })).toBe(true);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS total FROM browser_login_pairings WHERE approval_user_id=?"
            )
            .bind(approvalUser)
            .first()
        )
      ).toEqual({ total: 0 });
    })
  ));

it("invalidates the fifth wrong verifier without pacing it or extending expiry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => approvalFixture());
      expect(
        yield* Effect.tryPromise(() =>
          approvePairing(db, pairingId, { channel: "proved", current: approvalTime })
        )
      ).toBe(true);
      for (let attempt = 1; attempt <= 5; attempt++) {
        const response = yield* Effect.tryPromise(() => redeem(db, "r".repeat(43)));
        expect(response.status).toBe(400);
        expect(response.headers.get("retry-after")).toBeNull();
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT state,wrong_attempts,user_id AS userId,expires_at_ms FROM browser_login_pairings WHERE id=?"
            )
            .bind(pairingId)
            .first()
        )
      ).toEqual({
        state: "invalidated",
        wrong_attempts: 5,
        userId: null,
        expires_at_ms: approvalTime + 600_000,
      });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM web_sessions").first()
        )
      ).toEqual({
        total: 0,
      });
    })
  ));

it("advertises bounded slowdown for an early valid poll without renewing its deadline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => approvalFixture());
      const privateVerifier = "q".repeat(43);
      const digest = new Uint8Array(
        yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(privateVerifier))
        )
      );
      const current = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE browser_login_pairings SET verifier_digest=?,last_poll_at_ms=?,minimum_poll_interval_seconds=60 WHERE id=?"
          )
          .bind(digest, current, pairingId)
          .run()
      );
      const response = yield* Effect.tryPromise(() => redeem(db, privateVerifier));
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(60);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT state,wrong_attempts,minimum_poll_interval_seconds,expires_at_ms FROM browser_login_pairings WHERE id=?"
            )
            .bind(pairingId)
            .first()
        )
      ).toEqual({
        state: "pending_approval",
        wrong_attempts: 0,
        minimum_poll_interval_seconds: 60,
        expires_at_ms: approvalTime + 600_000,
      });
    })
  ));

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
