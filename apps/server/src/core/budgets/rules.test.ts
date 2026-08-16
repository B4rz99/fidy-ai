import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Equal, Result } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { Currency, Money } from "~/core/_shared/money";
import { BudgetId } from "./reference";
import type { Budget } from "./model";
import { calculateBudgetStatus, deriveCurrentBudgetMonth } from "./rules";
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
