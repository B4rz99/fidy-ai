import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { Category } from "~/core/categories/model";
import { CategoryId } from "~/core/categories/reference";
import { dashboardBucket, includesDashboardTransaction } from "./projection";

const categoryId = CategoryId.make("10000000-0000-4000-8000-000000000001");
const category = Schema.decodeSync(Category)({ id: categoryId, label: "Restaurantes" });
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
