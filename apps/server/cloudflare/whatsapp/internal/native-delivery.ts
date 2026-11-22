import { reconcileLocalHostedReceipt } from "../../agent/operations";
import {
  claimLocalDisclosure,
  claimLocalReminderPurpose,
  isRetainedDisclosure,
  reconcileLocalReminder,
} from "../../insights/operations";
import { Clock, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import type { ExternalEventBindings } from "../../directory/contract";
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

const conflictStatus = 409;

type Send = typeof DeliverySend.Type;

const answer = (status: number): Response => new Response(null, { status });

const sendAllowed = (work: Send, now: number): ReturnType<typeof protectConsentStatement> => {
  const statement = {
    sql: "SELECT id FROM users WHERE id=? AND whatsapp_portfolio_id=? AND whatsapp_bsuid=? AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=?)",
    params: [work.userId, work.portfolio, work.bsuid, work.userId],
  };

  const subject = ConsentSubject.User({ userId: work.userId });
  const live = protectConsentStatement({ subject, requirement: "active", statement });

  if (work.family !== "hosted" || work.deadline === null) return live;

  const retained = protectConsentStatement({
    subject,
    requirement: "granted",
    statement: {
      sql:
        statement.sql +
        ` AND EXISTS(SELECT 1 FROM hosted_turns t JOIN hosted_agent_sessions s ON s.id=t.session_id AND s.user_id=t.user_id JOIN hosted_whatsapp_inbound i ON i.turn_id=t.id AND i.user_id=t.user_id
      JOIN consent_history g ON g.id=json_extract(s.basis_json,'$.grantId') AND g.user_id=t.user_id AND g.record_type='processing_grant' AND json_extract(g.disclosure_json,'$.contentSha256')=json_extract(s.basis_json,'$.disclosureSha256')
      WHERE t.user_id=users.id AND t.id=? AND t.state='proposed' AND t.deadline_ms=? AND t.deadline_ms>? AND i.portfolio=users.whatsapp_portfolio_id AND i.bsuid=users.whatsapp_bsuid AND i.endpoint=? AND i.correlation=? AND i.answer_digest=?
      AND coalesce(i.sandbox_phone,'')=? AND users.whatsapp_verified_at_ms<=i.occurred_ms+999 AND i.occurred_ms+86400000>?)`,
      params: [
        ...statement.params,
        work.operationId,
        work.deadline,
        now,
        work.endpoint,
        work.correlation,
        work.contentDigest,
        work.sandboxPhone ?? "",
        now,
      ],
    },
  });

  return {
    sql: live.sql + " UNION ALL " + retained.sql,
    params: [...live.params, ...retained.params],
  };
};

const stage = Effect.fn(function* (work: Send) {
  const sql = yield* SqliteClient;
  const guard = sendAllowed(work, yield* Clock.currentTimeMillis);
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

const start = Effect.fn(function* (work: Send, enabled: { category: boolean; weekly: boolean }) {
  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const sql = yield* SqliteClient;
      const now = yield* Clock.currentTimeMillis;
      const guard = sendAllowed(work, now);
      const [live] = yield* sql.unsafe(guard.sql, guard.params);

      if (live === undefined) return answer(conflictStatus);

      if (work.family === "disclosure" && !(yield* claimLocalDisclosure(work, enabled))) {
        return answer(conflictStatus);
      }

      if (work.family === "proactivity") {
        const [ready] =
          yield* sql`SELECT 1 FROM whatsapp_deliveries WHERE user_id=${work.userId} AND family='proactivity' AND operation_id=${work.operationId} AND correlation=${work.correlation} AND route_ready=1 AND started_ms IS NULL AND state='staged'`;

        if (ready === undefined || !(yield* claimLocalReminderPurpose(work, enabled))) {
          return answer(conflictStatus);
        }
      }

      const result = yield* sql.unsafe(
        `UPDATE whatsapp_deliveries SET started_ms=?,state='sending' WHERE user_id=? AND family=? AND operation_id=? AND correlation=? AND endpoint=? AND state='staged' AND route_ready=1 AND portfolio=? AND bsuid=? AND sandbox_phone IS ? AND content_digest=? AND original_deadline_ms IS ? AND started_ms IS NULL AND (original_deadline_ms IS NULL OR original_deadline_ms>?) AND EXISTS(${guard.sql})
        AND (family<>'hosted' OR NOT EXISTS(SELECT 1 FROM hosted_whatsapp_inbound i WHERE i.user_id=whatsapp_deliveries.user_id AND i.turn_id=whatsapp_deliveries.operation_id) OR EXISTS(SELECT 1 FROM hosted_turns t JOIN hosted_whatsapp_inbound i ON i.turn_id=t.id AND i.user_id=t.user_id WHERE t.id=whatsapp_deliveries.operation_id AND t.user_id=whatsapp_deliveries.user_id AND t.state='proposed' AND t.deadline_ms=whatsapp_deliveries.original_deadline_ms AND i.answer_digest=whatsapp_deliveries.content_digest AND i.correlation=whatsapp_deliveries.correlation AND i.endpoint=whatsapp_deliveries.endpoint AND i.portfolio=whatsapp_deliveries.portfolio AND i.bsuid=whatsapp_deliveries.bsuid AND i.sandbox_phone IS whatsapp_deliveries.sandbox_phone)) RETURNING 1`,
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

type WeeklyLimits = Partial<
  Readonly<{ PROACTIVITY_ASK_AFTER: string; PROACTIVITY_PAUSE_AFTER: string }>
>;

const settledStatus = Effect.fn(function* (
  work: typeof DeliveredObservation.Type,
  limits: WeeklyLimits
) {
  if (
    work.family === "disclosure" &&
    (yield* isRetainedDisclosure(work.userId, work.operationId))
  ) {
    return answer(noContentStatus);
  }

  if (work.family === "proactivity") {
    yield* reconcileLocalReminder(work.userId, work.operationId, limits);

    return answer(noContentStatus);
  }

  if (
    work.family === "hosted" &&
    (yield* reconcileLocalHostedReceipt(work.userId, work.operationId))
  ) {
    return answer(noContentStatus);
  }

  return answer(noContentStatus);
});

const status = Effect.fn(function* (work: typeof DeliveredObservation.Type, limits: WeeklyLimits) {
  const sql = yield* SqliteClient;
  const event = work.evidence;

  const bsuid = event.recipientUserId ?? null,
    phone = event.recipientPhone ?? null;

  const [row] =
    yield* sql`SELECT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=d.user_id) AS draining FROM whatsapp_deliveries d JOIN users u ON u.id=d.user_id AND u.whatsapp_portfolio_id=d.portfolio AND u.whatsapp_bsuid=d.bsuid
    WHERE d.user_id=${work.userId} AND d.operation_id=${work.operationId} AND d.family=${work.family} AND d.portfolio=${event.portfolio}
      AND d.endpoint=${event.businessPhoneNumberId} AND d.correlation=${event.correlationToken} AND d.started_ms IS NOT NULL
      AND (d.provider_message_id IS NULL OR d.provider_message_id=${event.providerMessageId})
      AND ((d.sandbox_phone IS NULL AND d.bsuid=${bsuid}) OR (d.sandbox_phone=${phone} AND (${bsuid} IS NULL OR d.bsuid=${bsuid})))
      AND ${event.occurredAtMs}+1000>=d.started_ms AND ${event.occurredAtMs}<=${event.receivedAtMs}+300000
      AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=d.user_id AND state<>'Draining')`;

  if (row === undefined) return answer(noContentStatus);

  const [fresh] =
    yield* sql`INSERT INTO whatsapp_delivery_status(user_id,family,operation_id,provider_message_id,outcome,occurred_ms)
    VALUES(${work.userId},${work.family},${work.operationId},${event.providerMessageId},${event.outcome},${event.occurredAtMs}) ON CONFLICT DO NOTHING RETURNING 1`;

  const settled =
    row.draining === 1 ? Effect.succeed(answer(noContentStatus)) : settledStatus(work, limits);

  if (fresh === undefined) return yield* settled;
  yield* sql`UPDATE whatsapp_deliveries SET provider_message_id=coalesce(provider_message_id,${event.providerMessageId}),
    state=CASE WHEN state='delivered' OR (family='hosted' AND state='rejected') THEN state WHEN ${event.outcome}='delivered' AND (family<>'hosted' OR ${event.receivedAtMs}<=original_deadline_ms) THEN 'delivered'
    WHEN state='rejected' THEN state WHEN ${event.outcome}='failed' THEN 'rejected' WHEN family<>'hosted' AND state IN ('sending','ambiguous') THEN 'accepted' ELSE state END,
    delivered_at_ms=CASE WHEN ${event.outcome}='delivered' AND (family<>'hosted' OR state<>'rejected') AND (family<>'hosted' OR ${event.receivedAtMs}<=original_deadline_ms) THEN coalesce(delivered_at_ms,${event.occurredAtMs}) ELSE delivered_at_ms END
    WHERE user_id=${work.userId} AND family=${work.family} AND operation_id=${work.operationId}`;

  return yield* settled;
});

export const nativeDeliveryRequest = Effect.fn(function* (
  request: Request,
  env: Pick<ExternalEventBindings, "DIRECTORY"> &
    Partial<Readonly<{ PROACTIVITY_ENABLED: string; WEEKLY_SUMMARY_ENABLED: string }>> &
    WeeklyLimits,
  owns: (id: string) => boolean
) {
  const body: unknown = yield* Effect.tryPromise(() => request.json());

  if (request.url === claimDeliveryUrl || request.url === reserveDeliveryUrl) {
    const work = yield* Schema.decodeUnknownEffect(DeliverySend)(body);

    if (!owns(work.userId)) return answer(conflictStatus);

    return request.url === reserveDeliveryUrl
      ? yield* reserve(work, env)
      : yield* start(work, {
          category: env.PROACTIVITY_ENABLED === "enabled",
          weekly: env.WEEKLY_SUMMARY_ENABLED === "enabled",
        });
  }

  if (request.url === replyDeliveryUrl) {
    const work = yield* Schema.decodeUnknownEffect(SendReply)(body);

    if (!owns(work.userId)) return answer(noContentStatus);
    const sql = yield* SqliteClient;
    yield* sql`UPDATE whatsapp_deliveries SET state=${work.state},provider_message_id=coalesce(provider_message_id,${work.message}) WHERE user_id=${work.userId} AND family=${work.family} AND operation_id=${work.operationId} AND correlation=${work.correlation}
      AND endpoint=${work.endpoint} AND started_ms IS NOT NULL AND state='sending' AND (provider_message_id IS NULL OR provider_message_id=${work.message}) AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining')`;

    return answer(noContentStatus);
  }

  const work = yield* Schema.decodeUnknownEffect(DeliveredObservation)(body);

  return owns(work.userId)
    ? yield* status(work, env).pipe(withStoreCapacity("required"))
    : answer(noContentStatus);
});

export const routeWhatsAppStatus = Effect.fn(function* (
  event: typeof WhatsAppLifecycleWork.Type,
  env: ExternalEventBindings
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
});
