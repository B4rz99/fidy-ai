import { it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { expect } from "vitest";
import {
  BillingEmail,
  PaymentEnrollmentId,
  PaymentRequestId,
} from "../../src/core/subscription/contract";
import { UserId } from "../../src/core/identity/contract";
import { claimPreparedPaymentEnrollment } from "./internal/payment-enrollment-claim";
import { makePaymentEnrollmentD1 } from "./payment-enrollment-d1.test-fixture";

const userA = UserId.make("10000000-0000-4000-8000-000000000001");
const userB = UserId.make("10000000-0000-4000-8000-000000000002");
const enrollmentId = PaymentEnrollmentId.make("20000000-0000-4000-8000-000000000001");
const paymentRequestId = PaymentRequestId.make("30000000-0000-4000-8000-000000000001");
const billingEmail = BillingEmail.make("a@example.test");
const priceId = "22700000-0000-4000-8000-000000000001";
const nowMs = 1_000_000;

class TestOperationFailure extends Data.TaggedError("TestOperationFailure") {}
const fromPromise = <A>(tryPromise: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: tryPromise, catch: () => new TestOperationFailure() }).pipe(
    Effect.orDie
  );

const setup = (): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const { db } = yield* makePaymentEnrollmentD1([
      "CREATE TABLE users (paid_attempt_id TEXT,paid_price_id TEXT,paid_period_ends_at_ms INTEGER,paid_renewal_anchor_ms INTEGER,id TEXT PRIMARY KEY NOT NULL ,service_market TEXT,locale TEXT,time_zone TEXT,created_at_ms INTEGER,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER,route_portfolio_id TEXT,route_bsuid TEXT,route_phone_number_id TEXT,route_verified_at_ms INTEGER) STRICT",
    ]);

    yield* fromPromise(() =>
      db
        .prepare(
          "WITH fixture_user(id) AS (VALUES (?), (?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) SELECT id,'CO','es-CO','America/Bogota',0 FROM fixture_user"
        )
        .bind(userA, userB)
        .run()
    );
    yield* fromPromise(() =>
      db.prepare("INSERT INTO subscriptions(id,user_id) VALUES(?,?)").bind(userA, userA).run()
    );
    yield* fromPromise(() =>
      db
        .prepare(`INSERT INTO payment_enrollments
    (id, subscription_id, price_id, billing_email, status, payment_source_mode,
     contracts_json, disclosure_json, prepared_at_ms, expires_at_ms, wompi_environment)
    VALUES (?, ?, ?, 'a@example.test', 'prepared', 'create', '{}', '{}', ?, ?, 'sandbox')`)
        .bind(enrollmentId, userA, priceId, nowMs, nowMs + 900_000)
        .run()
    );
    return db;
  });

it.effect("only the owning User can claim a prepared PaymentEnrollment, once", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const request = {
      enrollmentId,
      paymentRequestId,
      billingEmail,
      paymentSourceMode: "create" as const,
    };
    expect(
      yield* fromPromise(() =>
        claimPreparedPaymentEnrollment({
          authorityGuard: { sql: "SELECT 1", params: [] },
          db,
          input: { ...request, userId: userB },
          claimedAtMs: nowMs,
        })
      )
    ).toBe(false);
    const unclaimed = yield* fromPromise(() =>
      db
        .prepare("SELECT status, payment_request_id FROM payment_enrollments WHERE id = ?")
        .bind(enrollmentId)
        .first()
    );
    expect(unclaimed).toEqual({ status: "prepared", payment_request_id: null });
    const outcomes = yield* fromPromise(() =>
      Promise.all([
        claimPreparedPaymentEnrollment({
          authorityGuard: { sql: "SELECT 1", params: [] },
          db,
          input: { ...request, userId: userA },
          claimedAtMs: nowMs,
        }),
        claimPreparedPaymentEnrollment({
          authorityGuard: { sql: "SELECT 1", params: [] },
          db,
          input: { ...request, userId: userA },
          claimedAtMs: nowMs,
        }),
      ])
    );
    expect(outcomes.sort((left, right) => Number(left) - Number(right))).toEqual([false, true]);
    expect(
      yield* fromPromise(() =>
        claimPreparedPaymentEnrollment({
          authorityGuard: { sql: "SELECT 1", params: [] },
          db,
          input: { ...request, userId: userA },
          claimedAtMs: nowMs,
        })
      )
    ).toBe(false);
    expect(
      yield* fromPromise(() =>
        db
          .prepare("SELECT status, payment_request_id FROM payment_enrollments WHERE id = ?")
          .bind(enrollmentId)
          .first()
      )
    ).toEqual({ status: "creating", payment_request_id: paymentRequestId });
  })
);

it.effect("an expired preparation cannot authorize a provider source", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    expect(
      yield* fromPromise(() =>
        claimPreparedPaymentEnrollment({
          authorityGuard: { sql: "SELECT 1", params: [] },
          db,
          input: {
            userId: userA,
            enrollmentId,
            paymentRequestId,
            billingEmail,
            paymentSourceMode: "create",
          },
          claimedAtMs: nowMs + 900_000,
        })
      )
    ).toBe(false);
    yield* fromPromise(() =>
      expect(
        db
          .prepare(
            `INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_source_id,billing_email,verified_at_ms,method,wompi_environment,archive_row_ref)
 SELECT incoming.id,e.subscription_id,incoming.enrollment_id,incoming.wompi_source_id,incoming.billing_email,incoming.created_at_ms,'card',e.wompi_environment,'source:'||incoming.id FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms FROM (VALUES (?, ?, ?, 42, 'a@example.test', ?))) incoming
 JOIN payment_enrollments e ON e.id=incoming.enrollment_id JOIN subscriptions sub ON sub.id=e.subscription_id AND sub.user_id=incoming.user_id`
          )
          .bind("50000000-0000-4000-8000-000000000001", userA, enrollmentId, nowMs)
          .run()
      ).rejects.toThrow()
    );
    expect(
      (yield* fromPromise(() => db.prepare("SELECT id FROM payment_source_context").all())).results
    ).toEqual([]);
  })
);

it.effect("rejects a source with another authorization method or provider environment", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    yield* fromPromise(() =>
      claimPreparedPaymentEnrollment({
        db,
        authorityGuard: { sql: "SELECT 1", params: [] },
        input: {
          userId: userA,
          enrollmentId,
          paymentRequestId,
          billingEmail,
          paymentSourceMode: "create",
        },
        claimedAtMs: nowMs,
      })
    );
    yield* fromPromise(() =>
      db
        .prepare("UPDATE payment_enrollments SET wompi_candidate_source_id = 42 WHERE id = ?")
        .bind(enrollmentId)
        .run()
    );
    yield* fromPromise(() =>
      expect(
        db
          .prepare(
            `INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_source_id,billing_email,verified_at_ms,method,wompi_environment,archive_row_ref)
 SELECT incoming.id,e.subscription_id,incoming.enrollment_id,incoming.wompi_source_id,incoming.billing_email,incoming.created_at_ms,incoming.method,e.wompi_environment,'source:'||incoming.id FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms,column7 AS method FROM (VALUES (?, ?, ?, 42, ?, ?, 'nequi'))) incoming
 JOIN payment_enrollments e ON e.id=incoming.enrollment_id JOIN subscriptions sub ON sub.id=e.subscription_id AND sub.user_id=incoming.user_id`
          )
          .bind("50000000-0000-4000-8000-000000000001", userA, enrollmentId, billingEmail, nowMs)
          .run()
      ).rejects.toThrow()
    );
    yield* fromPromise(() =>
      expect(
        db
          .prepare("UPDATE payment_enrollments SET wompi_environment = 'production' WHERE id = ?")
          .bind(enrollmentId)
          .run()
      ).rejects.toThrow()
    );
    expect(
      (yield* fromPromise(() => db.prepare("SELECT id FROM payment_source_context").all())).results
    ).toEqual([]);
  })
);

it.effect("rejects a pending BillingAttempt whose snapshot differs from the selected Price", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    expect(
      yield* fromPromise(() =>
        claimPreparedPaymentEnrollment({
          authorityGuard: { sql: "SELECT 1", params: [] },
          db,
          input: {
            userId: userA,
            enrollmentId,
            paymentRequestId,
            billingEmail,
            paymentSourceMode: "create",
          },
          claimedAtMs: nowMs,
        })
      )
    ).toBe(true);
    const sourceId = "50000000-0000-4000-8000-000000000001";
    yield* fromPromise(() =>
      db
        .prepare("UPDATE payment_enrollments SET wompi_candidate_source_id = 42 WHERE id = ?")
        .bind(enrollmentId)
        .run()
    );
    yield* fromPromise(() =>
      db
        .prepare(
          `INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_source_id,billing_email,verified_at_ms,method,wompi_environment,archive_row_ref)
 SELECT incoming.id,e.subscription_id,incoming.enrollment_id,incoming.wompi_source_id,incoming.billing_email,incoming.created_at_ms,'card',e.wompi_environment,'source:'||incoming.id FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms FROM (VALUES (?, ?, ?, 42, ?, ?))) incoming
 JOIN payment_enrollments e ON e.id=incoming.enrollment_id JOIN subscriptions sub ON sub.id=e.subscription_id AND sub.user_id=incoming.user_id`
        )
        .bind(sourceId, userA, enrollmentId, billingEmail, nowMs)
        .run()
    );
    yield* fromPromise(() =>
      db
        .prepare("UPDATE payment_enrollments SET status = 'available' WHERE id = ?")
        .bind(enrollmentId)
        .run()
    );
    const insert = db.prepare(
      `INSERT INTO billing_attempts (id, subscription_id, enrollment_id, payment_request_id, payment_source_id, price_id, time_zone, wompi_environment, wompi_reference, created_at_ms) VALUES (?, (SELECT id FROM subscriptions WHERE user_id=?), ?, ?, ?, ?, 'America/Bogota', 'sandbox', ?, ?)`
    );
    yield* fromPromise(() =>
      expect(
        insert
          .bind(
            "60000000-0000-4000-8000-000000000001",
            userA,
            enrollmentId,
            paymentRequestId,
            sourceId,
            "22700000-0000-4000-8000-000000000002",
            "fidy-60000000-0000-4000-8000-000000000001",
            nowMs
          )
          .run()
      ).rejects.toThrow()
    );
    expect(
      (yield* fromPromise(() => db.prepare("SELECT id FROM billing_attempt_context").all())).results
    ).toEqual([]);
  })
);
