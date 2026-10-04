import { DateTime } from "effect";
import { expect, it } from "vitest";
import { allowancePeriod, decideConsumption } from "./operations";

it("refuses a full Free meter at the exact next Bogotá month boundary", () => {
  const now = DateTime.makeUnsafe("2026-08-01T04:59:59Z");
  const period = allowancePeriod(now);
  expect(DateTime.formatIso(period.startsAt)).toBe("2026-07-01T05:00:00.000Z");
  expect(DateTime.formatIso(period.resetsAt)).toBe("2026-08-01T05:00:00.000Z");
  const decision = decideConsumption({
    allowance: "canonical_call",
    accessTier: "free",
    consumed: 50,
    now,
  });
  expect(decision).toEqual({
    _tag: "Exhausted",
    allowance: "canonical_call",
    resetsAt: period.resetsAt,
  });
});
