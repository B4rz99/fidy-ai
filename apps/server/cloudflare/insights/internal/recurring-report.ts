import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { type LocalMutationResult, notFoundRejection } from "../../canonical-admission/contract";
import { Effect, Option, Schema } from "effect";
import {
  InsightEvent,
  type InsightEventId,
  RecurringDigestReport,
} from "../../../src/core/insights/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { InsightUnavailable } from "../contract";
import { ReportJson } from "./recurring-models";

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

export const readLocalReport = Effect.fn(function* (
  input: Parameters<typeof recurringReportQuery>[0]
) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT e.event_json,r.report_json FROM insight_events e JOIN recurring_digest_reports r ON r.event_id=e.id WHERE e.user_id=${input.userId} AND e.id=${input.id}`;

  if (row === undefined) {
    return yield* notFoundRejection("Recurring report unavailable.");
  }

  const { event, report } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      event: Schema.fromJsonString(Schema.toCodecJson(InsightEvent)),
      report: ReportJson,
    })
  )({ event: row.event_json, report: row.report_json });

  if (
    event.kind !== "new-recurring-series" ||
    report.insightEventId !== event.id ||
    report.payload.confirmationDay.timeZone !== event.timeZone ||
    report.scheduledAt.epochMilliseconds !== event.scheduledAt.epochMilliseconds
  ) {
    return yield* new InsightUnavailable({ cause: Option.none() });
  }

  const response: LocalMutationResult = {
    status: 200,
    outcome: "success",
    body: {
      data: yield* Schema.encodeEffect(Schema.toCodecJson(RecurringDigestReport))(report),
      next: [],
    },
  };

  return response;
});
