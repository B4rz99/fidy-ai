import { type DateTime, Effect, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { SqlClient } from "effect/unstable/sql";
import { Workflow } from "effect/unstable/workflow";
import {
  EmailDeliveryIntentId,
  EmailReplacementWorkflowId,
} from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";

/** Persisted routing facts only; an intent identifier never grants another User's authority. */
export const ReplacementDeliveryPayload = Schema.Struct({
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  userId: UserId,
  intentId: EmailDeliveryIntentId,
}).annotate({ identifier: "ReplacementDeliveryPayload" });
export type ReplacementDeliveryPayload = typeof ReplacementDeliveryPayload.Type;

/** Original replacement identity; resends do not create or extend its expiry execution. */
export const ReplacementExpiryPayload = Schema.Struct({
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  userId: UserId,
  workflowId: EmailReplacementWorkflowId,
}).annotate({ identifier: "ReplacementExpiryPayload" });
export type ReplacementExpiryPayload = typeof ReplacementExpiryPayload.Type;

/** Safe delivery outcomes; provider errors and proofs never enter execution history. */
export const ReplacementDeliveryResult = Schema.Literals([
  "sent",
  "rejected",
  "uncertain",
  "not-current",
]);
export const ReplacementAttemptResult = Schema.Literals([
  "sent",
  "rejected",
  "uncertain",
  "not-current",
  "retry",
]);
export type ReplacementAttemptResult = typeof ReplacementAttemptResult.Type;

/** One logical delivery execution for one admitted generation, including bounded rejected retries. */
export const ReplacementDeliveryWorkflow = Workflow.make("EmailReplacementDelivery", {
  payload: ReplacementDeliveryPayload,
  success: ReplacementDeliveryResult,
  idempotencyKey: ({ intentId }) => intentId,
});
/** Expiry continues independently of delivery success or failure. */
export const ReplacementExpiryWorkflow = Workflow.make("EmailReplacementExpiry", {
  payload: ReplacementExpiryPayload,
  success: Schema.Void,
  idempotencyKey: ({ workflowId }) => workflowId,
});

export const replacementDeliveryQueueName = "email-replacement-delivery";
export const replacementExpiryQueueName = "email-replacement-expiry";

export const replacementDeliveryQueue = PersistedQueue.make({
  name: replacementDeliveryQueueName,
  schema: ReplacementDeliveryPayload,
});
export const replacementExpiryQueue = PersistedQueue.make({
  name: replacementExpiryQueueName,
  schema: ReplacementExpiryPayload,
});

/** Publishes accepted work in the caller's SQL transaction, preserving receipts after domain cleanup. */
export const publishReplacementDelivery = Effect.fn("EmailReplacement.publish")(function* (
  payload: ReplacementDeliveryPayload,
  expiresAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO email_replacement_executions (id, user_id, kind, expires_at)
    VALUES (${payload.intentId}, ${payload.userId}, 'delivery', ${expiresAt}) ON CONFLICT DO NOTHING`.pipe(
    Effect.orDie
  );
  const queue = yield* replacementDeliveryQueue;
  yield* queue.offer(payload, { id: payload.intentId }).pipe(Effect.orDie);
});

/** Transaction-composable expiry publication, once per original replacement workflow. */
export const publishReplacementExpiry = Effect.fn("EmailReplacement.publishExpiry")(function* (
  payload: ReplacementExpiryPayload,
  expiresAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO email_replacement_executions (id, user_id, kind, expires_at)
    VALUES (${payload.workflowId}, ${payload.userId}, 'expiry', ${expiresAt}) ON CONFLICT DO NOTHING`.pipe(
    Effect.orDie
  );
  const queue = yield* replacementExpiryQueue;
  yield* queue.offer(payload, { id: payload.workflowId }).pipe(Effect.orDie);
});
