import { expect, layer } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import {
  Crypto,
  DateTime,
  type Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
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
  WompiSourceId,
} from "~/core/subscription/enrollment-model";
import { PriceId } from "~/core/subscription/reference";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { MigrationSqlClient, MigratorLive, PgLive } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { TestPublicNamespace } from "~/shell/testing/test-config";
import {
  BillingAttemptReconciliationPayload,
  BillingAttemptReconciliationWorkflow,
  billingAttemptReconciliationWorkflowLayer,
} from "./billing-attempt-execution";
import { BillingReconciliationMaintenanceLive } from "./billing-reconciliation-maintenance";
import {
  armBillingAttemptInScope,
  billingAttemptQueueName,
  findBillingAttemptByIdInScope,
  getBillingContextInScope,
  getBillingReconciliationEscalations,
  insertPendingBillingAttemptInScope,
  markBillingAttemptAwaitingReferenceInScope,
  markBillingAttemptManualReconciliationInScope,
  maximumBillingAttemptQueueAttempts,
  pruneBillingAttemptQueueHistory,
  recordBillingTransactionInScope,
  retireExhaustedBillingAttemptWork,
} from "./billing-repo";
import { findPrice } from "./repo";
import {
  WompiBillingClient,
  type WompiBillingClientService,
  type WompiTransaction,
  WompiTransactionCreationFailed,
  WompiTransactionLookupFailed,
} from "./wompi-billing-client";
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
 * controls provider facts directly instead of traversing the browser enrollment boundary again. The
 * `observedAt` parameter lets a test place the first observed provider transaction in the past,
 * which is what puts it beyond Wompi's three-minute retry opportunity.
 */
const seedAttempt = Effect.fn("Test.seedBillingAttempt")(function* (
  input: {
    index: number;
    transactionId: Option.Option<WompiTransactionId>;
    armedAt: DateTime.Utc;
    createdAt: DateTime.Utc;
  },
  arm: boolean = true,
  observedAt: DateTime.Utc = input.armedAt
) {
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
  const amountInCents = yield* amountInCentsForBilling(price.value.money.amount);
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
  if (arm) {
    yield* withUserTransaction(
      userId,
      armBillingAttemptInScope(userId, billingAttemptId, input.armedAt)
    );
    if (Option.isSome(input.transactionId)) {
      yield* withUserTransaction(
        userId,
        recordBillingTransactionInScope(
          {
            userId,
            billingAttemptId,
            transactionId: input.transactionId.value,
            status: "PENDING",
            amountInCents,
            currency: price.value.money.currency,
            wompiSourceId: context.value.wompiSourceId,
            wompiEnvironment: "sandbox",
            finalizedAt: Option.none(),
            observedAt,
          },
          Option.some(reference)
        )
      );
    }
  }
  return {
    payload: { userId, billingAttemptId, revision: 1 },
    userId,
    reference,
    amountInCents,
    sourceId: context.value.wompiSourceId,
  } satisfies SeededAttempt;
});

/** How a test provider departs from a healthy Wompi for the scenario under test. */
type ProviderFault =
  | Readonly<{ _tag: "None" }>
  | Readonly<{ _tag: "Create"; certainty: "rejected" | "ambiguous" }>
  | Readonly<{ _tag: "Lookup" }>
  | Readonly<{ _tag: "Evidence" }>;

const buildProvider = Effect.fn("Test.buildWompiBillingProvider")(function* (input: {
  reference: WompiTransactionReference;
  amountInCents: number;
  sourceId: WompiSourceId;
  statuses: ReadonlyArray<WompiBillingStatus>;
  finalizedAt: DateTime.Utc;
  fault: ProviderFault;
}) {
  const lookups = yield* Ref.make(0);
  const creations = yield* Ref.make(0);
  const provider: WompiBillingClientService = {
    environment: "sandbox",
    createTransaction: ({ reference, amountInCents, currency, sourceId }) =>
      Ref.update(creations, (count) => count + 1).pipe(
        Effect.andThen(
          input.fault._tag === "Create"
            ? Effect.fail(new WompiTransactionCreationFailed({ certainty: input.fault.certainty }))
            : Effect.succeed({
                transactionId: WompiTransactionId.make(`txn-${reference}`),
                reference,
                status: "PENDING" as const,
                amountInCents,
                currency,
                sourceId,
                finalizedAt: Option.none(),
              })
        )
      ),
    findTransaction: (transactionId) =>
      Effect.gen(function* () {
        const ordinal = yield* Ref.updateAndGet(lookups, (count) => count + 1);
        if (input.fault._tag === "Lookup") return yield* new WompiTransactionLookupFailed();
        const status =
          input.statuses[Math.min(ordinal - 1, input.statuses.length - 1)] ?? "PENDING";
        return {
          transactionId,
          reference: input.reference,
          status,
          amountInCents:
            input.fault._tag === "Evidence" ? input.amountInCents + 1 : input.amountInCents,
          currency: "COP",
          sourceId: input.sourceId,
          finalizedAt: status === "APPROVED" ? Option.some(input.finalizedAt) : Option.none(),
        };
      }),
  };
  return { provider, lookups, creations };
});

/** A healthy provider used by most scenarios; faulty scenarios call {@link buildProvider}. */
const makeProvider = (input: {
  reference: WompiTransactionReference;
  amountInCents: number;
  sourceId: WompiSourceId;
  statuses: ReadonlyArray<WompiBillingStatus>;
  finalizedAt: DateTime.Utc;
}): ReturnType<typeof buildProvider> => buildProvider({ ...input, fault: { _tag: "None" } });

/** Builds one authenticated provider fact for one transaction under a seeded attempt. */
const providerTransaction = (
  input: Readonly<{
    attempt: SeededAttempt;
    transactionId: WompiTransactionId;
    status: WompiBillingStatus;
  }>,
  finalizedAt: Option.Option<DateTime.Utc> = Option.none()
): WompiTransaction => ({
  transactionId: input.transactionId,
  reference: input.attempt.reference,
  status: input.status,
  amountInCents: input.attempt.amountInCents,
  currency: "COP",
  sourceId: input.attempt.sourceId,
  finalizedAt,
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
          authenticatedClusterHttp.layerSql(Redacted.make("e".repeat(64)), {
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
      transactions: Schema.Int,
      periods: Schema.Int,
      paid: Schema.Boolean,
    }),
    execute: ({ id }) => sql`
      SELECT attempt.status,
        attempt.awaiting_reference_since IS NOT NULL AS "awaitingReference",
        attempt.manual_reconciliation_since IS NOT NULL AS "manualReconciliation",
        EXISTS (
          SELECT 1 FROM billing_attempt_transactions AS transaction
          WHERE transaction.billing_attempt_id = attempt.id
        ) AS "hasTransaction",
        (SELECT COUNT(*)::int FROM billing_attempt_transactions AS transaction
         WHERE transaction.billing_attempt_id = attempt.id) AS transactions,
        (SELECT COUNT(*)::int FROM paid_subscription_periods AS period
         WHERE period.billing_attempt_id = attempt.id) AS periods,
        subscription.paid_pro_active AS paid
      FROM billing_attempts AS attempt
      INNER JOIN subscriptions AS subscription ON subscription.id = attempt.subscription_id
      WHERE attempt.id = ${id}
    `,
  })({ id: attempt.payload.billingAttemptId }).pipe(Effect.orDie);
});

const attemptTransactions = Effect.fn("Test.readBillingTransactions")(function* (
  attempt: SeededAttempt
) {
  const sql = yield* MigrationSqlClient;
  return yield* SqlSchema.findAll({
    Request: Schema.Struct({ id: BillingAttemptId }),
    Result: Schema.Struct({ transactionId: Schema.String, status: Schema.String }),
    execute: ({ id }) => sql`
      SELECT wompi_transaction_id AS "transactionId", status
      FROM billing_attempt_transactions
      WHERE billing_attempt_id = ${id}
      ORDER BY first_observed_at, wompi_transaction_id
    `,
  })({ id: attempt.payload.billingAttemptId }).pipe(Effect.orDie);
});

/**
 * Offers one identifier-only queue item for a seeded attempt through the production table,
 * so exhaustion tests exercise the same durable identity the worker consumes. Duplicate offers
 * converge on one row via the queue's (id, queue_name) identity.
 */
const offerBillingQueueItem = Effect.fn("Test.offerBillingQueueItem")(function* (
  attempt: SeededAttempt
) {
  const sql = yield* MigrationSqlClient;
  const element = yield* Schema.encodeEffect(
    Schema.fromJsonString(BillingAttemptReconciliationPayload)
  )({
    userId: attempt.userId,
    billingAttemptId: attempt.payload.billingAttemptId,
    revision: 1,
  });
  yield* sql`INSERT INTO fidy_durable.fidy_queue (
      id, queue_name, element, completed, attempts, created_at, updated_at
    ) VALUES (
      ${attempt.payload.billingAttemptId}, ${billingAttemptQueueName}, ${element},
      FALSE, 0, now(), now()
    ) ON CONFLICT (id, queue_name) DO NOTHING`.pipe(Effect.orDie);
});

/** Forces the queue row into the exhausted but incomplete state the retirement must observe. */
const exhaustBillingQueueItem = Effect.fn("Test.exhaustBillingQueueItem")(function* (
  attempt: SeededAttempt
) {
  const sql = yield* MigrationSqlClient;
  yield* sql`UPDATE fidy_durable.fidy_queue SET attempts = ${maximumBillingAttemptQueueAttempts},
    updated_at = now()
    WHERE queue_name = ${billingAttemptQueueName}
      AND id = ${attempt.payload.billingAttemptId}`.pipe(Effect.orDie);
});

const readBillingQueueRow = Effect.fn("Test.readBillingQueueRow")(function* (
  attempt: SeededAttempt
) {
  const sql = yield* MigrationSqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ id: BillingAttemptId }),
    Result: Schema.Struct({
      completed: Schema.Boolean,
      attempts: Schema.Int,
      lastFailure: Schema.NullOr(Schema.String),
    }),
    execute: ({ id }) => sql`SELECT completed, attempts,
        last_failure AS "lastFailure"
      FROM fidy_durable.fidy_queue
      WHERE queue_name = ${billingAttemptQueueName} AND id = ${id}`,
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
    it.effect("builds and runs the escalation maintenance loop", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            BillingReconciliationMaintenanceLive.pipe(Layer.provide(TelemetryDisabled))
          );
          yield* Effect.sleep("500 millis");
        })
      )
    );

    it.effect(
      "returns not-current for an unknown BillingAttempt without calling the provider",
      () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const billingAttemptId = BillingAttemptId.make(
            yield* crypto.randomUUIDv7.pipe(Effect.orDie)
          );
          const { provider, lookups, creations } = yield* makeProvider({
            reference: WompiTransactionReference.make("fidy-00000000-0000-4000-8000-000000000000"),
            amountInCents: 100,
            sourceId: WompiSourceId.make(1),
            statuses: ["PENDING"],
            finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
          });
          const runtime = yield* acquireRuntime(24716, "25 millis", provider);
          const result = yield* Effect.tryPromise(() =>
            runtime.runPromise(
              BillingAttemptReconciliationWorkflow.execute({
                userId: userIdFor(9),
                billingAttemptId,
                revision: 1,
              })
            )
          );
          expect(result).toEqual({ outcome: "not-current" });
          expect(yield* Ref.get(lookups)).toBe(0);
          expect(yield* Ref.get(creations)).toBe(0);
        })
    );

    it.effect("re-reads an unresolved transaction until verified approval settles it once", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
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
        const attempt = yield* seedAttempt(
          {
            index: 7,
            transactionId: Option.some(WompiTransactionId.make("txn-reconcile-7")),
            armedAt: now,
            createdAt: now,
          },
          true,
          DateTime.subtract(now, { minutes: 4 })
        );
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

    it.effect("keeps a declined transaction pending inside the Wompi retry opportunity", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
          index: 20,
          transactionId: Option.some(WompiTransactionId.make("txn-reconcile-20")),
          armedAt: now,
          createdAt: now,
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction({
            attempt,
            transactionId: WompiTransactionId.make("txn-reconcile-20"),
            status: "DECLINED",
          }),
          environment: "sandbox",
          observedAt: now,
        });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "pending",
          transactions: 1,
          periods: 0,
          paid: false,
        });
      })
    );

    it.effect("settles a definitively rejected creation as failed", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt(
          {
            index: 16,
            transactionId: Option.none(),
            armedAt: now,
            createdAt: now,
          },
          false
        );
        const { provider, creations } = yield* buildProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["PENDING"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
          fault: { _tag: "Create", certainty: "rejected" },
        });
        const runtime = yield* acquireRuntime(24720, "25 millis", provider);
        const result = yield* Effect.tryPromise(() =>
          runtime.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        expect(result).toEqual({ outcome: "failed" });
        expect(yield* Ref.get(creations)).toBe(1);
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "failed",
          awaitingReference: false,
          hasTransaction: false,
          periods: 0,
          paid: false,
        });
      })
    );

    it.effect("records awaiting-reference when the first charge response is lost", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt(
          {
            index: 10,
            transactionId: Option.none(),
            armedAt: now,
            createdAt: now,
          },
          false
        );
        const { provider, creations } = yield* buildProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["PENDING"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
          fault: { _tag: "Create", certainty: "ambiguous" },
        });
        const runtime = yield* acquireRuntime(24717, "25 millis", provider);
        const result = yield* Effect.tryPromise(() =>
          runtime.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        expect(result).toEqual({ outcome: "awaiting-provider-reference" });
        expect(yield* Ref.get(creations)).toBe(1);
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "pending",
          awaitingReference: true,
          hasTransaction: false,
        });
      })
    );

    it.effect("survives runtime loss while waiting and settles without a duplicate period", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
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

    it.effect("keeps a twenty-minute-old armed charge with no provider reference pending", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
          index: 3,
          transactionId: Option.none(),
          armedAt: DateTime.subtract(now, { minutes: 25 }),
          createdAt: DateTime.subtract(now, { minutes: 25 }),
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
        // The expired link does not stop the later verified transaction that reveals the reference.
        yield* reconcileWompiSettlement({
          provider: providerTransaction(
            {
              attempt,
              transactionId: WompiTransactionId.make("txn-reconcile-3"),
              status: "APPROVED",
            },
            Option.some(DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"))
          ),
          environment: "sandbox",
          observedAt: now,
        });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "succeeded",
          awaitingReference: false,
          periods: 1,
          paid: true,
        });
      })
    );

    it.effect("escalates a provider outcome unresolved past the tracking age for manual work", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
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

    it.effect("keeps tracking when a provider lookup fails instead of settling", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
          index: 11,
          transactionId: Option.some(WompiTransactionId.make("txn-reconcile-11")),
          armedAt: DateTime.subtract(now, { days: 8 }),
          createdAt: DateTime.subtract(now, { days: 8 }),
        });
        const { provider, lookups } = yield* buildProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["PENDING"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
          fault: { _tag: "Lookup" },
        });
        const runtime = yield* acquireRuntime(24718, "25 millis", provider);
        const result = yield* Effect.tryPromise(() =>
          runtime.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        expect(result).toEqual({ outcome: "manual-reconciliation-required" });
        expect(yield* Ref.get(lookups)).toBe(1);
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "pending",
          manualReconciliation: true,
          periods: 0,
          paid: false,
        });
      })
    );

    it.effect("never settles from mismatched provider evidence", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
          index: 12,
          transactionId: Option.some(WompiTransactionId.make("txn-reconcile-12")),
          armedAt: DateTime.subtract(now, { days: 8 }),
          createdAt: DateTime.subtract(now, { days: 8 }),
        });
        const { provider } = yield* buildProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["APPROVED"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
          fault: { _tag: "Evidence" },
        });
        const runtime = yield* acquireRuntime(24719, "25 millis", provider);
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
          const attempt = yield* seedAttempt({
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
            provider: providerTransaction({
              attempt,
              transactionId: WompiTransactionId.make("txn-reconcile-8"),
              status: "PENDING",
            }),
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

    it.effect("approves once after a retry transaction under the same reference", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const first = WompiTransactionId.make("txn-retry-a");
        const retry = WompiTransactionId.make("txn-retry-b");
        const attempt = yield* seedAttempt({
          index: 21,
          transactionId: Option.some(first),
          armedAt: now,
          createdAt: now,
        });
        const t0 = now;
        yield* reconcileWompiSettlement({
          provider: providerTransaction({ attempt, transactionId: first, status: "DECLINED" }),
          environment: "sandbox",
          observedAt: t0,
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction({ attempt, transactionId: retry, status: "PENDING" }),
          environment: "sandbox",
          observedAt: DateTime.add(t0, { seconds: 30 }),
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction(
            { attempt, transactionId: retry, status: "APPROVED" },
            Option.some(DateTime.add(t0, { seconds: 45 }))
          ),
          environment: "sandbox",
          observedAt: DateTime.add(t0, { minutes: 1 }),
        });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "succeeded",
          transactions: 2,
          periods: 1,
          paid: true,
        });
        expect(yield* attemptTransactions(attempt)).toEqual([
          { transactionId: first, status: "DECLINED" },
          { transactionId: retry, status: "APPROVED" },
        ]);
      })
    );

    it.effect("keeps a declined transaction pending while another transaction is unresolved", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const declined = WompiTransactionId.make("txn-unresolved-a");
        const unresolved = WompiTransactionId.make("txn-unresolved-b");
        const attempt = yield* seedAttempt({
          index: 22,
          transactionId: Option.some(declined),
          armedAt: now,
          createdAt: now,
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction({ attempt, transactionId: declined, status: "DECLINED" }),
          environment: "sandbox",
          observedAt: now,
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction({ attempt, transactionId: unresolved, status: "PENDING" }),
          environment: "sandbox",
          observedAt: DateTime.add(now, { minutes: 4 }),
        });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "pending",
          transactions: 2,
          periods: 0,
          paid: false,
        });
      })
    );

    it.effect("recovers a failed aggregate when a later transaction is approved", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const declined = WompiTransactionId.make("txn-late-a");
        const recovered = WompiTransactionId.make("txn-late-b");
        const attempt = yield* seedAttempt({
          index: 23,
          transactionId: Option.some(declined),
          armedAt: now,
          createdAt: now,
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction({ attempt, transactionId: declined, status: "DECLINED" }),
          environment: "sandbox",
          observedAt: now,
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction({ attempt, transactionId: declined, status: "DECLINED" }),
          environment: "sandbox",
          observedAt: DateTime.add(now, { minutes: 4 }),
        });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "failed",
          periods: 0,
          paid: false,
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction(
            { attempt, transactionId: recovered, status: "APPROVED" },
            Option.some(DateTime.add(now, { minutes: 4, seconds: 30 }))
          ),
          environment: "sandbox",
          observedAt: DateTime.add(now, { minutes: 5 }),
        });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "succeeded",
          transactions: 2,
          periods: 1,
          paid: true,
        });
      })
    );

    it.effect("stays succeeded under duplicate and out-of-order retry evidence", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const declined = WompiTransactionId.make("txn-out-of-order-a");
        const approved = WompiTransactionId.make("txn-out-of-order-b");
        const attempt = yield* seedAttempt({
          index: 24,
          transactionId: Option.some(declined),
          armedAt: now,
          createdAt: now,
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction(
            { attempt, transactionId: approved, status: "APPROVED" },
            Option.some(DateTime.add(now, { seconds: 45 }))
          ),
          environment: "sandbox",
          observedAt: DateTime.add(now, { minutes: 1 }),
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction({ attempt, transactionId: declined, status: "DECLINED" }),
          environment: "sandbox",
          observedAt: DateTime.add(now, { minutes: 2 }),
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction(
            { attempt, transactionId: approved, status: "APPROVED" },
            Option.some(DateTime.add(now, { seconds: 45 }))
          ),
          environment: "sandbox",
          observedAt: DateTime.add(now, { minutes: 3 }),
        });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "succeeded",
          transactions: 2,
          periods: 1,
          paid: true,
        });
        expect(yield* attemptTransactions(attempt)).toEqual([
          { transactionId: declined, status: "DECLINED" },
          { transactionId: approved, status: "APPROVED" },
        ]);
      })
    );

    it.effect("rejects a retry transaction whose evidence does not match", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
          index: 25,
          transactionId: Option.some(WompiTransactionId.make("txn-mismatch-a")),
          armedAt: now,
          createdAt: now,
        });
        const mismatched = {
          ...providerTransaction(
            {
              attempt,
              transactionId: WompiTransactionId.make("txn-mismatch-b"),
              status: "APPROVED",
            },
            Option.some(now)
          ),
          amountInCents: attempt.amountInCents + 1,
        };
        const failure = yield* Effect.flip(
          reconcileWompiSettlement({
            provider: mismatched,
            environment: "sandbox",
            observedAt: now,
          })
        );
        expect(failure._tag).toBe("MismatchedWompiEvidence");
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "pending",
          transactions: 1,
          periods: 0,
          paid: false,
        });
      })
    );

    it.effect("reports per-bucket escalation deltas and maximum ages", () =>
      Effect.gen(function* () {
        const before = yield* getBillingReconciliationEscalations();
        const now = yield* DateTime.now;
        const awaiting = yield* seedAttempt({
          index: 13,
          transactionId: Option.none(),
          armedAt: now,
          createdAt: now,
        });
        yield* withUserTransaction(
          awaiting.userId,
          markBillingAttemptAwaitingReferenceInScope(
            awaiting.userId,
            awaiting.payload.billingAttemptId,
            DateTime.subtract(now, { hours: 26 })
          )
        );
        yield* seedAttempt({
          index: 14,
          transactionId: Option.some(WompiTransactionId.make("txn-probe-stalled")),
          armedAt: DateTime.subtract(now, { hours: 25 }),
          createdAt: DateTime.subtract(now, { hours: 25 }),
        });
        const manual = yield* seedAttempt({
          index: 15,
          transactionId: Option.some(WompiTransactionId.make("txn-probe-manual")),
          armedAt: DateTime.subtract(now, { hours: 25 }),
          createdAt: DateTime.subtract(now, { hours: 25 }),
        });
        yield* withUserTransaction(
          manual.userId,
          markBillingAttemptManualReconciliationInScope(
            manual.userId,
            manual.payload.billingAttemptId,
            DateTime.subtract(now, { hours: 1 })
          )
        );
        const after = yield* getBillingReconciliationEscalations();
        expect(after.awaitingReferenceCount - before.awaitingReferenceCount).toBe(1);
        expect(after.awaitingReferenceMaxAgeSeconds).toBeGreaterThanOrEqual(26 * 60 * 60);
        expect(after.providerStalledCount - before.providerStalledCount).toBe(1);
        expect(after.providerStalledMaxAgeSeconds).toBeGreaterThanOrEqual(25 * 60 * 60);
        expect(after.manualReconciliationCount - before.manualReconciliationCount).toBe(1);
        expect(after.manualReconciliationMaxAgeSeconds).toBeGreaterThanOrEqual(60 * 60);
      })
    );

    it.effect("does not expose another User's BillingAttempt through User-scoped access", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
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
        const childRows = yield* withUserTransaction(
          userIdFor(6),
          sql`SELECT wompi_transaction_id FROM billing_attempt_transactions
              WHERE billing_attempt_id = ${attempt.payload.billingAttemptId}`
        );
        expect(childRows).toEqual([]);
        // The runtime role holds INSERT and column-scoped UPDATE here, so only the child table's
        // WITH CHECK can stop a writer from attributing a transaction to another User.
        const forgedInsert = yield* Effect.exit(
          withUserTransaction(
            userIdFor(6),
            sql`INSERT INTO billing_attempt_transactions (
                billing_attempt_id, user_id, wompi_transaction_id, status, amount_in_cents,
                currency, wompi_source_id, wompi_environment, first_observed_at, last_observed_at
              ) VALUES (
                ${attempt.payload.billingAttemptId}, ${attempt.userId},
                'txn-cross-user-forged', 'PENDING', ${attempt.amountInCents}, 'COP',
                ${attempt.sourceId}, 'sandbox', ${now}, ${now}
              )`
          )
        );
        expect(Exit.isFailure(forgedInsert)).toBe(true);
        const crossUserUpdate = yield* withUserTransaction(
          userIdFor(6),
          sql`UPDATE billing_attempt_transactions SET last_observed_at = ${now}
              WHERE billing_attempt_id = ${attempt.payload.billingAttemptId} RETURNING 1 AS touched`
        );
        expect(crossUserUpdate).toEqual([]);
        const forgedRows = yield* withUserTransaction(
          attempt.userId,
          sql`SELECT wompi_transaction_id FROM billing_attempt_transactions
              WHERE wompi_transaction_id = 'txn-cross-user-forged'`
        );
        expect(forgedRows).toEqual([]);
        const crossUser = yield* withUserTransaction(
          userIdFor(6),
          findBillingAttemptByIdInScope(userIdFor(6), attempt.payload.billingAttemptId)
        );
        expect(Option.isNone(crossUser)).toBe(true);
      })
    );

    it.effect("retires a pending armed attempt through exhaustion without failing it", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
          index: 30,
          transactionId: Option.some(WompiTransactionId.make("txn-exhaust-30")),
          armedAt: DateTime.subtract(now, { days: 8 }),
          createdAt: DateTime.subtract(now, { days: 8 }),
        });
        yield* offerBillingQueueItem(attempt);
        yield* exhaustBillingQueueItem(attempt);
        const before = yield* getBillingReconciliationEscalations();
        const retired = yield* retireExhaustedBillingAttemptWork(now);
        expect(retired).toBeGreaterThanOrEqual(1);
        // Exhaustion keeps pending status and records manual evidence instead of definitive failure.
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "pending",
          manualReconciliation: true,
          periods: 0,
          paid: false,
        });
        const queue = yield* readBillingQueueRow(attempt);
        expect(Option.isSome(queue)).toBe(true);
        if (Option.isSome(queue)) {
          expect(queue.value.completed).toBe(true);
          expect(queue.value.lastFailure).toBe("exhausted");
        }
        const after = yield* getBillingReconciliationEscalations();
        expect(after.manualReconciliationCount - before.manualReconciliationCount).toBe(1);
        // A second retirement observes no incomplete exhausted work, so it stays idempotent.
        expect(yield* retireExhaustedBillingAttemptWork(now)).toBe(0);
        // A replayed workflow never submits a second provider charge for the armed attempt.
        const { provider, creations } = yield* makeProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["PENDING"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
        });
        const runtime = yield* acquireRuntime(24730, "25 millis", provider);
        const result = yield* Effect.tryPromise(() =>
          runtime.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        expect(result).toEqual({ outcome: "manual-reconciliation-required" });
        expect(yield* Ref.get(creations)).toBe(0);
      })
    );

    it.effect("retires a queued never-armed attempt without submitting a charge", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt(
          {
            index: 31,
            transactionId: Option.none(),
            armedAt: now,
            createdAt: now,
          },
          false
        );
        yield* offerBillingQueueItem(attempt);
        yield* exhaustBillingQueueItem(attempt);
        const retired = yield* retireExhaustedBillingAttemptWork(now);
        expect(retired).toBeGreaterThanOrEqual(1);
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "pending",
          manualReconciliation: true,
          hasTransaction: false,
        });
        const stored = yield* withUserTransaction(
          attempt.userId,
          findBillingAttemptByIdInScope(attempt.userId, attempt.payload.billingAttemptId)
        );
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          // The attempt was never armed, so no provider mutation could have been sent.
          expect(stored.value.chargeState).toBe("queued");
        }
      })
    );

    it.effect("retires exhausted work without calling the provider", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
          index: 32,
          transactionId: Option.some(WompiTransactionId.make("txn-exhaust-32")),
          armedAt: DateTime.subtract(now, { hours: 2 }),
          createdAt: DateTime.subtract(now, { hours: 2 }),
        });
        yield* offerBillingQueueItem(attempt);
        yield* exhaustBillingQueueItem(attempt);
        const { lookups, creations } = yield* buildProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["PENDING"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
          fault: { _tag: "Lookup" },
        });
        // Retirement reads owner state and never performs provider lookups or creations.
        const retired = yield* retireExhaustedBillingAttemptWork(now);
        expect(retired).toBeGreaterThanOrEqual(1);
        expect(yield* Ref.get(lookups)).toBe(0);
        expect(yield* Ref.get(creations)).toBe(0);
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "pending",
          manualReconciliation: true,
        });
      })
    );

    it.effect("keeps late authenticated success admissible after exhaustion", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
          index: 33,
          transactionId: Option.some(WompiTransactionId.make("txn-exhaust-33")),
          armedAt: now,
          createdAt: now,
        });
        yield* offerBillingQueueItem(attempt);
        yield* exhaustBillingQueueItem(attempt);
        yield* retireExhaustedBillingAttemptWork(now);
        expect(yield* attemptStatus(attempt)).toMatchObject({ status: "pending" });
        yield* reconcileWompiSettlement({
          provider: providerTransaction(
            {
              attempt,
              transactionId: WompiTransactionId.make("txn-exhaust-33"),
              status: "APPROVED",
            },
            Option.some(DateTime.add(now, { minutes: 1 }))
          ),
          environment: "sandbox",
          observedAt: DateTime.add(now, { minutes: 1 }),
        });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "succeeded",
          manualReconciliation: false,
          periods: 1,
          paid: true,
        });
      })
    );

    it.effect("keeps late authenticated failure admissible after exhaustion", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt(
          {
            index: 34,
            transactionId: Option.some(WompiTransactionId.make("txn-exhaust-34")),
            armedAt: now,
            createdAt: now,
          },
          true,
          DateTime.subtract(now, { minutes: 10 })
        );
        yield* offerBillingQueueItem(attempt);
        yield* exhaustBillingQueueItem(attempt);
        yield* retireExhaustedBillingAttemptWork(now);
        yield* reconcileWompiSettlement({
          provider: providerTransaction({
            attempt,
            transactionId: WompiTransactionId.make("txn-exhaust-34"),
            status: "DECLINED",
          }),
          environment: "sandbox",
          observedAt: now,
        });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "failed",
          manualReconciliation: false,
          periods: 0,
          paid: false,
        });
      })
    );

    it.effect("converges duplicate queue deliveries on one attempt without a second charge", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
          index: 35,
          transactionId: Option.some(WompiTransactionId.make("txn-exhaust-35")),
          armedAt: now,
          createdAt: now,
        });
        yield* offerBillingQueueItem(attempt);
        // A redelivered queue item shares the BillingAttempt identity, so the second offer is ignored.
        yield* offerBillingQueueItem(attempt);
        const sql = yield* MigrationSqlClient;
        const rows = yield* sql`SELECT count(*)::int AS count FROM fidy_durable.fidy_queue
          WHERE queue_name = ${billingAttemptQueueName}
            AND id = ${attempt.payload.billingAttemptId}`.pipe(Effect.orDie);
        expect(rows).toEqual([{ count: 1 }]);
        const { provider, creations } = yield* makeProvider({
          reference: attempt.reference,
          amountInCents: attempt.amountInCents,
          sourceId: attempt.sourceId,
          statuses: ["PENDING", "APPROVED"],
          finalizedAt: DateTime.makeUnsafe("2026-03-01T12:00:00.000Z"),
        });
        const runtime = yield* acquireRuntime(24731, "25 millis", provider);
        const first = yield* Effect.tryPromise(() =>
          runtime.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        const second = yield* Effect.tryPromise(() =>
          runtime.runPromise(BillingAttemptReconciliationWorkflow.execute(attempt.payload))
        );
        expect(first).toEqual({ outcome: "succeeded" });
        expect(second).toEqual({ outcome: "succeeded" });
        // The attempt was already armed, so neither delivery re-sent the provider mutation.
        expect(yield* Ref.get(creations)).toBe(0);
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "succeeded",
          periods: 1,
          paid: true,
        });
      })
    );

    it.effect("retains malformed exhausted work for inspection without domain writes", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const sql = yield* MigrationSqlClient;
        const malformedId = BillingAttemptId.make("47700000-0000-4000-8000-000000000031");
        yield* sql`INSERT INTO fidy_durable.fidy_queue (
            id, queue_name, element, completed, attempts, created_at, updated_at
          ) VALUES (
            ${malformedId}, ${billingAttemptQueueName}, 'not-json',
            FALSE, ${maximumBillingAttemptQueueAttempts}, now(), now()
          ) ON CONFLICT (id, queue_name) DO NOTHING`.pipe(Effect.orDie);
        const retired = yield* retireExhaustedBillingAttemptWork(now);
        expect(retired).toBe(0);
        const row = yield* SqlSchema.findOneOption({
          Request: Schema.Void,
          Result: Schema.Struct({
            completed: Schema.Boolean,
            lastFailure: Schema.NullOr(Schema.String),
          }),
          execute: () => sql`SELECT completed,
              last_failure AS "lastFailure"
            FROM fidy_durable.fidy_queue
            WHERE queue_name = ${billingAttemptQueueName} AND id = ${malformedId}`,
        })(undefined).pipe(Effect.orDie);
        expect(Option.isSome(row)).toBe(true);
        if (Option.isSome(row)) {
          // Malformed work stays incomplete for inspection with only a bounded marker.
          expect(row.value.completed).toBe(false);
          expect(row.value.lastFailure).toBe("schema_incompatible");
        }
        yield* sql`DELETE FROM fidy_durable.fidy_queue
          WHERE queue_name = ${billingAttemptQueueName} AND id = ${malformedId}`.pipe(Effect.orDie);
      })
    );

    it.effect("prunes completed queue history only after the attempt is terminal", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const succeeded = yield* seedAttempt({
          index: 36,
          transactionId: Option.some(WompiTransactionId.make("txn-exhaust-36")),
          armedAt: now,
          createdAt: now,
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction(
            {
              attempt: succeeded,
              transactionId: WompiTransactionId.make("txn-exhaust-36"),
              status: "APPROVED",
            },
            Option.some(now)
          ),
          environment: "sandbox",
          observedAt: now,
        });
        expect(yield* attemptStatus(succeeded)).toMatchObject({ status: "succeeded" });
        const pending = yield* seedAttempt({
          index: 37,
          transactionId: Option.some(WompiTransactionId.make("txn-exhaust-37")),
          armedAt: now,
          createdAt: now,
        });
        yield* offerBillingQueueItem(succeeded);
        yield* offerBillingQueueItem(pending);
        const sql = yield* MigrationSqlClient;
        const old = DateTime.subtract(now, { hours: 25 });
        yield* sql`UPDATE fidy_durable.fidy_queue SET completed = TRUE, updated_at = ${old}
          WHERE queue_name = ${billingAttemptQueueName}
            AND id IN ${sql.in([
              succeeded.payload.billingAttemptId,
              pending.payload.billingAttemptId,
            ])}`.pipe(Effect.orDie);
        const pruned = yield* pruneBillingAttemptQueueHistory(now);
        expect(pruned).toBeGreaterThanOrEqual(1);
        const remaining = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: Schema.Struct({ id: Schema.String }),
          execute: () => sql`SELECT id FROM fidy_durable.fidy_queue
            WHERE queue_name = ${billingAttemptQueueName}
              AND id IN ${sql.in([
                succeeded.payload.billingAttemptId,
                pending.payload.billingAttemptId,
              ])}`,
        })(undefined).pipe(Effect.orDie);
        const remainingIds = remaining.map((row) => row.id);
        // Terminal history is removed while pending submission history is retained for review.
        expect(remainingIds).not.toContain(succeeded.payload.billingAttemptId);
        expect(remainingIds).toContain(pending.payload.billingAttemptId);
      })
    );

    it.effect("retires exhausted work for an already settled attempt without a domain write", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const attempt = yield* seedAttempt({
          index: 38,
          transactionId: Option.some(WompiTransactionId.make("txn-exhaust-38")),
          armedAt: now,
          createdAt: now,
        });
        yield* reconcileWompiSettlement({
          provider: providerTransaction(
            {
              attempt,
              transactionId: WompiTransactionId.make("txn-exhaust-38"),
              status: "APPROVED",
            },
            Option.some(now)
          ),
          environment: "sandbox",
          observedAt: now,
        });
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "succeeded",
          manualReconciliation: false,
        });
        yield* offerBillingQueueItem(attempt);
        yield* exhaustBillingQueueItem(attempt);
        const retired = yield* retireExhaustedBillingAttemptWork(now);
        expect(retired).toBe(1);
        // A settled attempt needs no manual evidence; retirement only completes the queue row.
        expect(yield* attemptStatus(attempt)).toMatchObject({
          status: "succeeded",
          manualReconciliation: false,
          periods: 1,
          paid: true,
        });
        const queue = yield* readBillingQueueRow(attempt);
        expect(Option.isSome(queue)).toBe(true);
        if (Option.isSome(queue)) {
          expect(queue.value.completed).toBe(true);
          expect(queue.value.lastFailure).toBe("exhausted");
        }
      })
    );

    it.effect("retires exhausted work for a missing attempt without a domain write", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const sql = yield* MigrationSqlClient;
        const missingUserId = userIdFor(90);
        const missingAttemptId = BillingAttemptId.make("47700000-0000-4000-8000-000000000090");
        const element = yield* Schema.encodeEffect(
          Schema.fromJsonString(BillingAttemptReconciliationPayload)
        )({ userId: missingUserId, billingAttemptId: missingAttemptId, revision: 1 });
        yield* sql`INSERT INTO fidy_durable.fidy_queue (
            id, queue_name, element, completed, attempts, created_at, updated_at
          ) VALUES (
            ${missingAttemptId}, ${billingAttemptQueueName}, ${element},
            FALSE, ${maximumBillingAttemptQueueAttempts}, now(), now()
          ) ON CONFLICT (id, queue_name) DO NOTHING`.pipe(Effect.orDie);
        const retired = yield* retireExhaustedBillingAttemptWork(now);
        expect(retired).toBe(1);
        const row = yield* SqlSchema.findOneOption({
          Request: Schema.Void,
          Result: Schema.Struct({
            completed: Schema.Boolean,
            lastFailure: Schema.NullOr(Schema.String),
          }),
          execute: () => sql`SELECT completed,
              last_failure AS "lastFailure"
            FROM fidy_durable.fidy_queue
            WHERE queue_name = ${billingAttemptQueueName} AND id = ${missingAttemptId}`,
        })(undefined).pipe(Effect.orDie);
        expect(Option.isSome(row)).toBe(true);
        if (Option.isSome(row)) {
          expect(row.value.completed).toBe(true);
          expect(row.value.lastFailure).toBe("exhausted");
        }
        yield* sql`DELETE FROM fidy_durable.fidy_queue
          WHERE queue_name = ${billingAttemptQueueName} AND id = ${missingAttemptId}`.pipe(
          Effect.orDie
        );
      })
    );

    it.effect("prunes completed queue history for a missing attempt", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const sql = yield* MigrationSqlClient;
        const missingUserId = userIdFor(91);
        const missingAttemptId = BillingAttemptId.make("47700000-0000-4000-8000-000000000091");
        const element = yield* Schema.encodeEffect(
          Schema.fromJsonString(BillingAttemptReconciliationPayload)
        )({ userId: missingUserId, billingAttemptId: missingAttemptId, revision: 1 });
        const old = DateTime.subtract(now, { hours: 25 });
        yield* sql`INSERT INTO fidy_durable.fidy_queue (
            id, queue_name, element, completed, attempts, created_at, updated_at
          ) VALUES (
            ${missingAttemptId}, ${billingAttemptQueueName}, ${element},
            TRUE, ${maximumBillingAttemptQueueAttempts}, ${old}, ${old}
          ) ON CONFLICT (id, queue_name) DO UPDATE SET
            completed = TRUE, updated_at = ${old}`.pipe(Effect.orDie);
        const pruned = yield* pruneBillingAttemptQueueHistory(now);
        expect(pruned).toBe(1);
        const remaining = yield* SqlSchema.findOneOption({
          Request: Schema.Void,
          Result: Schema.Struct({ id: Schema.String }),
          execute: () => sql`SELECT id FROM fidy_durable.fidy_queue
            WHERE queue_name = ${billingAttemptQueueName} AND id = ${missingAttemptId}`,
        })(undefined).pipe(Effect.orDie);
        expect(Option.isNone(remaining)).toBe(true);
      })
    );

    it.effect("retains malformed completed queue history for inspection", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const sql = yield* MigrationSqlClient;
        const malformedHistoryId = BillingAttemptId.make("47700000-0000-4000-8000-000000000092");
        const old = DateTime.subtract(now, { hours: 25 });
        yield* sql`INSERT INTO fidy_durable.fidy_queue (
            id, queue_name, element, completed, attempts, created_at, updated_at
          ) VALUES (
            ${malformedHistoryId}, ${billingAttemptQueueName}, 'not-json',
            TRUE, ${maximumBillingAttemptQueueAttempts}, ${old}, ${old}
          ) ON CONFLICT (id, queue_name) DO UPDATE SET
            element = 'not-json', completed = TRUE, updated_at = ${old}`.pipe(Effect.orDie);
        const pruned = yield* pruneBillingAttemptQueueHistory(now);
        expect(pruned).toBe(0);
        const row = yield* SqlSchema.findOneOption({
          Request: Schema.Void,
          Result: Schema.Struct({ completed: Schema.Boolean }),
          execute: () => sql`SELECT completed FROM fidy_durable.fidy_queue
            WHERE queue_name = ${billingAttemptQueueName} AND id = ${malformedHistoryId}`,
        })(undefined).pipe(Effect.orDie);
        expect(Option.isSome(row)).toBe(true);
        if (Option.isSome(row)) {
          expect(row.value.completed).toBe(true);
        }
        yield* sql`DELETE FROM fidy_durable.fidy_queue
          WHERE queue_name = ${billingAttemptQueueName} AND id = ${malformedHistoryId}`.pipe(
          Effect.orDie
        );
      })
    );
  }
);
