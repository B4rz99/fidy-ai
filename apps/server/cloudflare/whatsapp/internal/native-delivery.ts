import { Clock, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import type { ExternalEventBindings, ExternalEventNamespace } from "../../directory/contract";
import { lookupExternalEventRoute, reserveExternalEventRoute } from "../../directory/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  DeliveredObservation,
  DeliverySend,
  SendReply,
  type WhatsAppLifecycleWork,
  claimDeliveryUrl,
  replyDeliveryUrl,
  reserveDeliveryUrl,
  statusDeliveryUrl,
} from "../contract";

const noContentStatus = 204;
const claimedStatus = 201;
const pendingStatus = 202;
const conflictStatus = 409;

type Send = typeof DeliverySend.Type;
const answer = (status: number): Response => new Response(null, { status });
const sendAllowed = (work: Send): ReturnType<typeof protectConsentStatement> =>
  protectConsentStatement({
    subject: { _tag: "User", userId: work.userId },
    requirement: "active",
    statement: {
      sql: "SELECT id FROM users WHERE id=? AND whatsapp_portfolio_id=? AND whatsapp_bsuid=? AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=?)",
      params: [work.userId, work.portfolio, work.bsuid, work.userId],
    },
  });
const stage = Effect.fn(function* (work: Send) {
  const sql = yield* SqliteClient;
  const guard = sendAllowed(work);
  const [live] = yield* sql.unsafe(guard.sql, guard.params);
  if (live === undefined) return false;
  yield* sql`INSERT INTO whatsapp_deliveries(user_id,family,operation_id,endpoint,correlation,portfolio,bsuid,sandbox_phone,original_deadline_ms,content_digest)
    VALUES(${work.userId},${work.family},${work.operationId},${work.endpoint},${work.correlation},${work.portfolio},${work.bsuid},${work.sandboxPhone},${work.deadline},${work.contentDigest})
    ON CONFLICT DO NOTHING`;
  const [exact] =
    yield* sql`SELECT 1 FROM whatsapp_deliveries WHERE user_id=${work.userId} AND family=${work.family} AND operation_id=${work.operationId} AND endpoint=${work.endpoint} AND correlation=${work.correlation}
    AND portfolio=${work.portfolio} AND bsuid=${work.bsuid} AND sandbox_phone IS ${work.sandboxPhone} AND original_deadline_ms IS ${work.deadline} AND content_digest=${work.contentDigest} AND started_ms IS NULL`;
  return exact !== undefined;
});
const reserve = Effect.fn(function* (work: Send, env: Pick<ExternalEventBindings, "DIRECTORY">) {
  if (!(yield* stage(work).pipe(withStoreCapacity("growth")))) return answer(conflictStatus);
  yield* reserveExternalEventRoute(env.DIRECTORY, {
    kind: "whatsapp",
    lookup: work.correlation,
    endpoint: work.endpoint,
    userId: work.userId,
    operationId: work.operationId,
    family: work.family,
  });
  const sql = yield* SqliteClient;
  const ready =
    yield* sql`UPDATE whatsapp_deliveries SET route_ready=1 WHERE user_id=${work.userId} AND family=${work.family} AND operation_id=${work.operationId} AND correlation=${work.correlation} AND content_digest=${work.contentDigest} AND state='staged' AND NOT EXISTS(SELECT 1 FROM erasure_requests) RETURNING 1`;
  return answer(ready.length === 1 ? noContentStatus : conflictStatus);
});
const start = Effect.fn(function* (work: Send) {
  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const sql = yield* SqliteClient;
      const guard = sendAllowed(work);
      const now = yield* Clock.currentTimeMillis;
      const result = yield* sql.unsafe(
        `UPDATE whatsapp_deliveries SET started_ms=?,state='sending' WHERE user_id=? AND family=? AND operation_id=? AND correlation=? AND endpoint=? AND state='staged' AND route_ready=1 AND portfolio=? AND bsuid=? AND sandbox_phone IS ? AND content_digest=? AND original_deadline_ms IS ? AND started_ms IS NULL AND (original_deadline_ms IS NULL OR original_deadline_ms>?) AND EXISTS(${guard.sql}) RETURNING 1`,
        [
          now,
          work.userId,
          work.family,
          work.operationId,
          work.correlation,
          work.endpoint,
          work.portfolio,
          work.bsuid,
          work.sandboxPhone,
          work.contentDigest,
          work.deadline,
          now,
          ...guard.params,
        ]
      );
      return answer(result.length === 1 ? claimedStatus : conflictStatus);
    })
  );
});
const status = Effect.fn(function* (work: typeof DeliveredObservation.Type) {
  const sql = yield* SqliteClient;
  const event = work.evidence;
  const bsuid = event.recipientUserId ?? null,
    phone = event.recipientPhone ?? null;
  const [row] =
    yield* sql`SELECT d.state FROM whatsapp_deliveries d JOIN users u ON u.id=d.user_id AND u.whatsapp_portfolio_id=d.portfolio AND u.whatsapp_bsuid=d.bsuid
    WHERE d.user_id=${work.userId} AND d.operation_id=${work.operationId} AND d.family=${work.family} AND d.portfolio=${event.portfolio}
      AND d.endpoint=${event.businessPhoneNumberId} AND d.correlation=${event.correlationToken} AND d.started_ms IS NOT NULL
      AND (d.provider_message_id IS NULL OR d.provider_message_id=${event.providerMessageId})
      AND ((d.sandbox_phone IS NULL AND d.bsuid=${bsuid}) OR (d.sandbox_phone=${phone} AND (${bsuid} IS NULL OR d.bsuid=${bsuid})))
      AND ${event.occurredAtMs}+1000>=d.started_ms AND ${event.occurredAtMs}<=${event.receivedAtMs}+300000
      AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=d.user_id)`;
  if (row === undefined) return answer(noContentStatus);
  const [fresh] =
    yield* sql`INSERT INTO whatsapp_delivery_status(user_id,family,operation_id,provider_message_id,outcome,occurred_ms)
    VALUES(${work.userId},${work.family},${work.operationId},${event.providerMessageId},${event.outcome},${event.occurredAtMs}) ON CONFLICT DO NOTHING RETURNING 1`;
  if (fresh === undefined) return answer(pendingStatus);
  yield* sql`UPDATE whatsapp_deliveries SET provider_message_id=coalesce(provider_message_id,${event.providerMessageId}),
    state=CASE WHEN state='delivered' OR (family='hosted' AND state='rejected') THEN state WHEN ${event.outcome}='delivered' AND (family<>'hosted' OR ${event.receivedAtMs}<=original_deadline_ms) THEN 'delivered'
    WHEN state='rejected' THEN state WHEN ${event.outcome}='failed' THEN 'rejected' WHEN family<>'hosted' AND state IN ('sending','ambiguous') THEN 'accepted' ELSE state END,
    delivered_at_ms=CASE WHEN ${event.outcome}='delivered' AND (family<>'hosted' OR state<>'rejected') AND (family<>'hosted' OR ${event.receivedAtMs}<=original_deadline_ms) THEN coalesce(delivered_at_ms,${event.occurredAtMs}) ELSE delivered_at_ms END
    WHERE user_id=${work.userId} AND family=${work.family} AND operation_id=${work.operationId}`;
  return answer(pendingStatus);
});
export const nativeDeliveryRequest = Effect.fn(function* (
  request: Request,
  env: Pick<ExternalEventBindings, "DIRECTORY">,
  owns: (id: string) => boolean
) {
  const body: unknown = yield* Effect.tryPromise(() => request.json());
  if (request.url === claimDeliveryUrl || request.url === reserveDeliveryUrl) {
    const work = yield* Schema.decodeUnknownEffect(DeliverySend)(body);
    if (!owns(work.userId)) return answer(conflictStatus);
    return request.url === reserveDeliveryUrl ? yield* reserve(work, env) : yield* start(work);
  }
  if (request.url === replyDeliveryUrl) {
    const work = yield* Schema.decodeUnknownEffect(SendReply)(body);
    if (!owns(work.userId)) return answer(noContentStatus);
    const sql = yield* SqliteClient;
    yield* sql`UPDATE whatsapp_deliveries SET state=${work.state},provider_message_id=coalesce(provider_message_id,${work.message}) WHERE user_id=${work.userId} AND family=${work.family} AND operation_id=${work.operationId} AND correlation=${work.correlation}
      AND endpoint=${work.endpoint} AND started_ms IS NOT NULL AND state='sending' AND (provider_message_id IS NULL OR provider_message_id=${work.message}) AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;
    return answer(noContentStatus);
  }
  const work = yield* Schema.decodeUnknownEffect(DeliveredObservation)(body);
  return owns(work.userId)
    ? yield* status(work).pipe(withStoreCapacity("required"))
    : answer(noContentStatus);
});
export const routeWhatsAppStatus = Effect.fn(function* (
  event: typeof WhatsAppLifecycleWork.Type,
  env: ExternalEventBindings & Readonly<{ USER_TRANSACTION_COORDINATOR: ExternalEventNamespace }>
) {
  const route = yield* lookupExternalEventRoute(env.DIRECTORY, {
    kind: "whatsapp",
    lookup: event.correlationToken,
    endpoint: event.businessPhoneNumberId,
  });
  if (Option.isNone(route)) return;
  const { userId, operationId, family } = route.value;
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    userId,
    operationId,
    family,
    evidence: event,
  });
  const response = yield* Effect.tryPromise((signal) =>
    env.USER_STORE.getByName(userId).fetch(statusDeliveryUrl, { method: "POST", body, signal })
  );
  if (!response.ok) return yield* Effect.fail("delivery-status-unavailable" as const);
  if (response.status !== pendingStatus) return;
  const continued = yield* Effect.tryPromise((signal) =>
    env.USER_TRANSACTION_COORDINATOR.getByName(userId).fetch(
      "https://coordinator.internal/hosted-turn/whatsapp/status",
      { method: "POST", body, signal }
    )
  );
  if (!continued.ok) return yield* Effect.fail("delivery-status-unavailable" as const);
});
