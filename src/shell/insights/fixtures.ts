import { BigDecimal, DateTime, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { IanaTimeZone } from "~/core/_shared/context";
import { Currency, Money } from "~/core/_shared/money";
import { type InsightGenerationInput, ScheduleId, ScheduleVersion } from "~/core/insights/model";

/** Resets the Insights slice's harness state between tests. */
export const truncateInsights = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`TRUNCATE insight_delivery_attempts, insight_money_groups, insight_events`;
});

/** A generated weekly occurrence, defaulted so tests override only relevant facts. */
export const weeklySummaryInput = (
  overrides: Partial<InsightGenerationInput> = {}
): InsightGenerationInput => {
  const currency = Currency.make("COP");
  return {
    kind: "weekly-summary",
    scheduleId: ScheduleId.make("f1d1a000-0000-4000-8000-000000000201"),
    scheduleVersion: ScheduleVersion.make(2),
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: IanaTimeZone.make("America/Bogota"),
    scheduledAt: DateTime.makeUnsafe("2026-08-09T23:00:00Z"),
    moneyGroups: [
      {
        currency,
        inflow: Money.make({
          amount: BigDecimal.fromStringUnsafe("2000000"),
          currency,
        }),
        outflow: Money.make({
          amount: BigDecimal.fromStringUnsafe("850000"),
          currency,
        }),
      },
    ],
    ...overrides,
  };
};
