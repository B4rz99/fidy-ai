import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Option, Schema } from "effect";
import { Currency, Money, MoneyGroups, type ReadonlyMoney } from "~/core/_shared/money";
import { IanaTimeZone } from "~/core/_shared/context";
import { CategoryId } from "~/core/categories/reference";
import { type AppliedDashboardPeriod, Widget } from "./model";
import {
  dashboardBucket,
  groupDashboardChart,
  includesDashboardTransaction,
  selectDashboardFacts,
} from "./projection";

const categoryId = CategoryId.make("10000000-0000-4000-8000-000000000001");
const category = { id: categoryId, label: "Restaurantes" };
const zone = Schema.decodeSync(IanaTimeZone)("America/New_York");

it("keeps a Transaction only when category, half-open period, and normalized notes all match", () => {
  const transaction = {
    categoryId,
    occurredAt: Date.parse("2026-03-09T04:00:00.000Z"),
    counterparty: Option.none<string>(),
    notes: Option.some("Café de mañana"),
  };
  const criteria = {
    categories: Option.some([categoryId]),
    period: Option.some({
      from: Date.parse("2026-03-08T05:00:00.000Z"),
      toExclusive: Date.parse("2026-03-10T04:00:00.000Z"),
    }),
    search: Option.some("CAFÉ"),
  };
  expect(includesDashboardTransaction(transaction, criteria)).toBe(true);
  expect(
    includesDashboardTransaction(transaction, {
      ...criteria,
      period: Option.some({ from: 0, toExclusive: transaction.occurredAt }),
    })
  ).toBe(false);
  expect(
    includesDashboardTransaction(transaction, { ...criteria, search: Option.some("otro") })
  ).toBe(false);
});

it("selects effective facts according to a Widget's Category, search, and period", () => {
  const transaction = {
    categoryId,
    occurredAt: DateTime.makeUnsafe(Date.parse("2026-03-09T04:00:00.000Z")),
    counterparty: Option.none<string>(),
    notes: Option.some("Café de mañana"),
  };
  const facts = [{ transaction, category }];
  const list = Schema.decodeSync(Widget)({
    id: "30000000-0000-4000-8000-000000000001",
    type: "transaction-list",
    limit: 5,
    search: "CAFÉ",
  });
  if (list.type !== "transaction-list") throw new Error("Expected Transaction list");
  const period: AppliedDashboardPeriod = {
    requested: "this-week",
    from: DateTime.makeUnsafe(Date.parse("2026-03-08T05:00:00.000Z")),
    toExclusive: DateTime.makeUnsafe(Date.parse("2026-03-10T04:00:00.000Z")),
    timeZone: zone,
  };
  expect(selectDashboardFacts(facts, list, Option.some(period))).toHaveLength(1);
  expect(
    selectDashboardFacts(
      facts,
      list,
      Option.some({
        ...period,
        toExclusive: transaction.occurredAt,
      })
    )
  ).toHaveLength(0);
  expect(selectDashboardFacts(facts, { ...list, search: "unrelated" }, Option.none())).toHaveLength(
    0
  );
});

it("assigns a UTC instant to the User's local day and month across the DST boundary", () => {
  const occurredAt = Date.parse("2026-03-09T03:30:00.000Z");
  expect(
    dashboardBucket({ groupBy: "category", category, occurredAt, timeZone: zone }).key
  ).toEqual({
    kind: "category",
    category,
  });
  expect(dashboardBucket({ groupBy: "day", category, occurredAt, timeZone: zone }).key).toEqual({
    kind: "day",
    date: "2026-03-08",
  });
  expect(dashboardBucket({ groupBy: "month", category, occurredAt, timeZone: zone }).key).toEqual({
    kind: "month",
    month: "2026-03",
  });
});

it("orders local chart buckets and keeps exact Money grouped by Currency and direction", () => {
  const cop = Currency.make("COP");
  const usd = Currency.make("USD");
  const fact = (
    at: string,
    direction: "inflow" | "outflow",
    money: ReadonlyMoney
  ): Readonly<{
    category: typeof category;
    occurredAt: number;
    direction: "inflow" | "outflow";
    money: ReadonlyMoney;
  }> => ({
    category,
    occurredAt: Date.parse(at),
    direction,
    money,
  });
  const copMoney = (amount: string): Money =>
    Money.make({
      amount: BigDecimal.fromStringUnsafe(amount),
      currency: cop,
    });
  const buckets = groupDashboardChart(
    [
      fact("2026-03-09T04:01:00.000Z", "outflow", copMoney("4.01")),
      fact("2026-03-09T03:30:00.000Z", "outflow", copMoney("1.02")),
      fact(
        "2026-03-09T03:35:00.000Z",
        "inflow",
        Money.make({ amount: BigDecimal.fromStringUnsafe("2.03"), currency: usd })
      ),
      fact("2026-03-09T03:45:00.000Z", "outflow", copMoney("3.04")),
    ],
    { groupBy: "day", timeZone: zone }
  );
  expect([buckets[0]?.key, buckets[1]?.key]).toEqual([
    { kind: "day", date: "2026-03-08" },
    { kind: "day", date: "2026-03-09" },
  ]);
  expect(Schema.encodeSync(MoneyGroups)(buckets[0]?.moneyGroups ?? [])).toEqual([
    {
      currency: "COP",
      inflow: { amount: "0", currency: "COP" },
      outflow: { amount: "4.06", currency: "COP" },
    },
    {
      currency: "USD",
      inflow: { amount: "2.03", currency: "USD" },
      outflow: { amount: "0", currency: "USD" },
    },
  ]);
});
