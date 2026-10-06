import { DateTime, Effect, Option, Schema } from "effect";
import type { UserId } from "../../../src/core/identity/contract";
import { BudgetCrossing } from "../../../src/core/budgets/contract";
import { MoneyGroups, encodeMoneyAmount, groupMoney } from "../../../src/core/_shared/money";
import { budgetAlertDeadline } from "../../../src/core/insights/operations";
import { type BudgetCrossingGroup } from "../../budgets/contract";
import {
  prepareBudgetCrossingPublication,
  readBudgetCrossingGroups,
} from "../../budgets/operations";
import { prepareConsentAction } from "../../consent/operations";
import { newId } from "../../secret-material/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { InsightUnavailable } from "../contract";

const monthDatePrefixLength = 7;
const assertionSql =
  "INSERT INTO proactivity_message_assertion(id,accepted) VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted";
type Scope = Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>;
const occurrenceProof = (input: Scope, id: string): OwnedStatement => ({
  sql: "SELECT 1 FROM budget_alert_occurrences WHERE user_id=? AND delivery_group_id=?",
  params: [input.userId, id],
});
const messageWrites = (
  input: Scope,
  group: BudgetCrossingGroup
): ReadonlyArray<D1PreparedStatement> => {
  if (Option.isNone(group.grantId)) return [];
  const first = group.crossings[0];
  const expires = budgetAlertDeadline({ detectedAt: first.detectedAt, monthEnd: first.period.to });
  const thresholds = group.crossings.map((crossing) => `${crossing.threshold}%`).join(" y ");
  const text = `Tu presupuesto de la categoría ${first.categoryId} alcanzó el ${thresholds}. Salidas registradas: ${encodeMoneyAmount(first.spent.amount)} ${first.spent.currency}. Tope capturado: ${encodeMoneyAmount(first.cap.amount)} ${first.cap.currency}. Mes aplicado: ${DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(first.period.from, first.period.timeZone)).slice(0, monthDatePrefixLength)} (${first.period.timeZone}).`;
  return [
    input.db
      .prepare(
        "INSERT INTO proactivity_reports(delivery_id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES (?,?,'budget-threshold',?,?,?,?,?,?)"
      )
      .bind(
        group.id,
        input.userId,
        group.grantId.value,
        text,
        first.detectedAt.epochMilliseconds,
        expires.epochMilliseconds,
        first.period.timeZone,
        input.now.epochMilliseconds
      ),
    input.db
      .prepare(
        "INSERT INTO proactivity_message_events(user_id,delivery_id,insight_event_id) SELECT user_id,delivery_group_id,insight_event_id FROM budget_alert_occurrences WHERE user_id=? AND delivery_group_id=?"
      )
      .bind(input.userId, group.id),
    input.db
      .prepare(
        "INSERT INTO proactivity_outbox(user_id,delivery_id,created_at_ms,state) VALUES (?,?,?,?)"
      )
      .bind(
        input.userId,
        group.id,
        input.now.epochMilliseconds,
        expires.epochMilliseconds <= input.now.epochMilliseconds ? "expired" : "ready"
      ),
  ];
};
const commitGroup = (
  input: Scope,
  group: BudgetCrossingGroup
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const money = yield* groupMoney({ inflows: [], outflows: [group.crossings[0].spent] });
    const encodedMoney = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(MoneyGroups))
    )(money);
    const statements: D1PreparedStatement[] = [];
    for (const [index, crossing] of group.crossings.entries()) {
      const id = index === 0 ? group.id : newId();
      const snapshot = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.toCodecJson(BudgetCrossing))
      )(crossing);
      statements.push(
        prepareConsentAction({
          db: input.db,
          subject: { _tag: "User", userId: input.userId },
          requirement: "active",
          statement: {
            sql: "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) SELECT ?,?,'budget-threshold',?,1,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM budget_alert_occurrences WHERE user_id=? AND delivery_group_id=? AND threshold=?)",
            params: [
              id,
              input.userId,
              id,
              crossing.serviceMarket,
              crossing.locale,
              crossing.period.timeZone,
              DateTime.formatIso(crossing.detectedAt),
              encodedMoney,
              input.userId,
              group.id,
              crossing.threshold,
            ],
          },
        })
      );
      statements.push(input.db.prepare(assertionSql));
      statements.push(
        input.db
          .prepare(
            "INSERT INTO budget_alert_occurrences(user_id,delivery_group_id,threshold,insight_event_id,crossing_json) VALUES(?,?,?,?,?)"
          )
          .bind(input.userId, group.id, crossing.threshold, id, snapshot)
      );
    }
    statements.push(
      ...messageWrites(input, group),
      prepareBudgetCrossingPublication({
        ...input,
        id: group.id,
        now: input.now.epochMilliseconds,
        proof: occurrenceProof(input, group.id),
      })
    );
    yield* Effect.tryPromise(() => input.db.batch(statements));
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
/** Freeze published detection facts once; even an ineligible crossing retains its InsightEvents. */
export const generateBudgetAlerts = (input: Scope): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const groups = yield* readBudgetCrossingGroups(input);
    yield* Effect.forEach(groups, (group) => commitGroup(input, group), { discard: true });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
