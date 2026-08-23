import { BigDecimal, Schema } from "effect";

const StringNumericLiteral = Schema.TemplateLiteral([Schema.Finite]);

/** Formats exact canonical Money without allowing Locale to supply Currency meaning. */
export const formatMoney = <Currency extends string>({
  locale,
  money,
}: Readonly<{
  locale: string;
  money: Readonly<{ amount: Readonly<BigDecimal.BigDecimal>; currency: Currency }>;
}>): string =>
  new Intl.NumberFormat(locale, {
    currency: money.currency,
    currencyDisplay: "code",
    style: "currency",
  }).format(Schema.decodeUnknownSync(StringNumericLiteral)(BigDecimal.format(money.amount)));
