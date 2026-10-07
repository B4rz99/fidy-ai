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
import { ReportJson, type Scope, type StageView } from "./recurring-models";

const assertChanged = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "INSERT INTO proactivity_message_assertion(id,accepted) VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted"
  );
type Publication = Readonly<{
  input: Scope;
  instruction: typeof InstructionRow.Type;
  report: RecurringDigestReport;
}>;
const prepareReport = (
  publication: Publication
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, Schema.SchemaError> =>
  Effect.gen(function* () {
    const { input, instruction, report } = publication;
    const id = report.insightEventId;
    const day = report.payload.confirmationDay;
    const timing = report;
    const statements: D1PreparedStatement[] = [];
    const reportJson = yield* Schema.encodeEffect(ReportJson)(report);
    const groups = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(MoneyGroups))
    )([]);
    statements.push(
      input.db
        .prepare(
          "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) VALUES(?,?,'new-recurring-series',?,?,?,?,?,?,?)"
        )
        .bind(
          id,
          input.userId,
          instruction.id,
          instruction.version,
          report.serviceMarket,
          report.locale,
          day.timeZone,
          DateTime.formatIso(timing.scheduledAt),
          groups
        )
    );
    statements.push(
      input.db
        .prepare(
          "INSERT INTO recurring_digest_reports(user_id,insight_event_id,instruction_id,instruction_version,grant_id,local_date,day_from_ms,day_to_ms,report_json) VALUES(?,?,?,?,?,?,?,?,?)"
        )
        .bind(
          input.userId,
          id,
          instruction.id,
          instruction.version,
          instruction.grant_id,
          day.localDate,
          day.from.epochMilliseconds,
          day.toExclusive.epochMilliseconds,
          reportJson
        )
    );

    return statements;
  });
const prepareDelivery = (publication: Publication): ReadonlyArray<D1PreparedStatement> => {
  const { input, instruction, report } = publication;
  const id = report.insightEventId;
  const day = report.payload.confirmationDay;
  const timing = report;
  const statements: D1PreparedStatement[] = [];
  statements.push(
    input.db
      .prepare(
        "INSERT INTO proactivity_reports(delivery_id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES(?,?,'new-recurring-series',?,?,?,?,?,?)"
      )
      .bind(
        id,
        input.userId,
        instruction.grant_id,
        presentation(report),
        timing.scheduledAt.epochMilliseconds,
        timing.expiresAt.epochMilliseconds,
        day.timeZone,
        input.now.epochMilliseconds
      )
  );
  statements.push(
    input.db
      .prepare(
        "INSERT INTO proactivity_message_events(user_id,delivery_id,insight_event_id) VALUES(?,?,?)"
      )
      .bind(input.userId, id, id)
  );
  statements.push(
    input.db
      .prepare(
        "INSERT INTO proactivity_outbox(user_id,delivery_id,created_at_ms,state) VALUES(?,?,?,?)"
      )
      .bind(
        input.userId,
        id,
        input.now.epochMilliseconds,
        input.now.epochMilliseconds >= timing.expiresAt.epochMilliseconds ? "expired" : "ready"
      )
  );
  return statements;
};
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
        "INSERT OR IGNORE INTO proactivity_message_assertion(id,accepted) VALUES(1,1)"
      ),
      prepareProactivityConsentAction({
        ...input,
        kind: "new-recurring-series",
        grantId: instruction.grant_id,
        statement: {
          sql: "UPDATE proactivity_message_assertion SET accepted=1 WHERE id=1 AND EXISTS(SELECT 1 FROM recurring_digest_instructions WHERE user_id=? AND id=? AND version=? AND grant_id=? AND enabled=1)",
          params: [input.userId, instruction.id, instruction.version, instruction.grant_id],
        },
      }),
      assertChanged(input.db)
    );
    statements.push(
      input.db
        .prepare(
          "INSERT INTO recurring_digest_days(user_id,local_date,day_from_ms,day_to_ms,insight_event_id) VALUES(?,?,?,?,?)"
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
      statements.push(...(yield* prepareReport(publication)), ...prepareDelivery(publication));
    }
    for (const row of rows) {
      statements.push(
        input.db
          .prepare(
            "INSERT INTO recurring_digest_consumption(user_id,confirmation_id,disposition) VALUES(?,?,?)"
          )
          .bind(input.userId, row.confirmation_id, disposition(row, items))
      );
    }
    yield* Effect.tryPromise(() => input.db.batch(statements));
    return items.length === 0
      ? ({ _tag: "Progress" } as const)
      : ({ _tag: "Created", id } as const);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
