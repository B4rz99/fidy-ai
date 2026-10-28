import { Currency, currencyMetadata } from "@fidy/server/client";
import { BigDecimal, Schema } from "effect";

const ExactDecimal = Schema.NonEmptyString.pipe(Schema.decodeTo(Schema.BigDecimalFromString));

const maximumFormatters = 32;
const formatters = new Map<string, Intl.NumberFormat>();
const numberFormatter = ({
  locale,
  currency,
  currencyDisplay,
  minimumDigits,
  maximumDigits,
}: Readonly<{
  locale: string;
  currency: string;
  currencyDisplay: "narrowSymbol" | "code";
  minimumDigits: number;
  maximumDigits: number;
}>): Intl.NumberFormat => {
  const key = [locale, currency, currencyDisplay, minimumDigits, maximumDigits].join("|");
  const previous = formatters.get(key);
  if (previous !== undefined) return previous;
  const formatter = new Intl.NumberFormat(
    locale,
    currency === ""
      ? {
          minimumIntegerDigits: minimumDigits,
          useGrouping: false,
        }
      : {
          currency,
          currencyDisplay,
          style: "currency",
          minimumFractionDigits: minimumDigits,
          maximumFractionDigits: maximumDigits,
        }
  );
  if (formatters.size >= maximumFormatters) formatters.clear();
  formatters.set(key, formatter);
  return formatter;
};

/** Applies Locale and explicit Currency without routing exact decimal magnitude through Number. */
const currencyAmount = ({
  amount,
  currency,
  locale,
  currencyDisplay,
  compact,
}: Readonly<{
  amount: string;
  currency: string;
  locale: string;
  currencyDisplay: "narrowSymbol" | "code";
  compact: boolean;
}>): string => {
  const decimal = Schema.decodeSync(ExactDecimal)(amount);
  const digits = currencyMetadata(Schema.decodeUnknownSync(Currency)(currency)).fractionalDigits;
  const formatter = numberFormatter({
    locale,
    currency,
    currencyDisplay,
    minimumDigits: compact && BigDecimal.isInteger(decimal) ? 0 : digits,
    maximumDigits: digits,
  });
  const scaled = BigDecimal.scale(BigDecimal.round(decimal, { scale: digits }), digits).value;
  const unit = 10n ** BigInt(digits);
  const whole = scaled / unit;
  const remainder = scaled % unit;
  const fraction =
    digits === 0
      ? ""
      : numberFormatter({
          locale,
          currency: "",
          currencyDisplay: "code",
          minimumDigits: digits,
          maximumDigits: digits,
        }).format(remainder < 0n ? -remainder : remainder);
  // Preserve negative zero's Locale sign placement when rounding a negative amount to zero.
  return formatter
    .formatToParts(whole === 0n && BigDecimal.isNegative(decimal) ? -0 : whole)
    .map((part) => {
      if (part.type === "fraction") return fraction;
      return currencyDisplay === "code" && part.type === "literal"
        ? part.value.replaceAll("\u00a0", " ")
        : part.value;
    })
    .join("");
};

type MoneyOptions = Readonly<{
  locale: string;
  money: Readonly<{ amount: Readonly<BigDecimal.BigDecimal>; currency: string }>;
}>;

export const formatCurrencyAmount = (
  options: Readonly<{ amount: string; currency: string; locale: string }>
): string => currencyAmount({ ...options, currencyDisplay: "narrowSymbol", compact: false });

/** Formats exact canonical Money without allowing Locale to supply Currency meaning. */
export const formatMoney = ({ locale, money }: MoneyOptions): string =>
  currencyAmount({
    amount: BigDecimal.format(money.amount),
    currency: money.currency,
    locale,
    currencyDisplay: "narrowSymbol",
    compact: false,
  });

/** Unambiguous Money for surfaces that mix currencies with a shared symbol. */
export const formatMoneyWithCode = ({ locale, money }: MoneyOptions): string =>
  currencyAmount({
    amount: BigDecimal.format(money.amount),
    currency: money.currency,
    locale,
    currencyDisplay: "code",
    compact: false,
  });

/** Explicit currency after the symbol; exact integral amounts need no empty fractional part. */
export const formatMoneyWithCompactCode = ({ locale, money }: MoneyOptions): string =>
  `${currencyAmount({
    amount: BigDecimal.format(money.amount),
    currency: money.currency,
    locale,
    currencyDisplay: "narrowSymbol",
    compact: true,
  }).replaceAll("\u00a0", " ")} ${money.currency}`;
