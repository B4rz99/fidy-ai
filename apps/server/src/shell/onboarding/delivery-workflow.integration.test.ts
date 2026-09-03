import assert from "node:assert/strict";
import { expect, layer } from "@effect/vitest";
import {
  Cause,
  type Config,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Schema,
} from "effect";
import {
  ClusterWorkflowEngine,
  type MessageStorage,
  RunnerAddress,
  type Runners,
  type Sharding,
} from "effect/unstable/cluster";
import type { HttpServerError } from "effect/unstable/http";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import type { WorkflowEngine } from "effect/unstable/workflow";
import type { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import { EmailDeliveryIntentId } from "~/core/email-authentication/model";
import { E164PhoneNumber } from "~/core/identity/reference";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import {
  EmailDeliveryPort,
  type EmailDeliveryPortService,
  EmailSendFailed,
} from "~/shell/email-authentication/delivery";
import { ApiHarness } from "~/shell/testing/api-harness";
import { deliverConsentDisclosureForTesting } from "~/shell/testing/consent-disclosure";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import {
  OnboardingDeliveryFailed,
  OnboardingEmailDeliveryWorkflow,
  OnboardingEmailDeliveryWorkflowLive,
} from "./delivery-workflow";
import { type OnboardingTurn, handleOnboardingTurn } from "./onboarding";

const caller = testWhatsAppCaller(E164PhoneNumber.make("+573009993325"));
const AvailabilityRows = Schema.Array(Schema.Struct({ available: Schema.Boolean }));
const IntentIdRows = Schema.Array(Schema.Struct({ id: Schema.String }));
const IntentStatusRows = Schema.Array(Schema.Struct({ status: Schema.String }));
const increment = (value: number): number => value + 1;
const normalizeDeliveryExit = (
  exit: Exit.Exit<unknown, OnboardingDeliveryFailed>
): Exit.Exit<unknown, unknown> =>
  Exit.match(exit, {
    onFailure: (cause) => Exit.fail(Cause.squash(cause)),
    onSuccess: Exit.succeed,
  });
const retryTwiceThenSucceed = (calls: Ref.Ref<number>): EmailDeliveryPortService =>
  EmailDeliveryPort.of({
    send: () =>
      Ref.getAndUpdate(calls, increment).pipe(
        Effect.flatMap((attempt) =>
          attempt < 2
            ? new EmailSendFailed({ certainty: "rejected", retryable: true })
            : Effect.void
        )
      ),
  });
const rejectRetryably = (calls: Ref.Ref<number>): EmailDeliveryPortService =>
  EmailDeliveryPort.of({
    send: () =>
      Ref.update(calls, increment).pipe(
        Effect.andThen(new EmailSendFailed({ certainty: "rejected", retryable: true }))
      ),
  });
const message = (providerMessageId: string): ProviderMessageEvidence => ({
  channel: "whatsapp",
  provider: "kapso",
  providerMessageId,
});
const turn = (
  text: string,
  providerMessageId: string,
  receivedAt: DateTime.Utc
): OnboardingTurn => ({
  caller,
  content: { _tag: "Text", text },
  message: message(providerMessageId),
  receivedAt,
});

const cleanup = Effect.fn("testCleanupClusterOnboarding")(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const [queueTable] = yield* Schema.decodeUnknownEffect(AvailabilityRows)(
        yield* sql`SELECT to_regclass('fidy_durable.fidy_queue') IS NOT NULL AS available`
      );
      if (queueTable?.available === true) {
        yield* sql`
          DELETE FROM fidy_durable.fidy_queue
          WHERE queue_name = 'onboarding-email-delivery' AND id::uuid IN (
            SELECT intent.id FROM email_delivery_intents AS intent
            JOIN email_enrollments AS enrollment ON enrollment.id = intent.enrollment_id
            WHERE enrollment.business_portfolio_id = ${caller.businessPortfolioId}
              AND enrollment.business_scoped_user_id = ${caller.businessScopedUserId}
          )
        `;
      }
      yield* sql`
        DELETE FROM email_enrollments
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}
      `;
      yield* sql`
        DELETE FROM pending_consent_exchanges
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}
      `;
      yield* sql`DELETE FROM email_delivery_admission_budgets`;
    })
  );
});

const admitDelivery = Effect.fn("testAdmitClusterOnboardingDelivery")(function* (
  email: string,
  evidencePrefix: string
) {
  yield* cleanup();
  const acceptedAt = yield* DateTime.now;
  const disclosure = yield* handleOnboardingTurn(
    turn("Quiero empezar", `${evidencePrefix}-start`, acceptedAt)
  );
  if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("expected disclosure");
  yield* deliverConsentDisclosureForTesting({
    exchangeId: disclosure.exchangeId,
    message: message(`${evidencePrefix}-disclosure`),
    deliveredAt: DateTime.add(acceptedAt, { seconds: 1 }),
  });
  yield* handleOnboardingTurn(
    turn("Acepto", `${evidencePrefix}-accept`, DateTime.add(acceptedAt, { seconds: 2 }))
  );
  yield* handleOnboardingTurn(
    turn(email, `${evidencePrefix}-email`, DateTime.add(acceptedAt, { seconds: 3 }))
  );
  const sql = yield* SqlClient.SqlClient;
  const [intent] = yield* Schema.decodeUnknownEffect(IntentIdRows)(
    yield* sql`SELECT intent.id::text AS id FROM email_delivery_intents AS intent
      JOIN email_enrollments AS enrollment ON enrollment.id = intent.enrollment_id
      WHERE enrollment.business_portfolio_id = ${caller.businessPortfolioId}
        AND enrollment.business_scoped_user_id = ${caller.businessScopedUserId}
      ORDER BY intent.created_at DESC LIMIT 1`
  );
  if (intent === undefined) return yield* Effect.die("expected delivery intent");
  return EmailDeliveryIntentId.make(intent.id);
});

const token = "c".repeat(64);
const makeRuntimeLayer = (
  crypto: Crypto.Crypto,
  port: number,
  deliveryPort: EmailDeliveryPortService
): Layer.Layer<
  | MessageStorage.MessageStorage
  | Runners.Runners
  | Sharding.Sharding
  | WorkflowEngine.WorkflowEngine,
  Config.ConfigError | HttpServerError.ServeError | SqlError.SqlError
> => {
  const cluster = authenticatedClusterHttp.layerSql(token, {
    runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
    runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
    availableShardGroups: ["default"],
    assignedShardGroups: ["default"],
    shardsPerGroup: 300,
    entityMessagePollInterval: 100,
    sendRetryInterval: 100,
  });
  return OnboardingEmailDeliveryWorkflowLive.pipe(
    Layer.provideMerge(ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(cluster))),
    Layer.provide(Layer.succeed(EmailDeliveryPort, deliveryPort)),
    Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
    Layer.provide(PgLive)
  );
};

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "SQL Cluster onboarding delivery",
  (it) => {
    it.effect(
      "coordinates one Activity across two independent runtimes",
      () =>
        Effect.gen(function* () {
          const intentId = yield* admitDelivery("cluster-once@example.com", "wamid.cluster-once");
          const sql = yield* SqlClient.SqlClient;
          const crypto = yield* Crypto.Crypto;
          const calls = yield* Ref.make(0);
          const deliveryPort = EmailDeliveryPort.of({
            send: () =>
              Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Effect.sleep(200))),
          });
          const runtimeA = ManagedRuntime.make(makeRuntimeLayer(crypto, 44601, deliveryPort));
          const runtimeB = ManagedRuntime.make(makeRuntimeLayer(crypto, 44602, deliveryPort));
          yield* Effect.promise(() => runtimeA.runPromise(Effect.void));
          yield* Effect.promise(() => runtimeB.runPromise(Effect.void));
          yield* Effect.tryPromise(() =>
            Promise.all([
              runtimeA.runPromise(
                OnboardingEmailDeliveryWorkflow.execute({ intentId, revision: 1 })
              ),
              runtimeB.runPromise(
                OnboardingEmailDeliveryWorkflow.execute({ intentId, revision: 1 })
              ),
            ])
          );
          expect(yield* Ref.get(calls)).toBe(1);
          expect(
            yield* Schema.decodeUnknownEffect(IntentStatusRows)(
              yield* sql`SELECT status FROM email_delivery_intents WHERE id = ${intentId}`
            )
          ).toEqual([{ status: "sent" }]);
          yield* Effect.promise(() => Promise.all([runtimeA.dispose(), runtimeB.dispose()]));
          yield* cleanup();
        }),
      30_000
    );

    it.effect(
      "retries definitively rejected provider attempts inside the Activity",
      () =>
        Effect.gen(function* () {
          const intentId = yield* admitDelivery("cluster-retry@example.com", "wamid.cluster-retry");
          const sql = yield* SqlClient.SqlClient;
          const crypto = yield* Crypto.Crypto;
          const calls = yield* Ref.make(0);
          const runtime = ManagedRuntime.make(
            makeRuntimeLayer(crypto, 44605, retryTwiceThenSucceed(calls))
          );
          yield* Effect.promise(() => runtime.runPromise(Effect.void));
          yield* Effect.promise(() =>
            runtime.runPromise(OnboardingEmailDeliveryWorkflow.execute({ intentId, revision: 1 }))
          );
          expect(yield* Ref.get(calls)).toBe(3);
          expect(
            yield* Schema.decodeUnknownEffect(IntentStatusRows)(
              yield* sql`SELECT status FROM email_delivery_intents WHERE id = ${intentId}`
            )
          ).toEqual([{ status: "sent" }]);
          yield* Effect.promise(() => runtime.dispose());
          yield* cleanup();
        }),
      30_000
    );

    it.effect(
      "preserves an exhausted retryable rejection in the workflow Exit",
      () =>
        Effect.gen(function* () {
          const intentId = yield* admitDelivery(
            "cluster-exhausted@example.com",
            "wamid.cluster-exhausted"
          );
          const crypto = yield* Crypto.Crypto;
          const calls = yield* Ref.make(0);
          const runtime = ManagedRuntime.make(
            makeRuntimeLayer(crypto, 44606, rejectRetryably(calls))
          );
          yield* Effect.promise(() => runtime.runPromise(Effect.void));
          const exit = yield* Effect.promise(() =>
            runtime.runPromise(
              OnboardingEmailDeliveryWorkflow.execute({ intentId, revision: 1 }).pipe(Effect.exit)
            )
          );
          assert.deepStrictEqual(
            normalizeDeliveryExit(exit),
            Exit.fail(OnboardingDeliveryFailed.make({ outcome: "rejected" }))
          );
          expect(yield* Ref.get(calls)).toBe(3);
          yield* Effect.promise(() => runtime.dispose());
          yield* cleanup();
        }),
      30_000
    );

    it.effect(
      "recovers an interrupted provider boundary as uncertain",
      () =>
        Effect.gen(function* () {
          const intentId = yield* admitDelivery(
            "cluster-recovery@example.com",
            "wamid.cluster-recovery"
          );
          const sql = yield* SqlClient.SqlClient;
          const crypto = yield* Crypto.Crypto;
          const calls = yield* Ref.make(0);
          const started = yield* Deferred.make<void>();
          const runtimeA = ManagedRuntime.make(
            makeRuntimeLayer(
              crypto,
              44603,
              EmailDeliveryPort.of({
                send: () =>
                  Ref.update(calls, (count) => count + 1).pipe(
                    Effect.andThen(Deferred.succeed(started, undefined)),
                    Effect.andThen(Effect.never)
                  ),
              })
            )
          );
          yield* Effect.promise(() => runtimeA.runPromise(Effect.void));
          const first = runtimeA
            .runPromise(OnboardingEmailDeliveryWorkflow.execute({ intentId, revision: 1 }))
            .catch(() => undefined);
          yield* Deferred.await(started);
          yield* Effect.promise(() => runtimeA.dispose());
          yield* Effect.promise(() => first);

          const runtimeB = ManagedRuntime.make(
            makeRuntimeLayer(
              crypto,
              44604,
              EmailDeliveryPort.of({ send: () => Ref.update(calls, (count) => count + 1) })
            )
          );
          yield* Effect.promise(() => runtimeB.runPromise(Effect.void));
          const recoveredExit = yield* Effect.promise(() =>
            runtimeB.runPromise(
              OnboardingEmailDeliveryWorkflow.execute({ intentId, revision: 1 }).pipe(Effect.exit)
            )
          );
          assert.deepStrictEqual(
            normalizeDeliveryExit(recoveredExit),
            Exit.fail(OnboardingDeliveryFailed.make({ outcome: "uncertain" }))
          );
          expect(yield* Ref.get(calls)).toBe(1);
          expect(
            yield* Schema.decodeUnknownEffect(IntentStatusRows)(
              yield* sql`SELECT status FROM email_delivery_intents WHERE id = ${intentId}`
            )
          ).toEqual([{ status: "uncertain" }]);
          yield* Effect.promise(() => runtimeB.dispose());
          yield* cleanup();
        }),
      30_000
    );
  }
);
