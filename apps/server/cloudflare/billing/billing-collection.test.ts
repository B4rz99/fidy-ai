import type { Miniflare } from "miniflare";
import { afterEach, expect, it, vi } from "vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  type WompiBillingClientService,
  WompiSourceId,
  type WompiTransaction,
  WompiTransactionId,
  WompiTransactionReference,
} from "@fidy/server/subscription-runtime";
import { makeCardEnrollmentD1 } from "../card-enrollment/card-enrollment-d1.test-fixture";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import {
  dispatchBillingCollection,
  receiveBillingCollection,
  reconcileBillingCandidates,
  reconcileBillingTransaction,
  runBillingCollectionWorkflow,
} from "./billing-collection";

const userId = "10000000-0000-4000-8000-000000000001";
const enrollmentId = "20000000-0000-4000-8000-000000000001";
const sourceId = "30000000-0000-4000-8000-000000000001";
const attemptId = "40000000-0000-4000-8000-000000000001";
const paymentRequestId = "50000000-0000-4000-8000-000000000001";
const priceId = "22700000-0000-4000-8000-000000000001";
const reference = WompiTransactionReference.make(`fidy-${attemptId}`);
const transactionId = WompiTransactionId.make("provider-transaction-1");
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

const fixture = (): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const created = yield* makeCardEnrollmentD1(`billing-collection-${++fixtureCounter}`, [
        "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT",
      ]);
      instance = Option.some(created.instance);
      const db = created.db;
      yield* Effect.promise(() =>
        db.batch([
          db.prepare("INSERT INTO users VALUES (?, 'America/Bogota')").bind(userId),
          db
            .prepare(`INSERT INTO card_enrollments (id, user_id, price_id, billing_email, status,
        payment_source_mode, contracts_json, disclosure_json, prepared_at_ms, expires_at_ms,
        payment_request_id, wompi_candidate_source_id)
        VALUES (?, ?, ?, 'payer@example.com', 'creating', 'create', '{}', '{}', 0, 900000, ?, 3891)`)
            .bind(enrollmentId, userId, priceId, paymentRequestId),
          db
            .prepare(`INSERT INTO card_payment_sources
        (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms)
        VALUES (?, ?, ?, 3891, 'payer@example.com', 0)`)
            .bind(sourceId, userId, enrollmentId),
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
      return db;
    })
  );

const publicBillingCallback = (db: D1Database, request: Request): Promise<Response> =>
  publicWorker.fetch(request, {
    BROWSER_ORIGIN: "https://app.fidyapp.com",
    LOCAL_CANONICAL_READ_BEARER: "local",
    PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CORE: {
      fetch: (forwarded) =>
        coreWorker.fetch(new Request(forwarded), {
          AI: { run: () => Promise.reject(new Error("unused")) },
          DB: db,
          HOSTED_AI_MODEL: approvedWorkersAiModel,
          CONTRACT_DIGEST: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          WOMPI_ENVIRONMENT: "sandbox",
          WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
          WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
          WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
          WOMPI_EVENT_SECRET: "test_events_payment_test_secret",
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
        }),
    },
  });

const transaction = (status: WompiTransaction["status"]): WompiTransaction => ({
  transactionId,
  reference,
  status,
  amountInCents: 990000,
  currency: "COP",
  sourceId: Option.some(WompiSourceId.make(3891)),
  finalizedAt:
    status === "PENDING" ? Option.none() : Option.some(DateTime.makeUnsafe("2026-09-08T12:00:00Z")),
});
const client = (read: () => WompiTransaction): WompiBillingClientService => ({
  environment: "sandbox",
  createTransaction: () => Effect.succeed(read()),
  findTransaction: () => Effect.succeed(read()),
});
const state = (db: D1Database): Promise<string> =>
  db
    .prepare("SELECT status FROM billing_attempts WHERE id = ?")
    .bind(attemptId)
    .first<{ status: string }>()
    .then((row) => row?.status ?? "missing");

it("settles verified approval with standing, Audit and follow-up exactly once across replay and reordering", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.promise(fixture);
      let observed = transaction("APPROVED");
      const verify = (): ReturnType<typeof reconcileBillingTransaction> =>
        reconcileBillingTransaction({ db, client: client(() => observed), transactionId });
      yield* verify();
      expect(yield* Effect.promise(() => state(db))).toBe("succeeded");
      observed = transaction("DECLINED");
      yield* verify();
      yield* verify();
      expect(yield* Effect.promise(() => state(db))).toBe("succeeded");
      expect(
        (yield* Effect.promise(() => db.prepare("SELECT * FROM billing_audit").all())).results
      ).toHaveLength(1);
      expect(
        (yield* Effect.promise(() => db.prepare("SELECT * FROM subscriptions").all())).results
      ).toHaveLength(1);
      expect(
        (yield* Effect.promise(() => db.prepare("SELECT * FROM billing_followup_outbox").all()))
          .results
      ).toHaveLength(1);
    })
  ));

it("holds verified negative until the retry opportunity and admits a later verified success", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.promise(fixture);
      let observed = transaction("DECLINED");
      const verify = (): ReturnType<typeof reconcileBillingTransaction> =>
        reconcileBillingTransaction({ db, client: client(() => observed), transactionId });
      yield* verify();
      expect(yield* Effect.promise(() => state(db))).toBe("pending");
      expect(
        (yield* Effect.promise(() =>
          db.prepare("SELECT * FROM billing_transaction_candidates").all()
        )).results
      ).toHaveLength(1);
      yield* Effect.promise(() =>
        db
          .prepare(`UPDATE billing_transaction_evidence
      SET negative_observed_at_ms = negative_observed_at_ms - 180001`)
          .run()
      );
      yield* verify();
      expect(yield* Effect.promise(() => state(db))).toBe("failed");
      observed = transaction("APPROVED");
      yield* verify();
      expect(yield* Effect.promise(() => state(db))).toBe("succeeded");
      expect(
        (yield* Effect.promise(() => db.prepare("SELECT * FROM billing_audit").all())).results
      ).toHaveLength(2);
    })
  ));

it("does not repeat an ambiguous Workflow POST and settles a later signed callback after provider GET", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.promise(fixture);
      const eventSecret = "test_events_payment_test_secret";
      const environment = {
        DB: db,
        WOMPI_ENVIRONMENT: "sandbox",
        WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
        WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
        WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
        WOMPI_EVENT_SECRET: eventSecret,
      };
      const provider = vi.fn((_request: URL, init?: RequestInit): Promise<Response> => {
        if (init?.method === "POST") return Promise.reject(new Error("lost response"));
        return Promise.resolve(
          Response.json({
            data: {
              id: transactionId,
              reference,
              status: "APPROVED",
              amount_in_cents: 990000,
              currency: "COP",
              finalized_at: "2026-09-08T12:00:00Z",
            },
          })
        );
      });
      vi.stubGlobal("fetch", provider);
      const run = (): Promise<void> =>
        runBillingCollectionWorkflow({
          environment,
          payload: { version: 1, attemptId },
          activity: (name, options, activity): Promise<void> => {
            expect(name).toBe("collect-wompi-billing-v1");
            expect(options.retries?.limit).toBe(0);
            return activity();
          },
        });
      yield* Effect.promise(run);
      yield* Effect.promise(run);
      expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(yield* Effect.promise(() => state(db))).toBe("pending");
      const timestamp = 1530291411;
      const data = {
        transaction: { id: transactionId, status: "APPROVED", amount_in_cents: 990000 },
      };
      const properties = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];
      const signed = `${transactionId}APPROVED990000${timestamp}${eventSecret}`;
      const hashed = new Uint8Array(
        yield* Effect.promise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(signed))
        )
      );
      const checksum = Array.from(hashed, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const event = {
        event: "transaction.updated",
        environment: "test",
        data,
        signature: { properties, checksum },
        timestamp,
      };
      const send = (payload: unknown = event): Effect.Effect<Response> =>
        Effect.gen(function* () {
          const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            payload
          ).pipe(Effect.orDie);
          return yield* Effect.promise(() =>
            publicBillingCallback(
              db,
              new Request("https://api.fidyapp.com/providers/wompi/billing-events", {
                method: "POST",
                headers: { "x-event-checksum": checksum, "content-type": "application/json" },
                body,
              })
            )
          );
        });
      expect(
        (yield* send({ ...event, data: { transaction: { ...data.transaction, id: "forged-id" } } }))
          .status
      ).toBe(400);
      expect(
        (yield* Effect.promise(() => db.prepare("SELECT * FROM billing_event_candidates").all()))
          .results
      ).toHaveLength(0);
      expect((yield* send()).status).toBe(200);
      expect((yield* send()).status).toBe(200);
      expect(yield* Effect.promise(() => state(db))).toBe("pending");
      expect(provider.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(0);
      const workflow = {
        create: vi.fn((options: { id: string; params: unknown }) =>
          runBillingCollectionWorkflow({
            environment,
            payload: options.params,
            activity: (name, stepOptions, activity): Promise<void> => {
              expect(name).toBe("lookup-wompi-billing-v1");
              expect(stepOptions.retries?.limit).toBe(0);
              return activity();
            },
          }).then(() => ({}))
        ),
        get: vi.fn((_id: string) => Promise.resolve({})),
      };
      yield* reconcileBillingCandidates({ DB: db, BILLING_COLLECTION_WORKFLOW: workflow });
      expect(workflow.create).toHaveBeenCalledTimes(1);
      expect(yield* Effect.promise(() => state(db))).toBe("succeeded");
      expect((yield* send()).status).toBe(200);
      yield* reconcileBillingCandidates({ DB: db, BILLING_COLLECTION_WORKFLOW: workflow });
      expect(workflow.create).toHaveBeenCalledTimes(1);
      expect(provider.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(1);
      expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(
        (yield* Effect.promise(() => db.prepare("SELECT * FROM billing_audit").all())).results
      ).toHaveLength(1);
    })
  ));

it("rejects forged callback evidence across Public and Core ingress without writes or provider calls", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.promise(fixture);
      const provider = vi.fn(() => Promise.reject(new Error("forbidden provider call")));
      vi.stubGlobal("fetch", provider);
      const request = new Request("https://api.fidyapp.com/providers/wompi/billing-events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-event-checksum": "forged" },
        body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          data: { transaction: { id: transactionId } },
        }),
      });
      const response = yield* Effect.promise(() => publicBillingCallback(db, request));
      expect(response.status).toBe(400);
      expect(yield* Effect.promise(() => state(db))).toBe("pending");
      expect(
        (yield* Effect.promise(() => db.prepare("SELECT * FROM billing_event_candidates").all()))
          .results
      ).toHaveLength(0);
      expect(
        (yield* Effect.promise(() =>
          db.prepare("SELECT * FROM billing_transaction_evidence").all()
        )).results
      ).toHaveLength(0);
      expect(provider).not.toHaveBeenCalled();
    })
  ));

it("publishes the armed intent once per cooldown and deduplicates Queue redelivery by Workflow identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.promise(fixture);
      const send = vi.fn((_work: unknown) => Promise.resolve());
      yield* dispatchBillingCollection({ DB: db, BILLING_COLLECTION_QUEUE: { send } });
      yield* dispatchBillingCollection({ DB: db, BILLING_COLLECTION_QUEUE: { send } });
      expect(send).toHaveBeenCalledExactlyOnceWith({ version: 1, attemptId });
      let created = false;
      const create = vi.fn((_options: { id: string; params: unknown }): Promise<unknown> => {
        if (created) return Promise.reject(new Error("existing workflow"));
        created = true;
        return Promise.resolve({});
      });
      const get = vi.fn((_id: string) => Promise.resolve({}));
      const ack = vi.fn();
      const batch = { messages: [{ body: { version: 1, attemptId }, ack }] };
      const environment = { DB: db, BILLING_COLLECTION_WORKFLOW: { create, get } };
      yield* receiveBillingCollection({ environment, batch });
      yield* receiveBillingCollection({ environment, batch });
      expect(create).toHaveBeenCalledTimes(2);
      expect(create.mock.calls[0]?.[0]).toEqual({
        id: attemptId,
        params: { version: 1, attemptId },
      });
      expect(get).toHaveBeenCalledExactlyOnceWith(attemptId);
      expect(ack).toHaveBeenCalledTimes(2);
    })
  ));

it("coordinates two out-of-order BillingAttempts by stable User in the Subscription D1 unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.promise(fixture);
      const secondEnrollment = "20000000-0000-4000-8000-000000000002";
      const secondAttempt = "40000000-0000-4000-8000-000000000002";
      const secondRequest = "50000000-0000-4000-8000-000000000002";
      const secondReference = WompiTransactionReference.make(`fidy-${secondAttempt}`);
      const secondTransaction = WompiTransactionId.make("provider-transaction-2");
      yield* Effect.promise(() =>
        db.batch([
          db
            .prepare(`INSERT INTO card_enrollments (id, user_id, price_id, billing_email, status,
        payment_source_mode, contracts_json, disclosure_json, prepared_at_ms, expires_at_ms,
        payment_request_id)
        VALUES (?, ?, ?, 'payer@example.com', 'creating', 'reuse', '{}', '{}', 0, 900000, ?)`)
            .bind(secondEnrollment, userId, priceId, secondRequest),
          db
            .prepare("UPDATE card_enrollments SET status = 'available' WHERE id = ?")
            .bind(secondEnrollment),
          db
            .prepare(`INSERT INTO billing_attempts (id, user_id, enrollment_id, payment_request_id,
        payment_source_id, price_id, amount, currency, billing_period, service_market,
        tax_treatment, time_zone, wompi_environment, wompi_reference, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, '9900', 'COP', 'weekly', 'CO', 'not-taxable',
          'America/Bogota', 'sandbox', ?, 0)`)
            .bind(
              secondAttempt,
              userId,
              secondEnrollment,
              secondRequest,
              sourceId,
              priceId,
              secondReference
            ),
        ])
      );
      yield* reconcileBillingTransaction({
        db,
        client: client(() => transaction("APPROVED")),
        transactionId,
      });
      const older = {
        ...transaction("APPROVED"),
        transactionId: secondTransaction,
        reference: secondReference,
        finalizedAt: Option.some(DateTime.makeUnsafe("2026-09-01T12:00:00Z")),
      };
      yield* reconcileBillingTransaction({
        db,
        client: client(() => older),
        transactionId: secondTransaction,
      });
      const standing = yield* Effect.promise(() =>
        db
          .prepare("SELECT attempt_id FROM subscriptions WHERE user_id = ?")
          .bind(userId)
          .first<{ attempt_id: string }>()
      );
      expect(standing?.attempt_id).toBe(attemptId);
      const followup = yield* Effect.promise(() =>
        db.prepare("SELECT attempt_id FROM billing_followup_outbox").all<{ attempt_id: string }>()
      );
      expect(followup.results.map((row) => row.attempt_id)).toEqual([attemptId]);
      expect(
        (yield* Effect.promise(() => db.prepare("SELECT * FROM billing_audit").all())).results
      ).toHaveLength(2);
    })
  ));

it("refuses a mismatched source even with a valid provider id and reference", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.promise(fixture);
      const forged = client(() => ({
        ...transaction("APPROVED"),
        sourceId: Option.some(WompiSourceId.make(3892)),
      }));
      const result = yield* Effect.exit(
        reconcileBillingTransaction({ db, client: forged, transactionId })
      );
      expect(result._tag).toBe("Failure");
      expect(yield* Effect.promise(() => state(db))).toBe("pending");
      expect(
        (yield* Effect.promise(() =>
          db.prepare("SELECT * FROM billing_transaction_evidence").all()
        )).results
      ).toHaveLength(0);
    })
  ));
