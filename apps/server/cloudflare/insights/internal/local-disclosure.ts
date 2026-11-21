import { disclosureWindowAt } from "./category-window";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import {
  UserId,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../../src/core/identity/contract";
import {
  HostedDeliveryCorrelationToken,
  PreparedProactivityTemplate,
  type ProactivityTemplateSender,
  WeeklyQuestionOffer,
  type WeeklyQuestionSender,
} from "../../../src/shell/channels/whatsapp/contract";
import type { ExternalEventBindings } from "../../directory/contract";
import { claimRegisteredSend, recordRegisteredSend } from "../../whatsapp/operations";
import type { DeliverySend } from "../../whatsapp/contract";
import {
  chargeLocalProvider,
  reserveSharedProviderSpend,
} from "../../resource-admission/operations";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";
import { sendEvidence } from "./weekly-execution";

const retryMs = 60000;

const offer = Schema.Struct({
  id: Schema.String,
  user_id: UserId,
  endpoint: WhatsAppBusinessPhoneNumberId,
  portfolio: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  correlation: HostedDeliveryCorrelationToken,
  expires_ms: Schema.Int,
  body: Schema.String,
});

export const dispatchDisclosure = Effect.fn(function* (
  env: ExternalEventBindings,
  delivery: { category: ProactivityTemplateSender } | { weekly: WeeklyQuestionSender; id: string },
  store: DurableObjectStorage
) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  yield* sql`UPDATE reminder_disclosures SET state='expired' WHERE state='ready' AND expires_ms<=${now}`;
  const id = "weekly" in delivery ? delivery.id : null;

  const [raw] =
    yield* sql`UPDATE reminder_disclosures SET attempt_ms=min(expires_ms,${now + retryMs}) WHERE id=(SELECT id FROM reminder_disclosures WHERE state='ready' AND ((${id} IS NULL AND kind<>'weekly-summary' AND attempt_ms<=${now}) OR (kind='weekly-summary' AND id=${id})) ORDER BY attempt_ms LIMIT 1) RETURNING *`;

  if (raw === undefined) return;
  const held = yield* Schema.decodeUnknownEffect(offer)(raw);
  yield* preserveStoreAlarm(store, Math.min(held.expires_ms, now + retryMs));

  if (!(yield* reserveSharedProviderSpend(env.DIRECTORY, { phase: "reminderSend", units: 4096 }))) {
    return;
  }

  const binding = {
    userId: held.user_id,
    family: "disclosure" as const,
    endpoint: held.endpoint,
    operationId: held.id,
    correlation: held.correlation,
  };

  const one = yield* claimRegisteredSend(env, {
    ...binding,
    portfolio: held.portfolio,
    bsuid: held.bsuid,
    sandboxPhone: null,
    content: held.body,
    deadline: held.expires_ms,
  });

  yield* one.claim;

  const channel = {
    recipient: held.bsuid,
    businessPhoneNumberId: held.endpoint,
    correlationToken: held.correlation,
  };

  const sent =
    "weekly" in delivery
      ? delivery.weekly.send({
          ...channel,
          offer: (yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ offer: WeeklyQuestionOffer }))
          )(held.body)).offer,
        })
      : delivery.category.send({
          ...channel,
          template: yield* Schema.decodeEffect(Schema.fromJsonString(PreparedProactivityTemplate))(
            held.body
          ),
        });

  const outcome = sendEvidence(yield* Effect.exit(sent));
  yield* recordRegisteredSend(env, {
    ...binding,
    state: outcome.certainty,
    message: Option.getOrNull(outcome.providerMessageId),
  });
});

const unattendedDisclosureAllowed = (
  automatic: unknown,
  activeGrant: unknown,
  now: number
): boolean => automatic !== 1 || (disclosureWindowAt(now) === now && activeGrant !== 1);

export const claimDisclosure = Effect.fn(function* (
  work: typeof DeliverySend.Type,
  enabled: { category: boolean; weekly: boolean }
) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  const [offer] =
    yield* sql`SELECT o.id,o.kind,EXISTS(SELECT 1 FROM category_opportunities q WHERE q.user_id=o.user_id AND q.offer_id=o.id) AS automatic,EXISTS(SELECT 1 FROM proactive_grants g WHERE g.user_id=o.user_id AND g.kind=o.kind AND g.revoked_at_ms IS NULL) AS active_grant FROM reminder_disclosures o WHERE o.id=${work.operationId} AND o.user_id=${work.userId}`;

  if (offer === undefined) return true;

  if (!unattendedDisclosureAllowed(offer.automatic, offer.active_grant, now)) return false;

  if (!(offer.kind === "weekly-summary" ? enabled.weekly : enabled.category)) return false;

  const [ready] =
    yield* sql`SELECT 1 FROM reminder_disclosures o JOIN whatsapp_deliveries w ON w.user_id=o.user_id AND w.operation_id=o.id AND w.family='disclosure' AND w.state='staged' AND w.route_ready=1 AND w.started_ms IS NULL WHERE o.id=${work.operationId} AND o.state='ready' AND (o.grant_id IS NULL OR EXISTS(SELECT 1 FROM proactive_grants g WHERE g.id=o.grant_id AND g.user_id=o.user_id AND g.revoked_at_ms IS NULL)) AND o.user_id=${work.userId} AND o.portfolio=${work.portfolio} AND o.bsuid=${work.bsuid} AND o.endpoint=${work.endpoint} AND o.correlation=${work.correlation} AND o.digest=${work.contentDigest} AND o.expires_ms=${work.deadline} AND o.expires_ms>${now} AND ${work.sandboxPhone} IS NULL`;

  if (ready === undefined) return false;

  if (!(yield* chargeLocalProvider({ phase: "reminderSend", units: 4096 }, "user", now))) {
    return false;
  }

  yield* sql`UPDATE reminder_disclosures SET state='claimed' WHERE id=${work.operationId} AND user_id=${work.userId}`;

  return true;
});

export const retainedDisclosure = Effect.fn(function* (user: string, id: string) {
  const sql = yield* SqliteClient;
  yield* sql`UPDATE weekly_attention AS a SET question_delivered_ms=w.delivered_at_ms FROM whatsapp_deliveries w WHERE w.user_id=${user} AND w.operation_id=${id} AND w.family='disclosure' AND w.state='delivered' AND a.question_id=w.operation_id AND a.question_delivered_ms IS NULL`;
  yield* sql`UPDATE reminder_attention AS a SET question_delivered_ms=w.delivered_at_ms FROM whatsapp_deliveries w WHERE w.user_id=${user} AND w.operation_id=${id} AND w.family='disclosure' AND w.state='delivered' AND a.question_id=w.operation_id AND a.unanswered=3 AND a.question_delivered_ms IS NULL`;

  return (
    (yield* sql`SELECT id FROM reminder_disclosures WHERE user_id=${user} AND id=${id}`).length ===
    1
  );
});
