import { expect } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { SubscriptionOffers, SubscriptionStatus } from "../../src/core/subscription/contract";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { makePaymentEnrollmentD1 } from "./payment-enrollment-d1.test-fixture";
import { executeProtectedSubscriptionQuery } from "./operations";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import {
  executeCanonicalHttpQuery,
  executeCanonicalQuery,
} from "../canonical-operations/operations";

import coreWorker from "../core-worker";
import { applyTestMigration } from "../d1-test-fixture";

const fromTestPromise = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise(() => Promise.resolve(run())).pipe(Effect.orDie);

const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const sessionA = "20000000-0000-4000-8000-000000000001";
const sessionB = "20000000-0000-4000-8000-000000000002";
const patId = "30000000-0000-4000-8000-000000000001";
const token = new Uint8Array(32);
const pastEnd = Date.parse("2026-09-08T12:00:00Z");

const fixture = (): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const created = yield* makePaymentEnrollmentD1([
        "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT",
        "CREATE TABLE trial_periods (user_id TEXT PRIMARY KEY, started_at_ms INTEGER NOT NULL, ends_at_ms INTEGER NOT NULL) STRICT",
        "CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_digest BLOB NOT NULL, revoked_at_ms INTEGER, idle_expires_at_ms INTEGER NOT NULL, hard_expires_at_ms INTEGER NOT NULL) STRICT",
        "CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY) STRICT",
        "CREATE TABLE pat_audit (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, pat_id TEXT, oauth_connection_id TEXT, oauth_credential_id TEXT, operation TEXT NOT NULL, outcome TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL) STRICT",
        "CREATE TABLE pat_atomic_assertion (id INTEGER PRIMARY KEY CHECK (id = 1), accepted INTEGER NOT NULL CHECK (accepted = 1)) STRICT",
        "CREATE TABLE pats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bearer_digest BLOB NOT NULL, scopes_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, last_used_at_ms INTEGER) STRICT",
      ]);

      const db = created.db;
      const migration = yield* fromTestPromise(() =>
        Bun.file(new URL("../migrations/0016_subscription_standing.sql", import.meta.url)).text()
      );
      yield* fromTestPromise(() =>
        db.batch(
          migration
            .replace(/^--.*$/gmu, "")
            .trim()
            .split(/;\s*\n(?=CREATE |DROP |$)/u)
            .map((statement) => db.prepare(statement))
        )
      );
      for (const name of ["0032_commercial_allowances", "0033_canonical_request_protection"]) {
        yield* fromTestPromise(() =>
          applyTestMigration({ db, source: new URL(`../migrations/${name}.sql`, import.meta.url) })
        );
      }
      const past = Date.parse("2026-09-01T12:00:00Z");
      const future = (yield* Clock.currentTimeMillis) + 86_400_000;
      yield* fromTestPromise(() =>
        db.batch([
          db.prepare("INSERT INTO users VALUES (?, 'America/Bogota')").bind(userA),
          db.prepare("INSERT INTO users VALUES (?, 'America/Bogota')").bind(userB),
          db
            .prepare("INSERT INTO trial_periods VALUES (?, ?, ?)")
            .bind(userA, past, past + 604_800_000),
          db
            .prepare("INSERT INTO trial_periods VALUES (?, ?, ?)")
            .bind(userB, past, past + 604_800_000),
          db
            .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?)")
            .bind(sessionA, userA, token, future, future),
          db
            .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?)")
            .bind(sessionB, userB, token, future, future),
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
            .prepare("SELECT user_id, session_id, operation, outcome FROM pat_audit ORDER BY rowid")
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
      (yield* fromTestPromise(() => db.prepare("SELECT occurred_at_ms FROM pat_audit").all()))
        .results
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
        (yield* fromTestPromise(() => db.prepare("SELECT * FROM pat_audit").all())).results
      ).toHaveLength(1);
    })
);

effectIt.effect("cannot renew the original TrialPeriod by updating its persisted interval", () =>
  Effect.gen(function* () {
    const db = yield* fromTestPromise(() => fixture());
    yield* fromTestPromise(() =>
      expect(
        db
          .prepare("UPDATE trial_periods SET ends_at_ms = ends_at_ms + 604800000 WHERE user_id = ?")
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
        (yield* fromTestPromise(() => db.prepare("SELECT * FROM pat_audit").all())).results
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
        AI: { run: () => Promise.reject(new Error("unused")) },
        DB: db,
        HOSTED_AI_MODEL: approvedWorkersAiModel,
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
        WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
        RELEASE_GIT_SHA: "",
      };
      const request = (): Request =>
        new Request("https://core.internal/subscription/status", {
          headers: { cookie: `__Host-fidy_session=${bearer}` },
        });
      const before = yield* fromTestPromise(() => coreWorker.fetch(request(), environment));
      expect(before.status).toBe(200);
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT * FROM pat_audit").all())).results
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
        (yield* fromTestPromise(() => db.prepare("SELECT * FROM pat_audit").all())).results
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
