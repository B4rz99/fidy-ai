import * as assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Exit, Schema } from "effect";
import { DashboardDocument } from "~/core/dashboard/contract";
import { UserContext } from "~/core/identity/contract";
import { Category } from "~/core/categories/contract";
import { Money } from "~/core/_shared/money";
import { type DashboardFacts, DashboardUnavailable, DashboardView } from "./contract";
import { renderDashboardView } from "./operations";

const now = DateTime.makeUnsafe("2026-07-20T12:00:00.000Z");
const category = Schema.decodeSync(Category)({
  id: "10000000-0000-4000-8000-000000000001",
  label: "Restaurantes",
});
const document = Schema.decodeSync(DashboardDocument)({
  title: "Tablero",
  layout: {
    kind: "leaf",
    widget: {
      id: "10000000-0000-4000-8000-000000000002",
      type: "custom-metric",
      aggregation: "sum",
      period: "this-month",
      label: "Salidas",
    },
  },
});
const money = (amount: string, currency: "COP" | "USD"): Money =>
  Money.make({ amount: BigDecimal.fromStringUnsafe(amount), currency });
const facts: DashboardFacts = {
  context: Schema.decodeSync(UserContext)({
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
  }),
  budgets: [],
  categories: new Map([[category.id, category]]),
  lists: new Map(),
  groups: new Map([
    [
      "10000000-0000-4000-8000-000000000002",
      [
        {
          key: "",
          contributions: [
            {
              categoryId: category.id,
              direction: "outflow",
              sum: money("9007199254740993.12", "COP"),
              maximum: money("9007199254740993.12", "COP"),
              count: 1n,
            },
            {
              categoryId: category.id,
              direction: "inflow",
              sum: money("0.01", "USD"),
              maximum: money("0.01", "USD"),
              count: 1n,
            },
          ],
        },
      ],
    ],
  ]),
};

it.effect(
  "publishes a complete Calendar and Currency-separated projection without rounding large Money",
  () =>
    Effect.gen(function* () {
      const view = yield* renderDashboardView({ document, facts, now });
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(DashboardView))(view);
      expect(encoded).toMatchObject({
        layout: {
          kind: "leaf",
          widget: {
            result: {
              appliedPeriod: {
                from: "2026-07-01T05:00:00.000Z",
                toExclusive: "2026-08-01T05:00:00.000Z",
                timeZone: "America/Bogota",
              },
              moneyGroups: [
                {
                  currency: "COP",
                  inflow: { currency: "COP", amount: "0" },
                  outflow: { currency: "COP", amount: "9007199254740993.12" },
                },
                {
                  currency: "USD",
                  inflow: { currency: "USD", amount: "0.01" },
                  outflow: { currency: "USD", amount: "0" },
                },
              ],
            },
          },
        },
      });
    })
);

it.effect(
  "refuses an incomplete Widget projection rather than presenting partial financial totals",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        renderDashboardView({ document, facts: { ...facts, groups: new Map() }, now })
      );
      assert.deepStrictEqual(result, Exit.fail(new DashboardUnavailable()));
    })
);

it.effect("refuses an invalid projected calendar bucket before publishing a view", () =>
  Effect.gen(function* () {
    const chart = yield* Schema.decodeEffect(DashboardDocument)({
      title: "Tablero",
      layout: {
        kind: "leaf",
        widget: {
          id: "10000000-0000-4000-8000-000000000002",
          type: "spending-chart",
          groupBy: "day",
          period: "this-month",
        },
      },
    });
    const invalid = {
      ...facts,
      groups: new Map(
        [...facts.groups].map(
          ([id, ranges]) => [id, ranges.map((range) => ({ ...range, key: "not-a-day" }))] as const
        )
      ),
    };
    const result = yield* Effect.exit(
      renderDashboardView({ document: chart, facts: invalid, now })
    );
    assert.deepStrictEqual(result, Exit.fail(new DashboardUnavailable()));
  })
);
