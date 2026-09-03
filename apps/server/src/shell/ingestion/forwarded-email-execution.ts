import { Crypto, Effect, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { Workflow } from "effect/unstable/workflow";
import { UserId } from "~/core/identity/reference";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";

/** Identifier-only request retained for one accepted provider receipt. */
export const ForwardedEmailWorkflowPayload = Schema.Struct({
  userId: UserId,
  receivedEmailId: ResendReceivedEmailId,
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
}).annotate({ identifier: "ForwardedEmailWorkflowPayload" });
export type ForwardedEmailWorkflowPayload = typeof ForwardedEmailWorkflowPayload.Type;

/** Terminal workflow result; User-owned details remain in the owning domain tables. */
export const ForwardedEmailWorkflowSuccess = Schema.Struct({
  outcome: Schema.Literals(["completed", "revoked", "expired", "stale"]),
}).annotate({ identifier: "ForwardedEmailWorkflowSuccess" });

/** Durable protocol for one authenticated and accepted Resend receipt. */
export const ForwardedEmailWorkflow = Workflow.make("ForwardedEmailIngestion", {
  payload: ForwardedEmailWorkflowPayload,
  success: ForwardedEmailWorkflowSuccess,
  idempotencyKey: ({ receivedEmailId, userId }) => `${userId}:${receivedEmailId}`,
});

/** Stable Effect queue identity for admitted Forwarded Email Ingestion Work. */
export const forwardedEmailQueueName = "forwarded-email-ingestion";
const hexadecimalRadix = 16;
const durableQueueIdentityLength = 36;

/** Identifier-only durable handoff decoded before any User-scoped execution. */
export const forwardedEmailWorkflowQueue = PersistedQueue.make({
  name: forwardedEmailQueueName,
  schema: ForwardedEmailWorkflowPayload,
});

/** Derives the bounded queue identity from both untrusted routing identifiers. */
export const forwardedEmailQueueId = Effect.fn("ForwardedEmail.queueId")(function* (
  payload: ForwardedEmailWorkflowPayload
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(`${payload.userId}:${payload.receivedEmailId}`)
  );
  return Array.from(digest, (byte) => byte.toString(hexadecimalRadix).padStart(2, "0"))
    .join("")
    .slice(0, durableQueueIdentityLength);
});

/** Transaction-composable publication; duplicate receipts converge on one workflow start. */
export const publishForwardedEmailWorkflow = Effect.fn("ForwardedEmail.publish")(function* (
  userId: UserId,
  receivedEmailId: ResendReceivedEmailId
) {
  const queue = yield* forwardedEmailWorkflowQueue;
  const payload = { userId, receivedEmailId, revision: 1 as const };
  yield* queue.offer(payload, { id: yield* forwardedEmailQueueId(payload) }).pipe(Effect.orDie);
});
