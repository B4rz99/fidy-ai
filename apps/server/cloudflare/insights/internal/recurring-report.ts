import { Effect, Schema } from "effect";
import { type InsightEventId, RecurringDigestReport } from "../../../src/core/insights/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { InsightUnavailable } from "../contract";
import { ReportJson } from "./recurring-models";

/** Read financial content together with its original owning occurrence, independently of message text. */
export const recurringReportQuery = (
  input: Readonly<{ userId: string; id: InsightEventId }>
): OwnedStatement => ({
  sql: `SELECT json_object('insightEventId',r.insight_event_id,'serviceMarket',e.service_market,'locale',e.locale,
 'scheduledAt',strftime('%Y-%m-%dT%H:%M:%fZ',e.scheduled_at_ms/1000.0,'unixepoch'),
 'expiresAt',strftime('%Y-%m-%dT%H:%M:%fZ',r.original_delivery_expires_at_ms/1000.0,'unixepoch'),'payload',json(r.payload_json)) AS report_json,
 e.schedule_id AS instruction_id,e.schedule_version AS instruction_version,r.local_date,r.day_from_ms,r.day_to_ms,
 e.id AS event_id,e.kind AS event_kind,e.schedule_id,e.schedule_version,e.service_market,e.locale,e.time_zone,e.scheduled_at_ms
 FROM insight_reports r JOIN insight_events e ON e.user_id=r.user_id AND e.id=r.insight_event_id
 WHERE r.kind='recurring-digest' AND r.user_id=? AND r.insight_event_id=?`,
  params: [input.userId, input.id],
});
const Row = Schema.Struct({
  report_json: ReportJson,
  instruction_id: Schema.String,
  instruction_version: Schema.Int,
  local_date: Schema.String,
  day_from_ms: Schema.Int,
  day_to_ms: Schema.Int,
  event_id: RecurringDigestReport.fields.insightEventId,
  event_kind: Schema.Literal("new-recurring-series"),
  schedule_id: Schema.String,
  schedule_version: Schema.Int,
  service_market: RecurringDigestReport.fields.serviceMarket,
  locale: RecurringDigestReport.fields.locale,
  time_zone: Schema.String,
  scheduled_at_ms: Schema.DateTimeUtcFromMillis,
});

export const decodeRecurringReport = (
  raw: unknown
): Effect.Effect<RecurringDigestReport, InsightUnavailable> =>
  Effect.gen(function* () {
    const row = yield* Schema.decodeUnknownEffect(Row)(raw);
    const report = row.report_json;
    const day = report.payload.confirmationDay;
    const projections: ReadonlyArray<readonly [string | number, string | number]> = [
      [report.insightEventId, row.event_id],
      [report.serviceMarket, row.service_market],
      [report.locale, row.locale],
      [report.scheduledAt.epochMilliseconds, row.scheduled_at_ms.epochMilliseconds],
      [day.timeZone, row.time_zone],
      [day.localDate, row.local_date],
      [day.from.epochMilliseconds, row.day_from_ms],
      [day.toExclusive.epochMilliseconds, row.day_to_ms],
      [row.instruction_id, row.schedule_id],
      [row.instruction_version, row.schedule_version],
    ];
    if (projections.some(([original, projected]) => original !== projected)) {
      return yield* new InsightUnavailable();
    }
    return report;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
