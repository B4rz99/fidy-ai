import { BigDecimal, DateTime, Schema } from "effect";
import { expect, it } from "vitest";
import { type BudgetStatus, budgetFigures, budgetRemaining, summaryFigures } from "./presentation";

const status = ({
  cap,
  spent,
  currency,
}: Readonly<{ cap: string; spent: string; currency: "COP" | "USD" }>): BudgetStatus => {
  const capMoney = { amount: BigDecimal.fromStringUnsafe(cap), currency };
  const spentMoney = { amount: BigDecimal.fromStringUnsafe(spent), currency };
  const difference = BigDecimal.subtract(capMoney.amount, spentMoney.amount);
  const common = {
    budget: {
      id: Schema.decodeSync(Schema.String.pipe(Schema.brand("BudgetId")))(
        "24000000-0000-4000-8000-000000000101"
      ),
      categoryId: Schema.decodeSync(Schema.String.pipe(Schema.brand("CategoryId")))(
        "24000000-0000-4000-8000-000000000102"
      ),
      cap: capMoney,
      createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
      updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    },
    spent: spentMoney,
    period: {
      from: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
      to: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
      timeZone: Schema.decodeSync(Schema.String.pipe(Schema.brand("IanaTimeZone")))("UTC"),
    },
  };
  if (BigDecimal.isNegative(difference)) {
    return { ...common, type: "over", overBy: { amount: BigDecimal.negate(difference), currency } };
  }
  if (BigDecimal.isZero(difference)) {
    return { ...common, type: "reached" };
  }
  return { ...common, type: "under", remaining: { amount: difference, currency } };
};

it("preserves cents above the numeric precision limit and keeps currency totals separate", () => {
  const statuses = [
    status({ cap: "9007199254740993.12", spent: "9007199254740993.10", currency: "COP" }),
    status({ cap: "50.25", spent: "10.1", currency: "USD" }),
    status({ cap: "10", spent: "50.3", currency: "USD" }),
  ];
  const figures = budgetFigures({ statuses, locale: "es-CO" });
  expect(
    figures.map((figure) => ({
      currency: figure.currency,
      remaining: figure.remaining,
      over: figure.over,
    }))
  ).toEqual([
    { currency: "COP", remaining: "$ 0,02", over: false },
    { currency: "USD", remaining: "-$ 0,15", over: true },
  ]);
  expect(figures.map((figure) => figure.percentage).every((value) => value <= 100)).toBe(true);
  expect(
    BigDecimal.format(budgetRemaining(status({ cap: "10", spent: "50.3", currency: "USD" })))
  ).toBe("-40.3");
});

it("counts uncapped expenses and recorded income with exact currency balances", () => {
  const cap = status({ cap: "50.25", spent: "10.1", currency: "USD" });
  const figures = summaryFigures({
    locale: "es-CO",
    report: {
      period: cap.period,
      statuses: [cap],
      cashFlow: {
        income: [{ currency: "COP", amount: BigDecimal.fromStringUnsafe("9007199254740993.12") }],
        expenses: [
          { currency: "COP", amount: BigDecimal.fromStringUnsafe("9007199254740993.10") },
          { currency: "USD", amount: BigDecimal.fromStringUnsafe("20.15") },
        ],
      },
    },
  });
  expect(
    figures.map(({ currency, balance, remaining, allocationAmount }) => ({
      currency,
      balance,
      remaining,
      allocationAmount,
    }))
  ).toEqual([
    {
      currency: "COP",
      balance: "$ 0,02",
      remaining: "-$ 9.007.199.254.740.993,10",
      allocationAmount: "$ 9.007.199.254.740.993,12",
    },
    { currency: "USD", balance: "-$ 20,15", remaining: "$ 30,10", allocationAmount: "$ 50,25" },
  ]);
});

it("calculates unallocated income from planned caps rather than actual spending", () => {
  const cap = status({ cap: "3880000", spent: "3203000", currency: "COP" });
  const figure = summaryFigures({
    locale: "es-CO",
    report: {
      period: cap.period,
      statuses: [cap],
      cashFlow: {
        income: [{ currency: "COP", amount: BigDecimal.fromStringUnsafe("6200000") }],
        expenses: [{ currency: "COP", amount: BigDecimal.fromStringUnsafe("3323000") }],
      },
    },
  })[0];
  expect(figure).toMatchObject({
    unallocated: "$ 2.320.000,00",
    balance: "$ 2.877.000,00",
    remaining: "$ 557.000,00",
    overallocated: false,
  });
});
