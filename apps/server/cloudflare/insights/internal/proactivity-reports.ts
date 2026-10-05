import { Effect, Option, Schema } from "effect";
import { TranscriptText } from "../../../src/core/agent/contract";
import { ProactivityMessageRole } from "../../../src/core/insights/contract";
import { ConsentRecordId } from "../../../src/core/consent/contract";
import { type UserId } from "../../../src/core/identity/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareConsentAction } from "../../consent/operations";
import { InsightUnavailable, ProactivityReport } from "../contract";

const Row = Schema.Struct({
  delivery_id: Schema.String.check(Schema.isUUID()),
  role: ProactivityMessageRole,
  consent_grant_id: Schema.OptionFromNullOr(ConsentRecordId),
  offer_id: Schema.OptionFromNullOr(ConsentRecordId),
  text: Schema.OptionFromNullOr(TranscriptText),
  scheduled_at_ms: Schema.DateTimeUtcFromMillis,
  expires_at_ms: Schema.DateTimeUtcFromMillis,
  time_zone: IanaTimeZone,
});
const decodeReport = (row: typeof Row.Type): Effect.Effect<ProactivityReport, InsightUnavailable> =>
  Effect.gen(function* () {
    const context = {
      id: row.delivery_id,
      text: row.text,
      scheduledAt: row.scheduled_at_ms,
      expiresAt: row.expires_at_ms,
      timeZone: row.time_zone,
    };
    if (row.role === "budget-offer" || row.role === "reminder-offer") {
      if (Option.isNone(row.offer_id) || Option.isSome(row.consent_grant_id)) {
        return yield* new InsightUnavailable();
      }
      return ProactivityReport.make({
        ...context,
        _tag: "ConsentOfferMessage",
        role: row.role,
        offerId: row.offer_id.value,
      });
    }
    if (Option.isNone(row.consent_grant_id) || Option.isSome(row.offer_id)) {
      return yield* new InsightUnavailable();
    }
    return ProactivityReport.make({
      ...context,
      _tag: "GrantMessage",
      role: row.role,
      grantId: row.consent_grant_id.value,
    });
  });
export const findReport = (
  input: Readonly<{ db: D1Database; userId: UserId; id: string }>
): Effect.Effect<Option.Option<ProactivityReport>, InsightUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT delivery_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone FROM proactivity_reports WHERE user_id=? AND delivery_id=?",
          params: [input.userId, input.id],
        },
      }).first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(Row)(raw);
    return Option.some(yield* decodeReport(row));
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const deliveryQuery = (input: Readonly<{ userId: UserId; id: string }>): OwnedStatement => ({
  sql: `SELECT 1 FROM proactivity_reports AS r WHERE r.user_id=? AND r.delivery_id=? AND r.text IS NOT NULL AND (r.role<>'manual-entry-reminder' OR EXISTS (SELECT 1 FROM proactivity_message_events AS l JOIN insight_events AS e ON e.user_id=l.user_id AND e.id=l.insight_event_id JOIN reminder_schedules AS s ON s.user_id=e.user_id AND s.id=e.schedule_id JOIN reminder_governors AS g ON g.user_id=s.user_id WHERE l.user_id=r.user_id AND l.delivery_id=r.delivery_id AND e.kind='manual-entry-reminder' AND s.enabled=1 AND s.consent_grant_id=r.consent_grant_id AND json_extract(g.standing_json,'$._tag')<>'Paused'))`,
  params: [input.userId, input.id],
});

/** Only actual channel proof can settle all same-User links; provider acceptance never calls this unit. */
export const prepareSettlement = (
  input: Readonly<{ db: D1Database; userId: UserId; id: string; proof: OwnedStatement }>
): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(
      `INSERT INTO insight_delivery_attempts(id,user_id,insight_event_id,sent_at,channel,provider,provider_message_id) SELECT l.insight_event_id,l.user_id,l.insight_event_id,strftime('%Y-%m-%dT%H:%M:%fZ',v.send_started_at_ms/1000.0,'unixepoch'),'whatsapp','kapso',v.provider_message_id FROM proactivity_message_events AS l JOIN (${input.proof.sql}) AS v ON v.user_id=l.user_id AND v.delivery_id=l.delivery_id WHERE l.user_id=? AND l.delivery_id=? AND NOT EXISTS (SELECT 1 FROM insight_delivery_attempts WHERE user_id=l.user_id AND insight_event_id=l.insight_event_id)`
    )
    .bind(...input.proof.params, input.userId, input.id),
  input.db
    .prepare(
      `UPDATE insight_events SET lifecycle_state='delivered' WHERE user_id=? AND lifecycle_state='pending' AND id IN (SELECT l.insight_event_id FROM proactivity_message_events AS l JOIN (${input.proof.sql}) AS v ON v.user_id=l.user_id AND v.delivery_id=l.delivery_id WHERE l.user_id=? AND l.delivery_id=?)`
    )
    .bind(input.userId, ...input.proof.params, input.userId, input.id),
  input.db
    .prepare(
      `UPDATE proactivity_outbox SET state='settled' WHERE user_id=? AND delivery_id=? AND EXISTS (SELECT 1 FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.delivery_id=?)`
    )
    .bind(input.userId, input.id, ...input.proof.params, input.userId, input.id),
  input.db
    .prepare(
      `UPDATE reminder_outbox SET state='settled' WHERE user_id=? AND insight_event_id IN (SELECT l.insight_event_id FROM proactivity_message_events AS l JOIN (${input.proof.sql}) AS v ON v.user_id=l.user_id AND v.delivery_id=l.delivery_id WHERE l.user_id=? AND l.delivery_id=?)`
    )
    .bind(input.userId, ...input.proof.params, input.userId, input.id),
];
/** Channel exact text plus the Insights-owned primary occurrence; Agent alone persists its Transcript. */
export const transcriptOccurrenceQuery = (
  input: Readonly<{ userId: UserId; id: string; proof: OwnedStatement }>
): OwnedStatement => ({
  sql: `SELECT v.user_id,(SELECT min(l.insight_event_id) FROM proactivity_message_events AS l WHERE l.user_id=v.user_id AND l.delivery_id=v.delivery_id) AS insight_event_id,v.delivered_at_ms,v.text FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.delivery_id=? AND EXISTS (SELECT 1 FROM proactivity_message_events WHERE user_id=v.user_id AND delivery_id=v.delivery_id)`,
  params: [...input.proof.params, input.userId, input.id],
});
