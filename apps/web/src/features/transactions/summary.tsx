import { BigDecimal, Option } from "effect";
import type { JSX } from "react";
import { useMemo } from "react";
import { formatMoney } from "@/transport/money";
import { type Transaction, formatOccurrence } from "./presentation";

type SummaryProps = Readonly<{
  transactions: ReadonlyArray<Transaction>;
  locale: string;
  timeZone: string;
}>;
const SummaryLine = ({ label, value }: Readonly<{ label: string; value: string }>): JSX.Element => (
  <div className="flex items-start justify-between gap-4 py-2.5">
    <dt className="text-sm text-muted-foreground">{label}</dt>
    <dd className="text-right text-sm font-medium tabular-nums">{value}</dd>
  </div>
);
const currencyFigures = (
  transactions: ReadonlyArray<Transaction>,
  locale: string
): ReadonlyArray<Readonly<{ label: string; value: string }>> => {
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
const dateRange = ({
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
/** Summarizes only the displayed FinancialRecord coverage; Money is aggregated within each Currency. */
export const TransactionSummary = (props: SummaryProps): JSX.Element => {
  const currencies = Array.from(
    new Set(props.transactions.map((transaction) => transaction.money.currency))
  );
  const range = dateRange(props);
  const currencyNames = useMemo(
    () => new Intl.DisplayNames(props.locale, { type: "currency" }),
    [props.locale]
  );
  return (
    <section aria-label="Resumen de transacciones" className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold">Resumen</h2>
      </div>
      <dl>
        <SummaryLine label="Total de transacciones" value={String(props.transactions.length)} />
        <SummaryLine
          label="Ingresos"
          value={String(
            props.transactions.filter((record) => record.direction === "inflow").length
          )}
        />
        <SummaryLine
          label="Gastos"
          value={String(
            props.transactions.filter((record) => record.direction === "outflow").length
          )}
        />
      </dl>
      {currencies.map((currency) => (
        <div key={currency} className="border-t pt-4">
          {currencies.length > 1 ? (
            <h3 className="text-xs font-semibold tracking-wider text-muted-foreground">
              {currencyNames.of(currency)}
            </h3>
          ) : null}
          <dl>
            {currencyFigures(
              props.transactions.filter((record) => record.money.currency === currency),
              props.locale
            ).map((figure) => (
              <SummaryLine key={figure.label} label={figure.label} value={figure.value} />
            ))}
          </dl>
        </div>
      ))}
      <dl className="border-t pt-4">
        <SummaryLine label="Primera transacción" value={range.first} />
        <SummaryLine label="Última transacción" value={range.last} />
      </dl>
    </section>
  );
};
