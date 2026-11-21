import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { DisclosureSnapshot } from "../../../src/core/consent/contract";
import { ProactivityOptInKind } from "../../../src/shell/consent/contract";
import { proactivityDisclosureFor } from "../../../src/shell/consent/operations";
import {
  PreparedProactivityTemplate,
  proactivityTemplateBody,
} from "../../../src/shell/channels/whatsapp/contract";
import type { WhatsAppTurnAdmission } from "../../whatsapp/contract";
import { digestBytes, newId } from "../../secret-material/operations";

const timestampSlop = 999;

const dayMs = 86400000,
  questionAt = 3;

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const countDeliveredReminder = Effect.fn(function* (user: string, id: string, at: number) {
  const sql = yield* SqliteClient;

  const [held] =
    yield* sql`SELECT g.kind,d.grant_id,d.portfolio,d.bsuid,d.endpoint,d.body FROM reminder_deliveries d JOIN proactive_grants g ON g.id=d.grant_id AND g.user_id=d.user_id AND g.revoked_at_ms IS NULL WHERE d.id=${id} AND d.user_id=${user}`;

  if (held === undefined) return;

  const row = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      kind: ProactivityOptInKind,
      grant_id: Schema.String,
      portfolio: Schema.String,
      bsuid: Schema.String,
      endpoint: Schema.String,
      body: Schema.fromJsonString(PreparedProactivityTemplate),
    })
  )(held);

  const [attention] =
    yield* sql`INSERT INTO reminder_attention(grant_id,unanswered,last_reply_ms) VALUES(${row.grant_id},1,0) ON CONFLICT(grant_id) DO UPDATE SET unanswered=unanswered+1 WHERE unanswered<5 AND last_reply_ms<${at} AND (unanswered<3 OR (question_delivered_ms IS NOT NULL AND question_delivered_ms<${at})) RETURNING unanswered`;

  if (attention?.unanswered !== questionAt) return;
  const disclosure = proactivityDisclosureFor(row.kind);

  const parameter =
    disclosure.text +
    " Responde a este mensaje con «Sí» para continuar o «Desactivar» para dejar de recibirlos.";

  const template = yield* Schema.decodeEffect(PreparedProactivityTemplate)({
    ...row.body,
    parameter,
    text: proactivityTemplateBody.replace("{{1}}", () => parameter),
  });

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(PreparedProactivityTemplate))(
    template
  );

  const digest = Hex.encode(yield* digestBytes(new TextEncoder().encode(yield* json(body))));
  const question = newId();
  yield* sql`INSERT INTO reminder_disclosures(id,user_id,portfolio,bsuid,endpoint,request_message,created_ms,expires_ms,attempt_ms,correlation,disclosure,body,digest,grant_id,kind) VALUES(${question},${user},${row.portfolio},${row.bsuid},${row.endpoint},${"question:" + id},${at},${at + dayMs},${at},${newId()},${yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(disclosure)},${body},${digest},${row.grant_id},${row.kind})`;
  yield* sql`UPDATE reminder_attention SET question_id=${question} WHERE grant_id=${row.grant_id} AND unanswered=3`;
});

export const recordReminderReply = Effect.fn(function* (event: WhatsAppTurnAdmission) {
  if (Option.isNone(event.replyToMessageId)) return;

  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  yield* sql`UPDATE reminder_attention AS a SET unanswered=0,last_reply_ms=${event.occurredAtMs},question_id=NULL,question_delivered_ms=NULL WHERE a.unanswered<5 AND a.last_reply_ms<${event.occurredAtMs} AND ${event.occurredAtMs + dayMs}>${now} AND EXISTS(SELECT 1 FROM reminder_deliveries d JOIN whatsapp_deliveries w ON w.user_id=d.user_id AND w.operation_id=d.id AND w.family='proactivity' AND w.correlation=d.correlation JOIN proactive_grants g ON g.id=d.grant_id AND g.revoked_at_ms IS NULL JOIN users u ON u.id=d.user_id AND u.whatsapp_portfolio_id=d.portfolio AND u.whatsapp_bsuid=d.bsuid WHERE d.grant_id=a.grant_id AND d.user_id=${event.userId} AND d.portfolio=${event.portfolioId} AND d.bsuid=${event.bsuid} AND d.endpoint=${event.businessPhoneNumberId} AND w.provider_message_id=${event.replyToMessageId.value} AND w.state='delivered' AND w.delivered_at_ms>a.last_reply_ms AND w.delivered_at_ms<=${event.occurredAtMs + timestampSlop})`;
});
