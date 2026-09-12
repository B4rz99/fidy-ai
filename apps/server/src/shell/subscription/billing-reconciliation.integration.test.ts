import { expect, layer } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import {
  Crypto,
  DateTime,
  type Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { ClusterWorkflowEngine, RunnerAddress } from "effect/unstable/cluster";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { amountInCentsForBilling } from "~/core/subscription/billing-rules";
import {
  BillingAttemptId,
  PaymentRequestId,
  type WompiBillingStatus,
  WompiTransactionId,
  WompiTransactionReference,
} from "~/core/subscription/model";
import {
  CardEnrollmentId,
  CardPaymentSourceId,
  type WompiSourceId,
} from "~/core/subscription/enrollment-model";
import { PriceId } from "~/core/subscription/reference";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { MigrationSqlClient, MigratorLive, PgLive } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { TestPublicNamespace } from "~/shell/testing/test-config";
import {
  BillingAttemptReconciliationWorkflow,
  billingAttemptReconciliationWorkflowLayer,
} from "./billing-attempt-execution";
import {
  armBillingAttemptInScope,
  findBillingAttemptByIdInScope,
  getBillingContextInScope,
  getBillingReconciliationEscalations,
  insertPendingBillingAttemptInScope,
  markBillingAttemptAwaitingReferenceInScope,
  recordCreatedWompiTransactionInScope,
} from "./billing-repo";
import { findPrice } from "./repo";
import { WompiBillingClient, type WompiBillingClientService } from "./wompi-billing-client";
import { reconcileWompiSettlement } from "./wompi-settlement";

const monthlyPriceId = PriceId.make("22700000-0000-4000-8000-000000000002");

const userIdFor = (index: number): UserId =>
  UserId.make(`24700000-0000-4000-8000-${String(index).padStart(12, "0")}`);

const bearerFor = (index: number): TokenBearer =>
  TokenBearer.make(`fin_rec${String(index).padStart(5, "0")}_${"b".repeat(40)}`);

type SeededAttempt = Readonly<{
  payload: typeof BillingAttemptReconciliationWorkflow.payloadSchema.Type;
  userId: UserId;
  reference: WompiTransactionReference;
  amountInCents: number;
  sourceId: WompiSourceId;
}>;

/**
 * Seeds one User-owned armed BillingAttempt with its own local CardPaymentSource so the durable test
 * controls provider facts directly instead of traversing the browser enrollment boundary again.
 */
const seedArmedAttempt = Effect.fn("Test.seedArmedBillingAttempt")(function* (input: {
  index: number;
  transactionId: Option.Option<WompiTransactionId>;
  armedAt: DateTime.Utc;
  createdAt: DateTime.Utc;
}) {
  const userId = userIdFor(input.index);
  yield* seedConsentedPatIdentity({ userId, bearer: bearerFor(input.index) });
  const sql = yield* MigrationSqlClient;
  // The development seed activates paid standing; this fixture proves settlement, not prior access.
  yield* sql`UPDATE subscriptions SET paid_pro_active = false WHERE user_id = ${userId}`;
  const crypto = yield* Crypto.Crypto;
  const enrollmentId = CardEnrollmentId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  const paymentSourceId = CardPaymentSourceId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  const billingAttemptId = BillingAttemptId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  const paymentRequestId = PaymentRequestId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  const reference = WompiTransactionReference.make(
    `fidy-${yield* crypto.randomUUIDv7.pipe(Effect.orDie)}`
  );
  const wompiSourceId = 10_000 + input.index;
  yield* sql`
    INSERT INTO card_payment_sources (id, user_id, wompi_source_id, status, created_at)
    VALUES (${paymentSourceId}, ${userId}, ${wompiSourceId}, 'available', ${input.createdAt})
  `;
  yield* sql`
    INSERT INTO card_enrollments (
      id, user_id, price_id, billing_email, payment_source_mode, status,
      end_user_policy_url, end_user_policy_text, end_user_policy_sha256,
      end_user_policy_provider_hash, personal_auth_url, personal_auth_text,
      personal_auth_sha256, personal_auth_provider_hash, contracts_observed_at,
      disclosure_revision, disclosure_text, disclosure_sha256, prepared_at, expires_at,
      accepted_at, payment_source_id
    ) VALUES (
      ${enrollmentId}, ${userId}, ${monthlyPriceId}, 'reconcile@example.com', 'create', 'available',
      'https://wompi.example/end-user.pdf', 'Acepto el reglamento de Wompi.', ${"0".repeat(64)},
      ${"2".repeat(64)}, 'https://wompi.example/personal-data.pdf',
      'Autorizo el tratamiento de datos personales de Wompi.', ${"1".repeat(64)},
      ${"3".repeat(64)}, ${input.createdAt}, 'wompi-card-enrollment-v1',
      'Autorizo cobros recurrentes de Fidy.', ${"4".repeat(64)},
      ${input.createdAt}, ${DateTime.add(input.createdAt, { hours: 1 })},
      ${input.createdAt}, ${paymentSourceId}
    )
  `;
  const context = yield* withUserTransaction(
    userId,
    getBillingContextInScope(userId, enrollmentId)
  );
  const price = yield* findPrice(monthlyPriceId);
  if (Option.isNone(context) || Option.isNone(price)) {
    return yield* Effect.die("billing fixture context is missing");
  }
  yield* withUserTransaction(
    userId,
    insertPendingBillingAttemptInScope({
      userId,
      billingAttemptId,
      subscriptionId: context.value.subscriptionId,
      paymentRequestId,
      enrollmentId,
      paymentSourceId: context.value.paymentSourceId,
      price: price.value,
      timeZone: context.value.timeZone,
      wompiEnvironment: "sandbox",
      reference,
      createdAt: input.createdAt,
    })
  );
  yield* withUserTransaction(
    userId,
    armBillingAttemptInScope(userId, billingAttemptId, input.armedAt)
  );
  if (Option.isSome(input.transactionId)) {
    yield* withUserTransaction(
      userId,
      recordCreatedWompiTransactionInScope({
        userId,
        billingAttemptId,
        transactionId: input.transactionId.value,
        reference,
      })
    );
  }
  return {
    payload: { userId, billingAttemptId, revision: 1 },
    userId,
    reference,
    amountInCents: yield* amountInCentsForBilling(price.value.money.amount),
    sourceId: context.value.wompiSourceId,
  } satisfies SeededAttempt;
});

const makeProvider = Effect.fn("Test.makeWompiBillingProvider")(function* (input: {
  reference: WompiTransactionReference;
  amountInCents: number;
  sourceId: WompiSourceId;
  statuses: ReadonlyArray<WompiBillingStatus>;
  finalizedAt: DateTime.Utc;
}) {
  const lookups = yield* Ref.make(0);
  const creations = yield* Ref.make(0);
  const provider: WompiBillingClientService = {
    environment: "sandbox",
    createTransaction: ({ reference, amountInCents, currency, sourceId }) =>
      Ref.update(creations, (count) => count + 1).pipe(
        Effect.as({
          transactionId: WompiTransactionId.make(`txn-${reference}`),
          reference,
          status: "PENDING" as const,
          amountInCents,
          currency,
          sourceId,
          finalizedAt: Option.none(),
        })
      ),
    findTransaction: (transactionId) =>
      Effect.gen(function* () {
        const ordinal = yield* Ref.updateAndGet(lookups, (count) => count + 1);
        const status =
          input.statuses[Math.min(ordinal - 1, input.statuses.length - 1)] ?? "PENDING";
        return {
          transactionId,
          reference: input.reference,
          status,
          amountInCents: input.amountInCents,
          currency: "COP",
          sourceId: input.sourceId,
          finalizedAt: status === "APPROVED" ? Option.some(input.finalizedAt) : Option.none(),
        };
      }),
  };
  return { provider, lookups, creations };
});

const acquireRuntime = Effect.fn("Test.acquireBillingRuntime")(function* (
  port: number,
  baseDelay: Duration.Input,
  provider: WompiBillingClientService
) {
  const crypto = yield* Crypto.Crypto;
  const workflowLayer = billingAttemptReconciliationWorkflowLayer(baseDelay).pipe(
    Layer.provideMerge(
      ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(
          authenticatedClusterHttp.layerSql("e".repeat(64), {
            runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
            runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
            availableShardGroups: ["default"],
            assignedShardGroups: ["default"],
            shardsPerGroup: 300,
            entityMessagePollInterval: 50,
            sendRetryInterval: 50,
            runnerHealthCheckInterval: "1 second",
            shardLockRefreshInterval: "500 millis",
            shardLockExpiration: "2 seconds",
          })
        )
      )
    ),
    Layer.provide(Layer.succeed(WompiBillingClient, provider)),
    Layer.provideMerge(Layer.succeed(Crypto.Crypto, crypto)),
    Layer.provideMerge(PgLive)
  );
  const runtime = ManagedRuntime.make(workflowLayer);
  yield* Effect.addFinalizer(() => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie));
  yield* Effect.tryPromise(() => runtime.runPromise(Effect.void));
  return runtime;
});

const attemptStatus = Effect.fn("Test.readBillingAttemptStatus")(function* (
  attempt: SeededAttempt
) {
  const sql = yield* MigrationSqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Struct({ id: BillingAttemptId }),
    Result: Schema.Struct({
      status: Schema.String,
      awaitingReference: Schema.Boolean,
      manualReconciliation: Schema.Boolean,
      hasTransaction: Schema.Boolean,
      periods: Schema.Int,
      paid: Schema.Boolean,
    }),
    execute: ({ id }) => sql`
      SELECT attempt.status,
        attempt.awaiting_reference_since IS NOT NULL AS "awaitingReference",
        attempt.manual_reconciliation_since IS NOT NULL AS "manualReconciliation",
        attempt.wompi_transaction_id IS NOT NULL AS "hasTransaction",
        (SELECT COUNT(*)::int FROM paid_subscription_periods AS period
         WHERE period.billing_attempt_id = attempt.id) AS periods,
        subscription.paid_pro_active AS paid
      FROM billing_attempts AS attempt
      INNER JOIN subscriptions AS subscription ON subscription.id = attempt.subscription_id
      WHERE attempt.id = ${id}
    `,
  })({ id: attempt.payload.billingAttemptId }).pipe(Effect.orDie);
});

const TestLayer = Layer.mergeAll(
  MigrationSqlClient.layer,
  MigratorLive,
  PgLive,
  TestPublicNamespace
).pipe(Layer.provideMerge(BunServices.layer));

layer(TestLayer, { excludeTestServices: true, timeout: "90 seconds" })(
  "durable BillingAttempt reconciliation",
  (it) => {
    it.effect("re-reads an unresolved transaction until verified approval settles it once", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedArmedAttempt({
          index: 1,
          transactionId: Option.some(WompiTransactionId.make("txn-reconcile-1")),
          armedAt: now,
          createdAt: now,
        });
        const { provider, lookups, creations } = yield* makeProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["PENDING", "APPROVED"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
        });
        const runtime = yield* acquireRuntime(24710, "25 millis", provider);
        const result = yield* Effect.tryPromise(() =>
          runtime.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        expect(result).toEqual({ outcome: "succeeded" });
        expect(yield* Ref.get(lookups)).toBeGreaterThanOrEqual(2);
        expect(yield* Ref.get(creations)).toBe(0);
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "succeeded",
          periods: 1,
          paid: true,
        });
      })
    );

    it.effect("settles a verified terminal decline as failed without activating paid Pro", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedArmedAttempt({
          index: 7,
          transactionId: Option.some(WompiTransactionId.make("txn-reconcile-7")),
          armedAt: now,
          createdAt: now,
        });
        const { provider } = yield* makeProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["DECLINED"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
        });
        const runtime = yield* acquireRuntime(24715, "25 millis", provider);
        const result = yield* Effect.tryPromise(() =>
          runtime.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        expect(result).toEqual({ outcome: "failed" });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "failed",
          periods: 0,
          paid: false,
        });
      })
    );

    it.effect("survives runtime loss while waiting and settles without a duplicate period", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedArmedAttempt({
          index: 2,
          transactionId: Option.some(WompiTransactionId.make("txn-reconcile-2")),
          armedAt: now,
          createdAt: now,
        });
        const { provider, lookups, creations } = yield* makeProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["PENDING", "APPROVED"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
        });
        const first = yield* acquireRuntime(24711, "2 seconds", provider);
        yield* Effect.tryPromise(() =>
          first.runPromise(
            BillingAttemptReconciliationWorkflow.execute(attempt.payload, { discard: true })
          )
        );
        const executionId = yield* BillingAttemptReconciliationWorkflow.executionId(
          attempt.payload
        );
        yield* Effect.tryPromise(() =>
          first.runPromise(BillingAttemptReconciliationWorkflow.poll(executionId))
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("20 millis"),
            until: (state) => Option.exists(state, (value) => value._tag === "Suspended"),
          }),
          Effect.timeout("10 seconds")
        );
        yield* Effect.tryPromise(() => first.dispose());

        const second = yield* acquireRuntime(24712, "2 seconds", provider);
        const result = yield* Effect.tryPromise(() =>
          second.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        expect(result).toEqual({ outcome: "succeeded" });
        expect(yield* Ref.get(lookups)).toBe(2);
        expect(yield* Ref.get(creations)).toBe(0);
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "succeeded",
          periods: 1,
          paid: true,
        });
      })
    );

    it.effect("surfaces an armed charge with no provider reference instead of charging again", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedArmedAttempt({
          index: 3,
          transactionId: Option.none(),
          armedAt: now,
          createdAt: now,
        });
        const { provider, lookups, creations } = yield* makeProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["APPROVED"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
        });
        const runtime = yield* acquireRuntime(24713, "25 millis", provider);
        const result = yield* Effect.tryPromise(() =>
          runtime.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        expect(result).toEqual({ outcome: "awaiting-provider-reference" });
        expect(yield* Ref.get(creations)).toBe(0);
        expect(yield* Ref.get(lookups)).toBe(0);
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "pending",
          awaitingReference: true,
          periods: 0,
          paid: false,
        });
      })
    );

    it.effect("escalates a provider outcome unresolved past the tracking age for manual work", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedArmedAttempt({
          index: 4,
          transactionId: Option.some(WompiTransactionId.make("txn-reconcile-4")),
          armedAt: DateTime.subtract(now, { days: 8 }),
          createdAt: DateTime.subtract(now, { days: 8 }),
        });
        const { provider } = yield* makeProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["PENDING"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
        });
        const runtime = yield* acquireRuntime(24714, "25 millis", provider);
        const result = yield* Effect.tryPromise(() =>
          runtime.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        expect(result).toEqual({ outcome: "manual-reconciliation-required" });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "pending",
          manualReconciliation: true,
          periods: 0,
          paid: false,
        });
      })
    );

    it.effect(
      "clears the awaiting-reference marker once an observation reveals the reference",
      () =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const attempt = yield* seedArmedAttempt({
            index: 8,
            transactionId: Option.none(),
            armedAt: now,
            createdAt: now,
          });
          yield* withUserTransaction(
            attempt.userId,
            markBillingAttemptAwaitingReferenceInScope(
              attempt.userId,
              attempt.payload.billingAttemptId,
              now
            )
          );
          expect(yield* attemptStatus(attempt)).toMatchObject({
            status: "pending",
            awaitingReference: true,
            hasTransaction: false,
          });
          yield* reconcileWompiSettlement({
            provider: {
              transactionId: WompiTransactionId.make("txn-reconcile-8"),
              reference: attempt.reference,
              status: "PENDING",
              amountInCents: attempt.amountInCents,
              currency: "COP",
              sourceId: attempt.sourceId,
              finalizedAt: Option.none(),
            },
            environment: "sandbox",
            observedAt: now,
          });
          expect(yield* attemptStatus(attempt)).toMatchObject({
            status: "pending",
            awaitingReference: false,
            hasTransaction: true,
          });
        })
    );

    it.effect("reports bounded cross-User escalation counts and maximum ages", () =>
      Effect.gen(function* () {
        const escalations = yield* getBillingReconciliationEscalations();
        expect(Object.keys(escalations).sort()).toEqual([
          "awaitingReferenceCount",
          "awaitingReferenceMaxAgeSeconds",
          "manualReconciliationCount",
          "manualReconciliationMaxAgeSeconds",
          "providerStalledCount",
          "providerStalledMaxAgeSeconds",
        ]);
        expect(escalations.awaitingReferenceCount).toBeGreaterThanOrEqual(1);
        expect(escalations.manualReconciliationCount).toBeGreaterThanOrEqual(1);
        expect(escalations.awaitingReferenceMaxAgeSeconds).toBeGreaterThanOrEqual(0);
        expect(escalations.manualReconciliationMaxAgeSeconds).toBeGreaterThanOrEqual(0);
      })
    );

    it.effect("does not expose another User's BillingAttempt through User-scoped reads", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedArmedAttempt({
          index: 5,
          transactionId: Option.some(WompiTransactionId.make("txn-reconcile-5")),
          armedAt: now,
          createdAt: now,
        });
        const sql = yield* SqlClient.SqlClient;
        // A direct read under the other User's context bypasses the repository's own user_id filter, so only
        // the billing_attempts_by_user policy can hide the row.
        const rows = yield* withUserTransaction(
          userIdFor(6),
          sql`SELECT id FROM billing_attempts WHERE id = ${attempt.payload.billingAttemptId}`
        );
        expect(rows).toEqual([]);
        const crossUser = yield* withUserTransaction(
          userIdFor(6),
          findBillingAttemptByIdInScope(userIdFor(6), attempt.payload.billingAttemptId)
        );
        expect(Option.isNone(crossUser)).toBe(true);
      })
    );
  }
);
