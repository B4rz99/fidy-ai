import type { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { afterEach, expect } from "vitest";
import { BillingEmail, CardEnrollmentId, PaymentRequestId } from "@fidy/server/client";
import { UserId } from "@fidy/server/identity-runtime";
import { claimPreparedCardEnrollment } from "./card-enrollment-claim";
import { makeCardEnrollmentD1 } from "./card-enrollment-d1.test-fixture";

const userA = UserId.make("10000000-0000-4000-8000-000000000001");
const userB = UserId.make("10000000-0000-4000-8000-000000000002");
const enrollmentId = CardEnrollmentId.make("20000000-0000-4000-8000-000000000001");
const paymentRequestId = PaymentRequestId.make("30000000-0000-4000-8000-000000000001");
const billingEmail = BillingEmail.make("a@example.test");
const priceId = "22700000-0000-4000-8000-000000000001";
const nowMs = 1_000_000;
let nextDatabase = 0;
const instances: Array<Miniflare> = [];

afterEach(() => Promise.all(instances.splice(0).map((instance) => instance.dispose())));

class TestOperationFailure extends Data.TaggedError("TestOperationFailure") {}
const fromPromise = <A>(tryPromise: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: tryPromise, catch: () => new TestOperationFailure() }).pipe(
    Effect.orDie
  );

const setup = (): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const name = `card-enrollment-${++nextDatabase}`;
    const { db, instance } = yield* makeCardEnrollmentD1(name, [
      "CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL) STRICT",
    ]);
    instances.push(instance);
    yield* fromPromise(() =>
      db.prepare("INSERT INTO users (id) VALUES (?), (?)").bind(userA, userB).run()
    );
    yield* fromPromise(() =>
      db
        .prepare(`INSERT INTO card_enrollments
    (id, user_id, price_id, billing_email, status, payment_source_mode,
     contracts_json, disclosure_json, prepared_at_ms, expires_at_ms)
    VALUES (?, ?, ?, 'a@example.test', 'prepared', 'create', '{}', '{}', ?, ?)`)
        .bind(enrollmentId, userA, priceId, nowMs, nowMs + 900_000)
        .run()
    );
    return db;
  });

it.effect("only the owning User can claim a prepared CardEnrollment, once", () =>
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
        claimPreparedCardEnrollment({ db, input: { ...request, userId: userB }, nowMs })
      )
    ).toBe(false);
    const unclaimed = yield* fromPromise(() =>
      db
        .prepare("SELECT status, payment_request_id FROM card_enrollments WHERE id = ?")
        .bind(enrollmentId)
        .first()
    );
    expect(unclaimed).toEqual({ status: "prepared", payment_request_id: null });
    const outcomes = yield* fromPromise(() =>
      Promise.all([
        claimPreparedCardEnrollment({ db, input: { ...request, userId: userA }, nowMs }),
        claimPreparedCardEnrollment({ db, input: { ...request, userId: userA }, nowMs }),
      ])
    );
    expect(outcomes.sort((left, right) => Number(left) - Number(right))).toEqual([false, true]);
    expect(
      yield* fromPromise(() =>
        claimPreparedCardEnrollment({ db, input: { ...request, userId: userA }, nowMs })
      )
    ).toBe(false);
    expect(
      yield* fromPromise(() =>
        db
          .prepare("SELECT status, payment_request_id FROM card_enrollments WHERE id = ?")
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
        claimPreparedCardEnrollment({
          db,
          input: {
            userId: userA,
            enrollmentId,
            paymentRequestId,
            billingEmail,
            paymentSourceMode: "create",
          },
          nowMs: nowMs + 900_000,
        })
      )
    ).toBe(false);
    yield* fromPromise(() =>
      expect(
        db
          .prepare(`INSERT INTO card_payment_sources
    (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms)
    VALUES (?, ?, ?, 42, 'a@example.test', ?)`)
          .bind("50000000-0000-4000-8000-000000000001", userA, enrollmentId, nowMs)
          .run()
      ).rejects.toThrow()
    );
    expect(
      (yield* fromPromise(() => db.prepare("SELECT id FROM card_payment_sources").all())).results
    ).toEqual([]);
  })
);

it.effect("rejects a pending BillingAttempt whose snapshot differs from the selected Price", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    expect(
      yield* fromPromise(() =>
        claimPreparedCardEnrollment({
          db,
          input: {
            userId: userA,
            enrollmentId,
            paymentRequestId,
            billingEmail,
            paymentSourceMode: "create",
          },
          nowMs,
        })
      )
    ).toBe(true);
    const sourceId = "50000000-0000-4000-8000-000000000001";
    yield* fromPromise(() =>
      db
        .prepare("UPDATE card_enrollments SET wompi_candidate_source_id = 42 WHERE id = ?")
        .bind(enrollmentId)
        .run()
    );
    yield* fromPromise(() =>
      db
        .prepare(`INSERT INTO card_payment_sources
    (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms)
    VALUES (?, ?, ?, 42, ?, ?)`)
        .bind(sourceId, userA, enrollmentId, billingEmail, nowMs)
        .run()
    );
    yield* fromPromise(() =>
      db
        .prepare("UPDATE card_enrollments SET status = 'available' WHERE id = ?")
        .bind(enrollmentId)
        .run()
    );
    const insert = db.prepare(`INSERT INTO billing_attempts
    (id, user_id, enrollment_id, payment_request_id, payment_source_id, price_id,
     amount, currency, billing_period, service_market, tax_treatment, time_zone,
     wompi_environment, wompi_reference, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'COP', 'weekly', 'CO', 'not-taxable',
      'America/Bogota', 'sandbox', ?, ?)`);
    yield* fromPromise(() =>
      expect(
        insert
          .bind(
            "60000000-0000-4000-8000-000000000001",
            userA,
            enrollmentId,
            paymentRequestId,
            sourceId,
            priceId,
            "1",
            "fidy-60000000-0000-4000-8000-000000000001",
            nowMs
          )
          .run()
      ).rejects.toThrow()
    );
    expect(
      (yield* fromPromise(() => db.prepare("SELECT id FROM billing_attempts").all())).results
    ).toEqual([]);
  })
);
