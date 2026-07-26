import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { Amount, CreateTransactionInput, Direction, Transaction } from "./model";

const decodeAmount = Schema.decodeUnknownResult(Amount);

const decodeDirection = Schema.decodeUnknownResult(Direction);

const decodeTransaction = Schema.decodeUnknownResult(Transaction);

/**
 * A whole Transaction as it arrives on the wire, defaulted so a test spells out
 * only the field it is about: an outflow of 25.000 COP to "El Corral".
 */
const wireTransaction = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: "f1d1a000-0000-4000-8000-0000000000aa",
  amount: 25_000,
  currency: "COP",
  merchant: "El Corral",
  direction: "outflow",
  occurredAt: "2026-07-20T12:30:00Z",
  createdAt: "2026-07-21T08:00:00Z",
  ...overrides,
});

it("rejects an amount of zero, because a logged movement always moves money", () => {
  expect(Result.isFailure(decodeAmount(0))).toBe(true);
});

it("rejects an amount beyond the JSON-safe integer range", () => {
  expect(Result.isFailure(decodeAmount(Number.MAX_SAFE_INTEGER + 1))).toBe(true);
});

it("accepts the largest amount that survives the JSON-number roundtrip", () => {
  expect(Result.isSuccess(decodeAmount(Number.MAX_SAFE_INTEGER))).toBe(true);
});

it("accepts both of the two ways money can move", () => {
  expect(Result.isSuccess(decodeDirection("outflow"))).toBe(true);
  expect(Result.isSuccess(decodeDirection("inflow"))).toBe(true);
});

it("rejects a third kind of movement, which is a domain decision and not a spelling", () => {
  expect(Result.isFailure(decodeDirection("transfer"))).toBe(true);
});

it("accepts a whole movement, currency and both instants included", () => {
  expect(Result.isSuccess(decodeTransaction(wireTransaction()))).toBe(true);
});

it("rejects a movement denominated in anything but the one currency fidy keeps", () => {
  expect(Result.isFailure(decodeTransaction(wireTransaction({ currency: "USD" })))).toBe(true);
});

it("carries no owner, so a client cannot name whose transaction it is creating", () => {
  expect(Object.keys(CreateTransactionInput.fields)).not.toContain("userId");
});

it("derives the create input from the canonical transaction, minus the server-assigned fields", () => {
  expect(Object.keys(CreateTransactionInput.fields)).toEqual(
    Object.keys(Transaction.fields).filter((field) => field !== "id" && field !== "createdAt")
  );
});
