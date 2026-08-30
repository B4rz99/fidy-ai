import { assert, expect, it } from "@effect/vitest";
import { BigDecimal, Effect, Equal, Exit, Result, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  Currency,
  CurrencyMismatch,
  Money,
  MoneyGroups,
  type ReadonlyMoney,
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

const moneyArbitrary = FastCheck.oneof(
  FastCheck.tuple(FastCheck.bigInt({ min: 0n }), FastCheck.constant(0), FastCheck.constant("JPY")),
  FastCheck.tuple(
    FastCheck.bigInt({ min: 0n }),
    FastCheck.integer({ min: 0, max: 2 }),
    FastCheck.constant("COP")
  ),
  FastCheck.tuple(
    FastCheck.bigInt({ min: 0n }),
    FastCheck.integer({ min: 0, max: 3 }),
    FastCheck.constant("KWD")
  ),
  FastCheck.tuple(
    FastCheck.bigInt({ min: 0n }),
    FastCheck.integer({ min: 0, max: 4 }),
    FastCheck.constant("UYW")
  )
).map(
  ([coefficient, scale, currency]: readonly [
    bigint,
    number,
    "JPY" | "COP" | "KWD" | "UYW",
  ]): ReadonlyMoney => ({
    amount: BigDecimal.make(coefficient, scale),
    currency: Currency.make(currency),
  })
);

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

it("fails same-Currency operations with the exact CurrencyMismatch class", () => {
  const usd = money("1", Currency.make("USD"));
  const cop = money("1", Currency.make("COP"));
  const expected = Exit.fail(new CurrencyMismatch({ left: "USD", right: "COP" }));

  assert.deepStrictEqual(
    Effect.runSync(Effect.exit(addMoney({ left: usd, right: cop }))),
    expected
  );
  assert.deepStrictEqual(
    Effect.runSync(Effect.exit(compareMoney({ left: usd, right: cop }))),
    expected
  );
});

it.effect.prop(
  "round-trips every generated Money value without changing its exact meaning",
  [moneyArbitrary],
  ([generated]: readonly [ReadonlyMoney]) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeEffect(Money)(encodeMoney(generated));

      expect(decoded.currency).toBe(generated.currency);
      expect(Equal.equals(decoded.amount, generated.amount)).toBe(true);
    })
);

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

type EncodedMoneyGroup = Readonly<{
  currency: string;
  inflow: Readonly<{ amount: string; currency: string }>;
  outflow: Readonly<{ amount: string; currency: string }>;
}>;

const encodedGroup = (currency: string): EncodedMoneyGroup => ({
  currency,
  inflow: { amount: "1", currency },
  outflow: { amount: "0", currency },
});

it("accepts only Currency-consistent, non-zero Money groups", () => {
  const wire = [
    {
      currency: "COP",
      inflow: { amount: "10", currency: "COP" },
      outflow: { amount: "0", currency: "COP" },
    },
    {
      currency: "USD",
      inflow: { amount: "0", currency: "USD" },
      outflow: { amount: "2.5", currency: "USD" },
    },
  ];

  expect(Schema.encodeSync(MoneyGroups)(Schema.decodeUnknownSync(MoneyGroups)(wire))).toEqual(wire);

  const group = encodedGroup("COP");
  const cases = [
    [{ ...group, inflow: { amount: "1", currency: "USD" } }, '[0]["inflow"]["currency"]'],
    [{ ...group, outflow: { amount: "0", currency: "USD" } }, '[0]["outflow"]["currency"]'],
    [{ ...group, inflow: { amount: "0", currency: "COP" } }, "non-zero Money value"],
  ] as const;

  for (const [invalid, expectedIssue] of cases) {
    const result = Schema.decodeUnknownResult(MoneyGroups)([invalid]);

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) ? String(result.failure) : "").toContain(expectedIssue);
  }
});

it("requires Money groups in strict ascending Currency order", () => {
  const decode = Schema.decodeUnknownResult(MoneyGroups);

  for (const groups of [
    [],
    [encodedGroup("COP")],
    [encodedGroup("COP"), encodedGroup("EUR")],
    [encodedGroup("COP"), encodedGroup("EUR"), encodedGroup("USD")],
  ]) {
    expect(Result.isSuccess(decode(groups))).toBe(true);
  }

  // The reported index is the later of the offending pair, so an ordered prefix
  // does not shift the correction onto the wrong group.
  const cases = [
    [[encodedGroup("COP"), encodedGroup("COP")], '[1]["currency"]'],
    [[encodedGroup("USD"), encodedGroup("COP")], '[1]["currency"]'],
    [[encodedGroup("COP"), encodedGroup("USD"), encodedGroup("EUR")], '[2]["currency"]'],
  ] as const;

  for (const [groups, expectedPath] of cases) {
    const result = decode(groups);

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) ? String(result.failure) : "").toContain(expectedPath);
  }
});
