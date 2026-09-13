import { Context, type DateTime, Effect, Option } from "effect";
import {
  ClusterSchema,
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  Sharding,
} from "effect/unstable/cluster";
import {
  durableQueueRetention,
  durableWorkflowMailboxesTerminal,
} from "~/shell/durable-execution-retention";
import {
  findExpiredConsentDisclosureRequests,
  isConsentDisclosureRequestExpired,
  lockConsentDisclosure,
  removeConsentDisclosureRequest,
} from "./disclosure-store";
import {
  ConsentDisclosureWorkflow,
  consentDisclosureEvidenceQueueName,
  consentDisclosureQueue,
  consentDisclosureQueueName,
} from "./disclosure-workflow";

const workflowEntityType = `Workflow/${ConsentDisclosureWorkflow._tag}`;
// Effect RC.112 addresses clocks by execution id under this shared entity type, not the workflow type.
const clockEntityType = "Workflow/-/DurableClock";

const clearMailboxes = Effect.fn("WhatsApp.clearDisclosureMailboxes")(function* (
  executionId: string
) {
  const storage = yield* MessageStorage.MessageStorage;
  const sharding = yield* Sharding.Sharding;
  const entityId = EntityId.make(executionId);
  const shardGroup = Context.get(
    ConsentDisclosureWorkflow.annotations,
    ClusterSchema.ShardGroup
  )(entityId);
  const shardId = sharding.getShardId(entityId, shardGroup);
  for (const entityType of [clockEntityType, workflowEntityType]) {
    yield* storage
      .clearAddress(
        EntityAddress.make({ entityId, entityType: EntityType.make(entityType), shardId })
      )
      .pipe(Effect.orDie);
  }
});

/**
 * Prunes at most 100 expired/orphaned requests per pass, only after native execution, handoff,
 * evidence notification, and clock mailboxes are terminal. Missing execution is republished for
 * terminal evaluation and retained until a later pass. No provider work or remote notification
 * runs in the short cleanup transaction. Completed evidence is removed in pages of 100 per request;
 * retained request identity fences callbacks until both native mailbox addresses can be erased.
 */
export const pruneConsentDisclosureDelivery = Effect.fn("WhatsApp.pruneDisclosureDelivery")(
  function* (now: DateTime.Utc) {
    const candidates = yield* findExpiredConsentDisclosureRequests(now);
    const queue = yield* consentDisclosureQueue;
    for (const exchangeId of candidates) {
      yield* lockConsentDisclosure(
        exchangeId,
        Effect.gen(function* () {
          if (!(yield* isConsentDisclosureRequestExpired(exchangeId, now))) return;
          // This also repairs a migrated request with no queue item. Its identity is stable and
          // an existing completed publication is untouched by the native duplicate-offer contract.
          yield* queue.offer({ exchangeId, revision: 1 }, { id: exchangeId }).pipe(Effect.orDie);
          const executionId = yield* ConsentDisclosureWorkflow.executionId({
            exchangeId,
            revision: 1,
          }).pipe(Effect.orDie);
          const result = yield* ConsentDisclosureWorkflow.poll(executionId);
          if (Option.isNone(result) || result.value._tag !== "Complete") return;
          if (
            !(yield* durableQueueRetention.completed(
              consentDisclosureQueueName,
              [exchangeId],
              [exchangeId]
            ))
          ) {
            return;
          }
          const evidenceEmpty = yield* durableQueueRetention.removeCompletedByPayload(
            consentDisclosureEvidenceQueueName,
            "exchangeId",
            exchangeId
          );
          if (!evidenceEmpty) return;
          if (
            !(yield* durableWorkflowMailboxesTerminal(executionId, [
              workflowEntityType,
              clockEntityType,
            ]))
          ) {
            return;
          }
          yield* clearMailboxes(executionId);
          yield* durableQueueRetention.removeCompleted(consentDisclosureQueueName, [exchangeId]);
          yield* removeConsentDisclosureRequest(exchangeId);
        })
      );
    }
  }
);
