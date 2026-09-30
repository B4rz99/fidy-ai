import { Option, Schema } from "effect";
import { InsightDeliveryAttempt, InsightEvent } from "@fidy/server/insights-contract";

const EventRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  schedule_id: Schema.String,
  schedule_version: Schema.Finite,
  service_market: Schema.String,
  locale: Schema.String,
  time_zone: Schema.String,
  scheduled_at: Schema.String,
  money_groups_json: Schema.String,
  lifecycle_state: Schema.String,
});
const AttemptRow = Schema.Struct({
  id: Schema.String,
  insight_event_id: Schema.String,
  sent_at: Schema.String,
  channel: Schema.String,
  provider: Schema.String,
  provider_message_id: Schema.String,
});

/** Decode retained occurrence context, including exact Currency-group Money. */
export const decodeEvent = (raw: unknown): Option.Option<InsightEvent> =>
  Option.flatMap(Schema.decodeUnknownOption(EventRow)(raw), (row) => {
    const groups = Schema.decodeOption(
      Schema.fromJsonString(Schema.toCodecJson(InsightEvent.fields.moneyGroups))
    )(row.money_groups_json);
    if (Option.isNone(groups)) return Option.none();
    return Schema.decodeOption(Schema.toCodecJson(InsightEvent))({
      id: row.id,
      kind: row.kind,
      scheduleId: row.schedule_id,
      scheduleVersion: row.schedule_version,
      serviceMarket: row.service_market,
      locale: row.locale,
      timeZone: row.time_zone,
      scheduledAt: row.scheduled_at,
      moneyGroups: Schema.encodeSync(Schema.toCodecJson(InsightEvent.fields.moneyGroups))(
        groups.value
      ),
      lifecycleState: row.lifecycle_state,
    });
  });

/** Decode immutable provider evidence without exposing its storage shape. */
export const decodeAttempt = (raw: unknown): Option.Option<InsightDeliveryAttempt> =>
  Option.flatMap(Schema.decodeUnknownOption(AttemptRow)(raw), (row) =>
    Schema.decodeOption(InsightDeliveryAttempt)({
      id: row.id,
      insightEventId: row.insight_event_id,
      sentAt: row.sent_at,
      channel: row.channel,
      provider: row.provider,
      providerMessageId: row.provider_message_id,
    })
  );
