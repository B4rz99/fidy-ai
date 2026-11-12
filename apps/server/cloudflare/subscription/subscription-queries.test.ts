import { openAiTestKey } from "../openai.test-fixture";
import { executeProCommand, prepareProGrant } from "../../src/shell/pro-grants/operations";
import { ProGrantFailure } from "../../src/shell/pro-grants/contract";
import { expect } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { SubscriptionOffers, SubscriptionStatus } from "../../src/core/subscription/contract";
import { approvedOpenAiModel } from "../../src/shell/hosted-inference/contract";
import { makePaymentEnrollmentD1 } from "./payment-enrollment-d1.test-fixture";
import { executeProtectedSubscriptionQuery, startRefund } from "./operations";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import {
  executeCanonicalHttpQuery,
  executeCanonicalQuery,
} from "../canonical-operations/operations";
import coreWorker from "../core-worker";
import { auditEntriesTestSchema, installCurrentTestObjects } from "../d1-test-fixture";

import { TestClock } from "effect/testing";
import { activeProUserCondition } from "../../src/shell/access-tier/operations";
import { prepareSubscriptionStatus } from "../../src/shell/subscription/operations";
import { seedPaidCardSubscription } from "./refund-charge.test-fixture";

const fromTestPromise = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise(() => Promise.resolve(run())).pipe(Effect.orDie);

const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const sessionA = "20000000-0000-4000-8000-000000000001";
const sessionB = "20000000-0000-4000-8000-000000000002";
const patId = "30000000-0000-4000-8000-000000000001";
const token = new Uint8Array(32);
const pastEnd = Date.parse("2026-09-08T12:00:00Z");

const fixture = (expiration: Option.Option<number> = Option.none()): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const created = yield* makePaymentEnrollmentD1([
        "CREATE TABLE users (paid_attempt_id TEXT,paid_price_id TEXT,paid_period_ends_at_ms INTEGER,paid_renewal_anchor_ms INTEGER,id TEXT PRIMARY KEY, time_zone TEXT NOT NULL, trial_started_at_ms INTEGER, trial_ends_at_ms INTEGER ,service_market TEXT,locale TEXT,created_at_ms INTEGER,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER) STRICT",
        "CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_digest BLOB NOT NULL, revoked_at_ms INTEGER, idle_expires_at_ms INTEGER NOT NULL, hard_expires_at_ms INTEGER NOT NULL) STRICT",
        auditEntriesTestSchema,

        "CREATE TABLE pats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bearer_digest BLOB NOT NULL, scopes_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, last_used_at_ms INTEGER) STRICT",
      ]);

      const db = created.db;
      yield* fromTestPromise(() =>
        installCurrentTestObjects({
          db,
          tables: [
            "commercial_allowance_consumptions",
            "canonical_request_replays",
            "canonical_request_buckets",
            "canonical_request_leases",
            "canonical_request_acceptances",
          ],
          objects: ["users_trial_immutable"],
        })
      );
      const past = Date.parse("2026-09-01T12:00:00Z");
      const future = (yield* Clock.currentTimeMillis) + 86_400_000;
      const sessionExpiresAt = Option.getOrElse(expiration, () => future);
      yield* fromTestPromise(() =>
        db.batch([
          db
            .prepare(
              "WITH fixture_user(id,time_zone) AS (VALUES (?, 'America/Bogota')) INSERT INTO users(id,time_zone,service_market,locale,created_at_ms) SELECT id,time_zone,'CO','es-CO',0 FROM fixture_user"
            )
            .bind(userA),
          db
            .prepare(
              "WITH fixture_user(id,time_zone) AS (VALUES (?, 'America/Bogota')) INSERT INTO users(id,time_zone,service_market,locale,created_at_ms) SELECT id,time_zone,'CO','es-CO',0 FROM fixture_user"
            )
            .bind(userB),
          db
            .prepare("UPDATE users SET trial_started_at_ms=?2,trial_ends_at_ms=?3 WHERE id=?1")
            .bind(userA, past, past + 604_800_000),
          db
            .prepare("UPDATE users SET trial_started_at_ms=?2,trial_ends_at_ms=?3 WHERE id=?1")
            .bind(userB, past, past + 604_800_000),
          db
            .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?)")
            .bind(sessionA, userA, token, sessionExpiresAt, sessionExpiresAt),
          db
            .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?)")
            .bind(sessionB, userB, token, sessionExpiresAt, sessionExpiresAt),
          db
            .prepare("INSERT INTO pats VALUES (?, ?, ?, '[\"write\"]', ?, NULL, NULL)")
            .bind(patId, userA, token, future),
        ])
      );
      return db;
    })
  );

effectIt.effect(
  "preserves configured HTTP upgrade guidance and the hosted production destination with shared Audit",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => fixture());
      const subject = { id: sessionA, userId: userA, digest: token };
      const operation = CanonicalOperationId.make("subscription.getUpgradeUrl");
      const http = yield* executeCanonicalHttpQuery({
        completion: Option.none(),
        db,
        subject,
        operation,
        request: new Request("https://core.internal/subscription/upgrade-url"),
        bucket: Option.none(),
        browserOrigin: "https://preview.fidyapp.test",
        coordinate: () => Effect.die(new Error("Upgrade guidance must not submit Dashboard work")),
      });
      const hosted = Option.getOrThrow(
        yield* executeCanonicalQuery({ db, subject, operation, input: {}, bucket: Option.none() })
      );
      expect(http.status).toBe(200);
      expect(hosted.status).toBe(200);
      expect(yield* fromTestPromise(() => http.json())).toEqual({
        data: { url: "https://preview.fidyapp.test/upgrade" },
        next: [],
      });
      expect(yield* fromTestPromise(() => hosted.json())).toEqual({
        data: { url: "https://app.fidyapp.com/upgrade" },
        next: [],
      });
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT user_id, session_id, operation, outcome FROM (SELECT sequence AS rowid,id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='credential_call') AS pat_audit ORDER BY rowid"
            )
            .all()
        )).results
      ).toEqual([
        { user_id: userA, session_id: sessionA, operation, outcome: "accepted" },
        { user_id: userA, session_id: sessionA, operation, outcome: "accepted" },
      ]);
    })
);

effectIt.effect("inherits the query owner's Clock for credential expiry and Audit evidence", () =>
  Effect.gen(function* () {
    const db = yield* fromTestPromise(() => fixture());
    const clock = yield* Clock.Clock;
    const session = yield* fromTestPromise(() =>
      db
        .prepare("SELECT hard_expires_at_ms FROM web_sessions WHERE id = ?")
        .bind(sessionA)
        .first<{ hard_expires_at_ms: number }>()
    );
    if (session === null) return yield* Effect.die(new Error("Missing test WebSession"));
    const atTime = (millis: number): Clock.Clock => ({
      currentTimeMillisUnsafe: () => millis,
      currentTimeMillis: Effect.succeed(millis),
      currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
      currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) => clock.sleep(duration),
    });
    const query = {
      db,
      subject: { id: sessionA, userId: userA, digest: token },
      operation: CanonicalOperationId.make("subscription.getSubscriptionStatus"),
      input: {},
      bucket: Option.none(),
    };
    const acceptedAt = session.hard_expires_at_ms - 1;
    const accepted = Option.getOrThrow(
      yield* executeCanonicalQuery(query).pipe(
        Effect.provideService(Clock.Clock, atTime(acceptedAt))
      )
    );
    expect(accepted.status).toBe(200);
    const expired = Option.getOrThrow(
      yield* executeCanonicalQuery(query).pipe(
        Effect.provideService(Clock.Clock, atTime(session.hard_expires_at_ms))
      )
    );
    expect(expired.status).toBe(401);
    expect(
      (yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT occurred_at_ms FROM (SELECT id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='credential_call') AS pat_audit"
          )
          .all()
      )).results
    ).toEqual([{ occurred_at_ms: acceptedAt }]);
  })
);

effectIt.effect(
  "returns only the authenticated User's expired trial and rejects a wrong bearer without an audit",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => fixture());
      const subject = { id: sessionA, userId: userA, digest: token };
      const response = yield* executeProtectedSubscriptionQuery({
        db,
        subject,
        operation: "subscription.getSubscriptionStatus",
      });
      expect(response.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.toCodecJson(SubscriptionStatus) })
      )(yield* fromTestPromise(() => response.json()));
      expect(body.data.accessTier).toBe("free");
      expect(body.data.trialPeriod.startedAt.epochMilliseconds).toBe(
        Date.parse("2026-09-01T12:00:00Z")
      );
      expect(body.data.recentAttempts).toEqual([]);
      const foreign = yield* executeProtectedSubscriptionQuery({
        db,
        subject: { ...subject, userId: userB },
        operation: "subscription.getSubscriptionStatus",
      });
      expect(foreign.status).toBe(401);
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms FROM (SELECT id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='credential_call') AS pat_audit"
            )
            .all()
        )).results
      ).toHaveLength(1);
    })
);

effectIt.effect("cannot renew the original TrialPeriod by updating its persisted interval", () =>
  Effect.gen(function* () {
    const db = yield* fromTestPromise(() => fixture());
    yield* fromTestPromise(() =>
      expect(
        db
          .prepare("UPDATE users SET trial_ends_at_ms = trial_ends_at_ms + 604800000 WHERE id = ?")
          .bind(userA)
          .run()
      ).rejects.toThrow()
    );
    const response = yield* executeProtectedSubscriptionQuery({
      db,
      subject: { id: sessionA, userId: userA, digest: token },
      operation: "subscription.getSubscriptionStatus",
    });
    const body = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.toCodecJson(SubscriptionStatus) })
    )(yield* fromTestPromise(() => response.json()));
    expect(body.data.trialPeriod.endsAt.epochMilliseconds).toBe(pastEnd);
  })
);

effectIt.effect(
  "refuses an under-scoped PAT without exposing standing or recording successful work",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => fixture());
      const subject = {
        patId,
        userId: userA,
        digest: token,
        requiredScope: Option.some("read" as const),
      };
      const operations = [
        "subscription.getSubscriptionStatus",
        "subscription.listSubscriptionOffers",
      ] as const;
      const responses = yield* Effect.forEach(operations, (operation) =>
        executeProtectedSubscriptionQuery({ db, subject, operation })
      );
      for (const response of responses) {
        expect(response.status).toBe(401);
      }
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms FROM (SELECT id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='credential_call') AS pat_audit"
            )
            .all()
        )).results
      ).toHaveLength(0);
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(patId).first()
        )
      ).toEqual({ last_used_at_ms: null });
    })
);

effectIt.effect(
  "refuses a revoked WebSession at the canonical HTTP boundary without recording accepted work",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => fixture());
      const bearer = "1".repeat(43);
      const digest = new Uint8Array(
        yield* fromTestPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))
        )
      );
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE web_sessions SET token_digest = ? WHERE id = ?")
          .bind(digest, sessionA)
          .run()
      );
      const environment: Parameters<typeof coreWorker.fetch>[1] = {
        OPENAI_API_KEY: openAiTestKey({ run: () => Promise.reject(new Error("unused")) }),
        DB: db,
        HOSTED_AI_MODEL: approvedOpenAiModel,
        CONTRACT_DIGEST: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        BROWSER_ORIGIN: "https://app.fidyapp.com",
        WOMPI_ENVIRONMENT: "sandbox",
        WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
        WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
        WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
        USER_TRANSACTION_COORDINATOR: {
          getByName: (): { fetch: () => Promise<Response> } => ({
            fetch: (): Promise<Response> => Promise.reject(new Error("unused")),
          }),
        },
        KAPSO_WEBHOOK_SECRET: "",
        CLOUDFLARE_ACCESS_ISSUER: "",
        CLOUDFLARE_ACCESS_AUDIENCE: "",
        KAPSO_API_KEY: "",
        WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
        WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
        RELEASE_GIT_SHA: "",
      };
      const request = (): Request =>
        new Request("https://core.internal/subscription/status", {
          headers: { "Fidy-Session-Binding": sessionA, cookie: `__Host-fidy_session=${bearer}` },
        });
      const before = yield* fromTestPromise(() => coreWorker.fetch(request(), environment));
      expect(before.status).toBe(200);
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms FROM (SELECT id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='credential_call') AS pat_audit"
            )
            .all()
        )).results
      ).toHaveLength(1);
      const revokedAt = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(revokedAt, sessionA)
          .run()
      );
      const after = yield* fromTestPromise(() => coreWorker.fetch(request(), environment));
      expect(after.status).toBe(401);
      expect(yield* fromTestPromise(() => after.text())).not.toContain("trialPeriod");
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms FROM (SELECT id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='credential_call') AS pat_audit"
            )
            .all()
        )).results
      ).toHaveLength(1);
    })
);

effectIt.effect(
  "refuses an invalid WebSession before returning published Subscription Prices",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => fixture());
      const denied = yield* executeProtectedSubscriptionQuery({
        db,
        subject: { id: sessionA, userId: userA, digest: new Uint8Array(32).fill(1) },
        operation: "subscription.listSubscriptionOffers",
      });
      expect(denied.status).toBe(401);
      const accepted = yield* executeProtectedSubscriptionQuery({
        db,
        subject: { id: sessionB, userId: userB, digest: token },
        operation: "subscription.listSubscriptionOffers",
      });
      expect(accepted.status).toBe(200);
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.toCodecJson(SubscriptionOffers) })
      )(yield* fromTestPromise(() => accepted.json()));
      expect(result.data).toHaveLength(3);
      expect(result.data[0].billingPeriod).toBe("weekly");
      expect(result.data[0].money.currency).toBe("COP");
    })
);

effectIt.effect(
  "reports manual Pro through protected status and preserves normal eligibility after revocation",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => fixture());
      const change = (action: "grant" | "revoke"): ReturnType<typeof executeProCommand> =>
        executeProCommand({
          command: { action, selector: { userId: userA } },
          operator: "operator",
          query: (statement) =>
            Effect.tryPromise({
              try: () =>
                db
                  .prepare(statement.sql)
                  .bind(...statement.params)
                  .all()
                  .then((result) => result.results),
              catch: () => new ProGrantFailure({ reason: "unavailable", candidates: [] }),
            }),
        });
      const status = Effect.gen(function* () {
        const response = yield* executeProtectedSubscriptionQuery({
          db,
          subject: { id: sessionA, userId: userA, digest: token },
          operation: "subscription.getSubscriptionStatus",
        });
        expect(response.status).toBe(200);
        return yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(SubscriptionStatus) })
        )(yield* fromTestPromise(() => response.json()));
      });
      yield* change("grant");
      const granted = yield* status;
      expect(granted.data.accessTier).toBe("pro");
      expect(granted.data.hasProGrant).toBe(true);
      expect(Option.isNone(granted.data.paidSubscription)).toBe(true);
      yield* change("revoke");
      const revoked = yield* status;
      expect(revoked.data.accessTier).toBe("free");
      expect(revoked.data.hasProGrant).toBe(false);
    })
);

const observeStanding = (
  db: D1Database,
  at: number,
  expected: "free" | "pro"
): Effect.Effect<SubscriptionStatus, Schema.SchemaError> =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const pro = activeProUserCondition({ userId: userA, nowEpochMs: at });
    expect(
      yield* fromTestPromise(() =>
        db
          .prepare(`SELECT ${pro.sql} AS active`)
          .bind(...pro.params)
          .first()
      )
    ).toEqual({ active: expected === "pro" ? 1 : 0 });
    const response = yield* executeProtectedSubscriptionQuery({
      db,
      subject: { id: sessionA, userId: userA, digest: token },
      operation: "subscription.getSubscriptionStatus",
    });
    expect(response.status).toBe(200);
    const body = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.toCodecJson(SubscriptionStatus) })
    )(yield* fromTestPromise(() => response.json()));
    expect(body.data.accessTier).toBe(expected);
    return body.data;
  });

effectIt.effect("agrees with the access predicate through trial and paid grace boundaries", () =>
  Effect.gen(function* () {
    const db = yield* fromTestPromise(() => fixture(Option.some(100000000000000)));
    const observe = (at: number, expected: "free" | "pro"): ReturnType<typeof observeStanding> =>
      observeStanding(db, at, expected);
    yield* observe(Date.parse("2026-09-01T12:00:00Z") - 1, "free");
    yield* observe(Date.parse("2026-09-01T12:00:00Z"), "pro");
    yield* observe(pastEnd - 1, "pro");
    yield* observe(pastEnd, "free");
    yield* seedPaidCardSubscription({ db, userId: userA });
    yield* observe(9999999999999, "pro");
    yield* observe(9999999999999 + 259200000 - 1, "pro");
    yield* observe(9999999999999 + 259200000, "free");
    const read = (
      sql: string,
      params: ReadonlyArray<string>
    ): ReturnType<typeof prepareSubscriptionStatus> =>
      prepareSubscriptionStatus({
        users: { sql, params },
        current: pastEnd,
        authority: { table: "web_sessions", predicate: "id=?", bindings: [sessionA] },
      });
    for (const sql of [
      "SELECT ? AS userId WHERE 0",
      "SELECT ? AS userId UNION ALL SELECT '10000000-0000-4000-8000-000000000002'",
    ]) {
      const prepared = read(sql, [userA]);
      const results = yield* fromTestPromise(() =>
        db.batch(
          prepared.statements.map((statement) =>
            db.prepare(statement.sql).bind(...statement.params)
          )
        )
      );
      expect(() => prepared.decode(results.map((result) => result.results))).toThrow();
    }
    const prepared = read("SELECT ? AS userId UNION ALL SELECT ?", [userA, userA]);
    const results = yield* fromTestPromise(() =>
      db.batch(
        prepared.statements.map((statement) => db.prepare(statement.sql).bind(...statement.params))
      )
    );
    expect(prepared.decode(results.map((result) => result.results))).toMatchObject({
      accessTier: "pro",
    });
  })
);

effectIt.effect(
  "returns unavailable without a partial explanation when standing storage is missing",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => fixture());
      yield* fromTestPromise(() => db.prepare("DROP TABLE pro_grant_events").run());
      const response = yield* executeProtectedSubscriptionQuery({
        db,
        subject: { id: sessionA, userId: userA, digest: token },
        operation: "subscription.getSubscriptionStatus",
      });
      expect(response.status).toBe(503);
      expect(yield* fromTestPromise(() => response.json())).toMatchObject({
        error: { code: "unavailable" },
      });
    })
);

const changeGrant = (
  db: D1Database,
  action: "grant" | "revoke",
  now: number
): Effect.Effect<void> => {
  const statement = prepareProGrant({
    action,
    selector: { userId: userA },
    operator: "test-operator",
    now,
  });
  return fromTestPromise(() =>
    db
      .prepare(statement.sql)
      .bind(...statement.params)
      .run()
  ).pipe(Effect.asVoid);
};

effectIt.effect(
  "preserves paid-through after cancellation, removes grace, and retains an independent manual grant",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => fixture(Option.some(100000000000000)));
      yield* seedPaidCardSubscription({ db, userId: userA });
      yield* TestClock.setTime(pastEnd + 1);
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO subscription_cancellations(subscription_id,paid_attempt_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation_state,verification_count)
      VALUES (?,'40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',?,9999999999999,'detached',0)`)
          .bind(userA, pastEnd + 1)
          .run()
      );
      const cancelled = yield* observeStanding(db, pastEnd + 1, "pro");
      expect(Option.getOrThrow(cancelled.cancellation).paidThrough.epochMilliseconds).toBe(
        9999999999999
      );
      yield* observeStanding(db, 9999999999998, "pro");
      yield* observeStanding(db, 9999999999999, "free");
      yield* changeGrant(db, "grant", 9999999999999);
      expect((yield* observeStanding(db, 9999999999999, "pro")).hasProGrant).toBe(true);
      yield* changeGrant(db, "revoke", 9999999999999);
      yield* observeStanding(db, 9999999999999, "free");
    })
);

effectIt.effect(
  "keeps trial and manual access independent of queued and verified refund adjustments",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => fixture(Option.some(100000000000000)));
      const trialStart = Date.parse("2026-09-01T12:00:00Z");
      yield* changeGrant(db, "grant", trialStart);
      expect((yield* observeStanding(db, trialStart, "pro")).hasProGrant).toBe(true);
      yield* changeGrant(db, "revoke", trialStart + 1);
      expect((yield* observeStanding(db, trialStart + 1, "pro")).hasProGrant).toBe(false);
      yield* seedPaidCardSubscription({ db, userId: userA });
      const refund = yield* startRefund({
        db,
        environment: "sandbox",
        authority: {
          operatorId: "test-operator",
          permission: "billing.refund",
          expiresAtMs: 9999999999999,
        },
        input: {
          userId: userA,
          billingAttemptId: "40000000-0000-4000-8000-000000000001",
          requestId: "50000000-0000-4000-8000-000000000002",
          intent: { kind: "refund", money: { amount: "4000", currency: "COP" } },
          reason: "user-request",
        },
      });
      const queued = yield* observeStanding(db, trialStart + 2, "pro");
      expect(Option.getOrThrow(queued.paidSubscription).endsAt.epochMilliseconds).toBe(
        9999999999999
      );
      yield* observeStanding(db, pastEnd, "pro");
      const adjustedAt = trialStart + 3;
      yield* fromTestPromise(() =>
        db.batch([
          db
            .prepare("UPDATE refund_attempts SET submission_claimed_at_ms=? WHERE id=?")
            .bind(adjustedAt, refund.id),
          db
            .prepare(
              "UPDATE refund_attempts SET provider_refund_id='verified-refund',verified_status='APPROVED',observed_at_ms=? WHERE id=?"
            )
            .bind(adjustedAt, refund.id),
        ])
      );
      const adjusted = yield* observeStanding(db, adjustedAt, "pro");
      expect(Option.getOrThrow(adjusted.paidSubscription).endsAt.epochMilliseconds).toBe(
        adjustedAt
      );
      yield* observeStanding(db, pastEnd - 1, "pro");
      yield* observeStanding(db, pastEnd, "free");
      yield* changeGrant(db, "grant", pastEnd);
      expect((yield* observeStanding(db, pastEnd, "pro")).hasProGrant).toBe(true);
      yield* changeGrant(db, "revoke", pastEnd);
      yield* observeStanding(db, pastEnd, "free");
    })
);
