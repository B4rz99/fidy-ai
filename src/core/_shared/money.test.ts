import { expect, it } from "@effect/vitest";
import { BigDecimal, Effect, Equal, Result, Schema } from "effect";
import {
  Currency,
  CurrencyMismatch,
  Money,
  addMoney,
  compareMoney,
  currencyMetadata,
  groupMoney,
} from "./money";

const decodeCurrency = Schema.decodeUnknownResult(Currency);
const decodeMoney = Schema.decodeUnknownResult(Money);
const encodeMoney = Schema.encodeSync(Money);

const money = (amount: string, currency: Currency = Currency.make("COP")): Money =>
  Money.make({ amount: BigDecimal.fromStringUnsafe(amount), currency });

it("accepts zero Money because the owning operation decides whether zero is meaningful", () => {
  const decoded = decodeMoney({ amount: "0", currency: "COP" });

  expect(Result.isSuccess(decoded)).toBe(true);
});

it("rejects negative, exponent, locale-formatted, and signed decimal text", () => {
  for (const amount of ["-1", "1e3", "1,000", "+1"]) {
    expect(Result.isFailure(decodeMoney({ amount, currency: "COP" }))).toBe(true);
  }
});

it("accepts whole and fractional COP through its two-digit precision", () => {
  expect(Result.isSuccess(decodeMoney({ amount: "25000", currency: "COP" }))).toBe(true);
  expect(Result.isSuccess(decodeMoney({ amount: "25000.75", currency: "COP" }))).toBe(true);
});

it("enforces representative zero-, two-, and three-digit Currency precision", () => {
  expect(Result.isSuccess(decodeMoney({ amount: "12", currency: "JPY" }))).toBe(true);
  expect(Result.isFailure(decodeMoney({ amount: "12.1", currency: "JPY" }))).toBe(true);
  expect(Result.isSuccess(decodeMoney({ amount: "12.34", currency: "USD" }))).toBe(true);
  expect(Result.isFailure(decodeMoney({ amount: "12.345", currency: "USD" }))).toBe(true);
  expect(Result.isSuccess(decodeMoney({ amount: "12.345", currency: "KWD" }))).toBe(true);
  expect(Result.isFailure(decodeMoney({ amount: "12.3456", currency: "KWD" }))).toBe(true);
  expect(Result.isSuccess(decodeMoney({ amount: "12.3456", currency: "UYW" }))).toBe(true);
  expect(Result.isFailure(decodeMoney({ amount: "12.34567", currency: "UYW" }))).toBe(true);
});

it("attributes excessive Currency precision to the nested amount", () => {
  const decoded = decodeMoney({ amount: "12.345", currency: "COP" });

  expect(Result.isFailure(decoded) ? String(decoded.failure) : "").toContain('["amount"]');
});

it("rejects unknown, fund, metal, testing, and no-currency codes", () => {
  for (const currency of ["ZZZ", "CLF", "XAU", "XTS", "XXX"]) {
    expect(Result.isFailure(decodeCurrency(currency))).toBe(true);
  }
});

it("retains stable ISO metadata for every accepted Currency", () => {
  for (const currency of Currency.literals) {
    const metadata = currencyMetadata(currency);

    expect(metadata.alphabeticCode).toBe(currency);
    expect([0, 2, 3, 4]).toContain(metadata.fractionalDigits);
  }
});

it("encodes normalized plain decimal text without trailing zeros or exponent notation", () => {
  expect(encodeMoney(money("25000.7500"))).toEqual({ amount: "25000.75", currency: "COP" });
  expect(encodeMoney(money("0.1"))).toEqual({ amount: "0.1", currency: "COP" });
  expect(encodeMoney(money("0.01"))).toEqual({ amount: "0.01", currency: "COP" });
  expect(encodeMoney(money("100000000000000000000"))).toEqual({
    amount: "100000000000000000000",
    currency: "COP",
  });
});

it("adds and compares Money with equal Currency exactly", () => {
  const total = Effect.runSync(addMoney({ left: money("0.1"), right: money("0.2") }));

  expect(Equal.equals(total.amount, BigDecimal.fromStringUnsafe("0.3"))).toBe(true);
  expect(Effect.runSync(compareMoney({ left: money("1"), right: money("2") }))).toBe(-1);
  expect(Effect.runSync(compareMoney({ left: money("2"), right: money("2.00") }))).toBe(0);
  expect(Effect.runSync(compareMoney({ left: money("3"), right: money("2") }))).toBe(1);
});

it("fails same-Currency operations with typed CurrencyMismatch", () => {
  const usd = money("1", Currency.make("USD"));
  const cop = money("1", Currency.make("COP"));

  const addition = Effect.runSync(Effect.result(addMoney({ left: usd, right: cop })));
  const comparison = Effect.runSync(Effect.result(compareMoney({ left: usd, right: cop })));

  expect(Result.isFailure(addition) ? addition.failure : undefined).toBeInstanceOf(
    CurrencyMismatch
  );
  expect(Result.isFailure(comparison) ? comparison.failure : undefined).toMatchObject({
    left: "USD",
    right: "COP",
  });
});

it("groups inflows and outflows separately in deterministic Currency order", () => {
  const groups = Effect.runSync(
    groupMoney({
      inflows: [
        money("2", Currency.make("USD")),
        money("1", Currency.make("USD")),
        money("3", Currency.make("COP")),
      ],
      outflows: [
        money("4", Currency.make("COP")),
        money("5", Currency.make("USD")),
        money("6", Currency.make("EUR")),
      ],
    })
  );

  expect(groups.map((group) => group.currency)).toEqual(["COP", "EUR", "USD"]);
  expect(groups.map((group) => encodeMoney(group.inflow))).toEqual([
    { amount: "3", currency: "COP" },
    { amount: "0", currency: "EUR" },
    { amount: "3", currency: "USD" },
  ]);
  expect(groups.map((group) => encodeMoney(group.outflow))).toEqual([
    { amount: "4", currency: "COP" },
    { amount: "6", currency: "EUR" },
    { amount: "5", currency: "USD" },
  ]);
});

it("omits Currency groups whose inflow and outflow are both zero", () => {
  const groups = Effect.runSync(groupMoney({ inflows: [money("0")], outflows: [money("0")] }));

  expect(groups).toEqual([]);
});
