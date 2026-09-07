import { Effect, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { Workflow } from "effect/unstable/workflow";
import {
  BrowserPairingEmailStartRequestId,
  BrowserPairingEmailWorkflowId,
  EmailDeliveryIntentId,
} from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";

/** Only the admitted request identity crosses the pre-subject durable boundary. */
export const PairingStartPayload = Schema.Struct({
  revision: Schema.Literal(1),
  requestId: BrowserPairingEmailStartRequestId,
});
export const pairingStartQueue = PersistedQueue.make({
  name: "browser-pairing-email-start",
  schema: PairingStartPayload,
});

/** Explicit User context is checked against the intent under RLS, never inferred from its id. */
export const PairingDeliveryPayload = Schema.Struct({
  revision: Schema.Literal(1),
  userId: UserId,
  intentId: EmailDeliveryIntentId,
});
export type PairingDeliveryPayload = typeof PairingDeliveryPayload.Type;
export const PairingDeliveryResult = Schema.Struct({
  outcome: Schema.Literals([
    "sent",
    "not-current",
    "expired",
    "refused",
    "retry-exhausted",
    "uncertain",
  ]),
});
export type PairingDeliveryResult = typeof PairingDeliveryResult.Type;

/** One admitted delivery generation addresses one durable execution, including all retries. */
export const BrowserPairingEmailDeliveryWorkflow = Workflow.make("BrowserPairingEmailDelivery", {
  payload: PairingDeliveryPayload,
  success: PairingDeliveryResult,
  idempotencyKey: ({ userId, intentId }) => `${userId}/${intentId}`,
});
export const pairingDeliveryQueue = PersistedQueue.make({
  name: "browser-pairing-email-delivery",
  schema: PairingDeliveryPayload,
});

/** Expiry is independent of provider completion and retains no proof or mailbox material. */
export const PairingExpiryPayload = Schema.Struct({
  revision: Schema.Literal(1),
  userId: UserId,
  workflowId: BrowserPairingEmailWorkflowId,
});
export type PairingExpiryPayload = typeof PairingExpiryPayload.Type;
export const BrowserPairingEmailExpiryWorkflow = Workflow.make("BrowserPairingEmailExpiry", {
  payload: PairingExpiryPayload,
  idempotencyKey: ({ userId, workflowId }) => `${userId}/${workflowId}`,
});
export const pairingExpiryQueue = PersistedQueue.make({
  name: "browser-pairing-email-expiry",
  schema: PairingExpiryPayload,
});

/** Publication shares the caller's SqlClient transaction with the admitted domain transition. */
export const publishPairingDelivery = Effect.fn(function* (payload: PairingDeliveryPayload) {
  const queue = yield* pairingDeliveryQueue;
  yield* queue.offer(payload, { id: payload.intentId }).pipe(Effect.orDie);
});
export const publishPairingExpiry = Effect.fn(function* (payload: PairingExpiryPayload) {
  const queue = yield* pairingExpiryQueue;
  yield* queue.offer(payload, { id: payload.workflowId }).pipe(Effect.orDie);
});
