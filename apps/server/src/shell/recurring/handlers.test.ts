import { expect, layer } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Option } from "effect";
import { Currency, Money, encodeMoneyAmount } from "~/core/_shared/money";
import { type RecurringSeriesReport } from "~/core/recurring/model";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";

const money = (amount: string, currency: Currency = Currency.make("COP")): Money =>
  Money.make({ amount: BigDecimal.fromStringUnsafe(amount), currency });

const resetRecurringSeries = Effect.gen(function* () {
  yield* truncateTransactions;
  const sql = yield* MigrationSqlClient;
  yield* sql`TRUNCATE recurring_series`;
});

/** Currency, series count, and exact direction-separated totals, as plain comparable values. */
const reportShape = (
  report: RecurringSeriesReport
): ReadonlyArray<readonly [string, number, string, string]> =>
  report.groups.map((group) => [
    group.currency,
    group.series.length,
    encodeMoneyAmount(group.perOccurrence.inflow.amount),
    encodeMoneyAmount(group.perOccurrence.outflow.amount),
  ]);

// The seeded harness User was created on 2026-01-01, so movements dated after it count as
// watched rather than imported and the cold-start window is long past.
const monthlyDates = [
  "2026-04-05T14:00:00Z",
  "2026-05-05T09:30:00Z",
  "2026-06-05T18:45:00Z",
] as const;

const claroMonthly = Effect.fn("claroMonthly")(function* (currency?: Currency) {
  const client = yield* ApiHarnessClient;
  return yield* Effect.forEach(monthlyDates, (occurredAt) =>
    client.transactions.createTransaction({
      payload: transactionPayload({
        counterparty: "Claro",
        money: currency === undefined ? money("50000") : money("12", currency),
        occurredAt: DateTime.makeUnsafe(occurredAt),
      }),
    })
  );
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "recurring series operations",
  (it) => {
    it.effect("confirms a monthly series once and reports it under its own Currency", () =>
      Effect.gen(function* () {
        yield* resetRecurringSeries;
        const client = yield* ApiHarnessClient;
        yield* claroMonthly();

        const first = yield* client.recurring.detectRecurringSeries();
        const again = yield* client.recurring.detectRecurringSeries();
        const reported = yield* client.recurring.listRecurringSeries();

        expect(
          first.data.confirmed.map((series) => [
            series.cadence,
            series.counterparty,
            series.occurrences.length,
            series.announcement,
          ])
        ).toStrictEqual([["monthly", "Claro", 3, { state: "announceable" }]]);
        // The trigger payload carries Currency-grouped Money and nothing about how it was found.
        expect(
          first.data.announcement.map((group) => [
            group.currency,
            encodeMoneyAmount(group.inflow.amount),
            encodeMoneyAmount(group.outflow.amount),
          ])
        ).toStrictEqual([["COP", "0", "50000"]]);
        // The same history confirms the same series, so nothing is newly confirmed a second time.
        expect(again.data.confirmed).toStrictEqual([]);
        expect(again.data.announcement).toStrictEqual([]);
        expect(reportShape(reported.data)).toStrictEqual([["COP", 1, "0", "50000"]]);
      })
    );

    it.effect("keeps one Counterparty's Currencies as separate groups without converting", () =>
      Effect.gen(function* () {
        yield* resetRecurringSeries;
        const client = yield* ApiHarnessClient;
        yield* claroMonthly();
        yield* claroMonthly(Currency.make("USD"));

        yield* client.recurring.detectRecurringSeries();
        const reported = yield* client.recurring.listRecurringSeries();

        expect(reportShape(reported.data)).toStrictEqual([
          ["COP", 1, "0", "50000"],
          ["USD", 1, "0", "12"],
        ]);
      })
    );

    it.effect("suppresses a series learned entirely from history older than the User", () =>
      Effect.gen(function* () {
        yield* resetRecurringSeries;
        const client = yield* ApiHarnessClient;
        yield* Effect.forEach(
          ["2025-09-05T10:00:00Z", "2025-10-05T10:00:00Z", "2025-11-05T10:00:00Z"],
          (occurredAt) =>
            client.transactions.createTransaction({
              payload: transactionPayload({
                counterparty: "Arriendo",
                money: money("1800000"),
                occurredAt: DateTime.makeUnsafe(occurredAt),
              }),
            })
        );

        const detected = yield* client.recurring.detectRecurringSeries();
        const reported = yield* client.recurring.listRecurringSeries();

        expect(detected.data.confirmed.map((series) => series.announcement)).toStrictEqual([
          { state: "suppressed", reason: "backfill" },
        ]);
        // Suppression withholds the announcement, never the series.
        expect(detected.data.announcement).toStrictEqual([]);
        expect(reportShape(reported.data)).toStrictEqual([["COP", 1, "0", "1800000"]]);
      })
    );

    it.effect("forgets a recorded series a later pass no longer confirms", () =>
      Effect.gen(function* () {
        yield* resetRecurringSeries;
        const client = yield* ApiHarnessClient;
        const created = yield* claroMonthly();
        yield* client.recurring.detectRecurringSeries();

        yield* Effect.forEach(Option.toArray(Option.fromUndefinedOr(created[0])), (first) =>
          client.transactions.deleteTransaction({ params: { id: first.data.id } })
        );
        yield* client.recurring.detectRecurringSeries();
        const reported = yield* client.recurring.listRecurringSeries();

        expect(reportShape(reported.data)).toStrictEqual([]);
      })
    );

    it.effect("answers an empty report before any detection has run", () =>
      Effect.gen(function* () {
        yield* resetRecurringSeries;
        const client = yield* ApiHarnessClient;

        const reported = yield* client.recurring.listRecurringSeries();

        expect(reportShape(reported.data)).toStrictEqual([]);
      })
    );
  }
);
