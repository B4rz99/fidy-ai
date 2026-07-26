import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { CreateTransactionInput, Direction, Transaction } from "./model";

const decodeDirection = Schema.decodeUnknownResult(Direction);
const decodeTransaction = Schema.decodeUnknownResult(Transaction);

/**
 * A whole Transaction as it arrives on the wire, defaulted so a test spells out
 * only the field it is about: an outflow of 25.000 COP to "El Corral".
 */
const wireTransaction = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: "f1d1a000-0000-4000-8000-0000000000aa",
  money: { amount: "25000", currency: "COP" },
  merchant: "El Corral",
  direction: "outflow",
  occurredAt: "2026-07-20T12:30:00Z",
  createdAt: "2026-07-21T08:00:00Z",
  ...overrides,
});

it("accepts both of the two ways money can move", () => {
  expect(Result.isSuccess(decodeDirection("outflow"))).toBe(true);
  expect(Result.isSuccess(decodeDirection("inflow"))).toBe(true);
});

it("rejects a third kind of movement, which is a domain decision and not a spelling", () => {
  expect(Result.isFailure(decodeDirection("transfer"))).toBe(true);
});

it("accepts a positive Transaction with nested Money and both instants", () => {
  expect(Result.isSuccess(decodeTransaction(wireTransaction()))).toBe(true);
});

it("accepts Transaction Money in a Currency independent of the Colombia ServiceMarket", () => {
  expect(
    Result.isSuccess(
      decodeTransaction(wireTransaction({ money: { amount: "12.34", currency: "USD" } }))
    )
  ).toBe(true);
});

it("rejects zero Transaction Money at the nested amount field", () => {
  const decoded = decodeTransaction(wireTransaction({ money: { amount: "0", currency: "COP" } }));

  expect(Result.isFailure(decoded) ? String(decoded.failure) : "").toContain('["money"]["amount"]');
});

it("rejects the legacy top-level amount and currency shape", () => {
  const { money: _, ...withoutMoney } = wireTransaction();

  expect(
    Result.isFailure(decodeTransaction({ ...withoutMoney, amount: 25_000, currency: "COP" }))
  ).toBe(true);
});

it("carries no owner, so a client cannot name whose transaction it is creating", () => {
  expect(Object.keys(CreateTransactionInput.fields)).not.toContain("userId");
});

it("derives the create input from the canonical transaction, minus the server-assigned fields", () => {
  expect(Object.keys(CreateTransactionInput.fields)).toEqual(
    Object.keys(Transaction.fields).filter((field) => field !== "id" && field !== "createdAt")
  );
});
