import { type WorkflowStepConfig } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { type Cause, Clock, Effect, Exit, Option, Schema } from "effect";
import { type Miniflare } from "miniflare";
import { makePaymentEnrollmentD1 } from "./payment-enrollment-d1.test-fixture";
import { executeProtectedSubscriptionQuery, getRefund, startRefund } from "./operations";
import { type RefundStartCall, RefundSupportAdmission } from "./contract";
import { UserTransactionCoordinator } from "../transactions/runtime";
import {
  dispatchRefunds,
  dispatchVoidVerification,
  receiveRefunds,
  runRefundWorkflow,
} from "./runtime";

const userId = "10000000-0000-4000-8000-000000000001";
const attemptId = "40000000-0000-4000-8000-000000000001";
const priceId = "22700000-0000-4000-8000-000000000001";
const requestId = "50000000-0000-4000-8000-000000000001";
let instance: Option.Option<Miniflare> = Option.none();
let counter = 0;
afterEach(() => {
  vi.unstubAllGlobals();
  const disposed = Option.isSome(instance) ? instance.value.dispose() : Promise.resolve();
  instance = Option.none();
  return disposed;
});
const fixture = (activeTrial = false): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const made = yield* makePaymentEnrollmentD1(`refund-${++counter}`, [
      "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT",
      "CREATE TABLE trial_periods (user_id TEXT PRIMARY KEY, started_at_ms INTEGER NOT NULL, ends_at_ms INTEGER NOT NULL) STRICT",
      "CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_digest BLOB NOT NULL, revoked_at_ms INTEGER, idle_expires_at_ms INTEGER NOT NULL, hard_expires_at_ms INTEGER NOT NULL) STRICT",
      "CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY) STRICT",
      "CREATE TABLE pat_audit (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, pat_id TEXT, operation TEXT NOT NULL, outcome TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL) STRICT",
      "CREATE TABLE pat_atomic_assertion (id INTEGER PRIMARY KEY CHECK (id = 1), accepted INTEGER NOT NULL CHECK (accepted = 1)) STRICT",
    ]);
    instance = Option.some(made.instance);
    const db = made.db;
    const trialStart = activeTrial ? (yield* Clock.currentTimeMillis) - 1000 : 1000;
    const trialEnd = trialStart + 604800000;
    yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare("INSERT INTO users VALUES (?, 'America/Bogota')").bind(userId),
        db.prepare("INSERT INTO trial_periods VALUES (?,?,?)").bind(userId, trialStart, trialEnd),
        db
          .prepare("INSERT INTO web_sessions VALUES (?,?,?,NULL,9999999999999,9999999999999)")
          .bind(requestId, userId, new Uint8Array(32)),
        db
          .prepare(`INSERT INTO card_enrollments (id,user_id,price_id,billing_email,status,payment_source_mode,
      contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,payment_request_id,wompi_candidate_source_id,method,wompi_environment)
      VALUES ('20000000-0000-4000-8000-000000000001',?,?,'payer@example.com','creating','create','{}','{}',0,900000,?,3891,'card','sandbox')`)
          .bind(userId, priceId, requestId),
        db
          .prepare(`INSERT INTO card_payment_sources (id,user_id,enrollment_id,wompi_source_id,billing_email,created_at_ms,method)
      VALUES ('30000000-0000-4000-8000-000000000001',?,'20000000-0000-4000-8000-000000000001',3891,'payer@example.com',0,'card')`)
          .bind(userId),
        db.prepare("UPDATE card_enrollments SET status='available'").bind(),
        db
          .prepare(`INSERT INTO billing_attempts (id,user_id,enrollment_id,payment_request_id,payment_source_id,price_id,
      amount,currency,billing_period,service_market,tax_treatment,time_zone,wompi_environment,wompi_reference,created_at_ms)
      VALUES (?,?,'20000000-0000-4000-8000-000000000001',?,'30000000-0000-4000-8000-000000000001',?,
      '9900','COP','weekly','CO','not-taxable','America/Bogota','sandbox','fidy-test',0)`)
          .bind(attemptId, userId, requestId, priceId),
        db
          .prepare(`INSERT INTO billing_transaction_evidence (transaction_id,attempt_id,status,first_observed_at_ms,finalized_at_ms)
      VALUES ('provider-charge',?,'APPROVED',0,1)`)
          .bind(attemptId),
        db
          .prepare("UPDATE billing_attempts SET status='succeeded',finalized_at_ms=1 WHERE id=?")
          .bind(attemptId),
        db
          .prepare("INSERT INTO billing_paid_periods VALUES (?,1,9999999999999,9999999999999)")
          .bind(attemptId),
        db
          .prepare("INSERT INTO subscriptions VALUES (?,?,?,9999999999999,9999999999999)")
          .bind(userId, attemptId, priceId),
      ])
    );
    return db;
  });
const standing = (
  db: D1Database,
  scopedUserId = userId,
  sessionId = requestId
): Effect.Effect<unknown, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    executeProtectedSubscriptionQuery({
      db,
      subject: { id: sessionId, userId: scopedUserId, digest: new Uint8Array(32) },
      operation: "subscription.getSubscriptionStatus",
    })
  ).pipe(Effect.flatMap((response) => Effect.tryPromise(() => response.json())));

const workflowFor = (db: D1Database, id: string): Parameters<typeof runRefundWorkflow>[0] => ({
  environment: {
    DB: db,
    WOMPI_ENVIRONMENT: "sandbox",
    WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
    WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
    WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
  },
  payload: { version: 1, kind: "refund", refundAttemptId: id },
  activity: (
    _name: string,
    _options: WorkflowStepConfig,
    run: () => Promise<void>
  ): Promise<void> => run(),
});
const providerReply = (
  id: string,
  status: string,
  correlation: Partial<
    Readonly<{ amount_in_cents: number; transaction_id: string; reference: string }>
  > = {}
): Response =>
  Response.json(
    {
      data: {
        id: 1523,
        v2_refund_id: "v2_refund_abc",
        status,
        transaction_id: "provider-charge",
        amount_in_cents: 400000,
        reference: `fidy-refund-${id}`,
        ...correlation,
      },
    },
    { status: 201 }
  );

const call = (db: D1Database, amount = "4000", identity = requestId): RefundStartCall => ({
  db,
  environment: "sandbox",
  authority: {
    operatorId: "support-operator",
    expiresAtMs: 9999999999999,
    permission: "billing.refund" as const,
  },
  input: {
    userId,
    billingAttemptId: attemptId,
    requestId: identity,
    intent: { kind: "refund" as const, money: { amount, currency: "COP" as const } },
    reason: "user-request" as const,
  },
});
const assertPendingIntegrity = Effect.fnUntraced(function* (
  db: D1Database,
  id: string,
  reserved: number = 400000
) {
  expect(
    yield* getRefund({ db, authority: call(db).authority, userId, refundAttemptId: id })
  ).toMatchObject({ status: "pending" });
  expect(yield* standing(db)).toMatchObject({ data: { accessTier: "pro" } });
  const retained = yield* Effect.tryPromise(() =>
    db
      .prepare(`SELECT
    (SELECT COUNT(*) FROM refund_outcome_evidence) AS outcomes,
    (SELECT COUNT(*) FROM billing_access_adjustments) AS adjustments,
    (SELECT COUNT(*) FROM subscription_renewal_stops) AS stops,
    (SELECT SUM(amount_in_cents) FROM refund_attempts WHERE status<>'failed') AS reserved,
    (SELECT COUNT(*) FROM refund_submission_claims WHERE refund_id=?) AS claims`)
      .bind(id)
      .first()
  );
  expect(retained).toEqual({ outcomes: 0, adjustments: 0, stops: 0, reserved, claims: 1 });
});

it("isolates mismatched coordinator Users and foreign charge identities before any financial acceptance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const accepted = yield* startRefund(call(db));
      const otherUserId = "10000000-0000-4000-8000-000000000002";
      const otherSessionId = "50000000-0000-4000-8000-000000000002";
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("INSERT INTO users VALUES (?,'America/Bogota')").bind(otherUserId),
          db.prepare("INSERT INTO trial_periods VALUES (?,1000,604801000)").bind(otherUserId),
          db
            .prepare("INSERT INTO web_sessions VALUES (?,?,?,NULL,9999999999999,9999999999999)")
            .bind(otherSessionId, otherUserId, new Uint8Array(32)),
        ])
      );
      const originalStanding = yield* standing(db);
      const otherStanding = yield* standing(db, otherUserId, otherSessionId);
      const coordinator = new UserTransactionCoordinator(
        {
          id: { name: otherUserId },
          storage: { setAlarm: (): Promise<void> => Promise.resolve() },
        },
        {
          DB: db,
          WOMPI_ENVIRONMENT: "sandbox",
          HOSTED_AI_MODEL: "",
          AI: {
            run: (): Promise<never> => Promise.reject(new Error("No inference during corrections")),
          },
        }
      );
      for (const scopedUserId of [userId, otherUserId]) {
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(RefundSupportAdmission))({
          _tag: "BillingRefundSupport",
          authority: call(db).authority,
          input: { ...call(db).input, userId: scopedUserId, requestId: otherSessionId },
        });
        const response = yield* Effect.tryPromise(() =>
          coordinator.fetch(
            new Request("https://coordinator.internal/billing-refund-work", {
              method: "POST",
              body,
            })
          )
        );
        expect(response.status).toBe(scopedUserId === userId ? 403 : 404);
      }
      expect(
        yield* Effect.flip(
          getRefund({
            db,
            authority: call(db).authority,
            userId: otherUserId,
            refundAttemptId: accepted.id,
          })
        )
      ).toBe("charge-unavailable");
      expect(
        yield* getRefund({
          db,
          authority: call(db).authority,
          userId,
          refundAttemptId: accepted.id,
        })
      ).toEqual(accepted);
      expect(yield* standing(db)).toEqual(originalStanding);
      expect(yield* standing(db, otherUserId, otherSessionId)).toEqual(otherStanding);
      const retained = yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT
    (SELECT COUNT(*) FROM refund_attempts) AS attempts,
    (SELECT SUM(amount_in_cents) FROM refund_attempts) AS reserved,
    (SELECT COUNT(*) FROM refund_outbox) AS outbox,
    (SELECT COUNT(*) FROM refund_submission_claims) AS claims,
    (SELECT COUNT(*) FROM refund_outcome_evidence) AS outcomes,
    (SELECT COUNT(*) FROM subscription_renewal_stops) AS stops,
    (SELECT COUNT(*) FROM billing_access_adjustments) AS adjustments`)
          .first()
      );
      expect(retained).toEqual({
        attempts: 1,
        reserved: 400000,
        outbox: 1,
        claims: 0,
        outcomes: 0,
        stops: 0,
        adjustments: 0,
      });
    })
  ));

it("accepts an attributable asynchronous correction and replays identical intent without another reservation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const accepted = yield* startRefund(call(db));
      expect(accepted).toMatchObject({
        status: "pending",
        progress: "queued",
        userId,
        billingAttemptId: attemptId,
      });
      const replay = yield* startRefund(call(db));
      expect(replay.id).toBe(accepted.id);
      expect(
        yield* getRefund({
          db,
          authority: call(db).authority,
          userId,
          refundAttemptId: accepted.id,
        })
      ).toEqual(accepted);
      expect(Exit.isFailure(yield* Effect.exit(startRefund(call(db, "4001"))))).toBe(true);
    })
  ));

it("serializes competing reservations and refuses real-money execution before acceptance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const calls = [call(db, "6000"), call(db, "6000", "50000000-0000-4000-8000-000000000002")];
      const outcomes = yield* Effect.forEach(calls, (input) => Effect.exit(startRefund(input)), {
        concurrency: "unbounded",
      });
      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
      expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);
      const production = yield* Effect.exit(
        startRefund({ ...call(db), environment: "production" })
      );
      expect(Exit.isFailure(production)).toBe(true);
    })
  ));

it("settles an authenticated matching Sandbox refund exactly once without mutating original charge history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const accepted = yield* startRefund(call(db));
      let posts = 0;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        posts++;
        expect(request.url).toBe("https://sandbox.wompi.co/v1/refunds");
        expect(request.method).toBe("POST");
        return request.json().then((body: unknown) => {
          expect(body).toMatchObject({
            transaction_id: "provider-charge",
            amount_in_cents: 400000,
            reference: `fidy-refund-${accepted.id}`,
          });
          return Response.json(
            {
              data: {
                id: 1523,
                v2_refund_id: "v2_refund_abc",
                status: "APPROVED",
                transaction_id: "provider-charge",
                amount_in_cents: 400000,
                reference: `fidy-refund-${accepted.id}`,
              },
            },
            { status: 201 }
          );
        });
      });
      expect(yield* standing(db)).toMatchObject({ data: { accessTier: "pro" } });
      const workflow = {
        environment: {
          DB: db,
          WOMPI_ENVIRONMENT: "sandbox",
          WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
          WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
          WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
        },
        payload: { version: 1, kind: "refund", refundAttemptId: accepted.id },
        activity: (
          _name: string,
          _options: WorkflowStepConfig,
          run: () => Promise<void>
        ): Promise<void> => run(),
      };
      yield* Effect.tryPromise(() => runRefundWorkflow(workflow));
      yield* Effect.tryPromise(() => runRefundWorkflow(workflow));
      expect(posts).toBe(1);
      expect(yield* standing(db)).toMatchObject({
        data: {
          accessTier: "free",
          recentAttempts: [{ status: "succeeded", paidPeriodEndsAt: "2286-11-20T17:46:39.999Z" }],
        },
      });
      expect(
        yield* getRefund({
          db,
          authority: call(db).authority,
          userId,
          refundAttemptId: accepted.id,
        })
      ).toMatchObject({ status: "succeeded" });
    })
  ));

it.each([
  "lost-response",
  "ERROR",
  "PENDING",
  "FAILED",
  "SUCCESSFUL",
  "wrong-amount",
  "wrong-transaction",
  "wrong-reference",
])("retains the reservation and access after %s without repeating the mutation", (outcome) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const accepted = yield* startRefund(call(db));
      let posts = 0;
      vi.stubGlobal("fetch", (): Promise<Response> => {
        posts++;
        return outcome === "lost-response"
          ? Promise.reject(new Error("uncertain"))
          : Promise.resolve(
              providerReply(accepted.id, outcome.startsWith("wrong-") ? "APPROVED" : outcome, {
                amount_in_cents: outcome === "wrong-amount" ? 400001 : 400000,
                transaction_id:
                  outcome === "wrong-transaction" ? "unrelated-charge" : "provider-charge",
                reference:
                  outcome === "wrong-reference"
                    ? "fidy-refund-10000000-0000-4000-8000-000000000099"
                    : `fidy-refund-${accepted.id}`,
              })
            );
      });
      yield* Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)));
      yield* Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)));
      expect(posts).toBe(1);
      yield* assertPendingIntegrity(db, accepted.id);
      expect(
        yield* getRefund({
          db,
          authority: call(db).authority,
          userId,
          refundAttemptId: accepted.id,
        })
      ).toMatchObject({ status: "pending", progress: "outcome-unknown" });
      expect(yield* standing(db)).toMatchObject({ data: { accessTier: "pro" } });
      const republished: unknown[] = [];
      yield* dispatchRefunds({
        DB: db,
        BILLING_COLLECTION_QUEUE: {
          send: (body) => {
            republished.push(body);
            return Promise.resolve();
          },
        },
      });
      expect(republished).toEqual([]);
      expect(
        Exit.isFailure(
          yield* Effect.exit(startRefund(call(db, "6000", "50000000-0000-4000-8000-000000000002")))
        )
      ).toBe(true);
    })
  )
);

it.each(["DECLINED", "CANCELLED"])(
  "releases refundable Money only on a correlated documented %s final response",
  (status) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fixture();
        const accepted = yield* startRefund(call(db));
        vi.stubGlobal("fetch", (): Promise<Response> =>
          Promise.resolve(providerReply(accepted.id, status))
        );
        yield* Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)));
        expect(
          yield* getRefund({
            db,
            authority: call(db).authority,
            userId,
            refundAttemptId: accepted.id,
          })
        ).toMatchObject({ status: "failed" });
        expect(yield* standing(db)).toMatchObject({ data: { accessTier: "pro" } });
        expect(
          yield* startRefund(call(db, "9900", "50000000-0000-4000-8000-000000000002"))
        ).toMatchObject({ status: "pending" });
      })
    )
);

it("refuses foreign User scope, ambiguous approved charges and an expired support admission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const accepted = yield* startRefund(call(db));
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            getRefund({
              db,
              authority: call(db).authority,
              userId: "10000000-0000-4000-8000-000000000002",
              refundAttemptId: accepted.id,
            })
          )
        )
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            startRefund({ ...call(db), authority: { ...call(db).authority, expiresAtMs: 1 } })
          )
        )
      ).toBe(true);
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO billing_transaction_evidence
    (transaction_id,attempt_id,status,first_observed_at_ms,finalized_at_ms) VALUES ('another-charge',?,'APPROVED',0,1)`)
          .bind(attemptId)
          .run()
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(startRefund(call(db, "1000", "50000000-0000-4000-8000-000000000002")))
        )
      ).toBe(true);
    })
  ));

it("recovers missed publication and duplicate Queue delivery using the same identity without repeating a POST", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const accepted = yield* startRefund(call(db));
      const sent: unknown[] = [];
      yield* dispatchRefunds({
        DB: db,
        BILLING_COLLECTION_QUEUE: {
          send: (body) => {
            sent.push(body);
            return Promise.resolve();
          },
        },
      });
      expect(sent).toEqual([{ version: 1, kind: "refund", refundAttemptId: accepted.id }]);
      let starts = 0;
      let acknowledgments = 0;
      const receive = {
        environment: {
          BILLING_REFUND_WORKFLOW: {
            create: (): Promise<void> => {
              starts++;
              return starts === 1
                ? runRefundWorkflow(workflowFor(db, accepted.id))
                : Promise.reject(new Error("exists"));
            },
            get: (): Promise<void> => Promise.resolve(),
          },
        },
        batch: {
          messages: [
            {
              body: sent[0],
              ack: (): void => {
                acknowledgments++;
              },
            },
          ],
        },
      };
      vi.stubGlobal("fetch", (): Promise<Response> =>
        Promise.resolve(providerReply(accepted.id, "APPROVED"))
      );
      yield* receiveRefunds(receive);
      yield* receiveRefunds(receive);
      expect(acknowledgments).toBe(2);
      expect(yield* standing(db)).toMatchObject({ data: { accessTier: "free" } });
    })
  ));

it("derives the whole card void Money and reconciles a lost response by transaction lookup, never another void", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const input = {
        ...call(db),
        input: { ...call(db).input, intent: { kind: "card-void" as const } },
      };
      const accepted = yield* startRefund(input);
      expect(accepted.kind).toBe("card-void");
      let posts = 0;
      let gets = 0;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        if (request.method === "POST") {
          posts++;
          expect(request.url).toBe("https://sandbox.wompi.co/v1/transactions/provider-charge/void");
          return Promise.reject(new Error("lost void response"));
        }
        gets++;
        expect(request.url).toBe("https://sandbox.wompi.co/v1/transactions/provider-charge");
        return Promise.resolve(
          Response.json({
            data: {
              id: "provider-charge",
              status: "VOIDED",
              reference: "fidy-test",
              amount_in_cents: 990000,
              currency: "COP",
              payment_source_id: 3891,
            },
          })
        );
      });
      yield* Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)));
      expect(yield* standing(db)).toMatchObject({ data: { accessTier: "pro" } });
      const lookups: unknown[] = [];
      yield* dispatchVoidVerification({
        DB: db,
        BILLING_COLLECTION_QUEUE: {
          send: (body) => {
            lookups.push(body);
            return Promise.resolve();
          },
        },
      });
      expect(lookups).toEqual([
        {
          version: 1,
          kind: "refund-void-verification",
          refundAttemptId: accepted.id,
          verification: 1,
        },
      ]);
      yield* Effect.tryPromise(() =>
        runRefundWorkflow({ ...workflowFor(db, accepted.id), payload: lookups[0] })
      );
      expect(posts).toBe(1);
      expect(gets).toBe(1);
      expect(
        yield* getRefund({
          db,
          authority: call(db).authority,
          userId,
          refundAttemptId: accepted.id,
        })
      ).toMatchObject({ status: "succeeded" });
      expect(yield* standing(db)).toMatchObject({ data: { accessTier: "free" } });
    })
  ));

it.each([
  { field: "transaction identity", patch: { id: "unrelated-charge" } },
  { field: "charge reference", patch: { reference: "unrelated-reference" } },
  { field: "original Money", patch: { amount_in_cents: 990001 } },
  { field: "Currency", patch: { currency: "USD" } },
  { field: "payment source", patch: { payment_source_id: 3892 } },
])("refuses mismatched void $field in both submission and read-only verification", ({ patch }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const accepted = yield* startRefund({
        ...call(db),
        input: { ...call(db).input, intent: { kind: "card-void" } },
      });
      let posts = 0;
      let lookups = 0;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        if (request.method === "POST") posts++;
        else lookups++;
        return Promise.resolve(
          Response.json({
            data: {
              id: "provider-charge",
              status: "VOIDED",
              reference: "fidy-test",
              amount_in_cents: 990000,
              currency: "COP",
              payment_source_id: 3891,
              ...patch,
            },
          })
        );
      });
      yield* Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)));
      yield* assertPendingIntegrity(db, accepted.id, 990000);
      yield* Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)));
      expect(posts).toBe(1);
      expect(lookups).toBe(1);
      yield* assertPendingIntegrity(db, accepted.id, 990000);
      expect(
        yield* Effect.flip(startRefund(call(db, "1000", "50000000-0000-4000-8000-000000000003")))
      ).toBe("amount-exceeds-remaining");
    })
  )
);

it("keeps the mutation claim and reservation after provider approval but failed durable settlement", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const accepted = yield* startRefund(call(db));
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER injected_settlement_failure BEFORE INSERT ON refund_outcome_evidence BEGIN SELECT RAISE(ABORT,'injected durable settlement failure'); END"
          )
          .run()
      );
      let posts = 0;
      vi.stubGlobal("fetch", (): Promise<Response> => {
        posts++;
        return Promise.resolve(providerReply(accepted.id, "APPROVED"));
      });
      const failed = yield* Effect.exit(
        Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)))
      );
      expect(Exit.isFailure(failed)).toBe(true);
      expect(posts).toBe(1);
      yield* assertPendingIntegrity(db, accepted.id);
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER injected_settlement_failure").run());
      yield* Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)));
      expect(posts).toBe(1);
      yield* assertPendingIntegrity(db, accepted.id);
      expect(
        yield* Effect.flip(startRefund(call(db, "6000", "50000000-0000-4000-8000-000000000003")))
      ).toBe("amount-exceeds-remaining");
    })
  ));

it("allows only one financial POST when independent Workflow executions race the durable submission claim", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const accepted = yield* startRefund(call(db));
      const entered = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<Response>();
      let posts = 0;
      vi.stubGlobal("fetch", (): Promise<Response> => {
        posts++;
        entered.resolve();
        return reply.promise;
      });
      const winner = runRefundWorkflow(workflowFor(db, accepted.id));
      yield* Effect.tryPromise(() => entered.promise);
      yield* Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)));
      expect(posts).toBe(1);
      yield* assertPendingIntegrity(db, accepted.id);
      reply.resolve(providerReply(accepted.id, "APPROVED"));
      yield* Effect.tryPromise(() => winner);
      yield* Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)));
      expect(posts).toBe(1);
      expect(
        yield* getRefund({
          db,
          authority: call(db).authority,
          userId,
          refundAttemptId: accepted.id,
        })
      ).toMatchObject({ status: "succeeded" });
      expect(yield* standing(db)).toMatchObject({ data: { accessTier: "free" } });
    })
  ));

it.each(["production-environment", "live-private-key", "production-captured-charge"])(
  "refuses %s before claiming or executing accepted corrections",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fixture();
        const accepted = yield* startRefund(call(db));
        if (scenario === "production-captured-charge") {
          // Deliberately inject impossible stored provenance to prove the execution barrier independently
          // of acceptance and immutable charge snapshots. This is isolated test-fixture corruption only.
          yield* Effect.tryPromise(() =>
            db.batch([
              db.prepare("DROP TRIGGER billing_attempt_snapshot_immutable"),
              db
                .prepare("UPDATE billing_attempts SET wompi_environment='production' WHERE id=?")
                .bind(attemptId),
            ])
          );
        }
        const originalStanding = yield* standing(db);
        const provider = vi.fn((): Promise<Response> =>
          Promise.reject(new Error("Prohibited financial egress"))
        );
        vi.stubGlobal("fetch", provider);
        const workflow = workflowFor(db, accepted.id);
        yield* Effect.tryPromise(() =>
          runRefundWorkflow({
            ...workflow,
            environment: {
              ...workflow.environment,
              WOMPI_ENVIRONMENT: scenario === "production-environment" ? "production" : "sandbox",
              WOMPI_PRIVATE_KEY:
                scenario === "live-private-key"
                  ? "prv_prod_synthetic_only"
                  : workflow.environment.WOMPI_PRIVATE_KEY,
            },
          })
        );
        expect(provider).not.toHaveBeenCalled();
        expect(
          yield* getRefund({
            db,
            authority: call(db).authority,
            userId,
            refundAttemptId: accepted.id,
          })
        ).toEqual(accepted);
        expect(yield* standing(db)).toEqual(originalStanding);
        const retained = yield* Effect.tryPromise(() =>
          db
            .prepare(`SELECT
    (SELECT COUNT(*) FROM refund_attempts) AS attempts,
    (SELECT SUM(amount_in_cents) FROM refund_attempts) AS reserved,
    (SELECT COUNT(*) FROM refund_submission_claims) AS claims,
    (SELECT COUNT(*) FROM refund_outcome_evidence) AS outcomes,
    (SELECT COUNT(*) FROM billing_access_adjustments) AS adjustments,
    (SELECT COUNT(*) FROM subscription_renewal_stops) AS stops`)
            .first()
        );
        expect(retained).toEqual({
          attempts: 1,
          reserved: 400000,
          claims: 0,
          outcomes: 0,
          adjustments: 0,
          stops: 0,
        });
      })
    )
);

it("reports malformed retained correction state as unavailable, not absent or a new intent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      const accepted = yield* startRefund(call(db));
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("PRAGMA ignore_check_constraints=ON"),
          db
            .prepare("UPDATE refund_attempts SET progress='unrecognized' WHERE id=?")
            .bind(accepted.id),
        ])
      );
      expect(
        yield* Effect.flip(
          getRefund({ db, authority: call(db).authority, userId, refundAttemptId: accepted.id })
        )
      ).toBe("unavailable");
      expect(yield* Effect.flip(startRefund(call(db)))).toBe("unavailable");
      const retained = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT COUNT(*) AS attempts,SUM(amount_in_cents) AS reserved FROM refund_attempts"
          )
          .first()
      );
      expect(retained).toEqual({ attempts: 1, reserved: 400000 });
    })
  ));

it("preserves an independently active TrialPeriod after a successful full refund", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture(true);
      const accepted = yield* startRefund(call(db, "9900"));
      vi.stubGlobal("fetch", (): Promise<Response> =>
        Promise.resolve(providerReply(accepted.id, "APPROVED", { amount_in_cents: 990000 }))
      );
      yield* Effect.tryPromise(() => runRefundWorkflow(workflowFor(db, accepted.id)));
      expect(
        yield* getRefund({
          db,
          authority: call(db).authority,
          userId,
          refundAttemptId: accepted.id,
        })
      ).toMatchObject({ status: "succeeded" });
      expect(yield* standing(db)).toMatchObject({ data: { accessTier: "pro" } });
    })
  ));
