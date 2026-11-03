import { BigDecimal, DateTime, Effect, Exit, Schema } from "effect";
import { expect, it } from "vitest";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { Money } from "../../src/core/_shared/money";
import { BudgetId, type BudgetStatus, BudgetWorkspace } from "../../src/core/budgets/contract";
import { deriveCurrentBudgetMonth } from "../../src/core/budgets/operations";
import { CategoryId } from "../../src/core/categories/contract";
import { encodeBudgetWorkspace } from "./internal/workspace-encoding";

const encodeOriginal = Schema.encodeEffect(Schema.toCodecJson(BudgetWorkspace));
type Workspace = typeof BudgetWorkspace.Type;
const money = (amount: bigint): Money =>
  Money.make({ amount: BigDecimal.make(amount, 0), currency: "COP" });
const fixture = (type: "under" | "reached" | "over", zone: string): Workspace => {
  const period = deriveCurrentBudgetMonth({
    now: DateTime.makeUnsafe("2026-03-15T12:00:00Z"),
    timeZone: IanaTimeZone.make(zone),
  });
  const budget = {
    id: BudgetId.make("10000000-0000-4000-8000-000000000001"),
    categoryId: CategoryId.make("20000000-0000-4000-8000-000000000001"),
    cap: money(100n),
    createdAt: period.from,
    updatedAt: period.from,
    groupName: "Casa",
  };
  const common = { budget, period };
  const status = ((): BudgetStatus => {
    if (type === "under") return { ...common, type, spent: money(80n), remaining: money(20n) };
    if (type === "reached") return { ...common, type, spent: money(100n) };
    return { ...common, type, spent: money(120n), overBy: money(20n) };
  })();
  return {
    period,
    budgets: [budget],
    statuses: [status],
    cashFlow: { income: [], expenses: [status.spent] },
    unbudgetedExpenses: [],
    initialized: true,
  };
};
const sameEncoding = (workspace: Workspace): Effect.Effect<void> =>
  Effect.gen(function* () {
    const original = yield* Effect.exit(encodeOriginal(workspace));
    const optimized = yield* Effect.exit(encodeBudgetWorkspace(workspace));
    expect(Exit.isSuccess(optimized)).toBe(Exit.isSuccess(original));
    if (Exit.isSuccess(original) && Exit.isSuccess(optimized)) {
      expect(optimized.value).toEqual(original.value);
    }
  });

it.each(["America/Bogota", "America/New_York", "Asia/Kathmandu"])(
  "preserves complete Budget encodings for shared calendar periods in %s",
  (zone) =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const type of ["under", "reached", "over"] as const) {
          yield* sameEncoding(fixture(type, zone));
        }
      })
    )
);
it("preserves valid independently represented status periods", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const workspace = fixture("under", "America/Bogota");
      for (const period of [
        { ...workspace.period },
        deriveCurrentBudgetMonth({
          now: DateTime.makeUnsafe("2024-02-15T12:00:00Z"),
          timeZone: IanaTimeZone.make("America/Bogota"),
        }),
      ]) {
        yield* sameEncoding({
          ...workspace,
          statuses: workspace.statuses.map((status) => ({ ...status, period })),
        });
      }
    })
  ));
it("retains invalid month, exact progress, Currency, cap, group and timestamp refusals", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const workspace = fixture("under", "America/Bogota");
      const period = { ...workspace.period, to: DateTime.add(workspace.period.to, { hours: 1 }) };
      const cases: ReadonlyArray<Workspace> = [
        {
          ...workspace,
          statuses: workspace.statuses.map((status) => ({
            ...status,
            type: "reached",
            spent: money(80n),
          })),
        },
        {
          ...workspace,
          statuses: workspace.statuses.map((status) => ({
            ...status,
            type: "over",
            spent: money(120n),
            overBy: money(99n),
          })),
        },
        {
          ...workspace,
          statuses: workspace.statuses.map((status) => ({
            ...status,
            spent: { ...status.spent, amount: BigDecimal.make(80001n, 3) },
          })),
        },
        {
          ...workspace,
          period,
          statuses: workspace.statuses.map((status) => ({ ...status, period })),
        },
        {
          ...workspace,
          statuses: workspace.statuses.map((status) => ({
            ...status,
            spent: { ...status.spent, currency: "USD" },
          })),
        },
        {
          ...workspace,
          statuses: workspace.statuses.map((status) => ({
            ...status,
            type: "under",
            remaining: money(99n),
          })),
        },
        {
          ...workspace,
          budgets: workspace.budgets.map((budget) => ({ ...budget, cap: money(0n) })),
        },
        {
          ...workspace,
          budgets: workspace.budgets.map((budget) => ({ ...budget, groupName: " " })),
        },
        {
          ...workspace,
          budgets: workspace.budgets.map((budget) => ({
            ...budget,
            createdAt: DateTime.makeUnsafe(253402300800000),
          })),
        },
      ];
      for (const invalid of cases) {
        expect(Exit.isFailure(yield* Effect.exit(encodeOriginal(invalid)))).toBe(true);
        yield* sameEncoding(invalid);
      }
    })
  ));
