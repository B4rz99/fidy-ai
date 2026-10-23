import { DateTime } from "effect";
import { expect, it } from "vitest";
import { allowanceMeter, allowancePeriod, decideConsumption } from "./operations";

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

it.each([
  ["forwarded_email", 30],
  ["media_submission", 2],
  ["hosted_history_turn", 2],
  ["canonical_call", 50],
] as const)("counts one accepted %s against its independent Free allowance", (allowance, limit) => {
  const now = DateTime.makeUnsafe("2026-08-01T05:00:00Z");
  const period = {
    startsAt: DateTime.makeUnsafe("2026-08-01T05:00:00Z"),
    resetsAt: DateTime.makeUnsafe("2026-09-01T05:00:00Z"),
  };
  for (const consumed of [0, limit - 1]) {
    const input = { allowance, accessTier: "free" as const, consumed, now };
    expect(allowanceMeter(input)).toEqual({
      _tag: "Limited",
      limit,
      consumed,
      remaining: limit - consumed,
      period,
    });
    expect(decideConsumption(input)).toEqual({ _tag: "Consume", remaining: limit - consumed - 1 });
  }
  for (const consumed of [limit, limit + 1]) {
    const input = { allowance, accessTier: "free" as const, consumed, now };
    expect(allowanceMeter(input)).toEqual({
      _tag: "Limited",
      limit,
      consumed,
      remaining: 0,
      period,
    });
    expect(decideConsumption(input)).toEqual({
      _tag: "Exhausted",
      allowance,
      resetsAt: period.resetsAt,
    });
  }
  const pro = { allowance, accessTier: "pro" as const, consumed: limit + 1, now };
  expect(allowanceMeter(pro)).toEqual({ _tag: "Uncapped" });
  expect(decideConsumption(pro)).toEqual({ _tag: "Uncapped" });
});
