import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { UserId } from "../../src/core/identity/contract";
import { activePaidSubscriptionCondition } from "../../src/shell/subscription/operations";
import { type Miniflare } from "miniflare";
import { afterEach, expect, it, vi } from "vitest";
import { type Cause, DateTime, Effect, Fiber, Option, Schema } from "effect";
import { makePaymentEnrollmentD1 } from "./payment-enrollment-d1.test-fixture";
import {
  dispatchSubscriptionRenewals,
  publishWeeklyPriceAndNotify,
  receiveBillingCollection,
  runBillingCollectionWorkflow,
} from "./runtime";
import { type BillingCollectionFailure, type BillingRuntime } from "./contract";
import { Price } from "../../src/core/subscription/contract";
import { executeSubscriptionRenewalAdmission, publishWeeklyPrice } from "./operations";

const RecordedTransaction = Schema.Struct({
  data: Schema.Struct({
    id: Schema.String,
    reference: Schema.String,
    status: Schema.Literals(["PENDING", "APPROVED", "DECLINED"]),
    amount_in_cents: Schema.Int,
    currency: Schema.String,
    payment_source_id: Schema.Int,
    finalized_at: Schema.NullOr(Schema.String),
  }),
});
const recordedTransactions = {
  PENDING: Schema.decodeSync(Schema.fromJsonString(RecordedTransaction))(
    await Bun.file(
      new URL("./internal/fixtures/wompi-transaction-created.sandbox.json", import.meta.url)
    ).text()
  ),
  APPROVED: Schema.decodeSync(Schema.fromJsonString(RecordedTransaction))(
    await Bun.file(
      new URL("./internal/fixtures/wompi-transaction-approved.sandbox.json", import.meta.url)
    ).text()
  ),
  DECLINED: Schema.decodeSync(Schema.fromJsonString(RecordedTransaction))(
    await Bun.file(
      new URL("./internal/fixtures/wompi-transaction-declined.sandbox.json", import.meta.url)
    ).text()
  ),
};

const userId = "10000000-0000-4000-8000-000000000001";
const enrollmentId = "20000000-0000-4000-8000-000000000001";
const sourceId = "30000000-0000-4000-8000-000000000001";
const attemptId = "40000000-0000-4000-8000-000000000001";
const paymentRequestId = "50000000-0000-4000-8000-000000000001";
const priceId = "22700000-0000-4000-8000-000000000001";
const reference = `fidy-${attemptId}`;
let instance: Option.Option<Miniflare> = Option.none();
let fixtureCounter = 0;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  const disposed = Option.match(instance, {
    onNone: () => Promise.resolve(),
    onSome: (value) => value.dispose(),
  });
  instance = Option.none();
  return disposed;
});

const fixture = (
  method: "card" | "nequi" | "daviplata" = "card",
  calendar: Readonly<{
    billingPeriod: "weekly" | "monthly" | "yearly";
    startsAt: string;
    endsAt: string;
  }> = {
    billingPeriod: "weekly",
    startsAt: "2026-10-06T15:00:00Z",
    endsAt: "2026-10-13T15:00:00Z",
  }
): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const created = yield* makePaymentEnrollmentD1(`weekly-renewal-${++fixtureCounter}`, [
        "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT",
        "CREATE TABLE onboarding_consent_records (user_id TEXT PRIMARY KEY) STRICT",
        "CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY) STRICT",
      ]);
      instance = Option.some(created.instance);
      const db = created.db;
      const selectedPriceId = {
        weekly: priceId,
        monthly: "22700000-0000-4000-8000-000000000002",
        yearly: "22700000-0000-4000-8000-000000000003",
      }[calendar.billingPeriod];
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("INSERT INTO users VALUES (?, 'America/Bogota')").bind(userId),
          db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(userId),

          db
            .prepare(`INSERT INTO card_enrollments (id, user_id, price_id, billing_email, status,
        payment_source_mode, contracts_json, disclosure_json, prepared_at_ms, expires_at_ms,
        payment_request_id, wompi_candidate_source_id, method, wompi_environment)
        VALUES (?, ?, ?, 'payer@example.com', 'creating', 'create', '{}', '{}', 0, 900000, ?, 3891, ?, 'sandbox')`)
            .bind(enrollmentId, userId, selectedPriceId, paymentRequestId, method),
          db
            .prepare(`INSERT INTO card_payment_sources
        (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms, method)
        VALUES (?, ?, ?, 3891, 'payer@example.com', 0, ?)`)
            .bind(sourceId, userId, enrollmentId, method),
          db
            .prepare("UPDATE card_enrollments SET status = 'available' WHERE id = ?")
            .bind(enrollmentId),
          db
            .prepare(`INSERT INTO billing_attempts (id, user_id, enrollment_id, payment_request_id,
        payment_source_id, price_id, amount, currency, billing_period, service_market,
        tax_treatment, time_zone, wompi_environment, wompi_reference, created_at_ms)
        SELECT ?, ?, ?, ?, ?, id, amount, currency, billing_period, service_market, tax_treatment,
          'America/Bogota', 'sandbox', ?, 0 FROM subscription_prices WHERE id = ?`)
            .bind(
              attemptId,
              userId,
              enrollmentId,
              paymentRequestId,
              sourceId,
              reference,
              selectedPriceId
            ),
        ])
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "UPDATE billing_attempts SET status = 'succeeded', finalized_at_ms = ? WHERE id = ?"
            )
            .bind(Date.parse(calendar.startsAt), attemptId),
          db
            .prepare("INSERT INTO billing_paid_periods VALUES (?, ?, ?, ?)")
            .bind(
              attemptId,
              Date.parse(calendar.startsAt),
              Date.parse(calendar.endsAt),
              Date.parse(calendar.endsAt)
            ),
          db
            .prepare("INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?)")
            .bind(
              userId,
              attemptId,
              selectedPriceId,
              Date.parse(calendar.endsAt),
              Date.parse(calendar.endsAt)
            ),
          db
            .prepare("INSERT INTO billing_followup_outbox VALUES (?, 'renewal_due', ?)")
            .bind(attemptId, Date.parse(calendar.endsAt)),
        ])
      );
      return db;
    })
  );

const billingCalendars = [
  {
    billingPeriod: "weekly" as const,
    startsAt: "2026-10-06T15:00:00Z",
    endsAt: "2026-10-13T15:00:00Z",
  },
  {
    billingPeriod: "monthly" as const,
    startsAt: "2026-01-31T23:30:00Z",
    endsAt: "2026-02-28T23:30:00Z",
  },
  {
    billingPeriod: "yearly" as const,
    startsAt: "2024-02-29T15:00:00Z",
    endsAt: "2025-02-28T15:00:00Z",
  },
] as const;

const renewalCalendars = billingCalendars.flatMap((calendar) =>
  (["card", "nequi", "daviplata"] as const).map((method) => ({ ...calendar, method }))
);

const fromPromise = <A>(run: () => Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(run);
const dueAt = Date.parse("2026-10-13T15:00:00Z");
const admission = (db: D1Database, now: number = dueAt): Effect.Effect<Response> =>
  executeSubscriptionRenewalAdmission({
    db,
    userId,
    environment: "sandbox",
    now,
    candidate: { _tag: "SubscriptionRenewal", userId, previousPaidAttemptId: attemptId },
  });

it("converges concurrent due claims on one frozen pending weekly attempt and durable collection intent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      yield* Effect.all([admission(db), admission(db)], { concurrency: 2 });
      const rows = yield* fromPromise(() =>
        db
          .prepare("SELECT * FROM billing_attempts WHERE previous_paid_attempt_id = ?")
          .bind(attemptId)
          .all()
      );
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]).toMatchObject({
        status: "pending",
        price_id: priceId,
        amount: "9900",
        period_starts_at_ms: dueAt,
        period_ends_at_ms: Date.parse("2026-10-20T15:00:00Z"),
        attempt_number: 1,
      });
      expect(
        (yield* fromPromise(() =>
          db
            .prepare("SELECT * FROM billing_collection_outbox WHERE attempt_id <> ?")
            .bind(attemptId)
            .all()
        )).results
      ).toHaveLength(1);
      expect(
        (yield* fromPromise(() => db.prepare("SELECT * FROM billing_paid_periods").all())).results
      ).toHaveLength(1);
    })
  ));

it("settles a late renewal once into the frozen adjacent week and schedules the following boundary", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      yield* admission(db);
      const row = yield* fromPromise(() =>
        db
          .prepare(
            "SELECT id, wompi_reference FROM billing_attempts WHERE previous_paid_attempt_id = ?"
          )
          .bind(attemptId)
          .first<{ id: string; wompi_reference: string }>()
      );
      if (row === null) throw new Error("Missing renewal fixture");
      let posts = 0;
      vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") posts++;
        return Promise.resolve(
          Response.json({
            data: {
              id: "renewal-transaction",
              reference: row.wompi_reference,
              status: "APPROVED",
              amount_in_cents: 990000,
              currency: "COP",
              payment_source_id: 3891,
              finalized_at: "2026-10-13T15:04:00Z",
            },
          })
        );
      });
      const run = (): Promise<void> =>
        runBillingCollectionWorkflow({
          environment: {
            DB: db,
            WOMPI_ENVIRONMENT: "sandbox",
            WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
          },
          payload: { version: 1, attemptId: row.id },
          activity: (_name, _options, work) => work(),
        });
      yield* fromPromise(run);
      yield* fromPromise(run);
      expect(posts).toBe(1);
      expect(
        yield* fromPromise(() =>
          db
            .prepare(
              "SELECT starts_at_ms, ends_at_ms FROM billing_paid_periods WHERE attempt_id = ?"
            )
            .bind(row.id)
            .first()
        )
      ).toEqual({ starts_at_ms: dueAt, ends_at_ms: Date.parse("2026-10-20T15:00:00Z") });
      expect(
        (yield* fromPromise(() => db.prepare("SELECT * FROM billing_followup_outbox").all()))
          .results
      ).toEqual([
        { attempt_id: row.id, kind: "renewal_due", due_at_ms: Date.parse("2026-10-20T15:00:00Z") },
      ]);
    })
  ));

it.each(renewalCalendars)(
  "rejects foreign admission and refuses early and revoked $method $billingPeriod renewals without partial intent",
  (calendar) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fromPromise(() => fixture(calendar.method, calendar));
        const boundaryMs = Date.parse(calendar.endsAt);
        const foreignUserId = "10000000-0000-4000-8000-000000000002";
        yield* fromPromise(() =>
          db.batch([
            db.prepare("INSERT INTO users VALUES (?, 'America/Bogota')").bind(foreignUserId),
            db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(foreignUserId),
          ])
        );
        const billingState = (): Promise<D1Result[]> =>
          db.batch([
            db.prepare("SELECT * FROM billing_attempts ORDER BY id"),
            db.prepare("SELECT * FROM billing_collection_arms ORDER BY attempt_id"),
            db.prepare("SELECT * FROM billing_collection_outbox ORDER BY attempt_id"),
          ]);
        const before = (yield* fromPromise(billingState)).map((result) => result.results);
        yield* executeSubscriptionRenewalAdmission({
          db,
          userId: foreignUserId,
          environment: "sandbox",
          now: boundaryMs,
          candidate: {
            _tag: "SubscriptionRenewal",
            userId: foreignUserId,
            previousPaidAttemptId: attemptId,
          },
        });
        expect((yield* fromPromise(billingState)).map((result) => result.results)).toEqual(before);
        const foreign = yield* executeSubscriptionRenewalAdmission({
          db,
          userId: "10000000-0000-4000-8000-000000000002",
          environment: "sandbox",
          now: boundaryMs,
          candidate: { _tag: "SubscriptionRenewal", userId, previousPaidAttemptId: attemptId },
        });
        expect(foreign.status).toBe(403);
        yield* admission(db, boundaryMs - 1);
        yield* fromPromise(() =>
          db.prepare("INSERT INTO consent_user_revocations VALUES (?)").bind(userId).run()
        );
        yield* admission(db, boundaryMs);
        expect(
          (yield* fromPromise(() =>
            db
              .prepare("SELECT id FROM billing_attempts WHERE previous_paid_attempt_id IS NOT NULL")
              .all()
          )).results
        ).toEqual([]);
        expect(
          (yield* fromPromise(() => db.prepare("SELECT * FROM billing_collection_outbox").all()))
            .results
        ).toHaveLength(1);
      })
    )
);

it("preserves weekly card Pro for exactly three days after the boundary without rewriting paid history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      for (const [now, expected] of [
        [dueAt, 1],
        [Date.parse("2026-10-16T14:59:59.999Z"), 1],
        [Date.parse("2026-10-16T15:00:00Z"), 0],
      ] as const) {
        const condition = activePaidSubscriptionCondition({
          userId: UserId.make(userId),
          nowEpochMs: now,
        });
        expect(
          yield* fromPromise(() =>
            db
              .prepare(`SELECT ${condition.sql} AS active`)
              .bind(...condition.params)
              .first()
          )
        ).toEqual({ active: expected });
      }
      expect(
        yield* fromPromise(() =>
          db
            .prepare("SELECT ends_at_ms FROM billing_paid_periods WHERE attempt_id = ?")
            .bind(attemptId)
            .first()
        )
      ).toEqual({ ends_at_ms: dueAt });
    })
  ));

it("publishes a changed weekly Price with immediate durable notice and charges it only in newly admitted attempts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      const newPrice = yield* Schema.decodeEffect(Schema.toCodecJson(Price))({
        id: "22700000-0000-4000-8000-000000000004",
        money: { amount: "10900", currency: "COP" },
        billingPeriod: "weekly",
        serviceMarket: "CO",
        taxTreatment: "not-taxable",
        renewalTerms: {
          automaticRenewal: true,
          renewalReminder: "none",
          cancellation: "future-renewals-only",
          paidAccessEnds: "paid-period-end",
        },
        paymentMethods: ["card", "nequi", "daviplata"],
      });
      yield* publishWeeklyPrice({ db, price: newPrice });
      expect(
        (yield* fromPromise(() =>
          db.prepare("SELECT user_id, price_id FROM billing_price_notices").all()
        )).results
      ).toEqual([{ user_id: userId, price_id: newPrice.id }]);
      yield* admission(db);
      expect(
        yield* fromPromise(() =>
          db
            .prepare(
              "SELECT price_id, amount FROM billing_attempts WHERE previous_paid_attempt_id = ?"
            )
            .bind(attemptId)
            .first()
        )
      ).toEqual({ price_id: newPrice.id, amount: "10900" });
      expect(
        yield* fromPromise(() =>
          db.prepare("SELECT amount FROM billing_attempts WHERE id = ?").bind(attemptId).first()
        )
      ).toEqual({ amount: "9900" });
    })
  ));

it("offers Price-change notices immediately and sends the retained billing email once across Workflow replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      const newPrice = yield* Schema.decodeEffect(Schema.toCodecJson(Price))({
        id: "22700000-0000-4000-8000-000000000004",
        money: { amount: "10900", currency: "COP" },
        billingPeriod: "weekly",
        serviceMarket: "CO",
        taxTreatment: "not-taxable",
        renewalTerms: {
          automaticRenewal: true,
          renewalReminder: "none",
          cancellation: "future-renewals-only",
          paidAccessEnds: "paid-period-end",
        },
        paymentMethods: ["card", "nequi", "daviplata"],
      });
      let work: unknown;
      yield* publishWeeklyPriceAndNotify({
        DB: db,
        BILLING_COLLECTION_QUEUE: {
          send: (body) => {
            work = body;
            return Promise.resolve();
          },
        },
        price: newPrice,
      });
      expect(work).toEqual({ version: 1, kind: "price-notice", userId, priceId: newPrice.id });
      let sends = 0;
      vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => {
        sends++;
        return new Request(url, init).json().then((body: unknown) => {
          expect(body).toMatchObject({ to: ["payer@example.com"] });
          expect(body).toHaveProperty("text", expect.stringContaining("10900"));
          return Response.json({ id: "resend-price-notice" });
        });
      });
      const run = (): Promise<void> =>
        runBillingCollectionWorkflow({
          environment: {
            DB: db,
            WOMPI_ENVIRONMENT: "sandbox",
            WOMPI_PUBLIC_KEY: "unused",
            WOMPI_PRIVATE_KEY: "unused",
            WOMPI_INTEGRITY_SECRET: "unused",
            RESEND_API_KEY: "re_test",
          },
          payload: work,
          activity: (_name, _options, activity) => activity(),
        });
      yield* fromPromise(run);
      yield* fromPromise(run);
      expect(sends).toBe(1);
      expect(
        yield* fromPromise(() =>
          db
            .prepare("SELECT accepted_at_ms IS NOT NULL AS accepted FROM billing_price_notices")
            .first()
        )
      ).toEqual({ accepted: 1 });
    })
  ));

it.each(renewalCalendars)(
  "rechecks Consent before the $method $billingPeriod renewal POST even after pending intent was accepted",
  (calendar) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fromPromise(() => fixture(calendar.method, calendar));
        yield* admission(db, Date.parse(calendar.endsAt));
        const row = yield* fromPromise(() =>
          db
            .prepare("SELECT id FROM billing_attempts WHERE previous_paid_attempt_id=?")
            .bind(attemptId)
            .first<{ id: string }>()
        );
        if (row === null) throw new Error("Missing renewal fixture");
        yield* fromPromise(() =>
          db.prepare("INSERT INTO consent_user_revocations VALUES (?)").bind(userId).run()
        );
        const fetch = vi.fn(() =>
          Promise.reject(new Error("Revoked renewal must not reach Wompi"))
        );
        vi.stubGlobal("fetch", fetch);
        yield* fromPromise(() =>
          runBillingCollectionWorkflow({
            environment: {
              DB: db,
              WOMPI_ENVIRONMENT: "sandbox",
              WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
              WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
              WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
            },
            payload: { version: 1, attemptId: row.id },
            activity: (_name, _options, activity) => activity(),
          })
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(
          yield* fromPromise(() =>
            db
              .prepare("SELECT state FROM billing_collection_arms WHERE attempt_id=?")
              .bind(row.id)
              .first()
          )
        ).toEqual({ state: "armed" });
        expect(
          (yield* fromPromise(() => db.prepare("SELECT * FROM billing_paid_periods").all())).results
        ).toHaveLength(1);
      })
    )
);

it.each(
  billingCalendars.flatMap((calendar) =>
    (["nequi", "daviplata"] as const).map((method) => ({ ...calendar, method }))
  )
)(
  "admits one automatic $method $billingPeriod renewal without extending unverified paid access",
  (calendar) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fromPromise(() => fixture(calendar.method, calendar));
        const boundaryMs = Date.parse(calendar.endsAt);
        yield* Effect.all([admission(db, boundaryMs), admission(db, boundaryMs)], {
          concurrency: 2,
        });
        expect(
          (yield* fromPromise(() =>
            db
              .prepare("SELECT id FROM billing_attempts WHERE previous_paid_attempt_id IS NOT NULL")
              .all()
          )).results
        ).toHaveLength(1);
        const condition = activePaidSubscriptionCondition({
          userId: UserId.make(userId),
          nowEpochMs: boundaryMs,
        });
        expect(
          yield* fromPromise(() =>
            db
              .prepare(`SELECT ${condition.sql} AS active`)
              .bind(...condition.params)
              .first()
          )
        ).toEqual({ active: 0 });
      })
    )
);

const noticeEnvironment = (db: D1Database): BillingRuntime => ({
  DB: db,
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "unused",
  WOMPI_PRIVATE_KEY: "unused",
  WOMPI_INTEGRITY_SECRET: "unused",
  RESEND_API_KEY: "re_test",
});
const noticeWork = { version: 1, kind: "price-notice", userId, priceId } as const;
const runNotice = (db: D1Database, payload: unknown = noticeWork): Promise<void> =>
  runBillingCollectionWorkflow({
    environment: noticeEnvironment(db),
    payload,
    activity: (_name, _options, activity) => activity(),
  });

it("aborts an interrupted renewal coordinator dispatch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      yield* fromPromise(() => db.prepare("UPDATE billing_followup_outbox SET due_at_ms=0").run());
      const started = Promise.withResolvers<Request>();
      const fiber = yield* dispatchSubscriptionRenewals({
        DB: db,
        WOMPI_ENVIRONMENT: "sandbox",
        USER_TRANSACTION_COORDINATOR: {
          getByName: () => ({
            fetch: (request: Request): Promise<Response> => {
              started.resolve(request);
              const pending = Promise.withResolvers<Response>();
              request.signal.addEventListener("abort", () => pending.reject(new Error("aborted")), {
                once: true,
              });
              return pending.promise;
            },
          }),
        },
      }).pipe(Effect.forkChild({ startImmediately: true }));
      const request = yield* fromPromise(() => started.promise);
      yield* Fiber.interrupt(fiber);
      expect(request.signal.aborted).toBe(true);
    })
  ));

it("renews despite an older collection with confirmed no charge", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      const historicalId = "40000000-0000-4000-8000-000000000009";
      yield* fromPromise(() =>
        db.batch([
          db.prepare(
            `INSERT INTO card_enrollments (id,user_id,price_id,billing_email,status,payment_source_mode,contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,payment_request_id,method,wompi_environment)
              SELECT '20000000-0000-4000-8000-000000000009',user_id,price_id,billing_email,'available','reuse','{}','{}',0,900000,'50000000-0000-4000-8000-000000000009',method,wompi_environment FROM card_enrollments WHERE id='20000000-0000-4000-8000-000000000001'`
          ),
          db
            .prepare(`INSERT INTO billing_attempts (id,user_id,enrollment_id,payment_request_id,payment_source_id,price_id,amount,currency,billing_period,service_market,tax_treatment,time_zone,wompi_environment,wompi_reference,created_at_ms)
      SELECT ?,user_id,'20000000-0000-4000-8000-000000000009',?,payment_source_id,price_id,amount,currency,billing_period,service_market,tax_treatment,time_zone,wompi_environment,?,0 FROM billing_attempts WHERE id=?`)
            .bind(
              historicalId,
              "50000000-0000-4000-8000-000000000009",
              `fidy-${historicalId}`,
              attemptId
            ),
          db
            .prepare(
              "UPDATE billing_collection_arms SET state='sent', sent_at_ms=1 WHERE attempt_id=?"
            )
            .bind(historicalId),
          db
            .prepare(
              "INSERT INTO billing_no_charge_confirmations VALUES (?, ?, 'sandbox', 'case-9', 'operator-9', 1)"
            )
            .bind(historicalId, `fidy-${historicalId}`),
        ])
      );
      expect((yield* admission(db)).status).toBe(202);
      expect(
        (yield* fromPromise(() =>
          db
            .prepare("SELECT id FROM billing_attempts WHERE previous_paid_attempt_id=?")
            .bind(attemptId)
            .all()
        )).results
      ).toHaveLength(1);
    })
  ));

it("uses the current payer and retries a definitively rejected notice", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      yield* fromPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO billing_price_notices (user_id,price_id,created_at_ms) VALUES (?, ?, 1)"
            )
            .bind(userId, priceId),
        ])
      );
      const workflowIds: string[] = [];
      const receiveNotice = (): Effect.Effect<void, BillingCollectionFailure> =>
        receiveBillingCollection({
          environment: {
            DB: db,
            BILLING_COLLECTION_WORKFLOW: {
              create: ({ id }): Promise<unknown> => {
                workflowIds.push(id);
                return Promise.resolve({});
              },
              get: (): Promise<unknown> => Promise.resolve({}),
            },
          },
          batch: { messages: [{ body: noticeWork, ack: (): void => {} }] },
        });
      yield* receiveNotice();
      let sends = 0;
      vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) =>
        new Request(url, init).json().then((body: unknown) => {
          expect(body).toMatchObject({ to: ["payer@example.com"] });
          sends++;
          return sends === 1
            ? Response.json({ message: "rate limited" }, { status: 429 })
            : Response.json({ id: "accepted" });
        })
      );
      expect((yield* Effect.exit(fromPromise(() => runNotice(db))))._tag).toBe("Failure");
      expect(
        yield* fromPromise(() =>
          db.prepare("SELECT send_started_at_ms FROM billing_price_notices").first()
        )
      ).toEqual({ send_started_at_ms: null });
      yield* fromPromise(() =>
        db.prepare("UPDATE billing_price_notices SET last_offered_at_ms=2").run()
      );
      yield* receiveNotice();
      expect(workflowIds).toHaveLength(2);
      expect(workflowIds[0]).not.toBe(workflowIds[1]);
      yield* fromPromise(() => runNotice(db));
      yield* fromPromise(() => runNotice(db));
      expect(sends).toBe(2);
    })
  ));

it("rejects foreign notice work and revoked queued notice egress without checkpoints", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      const foreignUserId = "10000000-0000-4000-8000-000000000009";
      yield* fromPromise(() =>
        db.batch([
          db.prepare("INSERT INTO users VALUES (?, 'America/Bogota')").bind(foreignUserId),
          db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(foreignUserId),
          db
            .prepare(
              "INSERT INTO billing_price_notices (user_id,price_id,created_at_ms) VALUES (?, ?, 1)"
            )
            .bind(userId, priceId),
        ])
      );
      const fetch = vi.fn(() => Promise.reject(new Error("forbidden notice")));
      vi.stubGlobal("fetch", fetch);
      const create = vi.fn(() => Promise.resolve({}));
      const foreignWork = { ...noticeWork, userId: foreignUserId };
      yield* receiveBillingCollection({
        environment: {
          DB: db,
          BILLING_COLLECTION_WORKFLOW: { create, get: () => Promise.resolve({}) },
        },
        batch: { messages: [{ body: foreignWork, ack: (): void => {} }] },
      });
      expect(create).not.toHaveBeenCalled();
      yield* fromPromise(() => runNotice(db, foreignWork));
      yield* fromPromise(() =>
        db.prepare("INSERT INTO consent_user_revocations VALUES (?)").bind(userId).run()
      );
      yield* receiveBillingCollection({
        environment: {
          DB: db,
          BILLING_COLLECTION_WORKFLOW: { create, get: () => Promise.resolve({}) },
        },
        batch: { messages: [{ body: noticeWork, ack: (): void => {} }] },
      });
      yield* fromPromise(() => runNotice(db));
      expect(fetch).not.toHaveBeenCalled();
      expect(
        yield* fromPromise(() =>
          db.prepare("SELECT send_started_at_ms,accepted_at_ms FROM billing_price_notices").first()
        )
      ).toEqual({ send_started_at_ms: null, accepted_at_ms: null });
    })
  ));

it("freezes one March 31 monthly renewal across duplicate delayed scheduler claims", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() =>
        fixture("card", {
          billingPeriod: "monthly",
          startsAt: "2026-01-31T23:30:00Z",
          endsAt: "2026-02-28T23:30:00Z",
        })
      );
      const now = Date.parse("2026-03-04T10:00:00Z");
      yield* Effect.all([admission(db, now), admission(db, now)], { concurrency: 2 });
      expect(
        (yield* fromPromise(() =>
          db
            .prepare(
              "SELECT status, period_starts_at_ms, period_ends_at_ms FROM billing_attempts WHERE previous_paid_attempt_id = ?"
            )
            .bind(attemptId)
            .all()
        )).results
      ).toEqual([
        {
          status: "pending",
          period_starts_at_ms: Date.parse("2026-02-28T23:30:00Z"),
          period_ends_at_ms: Date.parse("2026-03-31T23:30:00Z"),
        },
      ]);
      expect(
        (yield* fromPromise(() => db.prepare("SELECT * FROM billing_paid_periods").all())).results
      ).toHaveLength(1);
      const immutable = yield* Effect.exit(
        fromPromise(() =>
          db
            .prepare(
              "UPDATE billing_attempts SET calendar_anchor_ms = 0 WHERE previous_paid_attempt_id = ?"
            )
            .bind(attemptId)
            .run()
        )
      );
      expect(immutable._tag).toBe("Failure");
      expect(
        yield* fromPromise(() =>
          db
            .prepare(
              "SELECT calendar_anchor_ms FROM billing_attempts WHERE previous_paid_attempt_id = ?"
            )
            .bind(attemptId)
            .first()
        )
      ).toEqual({ calendar_anchor_ms: Date.parse("2026-01-31T23:30:00Z") });
    })
  ));

it.each(
  [
    {
      billingPeriod: "weekly" as const,
      startsAt: "2026-10-06T15:00:00Z",
      endsAt: "2026-10-13T15:00:00Z",
      boundaries: ["2026-10-20T15:00:00Z"],
      cents: 990000,
    },
    {
      billingPeriod: "monthly" as const,
      startsAt: "2026-01-31T23:30:00Z",
      endsAt: "2026-02-28T23:30:00Z",
      boundaries: ["2026-03-31T23:30:00Z", "2026-04-30T23:30:00Z"],
      cents: 2890000,
    },
    {
      billingPeriod: "monthly" as const,
      startsAt: "2024-01-31T23:30:00Z",
      endsAt: "2024-02-29T23:30:00Z",
      boundaries: ["2024-03-31T23:30:00Z"],
      cents: 2890000,
    },
    {
      billingPeriod: "yearly" as const,
      startsAt: "2024-02-29T15:00:00Z",
      endsAt: "2025-02-28T15:00:00Z",
      boundaries: ["2026-02-28T15:00:00Z", "2027-02-28T15:00:00Z", "2028-02-29T15:00:00Z"],
      cents: 28990000,
    },
  ].flatMap((calendar) =>
    (["card", "nequi", "daviplata"] as const).map((method) => ({ ...calendar, method }))
  )
)(
  "settles adjacent $method $billingPeriod periods once while retaining the original $startsAt anchor",
  (calendar) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fromPromise(() => fixture(calendar.method, calendar));
        let previousPaidAttemptId = attemptId;
        let previousEndsAt = Date.parse(calendar.endsAt);
        let paidPeriods = 1;
        for (const boundary of calendar.boundaries) {
          const candidate = { _tag: "SubscriptionRenewal", userId, previousPaidAttemptId };
          const claim = (): Effect.Effect<Response> =>
            executeSubscriptionRenewalAdmission({
              db,
              userId,
              environment: "sandbox",
              now: previousEndsAt + 60000,
              candidate,
            });
          yield* Effect.all([claim(), claim()], { concurrency: 2 });
          const row = yield* fromPromise(() =>
            db
              .prepare(
                "SELECT id, wompi_reference, calendar_anchor_ms FROM billing_attempts WHERE previous_paid_attempt_id = ?"
              )
              .bind(previousPaidAttemptId)
              .first<{ id: string; wompi_reference: string; calendar_anchor_ms: number }>()
          );
          if (row === null) throw new Error("Missing calendar renewal fixture");
          expect(row.calendar_anchor_ms).toBe(Date.parse(calendar.startsAt));
          let posts = 0;
          let status: keyof typeof recordedTransactions = "PENDING";
          let providerSourceId = 3891;
          // Wompi's retained source-payment fixtures are method-neutral. Substitute the
          // dynamic attempt identity, calendar amount/date, and the deliberate hostile source only.
          const providerResponse = (observedStatus: keyof typeof recordedTransactions): Response =>
            Response.json({
              data: {
                ...recordedTransactions[observedStatus].data,
                id: `calendar-${row.id}`,
                reference: row.wompi_reference,
                amount_in_cents: calendar.cents,
                payment_source_id: providerSourceId,
                finalized_at:
                  observedStatus === "APPROVED"
                    ? DateTime.formatIso(DateTime.makeUnsafe(previousEndsAt + 240000))
                    : null,
              },
            });
          vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            if (request.method === "POST") {
              posts++;
              expect(new URL(request.url).pathname).toBe("/v1/transactions");
              return request.json().then((body: unknown) => {
                const integritySignature: unknown = expect.any(String);
                expect(body).toEqual({
                  amount_in_cents: calendar.cents,
                  currency: "COP",
                  customer_email: "payer@example.com",
                  payment_source_id: 3891,
                  reference: row.wompi_reference,
                  signature: integritySignature,
                  ...(calendar.method === "card" ? { payment_method: { installments: 1 } } : {}),
                });
                return providerResponse("APPROVED");
              });
            }
            expect(new URL(request.url).pathname).toBe(`/v1/transactions/calendar-${row.id}`);
            return Promise.resolve(providerResponse(status));
          });
          const run = (lookup = false): Promise<void> =>
            runBillingCollectionWorkflow({
              environment: {
                DB: db,
                WOMPI_ENVIRONMENT: "sandbox",
                WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
                WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
                WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
              },
              payload: lookup
                ? { version: 1, kind: "lookup", transactionId: `calendar-${row.id}` }
                : { version: 1, attemptId: row.id },
              activity: (_name, _options, work) => work(),
            });
          yield* fromPromise(() => run());
          expect(
            (yield* fromPromise(() => db.prepare("SELECT * FROM billing_paid_periods").all()))
              .results
          ).toHaveLength(paidPeriods);
          status = "APPROVED";
          providerSourceId = 3892;
          const rejected = yield* Effect.exit(fromPromise(() => run(true)));
          expect(rejected._tag).toBe("Failure");
          expect(
            (yield* fromPromise(() => db.prepare("SELECT * FROM billing_paid_periods").all()))
              .results
          ).toHaveLength(paidPeriods);
          providerSourceId = 3891;
          yield* fromPromise(() => run(true));
          yield* fromPromise(() => run(true));
          yield* fromPromise(() => run());
          status = "DECLINED";
          yield* fromPromise(() => run(true));
          status = "PENDING";
          yield* fromPromise(() => run(true));
          expect(posts).toBe(1);
          expect(
            yield* fromPromise(() =>
              db
                .prepare(
                  "SELECT starts_at_ms, ends_at_ms FROM billing_paid_periods WHERE attempt_id = ?"
                )
                .bind(row.id)
                .first()
            )
          ).toEqual({ starts_at_ms: previousEndsAt, ends_at_ms: Date.parse(boundary) });
          paidPeriods++;
          expect(
            (yield* fromPromise(() => db.prepare("SELECT * FROM billing_paid_periods").all()))
              .results
          ).toHaveLength(paidPeriods);
          previousPaidAttemptId = row.id;
          previousEndsAt = Date.parse(boundary);
        }
      })
    )
);

effectIt.effect.each(renewalCalendars)(
  "discovers a $method $billingPeriod renewal at its captured boundary and preserves it after scheduler delay",
  (calendar) =>
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture(calendar.method, calendar));
      const boundary = Date.parse(calendar.endsAt);
      const requests: Request[] = [];
      const dispatch = (): Effect.Effect<void, BillingCollectionFailure> =>
        dispatchSubscriptionRenewals({
          DB: db,
          WOMPI_ENVIRONMENT: "sandbox",
          USER_TRANSACTION_COORDINATOR: {
            getByName: (name) => ({
              fetch: (request: Request): Promise<Response> => {
                expect(name).toBe(userId);
                requests.push(request);
                return Promise.resolve(new Response(null, { status: 202 }));
              },
            }),
          },
        });
      yield* TestClock.setTime(boundary - 1);
      yield* dispatch();
      expect(requests).toHaveLength(0);
      yield* TestClock.setTime(boundary);
      yield* dispatch();
      expect(requests).toHaveLength(1);
      const first = requests[0];
      if (first === undefined) throw new Error("Missing due renewal request");
      expect(new URL(first.url).pathname).toBe("/subscription-renewal-work");
      expect(yield* fromPromise(() => first.json())).toEqual({
        _tag: "SubscriptionRenewal",
        userId,
        previousPaidAttemptId: attemptId,
      });
      yield* TestClock.setTime(boundary + 4 * 86400000);
      yield* dispatch();
      expect(requests).toHaveLength(2);
    })
);

it.each(["card", "nequi", "daviplata"] as const)(
  "a failed $0 monthly renewal cannot extend paid access or create another collection",
  (method) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fromPromise(() =>
          fixture(method, {
            billingPeriod: "monthly",
            startsAt: "2026-01-31T23:30:00Z",
            endsAt: "2026-02-28T23:30:00Z",
          })
        );
        const boundary = Date.parse("2026-02-28T23:30:00Z");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(boundary);
        yield* admission(db, boundary);
        const row = yield* fromPromise(() =>
          db
            .prepare(
              "SELECT id, wompi_reference FROM billing_attempts WHERE previous_paid_attempt_id = ?"
            )
            .bind(attemptId)
            .first<{ id: string; wompi_reference: string }>()
        );
        if (row === null) throw new Error("Missing declined renewal fixture");
        vi.stubGlobal("fetch", () =>
          Promise.resolve(
            Response.json({
              data: {
                ...recordedTransactions.DECLINED.data,
                id: `declined-${row.id}`,
                reference: row.wompi_reference,
              },
            })
          )
        );
        const environment: BillingRuntime = {
          DB: db,
          WOMPI_ENVIRONMENT: "sandbox",
          WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
          WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
          WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
        };
        yield* fromPromise(() =>
          runBillingCollectionWorkflow({
            environment,
            payload: { version: 1, attemptId: row.id },
            activity: (_name, _options, work) => work(),
          })
        );
        vi.setSystemTime(boundary + 240000);
        yield* fromPromise(() =>
          runBillingCollectionWorkflow({
            environment,
            payload: { version: 1, kind: "lookup", transactionId: `declined-${row.id}` },
            activity: (_name, _options, work) => work(),
          })
        );
        expect(
          yield* fromPromise(() =>
            db.prepare("SELECT status FROM billing_attempts WHERE id = ?").bind(row.id).first()
          )
        ).toEqual({ status: "failed" });
        yield* admission(db, boundary + 240000);
        expect(
          (yield* fromPromise(() => db.prepare("SELECT * FROM billing_paid_periods").all())).results
        ).toHaveLength(1);
        expect(
          (yield* fromPromise(() =>
            db
              .prepare("SELECT id FROM billing_attempts WHERE previous_paid_attempt_id = ?")
              .bind(attemptId)
              .all()
          )).results
        ).toHaveLength(1);
        expect(
          yield* fromPromise(() =>
            db
              .prepare("SELECT paid_period_ends_at_ms FROM subscriptions WHERE user_id = ?")
              .bind(userId)
              .first()
          )
        ).toEqual({ paid_period_ends_at_ms: boundary });
      })
    )
);
