import {
  OAuthClientId,
  OAuthConnectionId,
  OAuthCredentialId,
} from "../../src/core/oauth-agents/contract";
import { type OAuthCaller, oauthResource } from "../../src/shell/oauth-agents/contract";
import type { OAuthConfirmationWork } from "../oauth-confirmation/contract";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { UserId } from "../../src/core/identity/contract";
import { executeCanonicalWork } from "../canonical-operations/operations";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { applyTestMigration } from "../d1-test-fixture";
import { activePaidSubscriptionCondition } from "../../src/shell/subscription/operations";
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
import {
  executeProtectedSubscriptionQuery,
  executeSubscriptionRenewalAdmission,
  publishWeeklyPrice,
} from "./operations";

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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
      const created = yield* makePaymentEnrollmentD1([
        "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT",
        "CREATE TABLE onboarding_consent_records (user_id TEXT PRIMARY KEY) STRICT",
        "CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY) STRICT",
      ]);

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
        renewal_attempt_number: 1,
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

it.each(renewalCalendars)(
  "preserves $method $billingPeriod Pro for exactly three days without rewriting paid history",
  (calendar) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fromPromise(() => fixture(calendar.method, calendar));
        const boundary = Date.parse(calendar.endsAt);
        for (const [now, expected] of [
          [boundary, 1],
          [boundary + 259200000 - 1, 1],
          [boundary + 259200000, 0],
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
        ).toEqual({ ends_at_ms: boundary });
      })
    )
);

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
        ).toEqual({ active: 1 });
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
  "a failed $0 monthly renewal retries only at the bounded original schedule",
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
        yield* admission(db, boundary + 86400000 - 1);
        yield* Effect.all(
          [admission(db, boundary + 86400000), admission(db, boundary + 86400000)],
          { concurrency: 2 }
        );
        expect(
          (yield* fromPromise(() =>
            db
              .prepare(
                "SELECT renewal_attempt_number, price_id, period_starts_at_ms, period_ends_at_ms FROM billing_attempts WHERE previous_paid_attempt_id=? ORDER BY renewal_attempt_number"
              )
              .bind(attemptId)
              .all()
          )).results
        ).toEqual([
          {
            renewal_attempt_number: 1,
            price_id: "22700000-0000-4000-8000-000000000002",
            period_starts_at_ms: boundary,
            period_ends_at_ms: Date.parse("2026-03-31T23:30:00Z"),
          },
          {
            renewal_attempt_number: 2,
            price_id: "22700000-0000-4000-8000-000000000002",
            period_starts_at_ms: boundary,
            period_ends_at_ms: Date.parse("2026-03-31T23:30:00Z"),
          },
        ]);
      })
    )
);

const cancellationFixture = (
  method: "card" | "nequi" | "daviplata"
): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* fromPromise(() => fixture(method));
    yield* fromPromise(() =>
      db.exec(`CREATE TABLE web_sessions (id TEXT PRIMARY KEY,user_id TEXT,token_digest BLOB,revoked_at_ms INTEGER,idle_expires_at_ms INTEGER,hard_expires_at_ms INTEGER);
CREATE TABLE pat_audit (id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,pat_id TEXT,oauth_connection_id TEXT,oauth_credential_id TEXT,operation TEXT,outcome TEXT,occurred_at_ms INTEGER);
CREATE TABLE transaction_audit (user_id TEXT,operation TEXT,occurred_at_ms INTEGER);
CREATE TABLE category_audit (user_id TEXT,occurred_at_ms INTEGER);
CREATE TABLE memory_audit (user_id TEXT,occurred_at_ms INTEGER);
CREATE TABLE statement_submission_audit (user_id TEXT,occurred_at_ms INTEGER);
CREATE TABLE statement_review_audit (user_id TEXT,occurred_at_ms INTEGER);
CREATE TABLE statement_clarification_audit (user_id TEXT,occurred_at_ms INTEGER);`)
    );
    yield* fromPromise(() =>
      applyTestMigration({
        db,
        source: new URL("../migrations/0019_canonical_child_guards.sql", import.meta.url),
      })
    );
    yield* fromPromise(() =>
      db
        .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?)")
        .bind(enrollmentId, userId, new Uint8Array(32), 9000000000000, 9000000000000)
        .run()
    );
    return db;
  });
const cancel = (db: D1Database, now: number, subjectUser = userId): Effect.Effect<Response> =>
  executeCanonicalWork({
    db,
    subject: { id: enrollmentId, userId: subjectUser, digest: new Uint8Array(32) },
    current: now,
    bucket: Option.none(),
    hostedFence: Option.none(),
    inference: Option.none(),
    oauthConfirmation: Option.none(),
    work: {
      _tag: "Call",
      operation: CanonicalOperationId.make("subscription.cancelSubscription"),
      input: {},
    },
  });
it.each(["card", "nequi", "daviplata"] as const)(
  "cancels $0 renewal idempotently while preserving the paid period and fencing queued collection",
  (method) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* cancellationFixture(method);
        const cancelledAt = dueAt - 1000;
        const response = yield* cancel(db, cancelledAt);
        expect(response.status).toBe(200);
        expect(yield* fromPromise(() => response.json())).toMatchObject({
          data: {
            cancelledAt: "2026-10-13T14:59:59.000Z",
            paidThrough: "2026-10-13T15:00:00.000Z",
            sourceCancellation: method === "daviplata" ? "void-pending" : "detached",
          },
        });
        expect((yield* cancel(db, cancelledAt + 500)).status).toBe(200);
        yield* admission(db, dueAt);
        expect(
          (yield* fromPromise(() =>
            db
              .prepare("SELECT id FROM billing_attempts WHERE previous_paid_attempt_id IS NOT NULL")
              .all()
          )).results
        ).toHaveLength(0);
        for (const [now, expected] of [
          [cancelledAt, 1],
          [dueAt, 0],
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
      })
    )
);
it.each(["card", "nequi", "daviplata"] as const)(
  "detaches $0 locally and voids only a matching DaviPlata source once",
  (method) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* cancellationFixture(method);
        yield* cancel(db, dueAt - 1000);
        let puts = 0;
        vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (request.method === "PUT") puts++;
          expect(new URL(request.url).pathname).toBe(
            request.method === "PUT" ? "/v1/payment_sources/3891/void" : "/v1/payment_sources/3891"
          );
          return Promise.resolve(
            Response.json({ data: { id: 3891, type: "DAVIPLATA", status: "VOIDED" } })
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
            payload: { version: 1, kind: "source-cancellation", userId },
            activity: (_name, _options, work) => work(),
          });
        yield* fromPromise(run);
        yield* fromPromise(run);
        expect(puts).toBe(method === "daviplata" ? 1 : 0);
        const response = yield* cancel(db, dueAt);
        expect(yield* fromPromise(() => response.json())).toMatchObject({
          data: { sourceCancellation: method === "daviplata" ? "voided" : "detached" },
        });
      })
    )
);
const runObservedRenewal = ({
  db,
  id,
  status,
  now,
  amountInCents,
}: Readonly<{
  db: D1Database;
  id: string;
  status: "DECLINED" | "APPROVED";
  now: number;
  amountInCents: number;
}>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json({
          data: {
            ...recordedTransactions[status].data,
            id: `dunning-${id}`,
            reference: `fidy-${id}`,
            amount_in_cents: amountInCents,
            payment_source_id: 3891,
            finalized_at:
              status === "APPROVED" ? DateTime.formatIso(DateTime.makeUnsafe(now)) : null,
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
    const run = (lookup: boolean): Promise<void> =>
      runBillingCollectionWorkflow({
        environment,
        payload: lookup
          ? { version: 1, kind: "lookup", transactionId: `dunning-${id}` }
          : { version: 1, attemptId: id },
        activity: (_name, _options, work) => work(),
      });
    yield* fromPromise(() => run(false));
    vi.setSystemTime(now + 240000);
    yield* fromPromise(() => run(true));
  });
const latestRenewal = (db: D1Database): Effect.Effect<string, Cause.UnknownError> =>
  fromPromise(() =>
    db
      .prepare(
        "SELECT id FROM billing_attempts WHERE previous_paid_attempt_id=? ORDER BY renewal_attempt_number DESC LIMIT 1"
      )
      .bind(attemptId)
      .first()
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))),
    Effect.map((row) => row.id),
    Effect.orDie
  );

it.each(["card", "nequi", "daviplata"] as const)(
  "bounds $0 retries at 24/48 hours and exhausts grace without granting another paid period",
  (method) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fromPromise(() => fixture(method, billingCalendars[1]));
        const boundary = Date.parse("2026-02-28T23:30:00Z");
        for (const offset of [0, 86400000, 172800000]) {
          yield* admission(db, boundary + offset);
          const id = yield* latestRenewal(db);
          yield* runObservedRenewal({
            db,
            id,
            status: "DECLINED",
            now: boundary + offset,
            amountInCents: 2890000,
          });
        }
        yield* admission(db, boundary + 172800001);
        yield* admission(db, boundary + 259200000);
        expect(
          (yield* fromPromise(() =>
            db
              .prepare(
                "SELECT renewal_attempt_number,status FROM billing_attempts WHERE previous_paid_attempt_id=? ORDER BY renewal_attempt_number"
              )
              .bind(attemptId)
              .all()
          )).results
        ).toEqual([
          { renewal_attempt_number: 1, status: "failed" },
          { renewal_attempt_number: 2, status: "failed" },
          { renewal_attempt_number: 3, status: "failed" },
        ]);
        const condition = activePaidSubscriptionCondition({
          userId: UserId.make(userId),
          nowEpochMs: boundary + 259200000,
        });
        expect(
          yield* fromPromise(() =>
            db
              .prepare(`SELECT ${condition.sql} AS active`)
              .bind(...condition.params)
              .first()
          )
        ).toEqual({ active: 0 });
        expect(
          (yield* fromPromise(() => db.prepare("SELECT * FROM billing_paid_periods").all())).results
        ).toHaveLength(1);
      })
    )
);

it.each(["card", "nequi", "daviplata"] as const)(
  "recovers $0 on verified retry success and absorbs a delayed earlier approval without anchor drift",
  (method) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fromPromise(() => fixture(method, billingCalendars[1]));
        const boundary = Date.parse("2026-02-28T23:30:00Z");
        yield* admission(db, boundary);
        const first = yield* latestRenewal(db);
        yield* runObservedRenewal({
          db,
          id: first,
          status: "DECLINED",
          now: boundary,
          amountInCents: 2890000,
        });
        yield* admission(db, boundary + 86400000);
        const retry = yield* latestRenewal(db);
        expect(retry).not.toBe(first);
        yield* runObservedRenewal({
          db,
          id: retry,
          status: "APPROVED",
          now: boundary + 86400000,
          amountInCents: 2890000,
        });
        yield* runObservedRenewal({
          db,
          id: first,
          status: "APPROVED",
          now: boundary + 86400001,
          amountInCents: 2890000,
        });
        expect(
          (yield* fromPromise(() =>
            db
              .prepare(
                "SELECT starts_at_ms,ends_at_ms FROM billing_paid_periods ORDER BY starts_at_ms"
              )
              .all()
          )).results
        ).toEqual([
          { starts_at_ms: Date.parse("2026-01-31T23:30:00Z"), ends_at_ms: boundary },
          { starts_at_ms: boundary, ends_at_ms: Date.parse("2026-03-31T23:30:00Z") },
        ]);
        expect(
          yield* fromPromise(() =>
            db
              .prepare("SELECT renewal_anchor_ms FROM subscriptions WHERE user_id=?")
              .bind(userId)
              .first()
          )
        ).toEqual({ renewal_anchor_ms: Date.parse("2026-03-31T23:30:00Z") });
        yield* executeSubscriptionRenewalAdmission({
          db,
          userId,
          environment: "sandbox",
          now: Date.parse("2026-03-31T23:30:00Z"),
          candidate: { _tag: "SubscriptionRenewal", userId, previousPaidAttemptId: retry },
        });
        expect(
          (yield* fromPromise(() =>
            db
              .prepare("SELECT id FROM billing_attempts WHERE previous_paid_attempt_id=?")
              .bind(retry)
              .all()
          )).results
        ).toHaveLength(1);
      })
    )
);
it("recovers on an earlier verified success while a retry is still queued", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture("card", billingCalendars[1]));
      const boundary = Date.parse("2026-02-28T23:30:00Z");
      yield* admission(db, boundary);
      const first = yield* latestRenewal(db);
      yield* runObservedRenewal({
        db,
        id: first,
        status: "DECLINED",
        now: boundary,
        amountInCents: 2890000,
      });
      yield* admission(db, boundary + 86400000);
      yield* runObservedRenewal({
        db,
        id: first,
        status: "APPROVED",
        now: boundary + 86400001,
        amountInCents: 2890000,
      });
      const response = yield* executeSubscriptionRenewalAdmission({
        db,
        userId,
        environment: "sandbox",
        now: Date.parse("2026-03-31T23:30:00Z"),
        candidate: { _tag: "SubscriptionRenewal", userId, previousPaidAttemptId: first },
      });
      expect(response.status).toBe(202);
      expect(
        (yield* fromPromise(() =>
          db
            .prepare("SELECT id FROM billing_attempts WHERE previous_paid_attempt_id=?")
            .bind(first)
            .all()
        )).results
      ).toHaveLength(1);
    })
  ));
it("refuses a borrowed or revoked browser credential before cancellation and rolls back when Audit fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* cancellationFixture("card");
      const foreign = "10000000-0000-4000-8000-000000000009";
      expect((yield* cancel(db, dueAt - 1000, foreign)).status).toBe(401);
      yield* fromPromise(() => db.prepare("UPDATE web_sessions SET revoked_at_ms=1").run());
      expect((yield* cancel(db, dueAt - 1000)).status).toBe(401);
      yield* fromPromise(() => db.prepare("UPDATE web_sessions SET revoked_at_ms=NULL").run());
      yield* fromPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER reject_cancellation_audit BEFORE INSERT ON pat_audit BEGIN SELECT RAISE(ABORT,'test_audit_failure'); END"
          )
          .run()
      );
      expect((yield* cancel(db, dueAt - 1000)).status).toBe(503);
      expect(
        (yield* fromPromise(() =>
          db.prepare("SELECT user_id FROM subscription_cancellations").all()
        )).results
      ).toHaveLength(0);
      yield* admission(db, dueAt);
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

it("fences an already queued renewal at cancellation without submitting its charge", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* cancellationFixture("card");
      yield* admission(db, dueAt);
      const queued = yield* latestRenewal(db);
      expect((yield* cancel(db, dueAt + 1)).status).toBe(200);
      const provider = vi.fn(() =>
        Promise.reject(new Error("Cancelled collection must not reach Wompi"))
      );
      vi.stubGlobal("fetch", provider);
      yield* fromPromise(() =>
        runBillingCollectionWorkflow({
          environment: {
            DB: db,
            WOMPI_ENVIRONMENT: "sandbox",
            WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
          },
          payload: { version: 1, attemptId: queued },
          activity: (_name, _options, work) => work(),
        })
      );
      expect(provider).not.toHaveBeenCalled();
    })
  ));

it("reconciles an ambiguous DaviPlata void without repeating PUT or trusting foreign source evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* cancellationFixture("daviplata");
      yield* cancel(db, dueAt - 1000);
      let puts = 0;
      let foundId = 3892;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === "PUT") {
          puts++;
          return Promise.reject(new Error("Ambiguous provider delivery"));
        }
        return Promise.resolve(
          Response.json({ data: { id: foundId, type: "DAVIPLATA", status: "VOIDED" } })
        );
      });
      const run = (subject = userId): Promise<void> =>
        runBillingCollectionWorkflow({
          environment: {
            DB: db,
            WOMPI_ENVIRONMENT: "sandbox",
            WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
          },
          payload: { version: 1, kind: "source-cancellation", userId: subject },
          activity: (_name, _options, work) => work(),
        });
      yield* fromPromise(() => run("10000000-0000-4000-8000-000000000009"));
      expect(puts).toBe(0);
      expect((yield* Effect.exit(fromPromise(() => run())))._tag).toBe("Failure");
      const pending = yield* cancel(db, dueAt);
      expect(yield* fromPromise(() => pending.json())).toMatchObject({
        data: { sourceCancellation: "void-pending" },
      });
      foundId = 3891;
      yield* fromPromise(() => run());
      yield* fromPromise(() => run());
      expect(puts).toBe(1);
      const done = yield* cancel(db, dueAt);
      expect(yield* fromPromise(() => done.json())).toMatchObject({
        data: { sourceCancellation: "voided" },
      });
    })
  ));
it("does not submit a queued retry after its grace boundary", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture("card", billingCalendars[1]));
      const boundary = Date.parse("2026-02-28T23:30:00Z");
      yield* admission(db, boundary);
      const first = yield* latestRenewal(db);
      yield* runObservedRenewal({
        db,
        id: first,
        status: "DECLINED",
        now: boundary,
        amountInCents: 2890000,
      });
      yield* admission(db, boundary + 86400000);
      const queued = yield* latestRenewal(db);
      vi.setSystemTime(boundary + 259200000);
      const provider = vi.fn(() => Promise.reject(new Error("Grace has expired")));
      vi.stubGlobal("fetch", provider);
      yield* fromPromise(() =>
        runBillingCollectionWorkflow({
          environment: {
            DB: db,
            WOMPI_ENVIRONMENT: "sandbox",
            WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
          },
          payload: { version: 1, attemptId: queued },
          activity: (_name, _options, work) => work(),
        })
      );
      expect(provider).not.toHaveBeenCalled();
    })
  ));

it("preserves an independent TrialPeriod after grace exhaustion and cancellation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* cancellationFixture("card");
      yield* fromPromise(() =>
        db.exec(
          "CREATE TABLE trial_periods (user_id TEXT PRIMARY KEY,started_at_ms INTEGER,ends_at_ms INTEGER) STRICT"
        )
      );
      yield* fromPromise(() =>
        db
          .prepare("INSERT INTO trial_periods VALUES (?,?,?)")
          .bind(userId, dueAt, dueAt + 604800000)
          .run()
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(dueAt + 259200000);
      expect((yield* cancel(db, dueAt + 259200000)).status).toBe(200);
      const response = yield* executeProtectedSubscriptionQuery({
        db,
        subject: { id: enrollmentId, userId, digest: new Uint8Array(32) },
        operation: "subscription.getSubscriptionStatus",
      });
      expect(response.status).toBe(200);
      expect(yield* fromPromise(() => response.json())).toMatchObject({
        data: { accessTier: "pro", paidSubscription: { endsAt: "2026-10-13T15:00:00.000Z" } },
      });
    })
  ));

it("keeps retry Money and Price frozen after replacement publication", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      yield* admission(db, dueAt);
      const first = yield* latestRenewal(db);
      yield* runObservedRenewal({
        db,
        id: first,
        status: "DECLINED",
        now: dueAt,
        amountInCents: 990000,
      });
      const replacement = yield* Schema.decodeEffect(Schema.toCodecJson(Price))({
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
      yield* publishWeeklyPrice({ db, price: replacement });
      yield* admission(db, dueAt + 86400000);
      const retry = yield* latestRenewal(db);
      expect(
        yield* fromPromise(() =>
          db
            .prepare(
              "SELECT price_id,amount,renewal_attempt_number,period_starts_at_ms,period_ends_at_ms FROM billing_attempts WHERE id=?"
            )
            .bind(retry)
            .first()
        )
      ).toEqual({
        price_id: priceId,
        amount: "9900",
        renewal_attempt_number: 2,
        period_starts_at_ms: dueAt,
        period_ends_at_ms: Date.parse("2026-10-20T15:00:00Z"),
      });
    })
  ));

it("refuses cancellation with a read-only PAT without changing renewal work or recording use", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* cancellationFixture("card");
      yield* admission(db, dueAt);
      yield* fromPromise(() =>
        db.exec(
          `CREATE TABLE pats(id TEXT PRIMARY KEY,user_id TEXT,bearer_digest BLOB,scopes_json TEXT,revoked_at_ms INTEGER,expires_at_ms INTEGER,last_used_at_ms INTEGER);`
        )
      );
      yield* fromPromise(() =>
        db
          .prepare("INSERT INTO pats VALUES(?,?,?,'[\"read\"]',NULL,9000000000000,NULL)")
          .bind(enrollmentId, userId, new Uint8Array(32))
          .run()
      );
      const before = yield* cancellationEffects(db);
      const response = yield* executeCanonicalWork({
        db,
        subject: {
          patId: enrollmentId,
          userId,
          digest: new Uint8Array(32),
          requiredScope: Option.some("write"),
        },
        current: dueAt + 1,
        bucket: Option.none(),
        hostedFence: Option.none(),
        inference: Option.none(),
        oauthConfirmation: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("subscription.cancelSubscription"),
          input: {},
        },
      });
      expect(response.status).toBe(401);
      expect(yield* cancellationEffects(db)).toEqual(before);
      expect(
        yield* fromPromise(() => db.prepare("SELECT last_used_at_ms FROM pats").first())
      ).toEqual({ last_used_at_ms: null });
    })
  ));

const cancellationEffects = (db: D1Database): Effect.Effect<unknown, Cause.UnknownError> =>
  fromPromise(() =>
    db
      .prepare(`SELECT
  (SELECT COUNT(*) FROM subscription_cancellations) AS cancellations,
  (SELECT COUNT(*) FROM subscription_renewal_stops) AS stops,
  (SELECT COUNT(*) FROM billing_collection_arms WHERE state='armed') AS armed,
  (SELECT COUNT(*) FROM billing_collection_outbox) AS offers,
  (SELECT COUNT(*) FROM pat_audit WHERE outcome='accepted') AS accepted`)
      .first()
  );

it.each(["missing", "declined", "expired", "borrowed", "replayed"] as const)(
  "refuses $0 OAuth cancellation confirmation without partial billing effects",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* cancellationFixture("card");
        yield* admission(db, dueAt);
        yield* fromPromise(() =>
          db.exec(`CREATE TABLE oauth_connections(id TEXT PRIMARY KEY,user_id TEXT,client_id TEXT,resource TEXT,scopes_json TEXT,revoked_at_ms INTEGER,expires_at_ms INTEGER);
CREATE TABLE oauth_access_credentials(id TEXT PRIMARY KEY,user_id TEXT,digest BLOB,connection_id TEXT,scopes_json TEXT,expires_at_ms INTEGER);
CREATE TABLE oauth_grant_consents(connection_id TEXT,user_id TEXT);`)
        );
        yield* fromPromise(() =>
          applyTestMigration({
            db,
            source: new URL("../migrations/0038_oauth_confirmation.sql", import.meta.url),
          })
        );
        const subject: OAuthCaller = {
          oauthConnectionId: OAuthConnectionId.make(enrollmentId),
          credentialId: OAuthCredentialId.make(sourceId),
          userId: UserId.make(userId),
          clientId: OAuthClientId.make(paymentRequestId),
          resource: oauthResource,
          digest: new Uint8Array(32),
          requiredScope: Option.some("write"),
        };
        yield* fromPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO oauth_connections VALUES(?,?,?,?,'[\"write\"]',NULL,9000000000000)"
              )
              .bind(enrollmentId, userId, subject.clientId, oauthResource),
            db
              .prepare(
                "INSERT INTO oauth_access_credentials VALUES(?,?,?,?,'[\"write\"]',9000000000000)"
              )
              .bind(sourceId, userId, subject.digest, enrollmentId),
            db.prepare("INSERT INTO oauth_grant_consents VALUES(?,?)").bind(enrollmentId, userId),
          ])
        );
        const operation = CanonicalOperationId.make("subscription.cancelSubscription");
        const invoke = (
          confirmation: Option.Option<OAuthConfirmationWork>
        ): Effect.Effect<Response> =>
          executeCanonicalWork({
            db,
            subject,
            current: dueAt + 1,
            bucket: Option.none(),
            hostedFence: Option.none(),
            inference: Option.none(),
            oauthConfirmation: confirmation,
            work: { _tag: "Call", operation, input: {} },
          });
        const before = yield* cancellationEffects(db);
        if (kind === "missing") {
          expect((yield* invoke(Option.none())).status).toBe(403);
        } else {
          const review = yield* invoke(
            Option.some({ operation, input: {}, attempt: { _tag: "Review" } })
          );
          expect(review.status).toBe(409);
          const retained = yield* fromPromise(() =>
            db.prepare("SELECT reference FROM oauth_operation_intents").first()
          );
          const { reference } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ reference: Schema.String })
          )(retained);
          if (kind === "expired") {
            yield* fromPromise(() =>
              db.prepare("UPDATE oauth_operation_intents SET expires_at_ms=2,created_at_ms=1").run()
            );
          }
          if (kind === "borrowed") {
            yield* fromPromise(() =>
              db
                .prepare(
                  "INSERT INTO oauth_connections SELECT ?,user_id,client_id,resource,scopes_json,revoked_at_ms,expires_at_ms FROM oauth_connections WHERE id=?"
                )
                .bind(attemptId, enrollmentId)
                .run()
            );
            yield* fromPromise(() =>
              db.prepare("UPDATE oauth_operation_intents SET connection_id=?").bind(attemptId).run()
            );
          }
          if (kind === "replayed") {
            yield* fromPromise(() => db.prepare("DELETE FROM oauth_operation_intents").run());
          }
          const response = yield* invoke(
            Option.some({
              operation,
              input: {},
              attempt: {
                _tag: "Decision",
                reference,
                response: {
                  action: kind === "declined" ? "decline" : "accept",
                  content: { confirm: true },
                },
              },
            })
          );
          expect(response.status).toBe(kind === "declined" ? 403 : 503);
          if (kind === "borrowed") {
            expect(
              yield* fromPromise(() =>
                db.prepare("SELECT COUNT(*) AS count FROM oauth_operation_intents").first()
              )
            ).toEqual({ count: 1 });
          }
        }
        expect(yield* cancellationEffects(db)).toEqual(before);
      })
    )
);
