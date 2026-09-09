import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { CapturedInterpretationContext } from "~/core/_shared/captured-interpretation-context";
import { Currency } from "~/core/_shared/money";
import { AccountHints } from "~/core/transactions/account-hints";
import { type EmailDocument, parseEmailDocument } from "./document";
import {
  containsCompleteFinancialNumber,
  decodeAccountHints,
  findField,
  makeInterpretation,
  parseAmount,
  resolveCurrency,
} from "./format-support";
import { format as bbvaPse } from "~/shell/ingestion/email-interpretation/formats/bbva-pse/format";
import { format as davibankCard } from "~/shell/ingestion/email-interpretation/formats/davibank-card/format";
import { format as rappicardPurchase } from "~/shell/ingestion/email-interpretation/formats/rappicard-purchase/format";

const context = Schema.decodeSync(CapturedInterpretationContext)({
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
});
const hints = Schema.decodeSync(AccountHints)({});
const defaultRule = {
  currency: Currency.make("COP"),
  basis: "format-cop-default-v1",
} as const;
const document = (rows: EmailDocument["rows"], text = ""): EmailDocument => ({ rows, text });

it("exercises strict shared field, Currency, amount, date, and privacy rejection seams", () => {
  expect(findField(document([]), ["monto"])).toEqual(Option.none());
  expect(findField(document([["monto", ""]]), ["monto"])).toEqual(Option.none());
  expect(
    findField(
      document([
        ["monto", "1"],
        ["monto", "2"],
      ]),
      ["monto"]
    )
  ).toEqual(Option.none());
  expect(findField(document([["monto", "1"]]), ["monto"])).toEqual(Option.some("1"));

  expect(
    resolveCurrency({
      document: document([
        ["currency", "USD"],
        ["moneda", "USD"],
      ]),
      amountText: "1",
      defaultRule,
    })
  ).toEqual(Option.none());
  expect(
    resolveCurrency({ document: document([["currency", "US$"]]), amountText: "1", defaultRule })
  ).toEqual(Option.none());
  expect(resolveCurrency({ document: document([]), amountText: "ABC 1", defaultRule })).toEqual(
    Option.none()
  );
  expect(resolveCurrency({ document: document([]), amountText: "COP USD 1", defaultRule })).toEqual(
    Option.none()
  );
  expect(resolveCurrency({ document: document([]), amountText: "€1", defaultRule })).toEqual(
    Option.none()
  );
  expect(
    resolveCurrency({ document: document([["currency", ""]]), amountText: "1", defaultRule })
  ).toEqual(Option.none());
  expect(resolveCurrency({ document: document([]), amountText: "$1", defaultRule })).toMatchObject({
    value: { currency: "COP", numericText: "1" },
  });

  expect(containsCompleteFinancialNumber("2026-01-15 15")).toBe(false);
  expect(containsCompleteFinancialNumber("4111 1111 1111 1111")).toBe(true);
  expect(containsCompleteFinancialNumber("reference 1234")).toBe(false);

  expect(parseAmount("1,234", "comma-grouped")).toEqual(Option.some("1234"));
  expect(parseAmount("1,234.50", "comma-grouped-decimal")).toEqual(Option.some("1234.50"));
  expect(parseAmount("1.234", "dot-grouped")).toEqual(Option.some("1234"));
  expect(parseAmount("01", "comma-grouped")).toEqual(Option.none());

  const valid = makeInterpretation({
    document: document([]),
    amountText: "1",
    amountStyle: "comma-grouped",
    dateText: "2026/01/15",
    timeText: "10:15",
    dateStyle: "slash",
    context,
    accountHints: hints,
    currencyDefault: defaultRule,
  });
  expect(Option.isSome(valid)).toBe(true);
  expect(
    makeInterpretation({
      document: document([]),
      amountText: "1",
      amountStyle: "comma-grouped",
      dateText: "not-a-date",
      timeText: "10:15",
      dateStyle: "dash",
      context,
      accountHints: hints,
      currencyDefault: defaultRule,
    })
  ).toEqual(Option.none());
  expect(
    makeInterpretation({
      document: document([]),
      amountText: "1",
      amountStyle: "comma-grouped",
      dateText: "2026-02-30",
      timeText: "10:15:30",
      dateStyle: "dash",
      context,
      accountHints: hints,
      currencyDefault: defaultRule,
    })
  ).toEqual(Option.none());
  expect(decodeAccountHints({ cardLastFour: "123" })).toEqual(Option.none());
});

it("projects only visible direct table cells across inert HTML node shapes", () => {
  expect(Option.isSome(parseEmailDocument("<table><tr><th>A</th><td>B</td></tr></table>"))).toBe(
    true
  );
  expect(
    Option.isSome(
      parseEmailDocument(
        "<table><tr><td>A<!-- comment --><script>x</script></td><td>B</td></tr></table>"
      )
    )
  ).toBe(true);
  expect(Option.isSome(parseEmailDocument("<table><tr><div>x</div></tr></table>"))).toBe(true);
  expect(Option.isNone(parseEmailDocument('<link rel="stylesheet"><p>visible</p>'))).toBe(true);
  expect(
    Option.isNone(
      parseEmailDocument("<table><tr><td><span hidden>x</span></td><td>B</td></tr></table>")
    )
  ).toBe(true);
});

it("requires every format-owned structural field after routing nomination", () => {
  const rappiRows = [
    ["método de pago", "*0034"],
    ["monto", "$42.500"],
    ["fecha de la transacción", "2026-01-15 10:15:30"],
    ["no. de autorización", "654321"],
    ["comercio", "tienda ficticia"],
  ];
  expect(Option.isNone(rappicardPurchase.interpret(document(rappiRows, "other"), context))).toBe(
    true
  );
  expect(
    Option.isNone(
      rappicardPurchase.interpret(
        document(
          rappiRows.filter(([label]) => label !== "método de pago"),
          "realizaste una compra con tu rappicard"
        ),
        context
      )
    )
  ).toBe(true);
  expect(
    Option.isNone(
      rappicardPurchase.interpret(
        document(
          rappiRows.map((row) => (row[0] === "método de pago" ? [row[0], "0034"] : row)),
          "realizaste una compra con tu rappicard"
        ),
        context
      )
    )
  ).toBe(true);
  expect(
    Option.isNone(
      rappicardPurchase.interpret(
        document(
          rappiRows.filter(([label]) => label !== "fecha de la transacción"),
          "realizaste una compra con tu rappicard"
        ),
        context
      )
    )
  ).toBe(true);
  expect(
    Option.isNone(
      rappicardPurchase.interpret(
        document(
          rappiRows.map((row) =>
            row[0] === "fecha de la transacción" ? [row[0], "yesterday"] : row
          ),
          "realizaste una compra con tu rappicard"
        ),
        context
      )
    )
  ).toBe(true);

  const bbvaRows = [
    ["tipo de transacción", "pago pse"],
    ["cuenta terminada en", "*0012"],
    ["valor", "$125,000.00"],
    ["fecha de la operación", "2026-01-15"],
    ["hora", "10:15"],
    ["establecimiento", "comercio"],
  ];
  expect(Option.isNone(bbvaPse.interpret(document([], "pago pse"), context))).toBe(true);
  expect(
    Option.isNone(
      bbvaPse.interpret(
        document(
          bbvaRows.filter(([label]) => label !== "cuenta terminada en"),
          "pago pse"
        ),
        context
      )
    )
  ).toBe(true);
  expect(
    Option.isNone(
      bbvaPse.interpret(
        document(
          bbvaRows.map((row) => (row[0] === "cuenta terminada en" ? [row[0], "0012"] : row)),
          "pago pse"
        ),
        context
      )
    )
  ).toBe(true);
  expect(Option.isNone(davibankCard.interpret(document([], "davibank"), context))).toBe(true);
});
