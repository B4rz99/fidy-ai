import { ConsentSubject } from "../../../src/shell/consent/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { type DateTime, Effect, Option, Schema } from "effect";
import {
  BudgetCrossing,
  BudgetMonthLatch,
  type BudgetStatus,
} from "../../../src/core/budgets/contract";
import { advanceBudgetLatch } from "../../../src/core/budgets/operations";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import { groupMoney } from "../../../src/core/_shared/money";
import {
  InsightEvent,
  InsightEventId,
  ScheduleId,
  ScheduleVersion,
} from "../../../src/core/insights/contract";
import { budgetAlertDeadline } from "../../../src/core/insights/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import {
  formatWhatsAppDate,
  formatWhatsAppMoney,
} from "../../../src/shell/channels/whatsapp/operations";
import { newId } from "../../secret-material/operations";
import { readLocalTransactionAggregate } from "../../transactions/operations";
import { assembleBudgetReport } from "./budget-report";
import { budgetPeriod } from "./budget-queries";
import { localMonth, plannedBudgets } from "./sqlite-planning";

const crossingCodec = Schema.fromJsonString(Schema.toCodecJson(BudgetCrossing));

const eventCodec = Schema.fromJsonString(Schema.toCodecJson(InsightEvent));

const currentCaps = Effect.fn(function* (user: UserId, now: DateTime.Utc) {
  const sql = yield* SqliteClient;

  const check = protectConsentStatement({
    subject: ConsentSubject.User({ userId: user }),
    requirement: "active",
    statement: {
      sql: "SELECT service_market AS serviceMarket,locale,time_zone AS timeZone FROM users WHERE id=? AND EXISTS(SELECT 1 FROM budgets WHERE user_id=?) AND NOT EXISTS(SELECT 1 FROM erasure_requests)",
      params: [user, user],
    },
  });

  const [raw] = yield* sql.unsafe(check.sql, check.params);

  if (raw === undefined) return Option.none();
  const context = yield* Schema.decodeUnknownEffect(UserContext)(raw);

  const query = { timeZone: context.timeZone },
    period = budgetPeriod({ now, query });

  const caps = yield* plannedBudgets(
    user,
    Option.some(localMonth({ now, zone: context.timeZone })),
    Option.none()
  );

  const aggregates = yield* readLocalTransactionAggregate(
    user,
    period.from.epochMilliseconds,
    period.to.epochMilliseconds
  );

  const { statuses } = yield* assembleBudgetReport({
    budgets: caps.active,
    aggregates,
    period,
    query,
    initialized: false,
  });

  return Option.some({ statuses, context });
});

const liveGrant = Effect.fn(function* (user: UserId) {
  const sql = yield* SqliteClient;

  const [grant] =
    yield* sql`SELECT g.id FROM proactive_grants g JOIN reminder_channels c ON c.grant_id=g.id JOIN users u ON u.id=g.user_id AND u.whatsapp_bsuid=c.bsuid AND u.whatsapp_portfolio_id=c.portfolio WHERE g.user_id=${user} AND g.kind='budget-threshold' AND g.revoked_at_ms IS NULL`;

  return yield* Schema.decodeUnknownEffect(Schema.OptionFromUndefinedOr(Schema.String))(grant?.id);
});

const evaluate = Effect.fn(function* (
  status: BudgetStatus,
  { user, context, now }: { user: UserId; context: UserContext; now: DateTime.Utc }
) {
  const sql = yield* SqliteClient;
  const { budget, period } = status;

  const [prior] =
    yield* sql`SELECT coalesce(max(threshold),0) AS highest FROM budget_threshold_crossings WHERE budget_id=${budget.id} AND month_start=${period.from.epochMilliseconds} AND zone=${period.timeZone}`;

  const highestReached = yield* Schema.decodeUnknownEffect(BudgetMonthLatch.fields.highestReached)(
    prior?.highest
  );

  const { newlyReached } = yield* advanceBudgetLatch({
    budget,
    spent: status.spent,
    latch: { budgetId: budget.id, period, highestReached },
  });

  if (newlyReached.length === 0) return false;
  const grantId = yield* liveGrant(user);

  const group = InsightEventId.make(newId()),
    moneyGroups = yield* groupMoney({ inflows: [], outflows: [status.spent] });

  yield* Effect.forEach(
    newlyReached.entries(),
    Effect.fnUntraced(function* ([index, threshold]) {
      const id = index === 0 ? group : InsightEventId.make(newId());

      const event = yield* Schema.encodeEffect(eventCodec)({
        id,
        kind: "budget-threshold",
        scheduleId: ScheduleId.make(id),
        scheduleVersion: ScheduleVersion.make(1),
        ...context,
        scheduledAt: now,
        moneyGroups,
        lifecycleState: "pending",
      });

      yield* sql`INSERT INTO insight_events(user_id,id,schedule_id,revision,scheduled_ms,event_json) VALUES(${user},${id},${id},1,${now.epochMilliseconds},${event})`;

      const frozen = yield* Schema.encodeEffect(crossingCodec)({
        budgetId: budget.id,
        categoryId: budget.categoryId,
        cap: budget.cap,
        spent: status.spent,
        period,
        threshold,
        detectedAt: now,
        serviceMarket: context.serviceMarket,
        locale: context.locale,
      });

      yield* sql`INSERT INTO budget_threshold_crossings VALUES(${budget.id},${period.from.epochMilliseconds},${period.timeZone},${threshold},${id},${group},${Option.getOrNull(grantId)},${frozen})`;
    }),
    { discard: true }
  );

  if (Option.isNone(grantId)) return false;
  const [category] = yield* sql`SELECT label FROM categories WHERE id=${budget.categoryId}`;
  const label = yield* Schema.decodeUnknownEffect(Schema.String)(category?.label);

  const monthName = formatWhatsAppDate(
    localMonth({ now: period.from, zone: period.timeZone }) + "-01"
  ).replace(/^1 de /u, "");

  const message = `Llevas ${formatWhatsAppMoney(status.spent)} de los ${formatWhatsAppMoney(budget.cap)} de tu presupuesto de ${label} para ${monthName}. Alcanzaste el ${newlyReached.map((threshold) => threshold + "%").join(" y el ")}.`;
  yield* sql`INSERT INTO category_alert_groups VALUES(${group},${grantId.value},${message},${budgetAlertDeadline({ detectedAt: now, monthEnd: period.to }).epochMilliseconds},${now.epochMilliseconds})`;

  return true;
});

export const detectLocalThresholds = Effect.fn(function* (user: UserId, now: DateTime.Utc) {
  const held = yield* currentCaps(user, now);

  if (Option.isNone(held)) return false;

  const pending = yield* Effect.forEach(held.value.statuses, (status) =>
    evaluate(status, { user, context: held.value.context, now })
  );

  return pending.includes(true);
});
