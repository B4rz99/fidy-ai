import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { DashboardView } from "./operations";

const widgetId = "f1d1a000-0000-4000-8000-00000000030a";
const category = {
  id: "10000000-0000-4000-8000-000000000001",
  label: "Restaurantes",
};
const appliedPeriod = {
  requested: "this-month",
  from: "2026-07-01T05:00:00.000Z",
  toExclusive: "2026-08-01T05:00:00.000Z",
  timeZone: "America/Bogota",
};
const valid = {
  title: "Mi tablero",
  context: {
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    calculatedAt: "2026-07-20T12:00:00.000Z",
  },
  layout: {
    kind: "leaf",
    widget: {
      widget: {
        id: widgetId,
        type: "spending-chart",
        groupBy: "category",
        period: "this-month",
      },
      result: {
        appliedPeriod,
        buckets: [{ key: { kind: "category", category }, moneyGroups: [] }],
      },
    },
  },
};

it("pairs every enriched Dashboard leaf with its only legal Widget result", () => {
  expect(Result.isSuccess(Schema.decodeUnknownResult(DashboardView)(valid))).toBe(true);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(DashboardView)({
        ...valid,
        layout: {
          kind: "leaf",
          widget: {
            widget: { ...valid.layout.widget.widget, type: "transaction-list", limit: 5 },
            result: valid.layout.widget.result,
          },
        },
      })
    )
  ).toBe(true);
});

it("rejects malformed calendar keys and mixed-Currency Budget results", () => {
  const calendarView = (date: string): unknown => ({
    ...valid,
    layout: {
      kind: "leaf",
      widget: {
        widget: { ...valid.layout.widget.widget, groupBy: "day" },
        result: {
          appliedPeriod,
          buckets: [{ key: { kind: "day", date }, moneyGroups: [] }],
        },
      },
    },
  });
  expect(
    Result.isSuccess(Schema.decodeUnknownResult(DashboardView)(calendarView("2026-07-20")))
  ).toBe(true);
  expect(
    Result.isFailure(Schema.decodeUnknownResult(DashboardView)(calendarView("2026-7-20")))
  ).toBe(true);

  const mixedBudget = {
    ...valid,
    layout: {
      kind: "leaf",
      widget: {
        widget: {
          id: widgetId,
          type: "budget-bar",
          categoryId: category.id,
          currency: "COP",
        },
        result: {
          availability: "available",
          appliedPeriod,
          category,
          currency: "COP",
          cap: { amount: "100", currency: "USD" },
          spent: { amount: "25", currency: "COP" },
          status: { type: "under", remaining: { amount: "75", currency: "COP" } },
        },
      },
    },
  };
  expect(Result.isFailure(Schema.decodeUnknownResult(DashboardView)(mixedBudget))).toBe(true);
  const contradictoryBudget = {
    ...mixedBudget,
    layout: {
      kind: "leaf",
      widget: {
        ...mixedBudget.layout.widget,
        result: {
          ...mixedBudget.layout.widget.result,
          cap: { amount: "100", currency: "COP" },
          status: { type: "under", remaining: { amount: "80", currency: "COP" } },
        },
      },
    },
  };
  expect(Result.isFailure(Schema.decodeUnknownResult(DashboardView)(contradictoryBudget))).toBe(
    true
  );
});

it("strips private Transaction search and tie-breaking fields from enriched leaves", () => {
  const decoded = Schema.decodeUnknownSync(DashboardView)({
    ...valid,
    layout: {
      kind: "leaf",
      widget: {
        widget: { id: widgetId, type: "transaction-list", limit: 5, search: "sensitive" },
        result: {
          transactions: [
            {
              id: "f1d1a000-0000-4000-8000-00000000030b",
              money: { amount: "10", currency: "COP" },
              counterparty: "Proveedor",
              direction: "outflow",
              category,
              occurredAt: "2026-07-20T12:00:00.000Z",
              notes: "sensitive",
              createdAt: "2026-07-20T12:01:00.000Z",
            },
          ],
        },
      },
    },
  });
  if (decoded.layout.kind !== "leaf") throw new Error("Expected leaf");
  const result = decoded.layout.widget.result;
  if (!("transactions" in result)) throw new Error("Expected Transaction list result");

  expect(result.transactions[0]).not.toHaveProperty("notes");
  expect(result.transactions[0]).not.toHaveProperty("createdAt");
  expect(result.transactions[0]?.category).toEqual(category);
});
