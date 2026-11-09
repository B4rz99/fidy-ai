import { expect, it } from "vitest";
import { DateTime, Option, Schema } from "effect";
import { Money } from "~/core/_shared/money";
import { formatWhatsAppLocalDate, formatWhatsAppMoney } from "./operations";

it.each([
  ["123456789012345678.25", "USD", "123.456.789.012.345.678,25 USD"],
  ["12500", "COP", "12.500 pesos"],
  ["0", "COP", "0 pesos"],
])("keeps exact Money while formatting %s %s", (amount, currency, expected) => {
  const money = Schema.decodeSync(Schema.toCodecJson(Money))({ amount, currency });
  expect(formatWhatsAppMoney(money)).toBe(expected);
});
it("uses the User's local day rather than the UTC date", () => {
  expect(
    formatWhatsAppLocalDate({
      date: DateTime.makeUnsafe("2026-11-02T02:00:00Z"),
      timeZone: "America/Bogota",
    })
  ).toEqual(Option.some("1 de noviembre de 2026"));
});
