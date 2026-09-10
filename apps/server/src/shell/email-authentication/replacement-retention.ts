import { Data, DateTime, Effect, Layer, Option, Ref, Schema } from "effect";
import {
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  Sharding,
} from "effect/unstable/cluster";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  EmailDeliveryIntentId,
  EmailReplacementWorkflowId,
} from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";
import { withSubjectLock } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { durableQueueRetention } from "~/shell/durable-execution-retention";
import { runBestEffortMaintenance } from "~/shell/maintenance-schedule";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import {
  ReplacementDeliveryWorkflow,
  type ReplacementExpiryPayload,
  ReplacementExpiryWorkflow,
  replacementDeliveryQueueName,
  replacementExpiryQueueName,
} from "./replacement-protocol";

/** Reads only the named User's original deadline; a routing identifier is not authority. */
export const findReplacementExpiry = Effect.fn("EmailReplacementRetention.findExpiry")(function* (
  payload: ReplacementExpiryPayload
) {
  return yield* withUserTransaction(
    payload.userId,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: Schema.Struct({ expiresAt: Schema.DateTimeUtcFromDate }),
        execute: () => sql`SELECT expires_at AS "expiresAt" FROM email_replacement_workflows
        WHERE id = ${payload.workflowId} AND user_id = ${payload.userId}`,
      })(undefined).pipe(Effect.orDie);
    })
  );
});

/** Deletes only this User's exact expired replacement, atomically against completion and resend. */
export const expireReplacement = Effect.fn("EmailReplacementRetention.expire")(function* (
  payload: ReplacementExpiryPayload
) {
  return yield* withUserTransaction(
    payload.userId,
    withSubjectLock(
      payload.userId,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const deleted = yield* sql`DELETE FROM email_replacement_workflows
      WHERE id = ${payload.workflowId} AND user_id = ${payload.userId} AND expires_at <= ${now}
      RETURNING id`.pipe(Effect.orDie);
        return deleted.length === 1;
      })
    )
  );
});

const ExecutionReceipt = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  userId: UserId,
  kind: Schema.Literals(["delivery", "expiry"]),
  terminalObserved: Schema.Boolean,
});
type ExecutionReceipt = typeof ExecutionReceipt.Type;

const findExecutionState = Effect.fn(function* (receipt: ExecutionReceipt) {
  if (receipt.kind === "delivery") {
    const executionId = yield* ReplacementDeliveryWorkflow.executionId({
      userId: receipt.userId,
      intentId: EmailDeliveryIntentId.make(receipt.id),
      revision: 1,
    }).pipe(Effect.orDie);
    const result = yield* ReplacementDeliveryWorkflow.poll(executionId);
    return {
      executionId,
      complete: Option.exists(result, (state) => state._tag === "Complete"),
      queueName: replacementDeliveryQueueName,
      workflowName: `Workflow/${ReplacementDeliveryWorkflow._tag}`,
    };
  }
  const executionId = yield* ReplacementExpiryWorkflow.executionId({
    userId: receipt.userId,
    workflowId: EmailReplacementWorkflowId.make(receipt.id),
    revision: 1,
  }).pipe(Effect.orDie);
  const result = yield* ReplacementExpiryWorkflow.poll(executionId);
  return {
    executionId,
    complete: Option.exists(result, (state) => state._tag === "Complete"),
    queueName: replacementExpiryQueueName,
    workflowName: `Workflow/${ReplacementExpiryWorkflow._tag}`,
  };
});

const removeExecutionReceipt = Effect.fn(function* (receipt: ExecutionReceipt, now: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* findExecutionState(receipt);
  if (!state.complete && !receipt.terminalObserved) return false;
  if (!(yield* durableQueueRetention.completed(state.queueName, [receipt.id], [receipt.id]))) {
    return false;
  }
  if (
    receipt.kind === "expiry" &&
    Option.isSome(
      yield* findReplacementExpiry({
        userId: receipt.userId,
        workflowId: EmailReplacementWorkflowId.make(receipt.id),
        revision: 1,
      })
    )
  ) {
    return false;
  }
  // Persist terminal evidence before clearing history so interrupted GC can finish without guessing.
  yield* withUserTransaction(
    receipt.userId,
    sql`UPDATE email_replacement_executions
    SET terminal_observed = TRUE WHERE id = ${receipt.id} AND user_id = ${receipt.userId}`.pipe(
      Effect.orDie
    )
  );
  const storage = yield* MessageStorage.MessageStorage;
  const sharding = yield* Sharding.Sharding;
  const entityId = EntityId.make(state.executionId);
  yield* storage
    .clearAddress(
      EntityAddress.make({
        entityId,
        entityType: EntityType.make(state.workflowName),
        shardId: sharding.getShardId(entityId, "default"),
      })
    )
    .pipe(Effect.orDie);
  yield* withUserTransaction(
    receipt.userId,
    Effect.gen(function* () {
      yield* durableQueueRetention.removeCompleted(state.queueName, [receipt.id]);
      yield* sql`DELETE FROM email_replacement_executions WHERE id = ${receipt.id}
      AND user_id = ${receipt.userId} AND expires_at <= ${now}`.pipe(Effect.orDie);
    })
  );
  return true;
});

/**
 * Collects expired identifier-only receipts after publication and execution are terminal. Receipts
 * survive domain cleanup; each deletion activates explicit User scope. Clearing terminal addresses
 * is idempotent, and expired domain work cannot send even if submitted after deduplication is removed.
 */
export const removeExpiredReplacementExecutions = Effect.fn("EmailReplacementRetention.executions")(
  function* (afterId: Option.Option<string> = Option.none<string>()) {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    let overdue = 0;
    const page = SqlSchema.findAll({
      Request: Schema.Option(ExecutionReceipt.fields.id),
      Result: ExecutionReceipt,
      execute: (
        cursor
      ) => sql`SELECT id, user_id AS "userId", kind, terminal_observed AS "terminalObserved"
        FROM fidy_expired_email_replacement_executions(${now}, ${Option.getOrNull(cursor)}::uuid)`,
    });
    const receipts: ReadonlyArray<ExecutionReceipt> = yield* page(afterId).pipe(Effect.orDie);
    let nextCursor = Option.none<string>();
    for (const receipt of receipts) {
      if (!(yield* removeExecutionReceipt(receipt, now))) overdue++;
      nextCursor = Option.some(receipt.id);
    }
    return { overdue, nextCursor: receipts.length < 100 ? Option.none<string>() : nextCursor };
  }
);

/** Owner operation for lifecycle evidence; rows exactly at the cutoff remain retained. */
export const removeReplacementLifecycleEventsBefore = Effect.fn(function* (cutoff: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`SELECT fidy_delete_verified_email_lifecycle_events_before(${cutoff}) AS deleted_count`;
});

class ReplacementRetentionOverdue extends Data.TaggedError("ReplacementRetentionOverdue")<{
  readonly count: number;
}> {}

/** Overdue state and failures reach the existing scheduled-Work alert boundary, without identifiers. */
export const EmailReplacementRetentionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    // Discovery progress only: restart may rescan a page, never forget a retained execution.
    const cursor = yield* Ref.make(Option.none<string>());
    const work = Effect.gen(function* () {
      const batch = yield* removeExpiredReplacementExecutions(yield* Ref.get(cursor));
      yield* Ref.set(cursor, batch.nextCursor);
      if (batch.overdue > 0) {
        return yield* new ReplacementRetentionOverdue({ count: batch.overdue });
      }
    }).pipe(
      runScheduledWork({
        component: "api",
        schedule: "task.emailAuthenticationRetention",
        operationalError: "operational_failure",
      }),
      Effect.ignoreCause
    );
    yield* runBestEffortMaintenance({
      timing: "best-effort",
      cadence: "1 minute",
      work,
    }).pipe(Effect.forkScoped);
  })
);
