import { Currency, currencyMetadata } from "@fidy/server/client";
import { BigDecimal, Schema } from "effect";

const ExactDecimal = Schema.NonEmptyString.pipe(Schema.decodeTo(Schema.BigDecimalFromString));

/** Applies Locale and explicit Currency without routing exact decimal magnitude through Number. */
const currencyAmount = ({
  amount,
  currency,
  locale,
  currencyDisplay,
}: Readonly<{
  amount: string;
  currency: string;
  locale: string;
  currencyDisplay: "narrowSymbol" | "code";
}>): string => {
  const decimal = Schema.decodeSync(ExactDecimal)(amount);
  const digits = currencyMetadata(Schema.decodeUnknownSync(Currency)(currency)).fractionalDigits;
  const formatter = new Intl.NumberFormat(locale, {
    currency,
    currencyDisplay,
    style: "currency",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const scaled = BigDecimal.scale(BigDecimal.round(decimal, { scale: digits }), digits).value;
  const unit = 10n ** BigInt(digits);
  const whole = scaled / unit;
  const remainder = scaled % unit;
  const fraction =
    digits === 0
      ? ""
      : new Intl.NumberFormat(locale, { minimumIntegerDigits: digits, useGrouping: false }).format(
          remainder < 0n ? -remainder : remainder
        );
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
): string => currencyAmount({ ...options, currencyDisplay: "narrowSymbol" });

/** Formats exact canonical Money without allowing Locale to supply Currency meaning. */
export const formatMoney = ({ locale, money }: MoneyOptions): string =>
  currencyAmount({
    amount: BigDecimal.format(money.amount),
    currency: money.currency,
    locale,
    currencyDisplay: "narrowSymbol",
  });

/** Unambiguous Money for surfaces that mix currencies with a shared symbol. */
export const formatMoneyWithCode = ({ locale, money }: MoneyOptions): string =>
  currencyAmount({
    amount: BigDecimal.format(money.amount),
    currency: money.currency,
    locale,
    currencyDisplay: "code",
  });
