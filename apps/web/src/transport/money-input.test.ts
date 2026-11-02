import { BigDecimal, Option } from "effect";
import { expect, it } from "vitest";
import { formatMoneyInput, moneyInputHint, parseMoneyInput } from "./money-input";

it("interprets Colombian thousands grouping as whole pesos", () => {
  const money = Option.getOrThrow(parseMoneyInput({ text: "12.500", currency: "COP" }));
  expect(BigDecimal.format(money.amount)).toBe("12500");
  expect(money.currency).toBe("COP");
});

it.each([
  "12.50",
  "12,500.50",
  "12..500",
  "1234.500",
  "0.125",
  "1.23.456",
  "12.500,",
  "12,50,0",
  "1e3",
])("rejects malformed or foreign separators in %s instead of guessing", (text) => {
  expect(Option.isNone(parseMoneyInput({ text, currency: "COP" }))).toBe(true);
});

it.each([
  ["12500", "COP", "12500"],
  ["12.500,50", "COP", "12500.5"],
  [" 12,50 ", "COP", "12.5"],
  ["1.234.567,89", "COP", "1234567.89"],
  ["9.007.199.254.740.993,12", "USD", "9007199254740993.12"],
  ["0,001", "KWD", "0.001"],
  ["1.234", "JPY", "1234"],
] as const)("parses %s as exact %s Money", (text, currency, amount) => {
  const money = Option.getOrThrow(parseMoneyInput({ text, currency }));
  expect(BigDecimal.equals(money.amount, BigDecimal.fromStringUnsafe(amount))).toBe(true);
});

it.each([
  ["", "COP"],
  ["0", "COP"],
  ["-12", "COP"],
  ["+12", "COP"],
  ["12,501", "COP"],
  ["12,500", "COP"],
  ["12,0", "JPY"],
  ["0,0001", "KWD"],
] as const)("rejects nonpositive or excessive precision input %s for %s", (text, currency) => {
  expect(Option.isNone(parseMoneyInput({ text, currency }))).toBe(true);
});

it.each([
  ["12.5", "12,5"],
  ["9007199254740993123456.12", "9007199254740993123456,12"],
])("opens existing Money %s as a round-trippable Colombian draft", (amount, draft) => {
  const money = { amount: BigDecimal.fromStringUnsafe(amount), currency: "COP" as const };
  expect(formatMoneyInput(money)).toBe(draft);
  const parsed = Option.getOrThrow(parseMoneyInput({ text: draft, currency: "COP" }));
  expect(BigDecimal.equals(parsed.amount, money.amount)).toBe(true);
});

it("explains separators and fractional precision for the selected Currency", () => {
  expect(moneyInputHint("COP")).toBe(
    "Usa punto para miles y coma para decimales. Máximo 2 decimales (ej.: 12.500,5)."
  );
  expect(moneyInputHint("JPY")).toBe("Usa punto para miles. JPY no admite decimales.");
  expect(moneyInputHint("KWD")).toContain("Máximo 3 decimales");
});
