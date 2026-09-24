import type { Miniflare } from "miniflare";
import { afterEach, expect, it, vi } from "vitest";
import { DateTime, Effect, Option } from "effect";
import {
  type WompiBillingClientService,
  WompiSourceId,
  type WompiTransaction,
  WompiTransactionId,
  WompiTransactionReference,
} from "@fidy/server/subscription-runtime";
import { makeCardEnrollmentD1 } from "../card-enrollment/card-enrollment-d1.test-fixture";
import {
  receiveWompiBillingEvent,
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

const transaction = (status: WompiTransaction["status"]): WompiTransaction => ({
  transactionId,
  reference,
  status,
  amountInCents: 990000,
  currency: "COP",
  sourceId: WompiSourceId.make(3891),
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
              payment_source_id: 3891,
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
      const send = (payload: unknown = event): ReturnType<typeof receiveWompiBillingEvent> =>
        receiveWompiBillingEvent({
          environment,
          request: new Request("https://core.internal/providers/wompi/billing-events", {
            method: "POST",
            headers: { "x-event-checksum": checksum, "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
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
      expect(yield* Effect.promise(() => state(db))).toBe("succeeded");
      expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(
        (yield* Effect.promise(() => db.prepare("SELECT * FROM billing_audit").all())).results
      ).toHaveLength(1);
    })
  ));

it("refuses a mismatched source even with a valid provider id and reference", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.promise(fixture);
      const forged = client(() => ({
        ...transaction("APPROVED"),
        sourceId: WompiSourceId.make(3892),
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
