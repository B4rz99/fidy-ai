import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Schema } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { Currency, Money, MoneyGroups } from "~/core/_shared/money";
import {
  dashboardMoneyGroupsFromMetrics,
  dashboardMoneyGroupsFromSums,
  resolveDashboardPeriod,
} from "./calculation";

const bogota = Schema.decodeSync(IanaTimeZone)("America/Bogota");
const newYork = Schema.decodeSync(IanaTimeZone)("America/New_York");
const cop = Currency.make("COP");
const usd = Currency.make("USD");
const decimal = BigDecimal.fromStringUnsafe;
const money = (amount: string, currency: Currency): Money =>
  Money.make({ amount: decimal(amount), currency });
const encodeGroups = Schema.encodeSync(MoneyGroups);

it("resolves Monday weeks and rolling local days in the applied IANA time zone", () => {
  const now = DateTime.makeUnsafe("2026-07-22T12:00:00.000Z");
  const thisWeek = resolveDashboardPeriod({ now, period: "this-week", timeZone: bogota });
  const lastSeven = resolveDashboardPeriod({ now, period: "last-7-days", timeZone: bogota });

  expect(DateTime.formatIso(thisWeek.from)).toBe("2026-07-20T05:00:00.000Z");
  expect(DateTime.formatIso(thisWeek.toExclusive)).toBe("2026-07-27T05:00:00.000Z");
  expect(thisWeek.requested).toBe("this-week");
  expect(thisWeek.timeZone).toBe("America/Bogota");
  expect(DateTime.formatIso(lastSeven.from)).toBe("2026-07-16T05:00:00.000Z");
  expect(DateTime.formatIso(lastSeven.toExclusive)).toBe("2026-07-23T05:00:00.000Z");
});

it("keeps local week boundaries exact across daylight-saving transitions", () => {
  const now = DateTime.makeUnsafe("2026-03-10T12:00:00.000Z");
  const previous = resolveDashboardPeriod({ now, period: "last-week", timeZone: newYork });

  expect(DateTime.formatIso(previous.from)).toBe("2026-03-02T05:00:00.000Z");
  expect(DateTime.formatIso(previous.toExclusive)).toBe("2026-03-09T04:00:00.000Z");
});

it("resolves complete current and previous calendar months", () => {
  const now = DateTime.makeUnsafe("2026-03-15T12:00:00.000Z");
  const current = resolveDashboardPeriod({ now, period: "this-month", timeZone: bogota });
  const previous = resolveDashboardPeriod({ now, period: "last-month", timeZone: bogota });

  expect(DateTime.formatIso(current.from)).toBe("2026-03-01T05:00:00.000Z");
  expect(DateTime.formatIso(current.toExclusive)).toBe("2026-04-01T05:00:00.000Z");
  expect(DateTime.formatIso(previous.from)).toBe("2026-02-01T05:00:00.000Z");
  expect(DateTime.formatIso(previous.toExclusive)).toBe("2026-03-01T05:00:00.000Z");
});

it("sums repeated facts while keeping Currency and direction separate in sorted groups", () => {
  const groups = dashboardMoneyGroupsFromSums([
    { direction: "outflow", money: money("12.34", usd) },
    { direction: "inflow", money: money("500", cop) },
    { direction: "outflow", money: money("25", cop) },
    { direction: "outflow", money: money("2.5", cop) },
  ]);

  expect(encodeGroups(groups)).toEqual([
    {
      currency: "COP",
      inflow: { amount: "500", currency: "COP" },
      outflow: { amount: "27.5", currency: "COP" },
    },
    {
      currency: "USD",
      inflow: { amount: "0", currency: "USD" },
      outflow: { amount: "12.34", currency: "USD" },
    },
  ]);
  expect(dashboardMoneyGroupsFromSums([])).toEqual([]);
});

it("finalizes exact sum and maximum metrics without netting directions", () => {
  expect(
    encodeGroups(
      dashboardMoneyGroupsFromMetrics([
        { aggregation: "sum", direction: "outflow", money: money("11", cop) },
        { aggregation: "sum", direction: "inflow", money: money("20", cop) },
      ])
    )
  ).toEqual([
    {
      currency: "COP",
      inflow: { amount: "20", currency: "COP" },
      outflow: { amount: "11", currency: "COP" },
    },
  ]);
  expect(
    encodeGroups(
      dashboardMoneyGroupsFromMetrics([
        { aggregation: "maximum", direction: "outflow", money: money("7", cop) },
        { aggregation: "maximum", direction: "inflow", money: money("20", cop) },
      ])
    )
  ).toEqual([
    {
      currency: "COP",
      inflow: { amount: "20", currency: "COP" },
      outflow: { amount: "7", currency: "COP" },
    },
  ]);
});

it("rounds averages half-even at each Currency precision", () => {
  const groups = dashboardMoneyGroupsFromMetrics([
    {
      aggregation: "average",
      direction: "outflow",
      sum: money("5.01", cop),
      count: 2n,
    },
    {
      aggregation: "average",
      direction: "inflow",
      sum: money("2.01", usd),
      count: 2n,
    },
  ]);

  expect(encodeGroups(groups)).toEqual([
    {
      currency: "COP",
      inflow: { amount: "0", currency: "COP" },
      outflow: { amount: "2.5", currency: "COP" },
    },
    {
      currency: "USD",
      inflow: { amount: "1", currency: "USD" },
      outflow: { amount: "0", currency: "USD" },
    },
  ]);
});
