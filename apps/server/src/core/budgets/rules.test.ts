import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Equal, Result } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { Currency, Money } from "~/core/_shared/money";
import { BudgetId } from "./reference";
import type { Budget } from "./model";
import {
  advanceBudgetLatch,
  calculateBudgetStatus,
  deriveCurrentBudgetMonth,
  sumBudgetContributions,
} from "./rules";
import { CategoryId } from "~/core/categories/reference";

const money = (amount: string, currency: Currency = Currency.make("COP")): Money =>
  Money.make({ amount: BigDecimal.fromStringUnsafe(amount), currency });

const budget: Budget = {
  id: BudgetId.make("f1d1a000-0000-4000-8000-0000000000bb"),
  categoryId: CategoryId.make("10000000-0000-4000-8000-000000000001"),
  cap: money("1000"),
  createdAt: DateTime.makeUnsafe("2026-07-01T12:00:00Z"),
  updatedAt: DateTime.makeUnsafe("2026-07-01T12:00:00Z"),
};

const period = deriveCurrentBudgetMonth({
  now: DateTime.makeUnsafe("2026-07-15T12:00:00Z"),
  timeZone: IanaTimeZone.make("America/Bogota"),
});

const initialLatch = (): Parameters<typeof advanceBudgetLatch>[0]["latch"] => ({
  budgetId: budget.id,
  period,
  reached80: false,
  reached100: false,
});

it("calculates the half-open calendar month in the explicitly applied IANA time zone", () => {
  const newYork = deriveCurrentBudgetMonth({
    now: DateTime.makeUnsafe("2026-03-15T12:00:00Z"),
    timeZone: IanaTimeZone.make("America/New_York"),
  });

  expect(DateTime.formatIso(newYork.from)).toBe("2026-03-01T05:00:00.000Z");
  expect(DateTime.formatIso(newYork.to)).toBe("2026-04-01T04:00:00.000Z");
  expect(newYork.timeZone).toBe("America/New_York");
});

it("returns exact under, reached, and over variants in the Budget Currency", () => {
  const under = Effect.runSync(calculateBudgetStatus({ budget, spent: money("250.25"), period }));
  const reached = Effect.runSync(calculateBudgetStatus({ budget, spent: money("1000"), period }));
  const over = Effect.runSync(calculateBudgetStatus({ budget, spent: money("1250.75"), period }));

  expect(under.type).toBe("under");
  expect(
    under.type === "under" && Equal.equals(under.remaining.amount, money("749.75").amount)
  ).toBe(true);
  expect(reached.type).toBe("reached");
  expect(over.type).toBe("over");
  expect(over.type === "over" && Equal.equals(over.overBy.amount, money("250.75").amount)).toBe(
    true
  );
});

it("sums only same-Category, same-Currency outflows inside the half-open zoned month", () => {
  type Movement = Parameters<typeof sumBudgetContributions>[0]["movements"][number];
  const makeMovement = (changes: Partial<Movement> = {}): Movement => ({
    money: money("100"),
    categoryId: budget.categoryId,
    direction: "outflow",
    occurredAt: DateTime.makeUnsafe("2026-07-15T12:00:00Z"),
    ...changes,
  });
  const otherCategory = CategoryId.make("10000000-0000-4000-8000-000000000002");
  const movements = [
    makeMovement({ money: money("10.25"), occurredAt: period.from }),
    makeMovement({ money: money("7.50"), occurredAt: DateTime.makeUnsafe("2026-08-01T04:59:59Z") }),
    makeMovement({ money: money("100", Currency.make("USD")) }),
    makeMovement({ categoryId: otherCategory }),
    makeMovement({ direction: "inflow" }),
    makeMovement({ occurredAt: DateTime.makeUnsafe("2026-07-01T04:59:59Z") }),
    makeMovement({ occurredAt: period.to }),
  ];

  const total = sumBudgetContributions({ budget, period, movements });
  expect(Equal.equals(total.amount, money("17.75").amount)).toBe(true);
  expect(total.currency).toBe("COP");
});

it("latches each crossed threshold once, including a jump across both thresholds", () => {
  const crossed = Effect.runSync(
    advanceBudgetLatch({ budget, spent: money("1000"), latch: initialLatch() })
  );
  expect(crossed.newlyReached).toEqual([80, 100]);
  expect(
    Effect.runSync(advanceBudgetLatch({ budget, spent: money("1200"), latch: crossed.latch }))
      .newlyReached
  ).toEqual([]);
  expect(
    Effect.runSync(advanceBudgetLatch({ budget, spent: money("500"), latch: crossed.latch })).latch
  ).toEqual(crossed.latch);
});

it("uses exact Money at the 80% boundary without rounding or reopening a mark", () => {
  const decimalBudget = { ...budget, cap: money("100.01") };
  const below = Effect.runSync(
    advanceBudgetLatch({ budget: decimalBudget, spent: money("80"), latch: initialLatch() })
  );
  expect(below.newlyReached).toEqual([]);
  const above = Effect.runSync(
    advanceBudgetLatch({ budget: decimalBudget, spent: money("80.01"), latch: below.latch })
  );
  expect(above.newlyReached).toEqual([80]);
  expect(above.latch.reached100).toBe(false);
});

it("does not compare a threshold with spending in another Currency", () => {
  const result = Effect.runSync(
    Effect.result(
      advanceBudgetLatch({
        budget,
        spent: money("100", Currency.make("USD")),
        latch: initialLatch(),
      })
    )
  );
  expect(Result.isFailure(result) ? result.failure._tag : undefined).toBe("CurrencyMismatch");
});

it("refuses to calculate status from spending in another Currency", () => {
  const outcome = Effect.runSync(
    Effect.result(
      calculateBudgetStatus({
        budget,
        spent: money("250", Currency.make("USD")),
        period,
      })
    )
  );

  expect(Result.isFailure(outcome) ? outcome.failure : undefined).toMatchObject({
    _tag: "CurrencyMismatch",
    left: "COP",
    right: "USD",
  });
});
