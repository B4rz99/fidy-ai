import { expect, it } from "vitest";
import { formatCurrencyAmount } from "./money";

it.each([
  ["-0.001", "USD", "-$0.00"],
  ["-1234.56", "USD", "-$1,234.56"],
  ["1234.56", "USD", "$1,234.56"],
  ["1234.6", "JPY", "¥1,235"],
  ["9007199254740993.12", "USD", "$9,007,199,254,740,993.12"],
])("formats exact %s %s without losing decimal precision or sign", (amount, currency, result) => {
  expect(formatCurrencyAmount({ amount, currency, locale: "en-US" })).toBe(result);
});
