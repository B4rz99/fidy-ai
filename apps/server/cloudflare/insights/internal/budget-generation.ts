import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
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

type Scope = Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>;
const occurrenceProof = (input: Scope, id: string): OwnedStatement => ({
  sql: "SELECT 1 FROM (SELECT rowid,user_id,budget_delivery_group_id AS delivery_group_id,budget_threshold AS threshold,id AS insight_event_id,budget_crossing_json AS crossing_json FROM insight_events WHERE budget_delivery_group_id IS NOT NULL) WHERE user_id=? AND delivery_group_id=?",
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
        "INSERT INTO insight_reports(kind,delivery_id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts) VALUES ('proactivity-delivery',?,?,'budget-threshold',?,?,?,?,?,? ,CASE WHEN ?6<=?8 THEN 'expired' ELSE 'ready' END,?8,0,0)"
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
        "UPDATE insight_events SET report_delivery_id=?2 WHERE user_id=?1 AND budget_delivery_group_id=?2 AND report_delivery_id IS NULL"
      )
      .bind(input.userId, group.id),
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
            sql: "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json,budget_delivery_group_id,budget_threshold,budget_crossing_json) SELECT ?,?,'budget-threshold',?,1,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM (SELECT rowid,user_id,budget_delivery_group_id AS delivery_group_id,budget_threshold AS threshold,id AS insight_event_id,budget_crossing_json AS crossing_json FROM insight_events WHERE budget_delivery_group_id IS NOT NULL) WHERE user_id=? AND delivery_group_id=? AND threshold=?)",
            params: [
              id,
              input.userId,
              id,
              crossing.serviceMarket,
              crossing.locale,
              crossing.period.timeZone,
              DateTime.formatIso(crossing.detectedAt),
              encodedMoney,
              group.id,
              crossing.threshold,
              snapshot,
              input.userId,
              group.id,
              crossing.threshold,
            ],
          },
        })
      );
      statements.push(prepareChangedRowAssertion({ db: input.db, scope: "proactivity_message" }));
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
