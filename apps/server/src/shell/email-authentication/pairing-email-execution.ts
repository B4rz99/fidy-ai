import { type DateTime, Effect, Schema } from "effect";
import type { BrowserLoginPairingId } from "~/core/browser-login/reference";
import { Workflow } from "effect/unstable/workflow";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  BrowserPairingEmailStartRequestId,
  BrowserPairingEmailWorkflowId,
  EmailDeliveryIntentId,
} from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";
import { declarePersistedQueue } from "~/shell/persisted-queue/operations";
import { durableQueueTableName } from "~/shell/durable-queue-policy";

/** Stable queue names are deployment contracts shared with in-flight handoffs. */
export const pairingStartQueueName = "browser-pairing-email-start";
export const pairingDeliveryQueueName = "browser-pairing-email-delivery";
export const pairingExpiryQueueName = "browser-pairing-email-expiry";

/** Only the admitted request identity crosses the pre-subject durable boundary. */
export const PairingStartPayload = Schema.Struct({
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  requestId: BrowserPairingEmailStartRequestId,
}).annotate({ identifier: "PairingStartPayload" });
export type PairingStartPayload = typeof PairingStartPayload.Type;
export const pairingStartQueue = declarePersistedQueue({
  name: pairingStartQueueName,
  schema: PairingStartPayload,
  descriptor: {
    component: "api",
    operation: "emailAuthentication.processPairingStart",
  },
});

/** Explicit User context is checked against the intent under RLS, never inferred from its id. */
export const PairingDeliveryPayload = Schema.Struct({
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  userId: UserId,
  intentId: EmailDeliveryIntentId,
}).annotate({ identifier: "PairingDeliveryPayload" });
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
export const pairingDeliveryQueue = declarePersistedQueue({
  name: pairingDeliveryQueueName,
  schema: PairingDeliveryPayload,
  descriptor: {
    component: "api",
    operation: "emailAuthentication.processPairingDelivery",
  },
});

/** Expiry is independent of provider completion and retains no proof or mailbox material. */
export const PairingExpiryPayload = Schema.Struct({
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  userId: UserId,
  workflowId: BrowserPairingEmailWorkflowId,
}).annotate({ identifier: "PairingExpiryPayload" });
export type PairingExpiryPayload = typeof PairingExpiryPayload.Type;
export const BrowserPairingEmailExpiryWorkflow = Workflow.make("BrowserPairingEmailExpiry", {
  payload: PairingExpiryPayload,
  idempotencyKey: ({ userId, workflowId }) => `${userId}/${workflowId}`,
});
export const pairingExpiryQueue = declarePersistedQueue({
  name: pairingExpiryQueueName,
  schema: PairingExpiryPayload,
  descriptor: {
    component: "api",
    operation: "emailAuthentication.processPairingExpiry",
  },
});

/** Stable native queue keys from one offered payload; payloads keep the routing identities. */
export const pairingStartQueueId = (payload: PairingStartPayload): string => payload.requestId;
export const pairingDeliveryQueueId = (payload: PairingDeliveryPayload): string => payload.intentId;
export const pairingExpiryQueueId = (payload: PairingExpiryPayload): string => payload.workflowId;

const maximumPairingExecutionRows = 50_000;

// Count unfinished work and completed history. Each admitted start can still create at most two
// continuations, bounding all queue rows to three times the threshold without blocking drain.
const admitPairingExecutionInScope = Effect.fn(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ acquired: Schema.Boolean }),
    execute: () =>
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended('email-authentication:browser-pairing-execution-capacity', 0)) AS acquired`,
  })(undefined);
  if (!lock.acquired) return false;
  const capacity = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ count: Schema.Int }),
    execute: () => sql`SELECT count(*)::int AS count FROM (
      SELECT 1 FROM ${sql(durableQueueTableName)} WHERE queue_name IN (${pairingStartQueueName}, ${pairingDeliveryQueueName}, ${pairingExpiryQueueName})
      LIMIT ${maximumPairingExecutionRows}
    ) AS retained`,
  })(undefined);
  return capacity.count < maximumPairingExecutionRows;
});

/** Atomically retains and publishes a proved, admission-budgeted pairing start.
 * Global storage backpressure applies equally to known and unknown addresses. Saturation or lock
 * contention publishes nothing and does not disclose mailbox existence. The capacity lock cannot
 * outlive or be separated from the protected admission/publication transaction.
 */
export const publishPairingStart = Effect.fn(function* (request: {
  requestId: BrowserPairingEmailStartRequestId;
  pairingId: BrowserLoginPairingId;
  addressLookupKey: string;
  requestedAt: DateTime.Utc;
  expiresAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  const queue = pairingStartQueue;
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        if (!(yield* admitPairingExecutionInScope())) return;
        yield* sql`INSERT INTO browser_pairing_email_start_requests (
      id, pairing_id, address_lookup_key, requested_at, expires_at
    ) VALUES (
      ${request.requestId}, ${request.pairingId}, ${request.addressLookupKey},
      ${request.requestedAt}, ${request.expiresAt}
    )`;
        const payload: PairingStartPayload = {
          revision: 1,
          requestId: request.requestId,
        };
        yield* queue.offer(payload, { id: pairingStartQueueId(payload) });
      })
    )
    .pipe(Effect.orDie);
});

/** Publication shares the caller's SqlClient transaction with the admitted domain transition. */
export const publishPairingDelivery = Effect.fn(function* (payload: PairingDeliveryPayload) {
  const queue = pairingDeliveryQueue;
  yield* queue.offer(payload, { id: pairingDeliveryQueueId(payload) }).pipe(Effect.orDie);
});
export const publishPairingExpiry = Effect.fn(function* (payload: PairingExpiryPayload) {
  const queue = pairingExpiryQueue;
  yield* queue.offer(payload, { id: pairingExpiryQueueId(payload) }).pipe(Effect.orDie);
});
