import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Crypto, DateTime, Effect, Exit, Layer, Option, Schedule, Schema } from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
import { PersistedQueue } from "effect/unstable/persistence";
import { DurableClock, WorkflowEngine } from "effect/unstable/workflow";
import { PendingConsentExchangeId } from "~/core/consent/model";
import { MigrationSqlClient, MigratorLive, PgLive } from "~/shell/db/client";
import {
  ConsentDisclosureWorkflowLive,
  startNextConsentDisclosure,
  startNextConsentDisclosureEvidence,
} from "./disclosure-delivery";
import { DisclosureDeliveryAttemptId } from "./disclosure-model";
import { pruneConsentDisclosureDelivery } from "./disclosure-retention";
import { findExpiredConsentDisclosureRequests } from "./disclosure-store";
import {
  ConsentDisclosureWorkflow,
  consentDisclosureEvidenceQueue,
  disclosureEvidenceQueueId,
} from "./disclosure-workflow";
import { KapsoClient } from "./kapso-client";

const RetentionHarness = ConsentDisclosureWorkflowLive.pipe(
  Layer.provideMerge(
    ClusterWorkflowEngine.layer.pipe(
      Layer.provideMerge(
        SingleRunner.layer({
          runnerStorage: "memory",
          shardingConfig: {
            entityMessagePollInterval: 25,
            sendRetryInterval: 25,
            entityTerminationTimeout: 100,
          },
        })
      )
    )
  ),
  Layer.provideMerge(
    PersistedQueue.layer.pipe(
      Layer.provideMerge(PersistedQueue.layerStoreSql({ tableName: "fidy_queue" }))
    )
  ),
  Layer.provide(
    Layer.succeed(KapsoClient, {
      sendText: () => Effect.die("expired disclosure invoked provider"),
    })
  ),
  Layer.provideMerge(PgLive),
  Layer.provideMerge(MigrationSqlClient.layer),
  Layer.provide(MigratorLive),
  Layer.provideMerge(BunServices.layer)
);

const orphanedRequest = Effect.fn("Test.orphanedDisclosureRequest")(function* () {
  const crypto = yield* Crypto.Crypto;
  const exchangeId = PendingConsentExchangeId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const now = yield* DateTime.now;
  const admin = yield* MigrationSqlClient;
  yield* admin`INSERT INTO whatsapp_consent_disclosure_requests(exchange_id, expires_at, business_phone_number_id)
    VALUES (${exchangeId}, ${DateTime.toDateUtc(DateTime.subtract(now, { hours: 1 }))}, '123456789012345')`;
  return { exchangeId, revision: 1 as const };
});

const awaitTerminal = Effect.fn("Test.awaitTerminalDisclosure")(function* (
  payload: typeof ConsentDisclosureWorkflow.payloadSchema.Type
) {
  const executionId = yield* ConsentDisclosureWorkflow.executionId(payload);
  yield* ConsentDisclosureWorkflow.poll(executionId).pipe(
    Effect.filterOrFail((result) => Option.isSome(result) && result.value._tag === "Complete"),
    Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 }),
    Effect.orDie
  );
  return executionId;
});

const retained = Effect.fn("Test.retainedDisclosureRequest")(function* (
  exchangeId: PendingConsentExchangeId
) {
  return (yield* findExpiredConsentDisclosureRequests(yield* DateTime.now)).includes(exchangeId);
});

const awaitPruned = Effect.fn("Test.awaitPrunedDisclosure")(function* (
  exchangeId: PendingConsentExchangeId
) {
  yield* Effect.gen(function* () {
    yield* pruneConsentDisclosureDelivery(yield* DateTime.now);
    return yield* retained(exchangeId);
  }).pipe(
    Effect.filterOrFail((exists) => !exists),
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }),
    Effect.orDie
  );
});

layer(RetentionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "WhatsApp disclosure retention",
  (it) => {
    it.effect(
      "publishes an orphaned request without execution and removes it only after native completion",
      () =>
        Effect.gen(function* () {
          const payload = yield* orphanedRequest();
          yield* pruneConsentDisclosureDelivery(yield* DateTime.now);
          expect(yield* retained(payload.exchangeId)).toBe(true);
          yield* startNextConsentDisclosure();
          const executionId = yield* awaitTerminal(payload);
          yield* awaitPruned(payload.exchangeId);
          expect(Option.isNone(yield* ConsentDisclosureWorkflow.poll(executionId))).toBe(true);
          const admin = yield* MigrationSqlClient;
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ count: Schema.Int }))
          )(
            yield* admin`SELECT count(*)::int AS count FROM fidy_durable.fidy_queue WHERE id = ${payload.exchangeId}`
          );
          expect(rows).toEqual([{ count: 0 }]);
        })
    );

    it.effect(
      "retains completed execution while evidence or a native clock can still publish a wake",
      () =>
        Effect.gen(function* () {
          const payload = yield* orphanedRequest();
          yield* pruneConsentDisclosureDelivery(yield* DateTime.now);
          yield* startNextConsentDisclosure();
          const executionId = yield* awaitTerminal(payload);
          const crypto = yield* Crypto.Crypto;
          const evidence = {
            ...payload,
            attemptId: DisclosureDeliveryAttemptId.make(
              yield* crypto.randomUUIDv4.pipe(Effect.orDie)
            ),
            evidenceRevision: 0,
          };
          const queue = yield* consentDisclosureEvidenceQueue;
          yield* queue
            .offer(evidence, { id: disclosureEvidenceQueueId(evidence) })
            .pipe(Effect.orDie);
          yield* pruneConsentDisclosureDelivery(yield* DateTime.now);
          expect(yield* retained(payload.exchangeId)).toBe(true);
          const engine = yield* WorkflowEngine.WorkflowEngine;
          yield* engine.scheduleClock(ConsentDisclosureWorkflow, {
            executionId,
            clock: DurableClock.make({ name: "Expiry", duration: "2 seconds" }),
          });
          yield* startNextConsentDisclosureEvidence();
          yield* pruneConsentDisclosureDelivery(yield* DateTime.now);
          expect(yield* retained(payload.exchangeId)).toBe(true);
          yield* awaitPruned(payload.exchangeId);
          const admin = yield* MigrationSqlClient;
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ count: Schema.Int }))
          )(
            yield* admin`SELECT count(*)::int AS count FROM fidy_durable.cluster_messages WHERE entity_id = ${executionId}`
          );
          expect(rows).toEqual([{ count: 0 }]);
          yield* Effect.sleep("100 millis");
          expect(Option.isNone(yield* ConsentDisclosureWorkflow.poll(executionId))).toBe(true);
        })
    );
    it.effect("rolls back queue and mailbox erasure if private request deletion fails", () =>
      Effect.gen(function* () {
        const payload = yield* orphanedRequest();
        yield* pruneConsentDisclosureDelivery(yield* DateTime.now);
        yield* startNextConsentDisclosure();
        const executionId = yield* awaitTerminal(payload);
        const admin = yield* MigrationSqlClient;
        yield* admin`
        CREATE FUNCTION test_reject_disclosure_retention() RETURNS trigger LANGUAGE plpgsql AS \$body\$
        BEGIN RAISE EXCEPTION 'retention fixture rejects deletion'; END
        \$body\$;
        CREATE TRIGGER test_reject_disclosure_retention BEFORE DELETE ON whatsapp_consent_disclosure_requests
        FOR EACH ROW EXECUTE FUNCTION test_reject_disclosure_retention()
      `;
        yield* Effect.addFinalizer(() =>
          admin`
        DROP TRIGGER test_reject_disclosure_retention ON whatsapp_consent_disclosure_requests;
        DROP FUNCTION test_reject_disclosure_retention()
      `.pipe(Effect.orDie)
        );
        const result = yield* Effect.exit(pruneConsentDisclosureDelivery(yield* DateTime.now));
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* retained(payload.exchangeId)).toBe(true);
        const polled = yield* ConsentDisclosureWorkflow.poll(executionId);
        expect(Option.isSome(polled) && polled.value._tag === "Complete").toBe(true);
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ completed: Schema.Boolean }))
        )(
          yield* admin`SELECT completed FROM fidy_durable.fidy_queue WHERE queue_name = 'whatsapp-consent-disclosure' AND id = ${payload.exchangeId}`
        );
        expect(rows).toEqual([{ completed: true }]);
      })
    );
  }
);
