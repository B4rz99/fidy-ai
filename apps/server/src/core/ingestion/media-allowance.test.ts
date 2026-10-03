import { expect, it } from "@effect/vitest";
import { DateTime, Option } from "effect";
import { decideMediaAdmission } from "./operations";

it("admits two Free media units and refuses the third with the next Bogotá reset instant", () => {
  const now = DateTime.makeUnsafe("2026-10-15T12:00:00.000Z");
  expect(decideMediaAdmission({ access: "free", consumed: 0, now })).toEqual({
    _tag: "Admit",
    consumesFreeAllowance: true,
    remaining: Option.some(1),
  });
  expect(decideMediaAdmission({ access: "free", consumed: 1, now })).toEqual({
    _tag: "Admit",
    consumesFreeAllowance: true,
    remaining: Option.some(0),
  });
  const refusal = decideMediaAdmission({ access: "free", consumed: 2, now });
  expect(refusal._tag).toBe("QuotaExhausted");
  if (refusal._tag !== "QuotaExhausted") return;
  expect(DateTime.formatIso(refusal.resetsAt)).toBe("2026-11-01T05:00:00.000Z");
});

it("keeps the October allowance until Bogotá midnight and calculates the new reset at the boundary", () => {
  const cases = [
    { now: "2026-11-01T04:59:59.999Z", resetsAt: "2026-11-01T05:00:00.000Z" },
    { now: "2026-11-01T05:00:00.000Z", resetsAt: "2026-12-01T05:00:00.000Z" },
    { now: "2026-12-31T23:59:59.999Z", resetsAt: "2027-01-01T05:00:00.000Z" },
  ];
  for (const example of cases) {
    const result = decideMediaAdmission({
      access: "free",
      consumed: 2,
      now: DateTime.makeUnsafe(example.now),
    });
    expect(result._tag).toBe("QuotaExhausted");
    if (result._tag !== "QuotaExhausted") continue;
    expect(DateTime.formatIso(result.resetsAt)).toBe(example.resetsAt);
  }
  expect(
    decideMediaAdmission({
      access: "free",
      consumed: 0,
      now: DateTime.makeUnsafe("2026-11-01T05:00:00.000Z"),
    })
  ).toEqual({
    _tag: "Admit",
    consumesFreeAllowance: true,
    remaining: Option.some(1),
  });
});

it("does not cap Pro access or publish a monthly remaining meter", () => {
  expect(
    decideMediaAdmission({
      access: "pro",
      consumed: 500,
      now: DateTime.makeUnsafe("2026-10-15T12:00:00.000Z"),
    })
  ).toEqual({
    _tag: "Admit",
    consumesFreeAllowance: false,
    remaining: Option.none(),
  });
});
