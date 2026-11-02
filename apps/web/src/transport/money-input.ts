import { Transaction, currencyMetadata } from "@fidy/server/client";
import { BigDecimal, Option, Schema } from "effect";

const LocalizedAmount = Schema.String.check(
  Schema.isPattern(/^(?:[0-9]+|[1-9][0-9]{0,2}(?:\.[0-9]{3})+)(?:,[0-9]+)?$/u)
);
const decodeAmount = Schema.decodeUnknownOption(LocalizedAmount);
const decodeMoney = Schema.decodeUnknownOption(Transaction.fields.money);

/** Parses positive Money using es-CO separators; a period always denotes thousands grouping. */
export const parseMoneyInput = ({
  text,
  currency,
}: Readonly<{ text: string; currency: Transaction["money"]["currency"] }>): Option.Option<
  Transaction["money"]
> =>
  decodeAmount(text.trim()).pipe(
    Option.filter((value) => {
      const fraction = value.split(",")[1] ?? "";
      return fraction.length <= currencyMetadata(currency).fractionalDigits;
    }),
    Option.flatMap((value) =>
      decodeMoney({ amount: value.replaceAll(".", "").replace(",", "."), currency })
    ),
    Option.filter((money) => BigDecimal.isPositive(money.amount))
  );

/** Keeps an existing Money value editable without exponent notation or a decimal period. */
export const formatMoneyInput = (money: Transaction["money"]): string =>
  Schema.encodeSync(Transaction.fields.money)(money).amount.replace(".", ",");

export const moneyInputHint = (currency: Transaction["money"]["currency"]): string => {
  const digits = currencyMetadata(currency).fractionalDigits;
  return digits === 0
    ? `Usa punto para miles. ${currency} no admite decimales.`
    : `Usa punto para miles y coma para decimales. Máximo ${digits} decimales (ej.: 12.500,5).`;
};
