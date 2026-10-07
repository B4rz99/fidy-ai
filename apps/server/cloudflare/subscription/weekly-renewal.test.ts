import { UserId } from "../../src/core/identity/contract";
import { activePaidSubscriptionCondition } from "../../src/shell/subscription/operations";
import { type Miniflare } from "miniflare";
import { afterEach, expect, it, vi } from "vitest";
import { type Cause, Effect, Fiber, Option, Schema } from "effect";
import { makePaymentEnrollmentD1 } from "./payment-enrollment-d1.test-fixture";
import {
  dispatchWeeklyRenewals,
  publishWeeklyPriceAndNotify,
  receiveBillingCollection,
  runBillingCollectionWorkflow,
} from "./runtime";
import { type BillingCollectionFailure, type BillingRuntime } from "./contract";
import { Price } from "../../src/core/subscription/contract";
import { executeWeeklyRenewalAdmission, publishWeeklyPrice } from "./operations";

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
  const disposed = Option.match(instance, {
    onNone: () => Promise.resolve(),
    onSome: (value) => value.dispose(),
  });
  instance = Option.none();
  return disposed;
});

const fixture = (method: "card" | "nequi" = "card"): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const created = yield* makePaymentEnrollmentD1(`weekly-renewal-${++fixtureCounter}`, [
        "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT",
        "CREATE TABLE onboarding_consent_records (user_id TEXT PRIMARY KEY) STRICT",
        "CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY) STRICT",
      ]);
      instance = Option.some(created.instance);
      const db = created.db;
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("INSERT INTO users VALUES (?, 'America/Bogota')").bind(userId),
          db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(userId),

          db
            .prepare(`INSERT INTO card_enrollments (id, user_id, price_id, billing_email, status,
        payment_source_mode, contracts_json, disclosure_json, prepared_at_ms, expires_at_ms,
        payment_request_id, wompi_candidate_source_id, method, wompi_environment)
        VALUES (?, ?, ?, 'payer@example.com', 'creating', 'create', '{}', '{}', 0, 900000, ?, 3891, ?, 'sandbox')`)
            .bind(enrollmentId, userId, priceId, paymentRequestId, method),
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
        VALUES (?, ?, ?, ?, ?, ?, '9900', 'COP', 'weekly', 'CO', 'not-taxable',
          'America/Bogota', 'sandbox', ?, 0)`)
            .bind(attemptId, userId, enrollmentId, paymentRequestId, sourceId, priceId, reference),
        ])
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "UPDATE billing_attempts SET status = 'succeeded', finalized_at_ms = ? WHERE id = ?"
            )
            .bind(Date.parse("2026-10-06T15:00:00Z"), attemptId),
          db
            .prepare("INSERT INTO billing_paid_periods VALUES (?, ?, ?, ?)")
            .bind(
              attemptId,
              Date.parse("2026-10-06T15:00:00Z"),
              Date.parse("2026-10-13T15:00:00Z"),
              Date.parse("2026-10-13T15:00:00Z")
            ),
          db
            .prepare("INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?)")
            .bind(
              userId,
              attemptId,
              priceId,
              Date.parse("2026-10-13T15:00:00Z"),
              Date.parse("2026-10-13T15:00:00Z")
            ),
          db
            .prepare("INSERT INTO billing_followup_outbox VALUES (?, 'renewal_due', ?)")
            .bind(attemptId, Date.parse("2026-10-13T15:00:00Z")),
        ])
      );
      return db;
    })
  );

const fromPromise = <A>(run: () => Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(run);
const dueAt = Date.parse("2026-10-13T15:00:00Z");
const admission = (db: D1Database, now: number = dueAt): Effect.Effect<Response> =>
  executeWeeklyRenewalAdmission({
    db,
    userId,
    environment: "sandbox",
    now,
    candidate: { _tag: "WeeklyRenewal", userId, previousPaidAttemptId: attemptId },
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

it("rejects foreign admission and refuses early and revoked renewals without partial intent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
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
      yield* executeWeeklyRenewalAdmission({
        db,
        userId: foreignUserId,
        environment: "sandbox",
        now: dueAt,
        candidate: {
          _tag: "WeeklyRenewal",
          userId: foreignUserId,
          previousPaidAttemptId: attemptId,
        },
      });
      expect((yield* fromPromise(billingState)).map((result) => result.results)).toEqual(before);
      const foreign = yield* executeWeeklyRenewalAdmission({
        db,
        userId: "10000000-0000-4000-8000-000000000002",
        environment: "sandbox",
        now: dueAt,
        candidate: { _tag: "WeeklyRenewal", userId, previousPaidAttemptId: attemptId },
      });
      expect(foreign.status).toBe(403);
      yield* admission(db, dueAt - 1);
      yield* fromPromise(() =>
        db.prepare("INSERT INTO consent_user_revocations VALUES (?)").bind(userId).run()
      );
      yield* admission(db);
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
  ));

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

it("rechecks Consent before the renewal POST even after its pending intent was accepted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture());
      yield* admission(db);
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
      const fetch = vi.fn(() => Promise.reject(new Error("Revoked renewal must not reach Wompi")));
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
  ));

it("does not admit automatic renewal or post-boundary grace for a wallet Subscription", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromPromise(() => fixture("nequi"));
      yield* admission(db);
      expect(
        (yield* fromPromise(() =>
          db
            .prepare("SELECT id FROM billing_attempts WHERE previous_paid_attempt_id IS NOT NULL")
            .all()
        )).results
      ).toEqual([]);
      const condition = activePaidSubscriptionCondition({
        userId: UserId.make(userId),
        nowEpochMs: dueAt,
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
  ));

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
      const fiber = yield* dispatchWeeklyRenewals({
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
