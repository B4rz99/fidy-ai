import { BigDecimal, Option } from "effect";
import { formatMoney } from "@/transport/money";
import { type Transaction, formatOccurrence } from "./presentation";

export type SummaryProps = Readonly<{
  partial: boolean;
  transactions: ReadonlyArray<Transaction>;
  locale: string;
  timeZone: string;
}>;
export const currencyFigures = ({
  transactions,
  locale,
}: Readonly<{ transactions: ReadonlyArray<Transaction>; locale: string }>): ReadonlyArray<
  Readonly<{ label: string; value: string }>
> => {
  const currency = Option.getOrThrow(Option.fromNullishOr(transactions[0])).money.currency;
  const amounts = transactions.map((transaction) => transaction.money.amount);
  const sum = BigDecimal.sumAll(amounts);
  const largest = (records: ReadonlyArray<Transaction>): string => {
    if (records.length === 0) return "—";
    const sorted = records.toSorted((left, right) =>
      BigDecimal.Order(right.money.amount, left.money.amount)
    );
    return formatMoney({ locale, money: Option.getOrThrow(Option.fromNullishOr(sorted[0])).money });
  };
  const total = (direction: Transaction["direction"]): string =>
    formatMoney({
      locale,
      money: {
        currency,
        amount: BigDecimal.sumAll(
          transactions.flatMap((record) =>
            record.direction === direction ? [record.money.amount] : []
          )
        ),
      },
    });
  return [
    { label: "Ingresos registrados", value: total("inflow") },
    { label: "Gastos registrados", value: total("outflow") },
    { label: "Mayor transacción", value: largest(transactions) },
    {
      label: "Mayor gasto",
      value: largest(transactions.filter((record) => record.direction === "outflow")),
    },
    {
      label: "Promedio por transacción",
      value: formatMoney({
        locale,
        money: {
          currency,
          amount: BigDecimal.divideUnsafe(sum, BigDecimal.fromBigInt(BigInt(transactions.length))),
        },
      }),
    },
  ];
};
export const dateRange = ({
  transactions,
  locale,
  timeZone,
}: SummaryProps): Readonly<{ first: string; last: string }> => {
  const dates = transactions
    .map((transaction) => transaction.occurredAt)
    .toSorted((left, right) => left.epochMilliseconds - right.epochMilliseconds);
  const format = (value: Option.Option<Transaction["occurredAt"]>): string =>
    Option.match(value, {
      onNone: () => "—",
      onSome: (occurredAt) => formatOccurrence({ locale, occurredAt, timeZone }),
    });
  return {
    first: format(Option.fromNullishOr(dates[0])),
    last: format(Option.fromNullishOr(dates.at(-1))),
  };
};
