import { DateTime, Effect, Exit } from "effect";
import { expect, it } from "vitest";
import { encodeMoneyAmount } from "../../src/core/_shared/money";
import { budgetFromRow, budgetsFromRows } from "./internal/budget-row";

const row = {
  id: "10000000-0000-4000-8000-000000000001",
  category_id: "20000000-0000-4000-8000-000000000001",
  currency: "COP",
  cap: "100.00",
  created_at_ms: 0,
  updated_at_ms: 0,
};
it.each([null, "Casa", undefined])(
  "decodes exact cap and native timestamps with group %s",
  (group) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const input = group === undefined ? row : { ...row, group_name: group };
        const budget = yield* budgetFromRow(input);
        expect(encodeMoneyAmount(budget.cap.amount)).toBe("100");
        expect(budget.cap.currency).toBe("COP");
        expect(DateTime.formatIso(budget.createdAt)).toBe("1970-01-01T00:00:00.000Z");
        expect(budget.groupName).toBe(group ?? undefined);
        expect(yield* budgetsFromRows([input, input])).toEqual([budget, budget]);
      })
    )
);
it.each([-62135596800000, 253402300799999])(
  "retains the supported timestamp boundary %i",
  (milliseconds) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const budget = yield* budgetFromRow({ ...row, created_at_ms: milliseconds });
        expect(budget.createdAt.epochMilliseconds).toBe(milliseconds);
      })
    )
);
it.each([
  { cap: "0" },
  { cap: "-1" },
  { cap: "1e3" },
  { cap: "1.001" },
  { cap: "01" },
  { currency: "ABC" },
  { group_name: " " },
  { group_name: "" },
  { id: "invalid" },
  { category_id: null },
  { created_at_ms: -62135596800001 },
  { created_at_ms: 253402300800000 },
  { created_at_ms: Number.POSITIVE_INFINITY },
  { updated_at_ms: "0" },
])("refuses malformed retained Budget facts %j", (invalid) =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* Effect.exit(budgetFromRow({ ...row, ...invalid })))).toBe(true);
      expect(
        Exit.isFailure(yield* Effect.exit(budgetsFromRows([row, { ...row, ...invalid }])))
      ).toBe(true);
    })
  )
);
