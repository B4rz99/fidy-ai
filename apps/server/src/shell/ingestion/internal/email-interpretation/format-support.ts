import { DateTime, Function, Option, Schema } from "effect";
import { Currency } from "~/core/_shared/money";
import type { CapturedInterpretationContext } from "~/core/interpretation-evidence/contract";
import { AccountHints, type NotificationCurrencyBasis } from "~/core/transactions/contract";
import type { EmailDocument } from "./document";
import type { FormatInterpretation } from "./format-definition";

const rowCell = (row: ReadonlyArray<string>, index: number): string => {
  const cell = row[index];

  if (cell === undefined) throw new Error(`Missing email table cell ${index}`);

  return cell;
};

export const findField: {
  (labels: ReadonlyArray<string>): (document: EmailDocument) => Option.Option<string>;
  (document: EmailDocument, labels: ReadonlyArray<string>): Option.Option<string>;
} = Function.dual(2, (document: EmailDocument, labels: ReadonlyArray<string>) => {
  const values = document.rows
    .filter((row) => row.length === 2 && labels.includes(rowCell(row, 0)))
    .map((row) => rowCell(row, 1));

  return values.length === 1 && values[0] !== "" ? Option.some(rowCell(values, 0)) : Option.none();
});

type CurrencyEvidence = Readonly<{
  currency: Currency;
  basis: NotificationCurrencyBasis;
  numericText: string;
}>;

export type FormatCurrencyDefault = Readonly<{
  currency: Currency;
  basis: Extract<NotificationCurrencyBasis, "format-cop-default-v1">;
}>;

const currencyFieldLabels = ["currency", "currency:", "moneda", "moneda:"];

const minimumCompleteFinancialDigits = 10;

export const resolveCurrency = (input: {
  document: EmailDocument;
  amountText: string;
  defaultRule: FormatCurrencyDefault;
}): Option.Option<CurrencyEvidence> => {
  const currencyFields = input.document.rows
    .filter((row) => currencyFieldLabels.includes(rowCell(row, 0)))
    .map((row) => rowCell(row, 1));

  if (currencyFields.length > 1) return Option.none();
  const localEvidenceText = [input.amountText, ...currencyFields].join(" ");

  const localCodes = Array.from(localEvidenceText.matchAll(/\b[A-Za-z]{3}\b/gu), (match) =>
    match[0].toUpperCase()
  );

  if (localCodes.some((code) => !Schema.is(Currency)(code))) return Option.none();
  const distinctCodes = [...new Set(localCodes)];

  if (distinctCodes.length > 1 || /[€£¥]/u.test(localEvidenceText)) return Option.none();

  if (distinctCodes.length === 1) {
    const decoded = Schema.decodeUnknownOption(Currency)(rowCell(distinctCodes, 0));

    return Option.map(decoded, (currency) => ({
      currency,
      basis: "explicit" as const,
      numericText: input.amountText
        .replaceAll(/\b[A-Za-z]{3}\b/gu, "")
        .replaceAll("$", "")
        .trim(),
    }));
  }

  if (currencyFields.length === 1) return Option.none();

  return Option.some({
    ...input.defaultRule,
    numericText: input.amountText.replaceAll("$", "").trim(),
  });
};

export const containsCompleteFinancialNumber = (text: string): boolean => {
  for (const match of text.matchAll(/[0-9][0-9 .-]*[0-9]/gu)) {
    const candidate = match[0].trim();

    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}$/u.test(candidate)) continue;

    if (Array.from(candidate.matchAll(/[0-9]/gu)).length >= minimumCompleteFinancialDigits) {
      return true;
    }
  }

  return false;
};

export type AmountStyle = "comma-grouped" | "comma-grouped-decimal" | "dot-grouped";

export const parseAmount: {
  (style: AmountStyle): (value: string) => Option.Option<string>;
  (value: string, style: AmountStyle): Option.Option<string>;
} = Function.dual(2, (value: string, style: AmountStyle) => {
  const patterns: Record<AmountStyle, RegExp> = {
    "comma-grouped": /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u,
    "comma-grouped-decimal": /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/u,
    "dot-grouped": /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:\.\d{3})+)$/u,
  };

  if (!patterns[style].test(value)) return Option.none();

  return Option.some(
    style === "dot-grouped" ? value.replaceAll(".", "") : value.replaceAll(",", "")
  );
});

type DateStyle = "slash" | "dash";

type OccurredAtInput = Readonly<{
  dateText: string;
  timeText: string;
  dateStyle: DateStyle;
  context: CapturedInterpretationContext;
}>;

const parseOccurredAt = (input: OccurredAtInput): Option.Option<DateTime.Utc> => {
  const datePattern =
    input.dateStyle === "slash" ? /^(\d{4})\/(\d{2})\/(\d{2})$/u : /^(\d{4})-(\d{2})-(\d{2})$/u;

  const date = datePattern.exec(input.dateText);
  const time = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(input.timeText);

  if (date === null || time === null) {
    return Option.none();
  }

  const [, year, month, day] = date;
  const [, hour, minute, second = "0"] = time;

  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };

  const zoned = DateTime.makeZoned(parts, {
    timeZone: input.context.timeZone,
    adjustForTimeZone: true,
  });

  return Option.flatMap(zoned, (value) => {
    const actual = DateTime.toParts(value);

    const actualValues = [
      actual.year,
      actual.month,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    ];

    return actualValues.every((part, index) => part === Object.values(parts)[index])
      ? Option.some(DateTime.toUtc(value))
      : Option.none();
  });
};

export const decodeAccountHints = (
  input: typeof AccountHints.Encoded
): Option.Option<AccountHints> => Schema.decodeOption(AccountHints)(input);

export const makeInterpretation = (input: {
  document: EmailDocument;
  amountText: string;
  amountStyle: AmountStyle;
  dateText: string;
  timeText: string;
  dateStyle: DateStyle;
  context: CapturedInterpretationContext;
  accountHints: AccountHints;
  currencyDefault: FormatCurrencyDefault;
}): Option.Option<FormatInterpretation> =>
  Option.all({
    currency: resolveCurrency({
      document: input.document,
      amountText: input.amountText,
      defaultRule: input.currencyDefault,
    }),
    occurredAt: parseOccurredAt(input),
  }).pipe(
    Option.flatMap(({ currency, occurredAt }) =>
      Option.map(parseAmount(currency.numericText, input.amountStyle), (amount) => ({
        amount,
        currency: currency.currency,
        currencyBasis: currency.basis,
        occurredAt,
        accountHints: input.accountHints,
      }))
    )
  );
