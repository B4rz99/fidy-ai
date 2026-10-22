import { Result, Schema } from "effect";
import { expect, it } from "vitest";
import { RecurringDate, RecurringMonth, RecurringPlanInput } from "./contract";

const plan = {
  name: "Arriendo",
  kind: "expense",
  currency: "COP",
  amountMode: "unknown",
  frequency: "monthly",
  firstDate: "2026-01-31",
  timeZone: "America/Bogota",
};

it("accepts real local dates in the supported century and rejects normalized or partial spellings", () => {
  const decode = Schema.decodeUnknownResult(RecurringDate);
  for (const value of ["2000-01-01", "2099-12-31", "2028-02-29"]) {
    expect(Result.isSuccess(decode(value))).toBe(true);
  }
  for (const value of [
    "1999-12-31",
    "2100-01-01",
    "2026-02-29",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
    "2026-1-01",
    "2026-01-1",
    "2026-01-01T00:00:00Z",
    "x2026-01-01",
    "2026-01-01x",
    "202a-01-01",
    "2026-ab-01",
    "2026-01-ab",
    "2026/01/01",
  ]) {
    expect(Result.isFailure(decode(value)), value).toBe(true);
  }
  const month = Schema.decodeUnknownResult(RecurringMonth);
  for (const value of ["2000-01", "2099-09", "2026-10", "2026-11", "2026-12"]) {
    expect(Result.isSuccess(month(value))).toBe(true);
  }
  for (const value of [
    "1999-12",
    "2100-01",
    "2026-00",
    "2026-13",
    "2026-19",
    "2026-1",
    "2026-001",
    "x2026-01",
    "2026-01x",
    "202a-01",
    "2026/01",
  ]) {
    expect(Result.isFailure(month(value)), value).toBe(true);
  }
});

it("requires bounded trimmed names, coherent Money and a nondecreasing schedule", () => {
  const decode = Schema.decodeUnknownResult(RecurringPlanInput);
  for (const value of [
    plan,
    { ...plan, name: "a".repeat(120), counterparty: "b".repeat(120) },
    { ...plan, endDate: plan.firstDate },
    { ...plan, kind: "transfer", cardPayment: true },
    { ...plan, cardPayment: false },
    { ...plan, amountMode: "fixed", money: { amount: "0.01", currency: "COP" } },
    { ...plan, amountMode: "estimated", money: { amount: "100", currency: "COP" } },
    { ...plan, frequency: "twice-monthly", monthDays: [1, 31] },
    { ...plan, frequency: "twice-monthly", monthDays: [15, "last"] },
  ]) {
    expect(Result.isSuccess(decode(value))).toBe(true);
  }
  for (const change of [
    { name: "" },
    { name: " Arriendo" },
    { name: "Arriendo " },
    { name: "a".repeat(121) },
    { counterparty: "" },
    { counterparty: " a " },
    { counterparty: "a".repeat(121) },
    { cardPayment: true },
    { kind: "income", cardPayment: true },
    { endDate: "2026-01-30" },
    { money: { amount: "100", currency: "COP" } },
    { amountMode: "fixed" },
    { amountMode: "estimated" },
    { amountMode: "fixed", money: { amount: "0", currency: "COP" } },
    { amountMode: "fixed", money: { amount: "100", currency: "USD" } },
    { frequency: "twice-monthly" },
    { frequency: "twice-monthly", monthDays: [15, 15] },
    { frequency: "twice-monthly", monthDays: ["last", "last"] },
    { frequency: "twice-monthly", monthDays: [0, 15] },
    { frequency: "twice-monthly", monthDays: [15, 32] },
  ]) {
    expect(Result.isFailure(decode({ ...plan, ...change })), JSON.stringify(change)).toBe(true);
  }
});
