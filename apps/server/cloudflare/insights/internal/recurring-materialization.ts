import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { DateTime, Effect, Option, Schema } from "effect";
import { MoneyGroups, encodeMoneyAmount } from "../../../src/core/_shared/money";
import {
  type ConfirmationDay,
  InsightEventId,
  type RecurringDigestItem,
  RecurringDigestPayload,
  RecurringDigestReport,
} from "../../../src/core/insights/contract";
import {
  captureConfirmationDay,
  recurringDigestTiming,
} from "../../../src/core/insights/operations";
import { PreparedProactivityTemplate } from "../../../src/shell/channels/whatsapp/contract";
import { prepareRecurringDigestSourceGuard } from "../../recurring/operations";
import { prepareProactivityConsentAction } from "../../consent/operations";
import { newId } from "../../secret-material/operations";
import { type InstructionRow } from "./recurring-standing";
import {
  type RecurringDigestAdvanceResult as AdvanceResult,
  InsightUnavailable,
} from "../contract";

import type { RecurringUnavailable } from "../../recurring/contract";
import { type Scope, type StageView } from "./recurring-models";

type Publication = Readonly<{
  input: Scope;
  instruction: typeof InstructionRow.Type;
  report: RecurringDigestReport;
}>;
const prepareEvent = ({
  input,
  instruction,
  report,
}: Publication): Effect.Effect<D1PreparedStatement, Schema.SchemaError> =>
  Effect.gen(function* () {
    const groups = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(MoneyGroups))
    )([]);
    return input.db
      .prepare(
        "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at_ms,money_groups_json) VALUES(?,?,'new-recurring-series',?,?,?,?,?,?,?)"
      )
      .bind(
        report.insightEventId,
        input.userId,
        instruction.id,
        instruction.version,
        report.serviceMarket,
        report.locale,
        report.payload.confirmationDay.timeZone,
        report.scheduledAt.epochMilliseconds,
        groups
      );
  });
const prepareContent = ({
  input,
  instruction,
  report,
}: Publication): Effect.Effect<D1PreparedStatement, Schema.SchemaError> =>
  Effect.gen(function* () {
    const day = report.payload.confirmationDay;
    const payload = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(RecurringDigestPayload))
    )(report.payload);
    return input.db
      .prepare(
        "INSERT INTO insight_reports(user_id,insight_event_id,kind,consent_grant_id,payload_json,local_date,day_from_ms,day_to_ms,original_delivery_expires_at_ms) VALUES(?,?,'recurring-digest',?,?,?,?,?,?)"
      )
      .bind(
        input.userId,
        report.insightEventId,
        instruction.grant_id,
        payload,
        day.localDate,
        day.from.epochMilliseconds,
        day.toExclusive.epochMilliseconds,
        report.expiresAt.epochMilliseconds
      );
  });
const prepareReport = (
  publication: Publication
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, Schema.SchemaError> =>
  Effect.gen(function* () {
    const { input, instruction, report } = publication;
    const id = report.insightEventId;
    const day = report.payload.confirmationDay;
    const timing = report;
    const statements: D1PreparedStatement[] = [yield* prepareEvent(publication)];
    statements.push(yield* prepareContent(publication));
    statements.push(
      input.db
        .prepare(
          "INSERT INTO proactive_messages(kind,id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,report_event_id,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts) VALUES('proactivity-delivery',?,?,'new-recurring-series',?,?,?,?,?,?,? ,CASE WHEN ?6<=?8 THEN 'expired' ELSE 'ready' END,?8,0,0)"
        )
        .bind(
          id,
          input.userId,
          instruction.grant_id,
          presentation(report),
          timing.scheduledAt.epochMilliseconds,
          timing.expiresAt.epochMilliseconds,
          day.timeZone,
          input.now.epochMilliseconds,
          id
        )
    );
    statements.push(
      input.db
        .prepare(
          "UPDATE insight_events SET message_kind='proactivity-delivery',message_id=?2 WHERE user_id=?1 AND id=?3 AND message_id IS NULL"
        )
        .bind(input.userId, id, id)
    );

    return statements;
  });
const prepareDay = (
  work: Readonly<{
    input: Scope;
    instruction: typeof InstructionRow.Type;
    checkpoint: string;
    day: ConfirmationDay;
    id: Option.Option<InsightEventId>;
  }>
): Effect.Effect<D1PreparedStatement[], RecurringUnavailable> =>
  Effect.gen(function* () {
    const { input, instruction, checkpoint, day, id } = work;
    const statements = [...(yield* prepareRecurringDigestSourceGuard({ ...input, checkpoint }))];
    statements.push(
      input.db.prepare(
        "INSERT OR IGNORE INTO sql_assertions (scope, accepted) VALUES ('proactivity_message',1)"
      ),
      prepareProactivityConsentAction({
        ...input,
        kind: "new-recurring-series",
        grantId: instruction.grant_id,
        statement: {
          sql: "UPDATE sql_assertions SET accepted=1 WHERE scope='proactivity_message' AND EXISTS(SELECT 1 FROM (SELECT rowid,user_id,id,version,enabled,consent_grant_id AS grant_id,snapshot_json AS context_json,acceptance_from_ms,accepted_at_ms,last_source_identity,next_closed_at_ms,last_evaluated_at_ms,source_checkpoint,source_cursor,source_cutoff_at_ms,source_complete FROM schedules WHERE kind='digest') WHERE user_id=? AND id=? AND version=? AND grant_id=? AND enabled=1)",
          params: [input.userId, instruction.id, instruction.version, instruction.grant_id],
        },
      }),
      prepareChangedRowAssertion({ db: input.db, scope: "proactivity_message" })
    );
    statements.push(
      input.db
        .prepare(
          "INSERT INTO schedule_history(record_type,user_id,local_date,day_from_ms,day_to_ms,insight_event_id) VALUES('digest-day',?,?,?,?,?)"
        )
        .bind(
          input.userId,
          day.localDate,
          day.from.epochMilliseconds,
          day.toExclusive.epochMilliseconds,
          Option.getOrNull(id)
        )
    );

    return statements;
  });
const disposition = (row: StageView, items: ReadonlyArray<RecurringDigestItem>): string => {
  if (items.some((item) => item.confirmationId === row.confirmation_id)) return "included";
  if (row.eligible === "suppressed") return "suppressed";
  if (row.eligible === "invalid") return "invalid";
  return "excluded";
};
const compareItems = (left: RecurringDigestItem, right: RecurringDigestItem): number => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [left.money.currency, right.money.currency],
    [left.counterparty, right.counterparty],
    [left.confirmationId, right.confirmationId],
  ];
  for (const [leftValue, rightValue] of pairs) {
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
};
const presentation = (report: RecurringDigestReport): string => {
  const heading = `Nuevos patrones históricos de cargos recurrentes del ${report.payload.confirmationDay.localDate}. No indica que sigan activos.`;
  const text = `${heading}\n${report.payload.items.map((item) => `${item.counterparty}: ${encodeMoneyAmount(item.money.amount)} ${item.money.currency}; mensual.`).join("\n")}`;
  return Option.isSome(Schema.decodeOption(PreparedProactivityTemplate.fields.parameter)(text))
    ? text
    : `${heading}\n${report.payload.items.length} patrones. Informe completo: https://app.fidyapp.com/insights/recurring/${report.insightEventId}`;
};

export const materializeDay = (
  work: Readonly<{
    input: Scope;
    instruction: typeof InstructionRow.Type;
    checkpoint: string;
    rows: ReadonlyArray<StageView>;
  }>
): Effect.Effect<AdvanceResult, InsightUnavailable> =>
  Effect.gen(function* () {
    const { input, instruction, checkpoint, rows } = work;
    const first = rows[0];
    if (first === undefined) return { _tag: "NoWork" } as const;
    const day = captureConfirmationDay({
      confirmedAt: DateTime.makeUnsafe(first.confirmed_at_ms),
      timeZone: first.context_json.timeZone,
    });
    const items = rows
      .filter(
        (row) =>
          row.eligible === "eligible" && row.confirmed_at_ms >= instruction.acceptance_from_ms
      )
      .flatMap((row) => (Option.isSome(row.item_json) ? [row.item_json.value] : []))
      .sort(compareItems);
    const id = InsightEventId.make(newId());
    const statements = yield* prepareDay({
      input,
      instruction,
      checkpoint,
      day,
      id: items.length === 0 ? Option.none() : Option.some(id),
    });
    if (items.length > 0) {
      const payload = yield* Schema.decodeUnknownEffect(Schema.toType(RecurringDigestPayload))({
        confirmationDay: day,
        items,
      });
      const report = RecurringDigestReport.make({
        insightEventId: id,
        serviceMarket: first.context_json.serviceMarket,
        locale: first.context_json.locale,
        ...recurringDigestTiming(day),
        payload,
      });
      const publication = { input, instruction, report };
      statements.push(...(yield* prepareReport(publication)));
    }
    for (const row of rows) {
      statements.push(
        input.db
          .prepare(
            "INSERT INTO recurring_digest_items(user_id,confirmation_id,disposition) VALUES(?,?,?) ON CONFLICT(user_id,confirmation_id) DO UPDATE SET disposition=excluded.disposition"
          )
          .bind(input.userId, row.confirmation_id, disposition(row, items))
      );
    }
    yield* Effect.tryPromise(() => input.db.batch(statements));
    return items.length === 0
      ? ({ _tag: "Progress" } as const)
      : ({ _tag: "Created", id } as const);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
