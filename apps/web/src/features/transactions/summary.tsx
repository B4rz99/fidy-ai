import { BigDecimal, Option } from "effect";
import type { JSX } from "react";
import { formatMoney } from "@/transport/money";
import { type Transaction, formatOccurrence } from "./presentation";

type SummaryProps = Readonly<{
  partial: boolean;
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
const SummaryCount = ({ transactions }: Pick<SummaryProps, "transactions">): JSX.Element => {
  const inflows = transactions.filter((record) => record.direction === "inflow").length;
  const outflows = transactions.filter((record) => record.direction === "outflow").length;
  return (
    <p data-transaction-slot="transaction-summary-count">
      {transactions.length} {transactions.length === 1 ? "transacción" : "transacciones"} ·{" "}
      {inflows} {inflows === 1 ? "ingreso" : "ingresos"} · {outflows}{" "}
      {outflows === 1 ? "gasto" : "gastos"}
    </p>
  );
};
const CurrencySummary = ({
  currency,
  props,
}: Readonly<{
  currency: Transaction["money"]["currency"];
  props: SummaryProps;
}>): JSX.Element => {
  const transactions = props.transactions.filter((record) => record.money.currency === currency);
  const figures = currencyFigures(transactions, props.locale);
  return (
    <div>
      <span data-transaction-slot="transaction-summary-currency">{currency}</span>
      <dl data-transaction-slot="transaction-summary-totals">
        {figures.slice(0, 2).map((figure) => (
          <div key={figure.label}>
            <dt>{figure.label}</dt>
            <dd>{figure.value}</dd>
          </div>
        ))}
      </dl>
      <SummaryCount transactions={transactions} />
      <dl data-transaction-slot="transaction-summary-facts">
        {figures.slice(2).map((figure) => (
          <SummaryLine key={figure.label} label={figure.label} value={figure.value} />
        ))}
      </dl>
    </div>
  );
};
/** Summarizes only the displayed FinancialRecord coverage; Money is aggregated within each Currency. */
export const TransactionSummary = (props: SummaryProps): JSX.Element => {
  const currencies = Array.from(new Set(props.transactions.map((record) => record.money.currency)));
  const range = dateRange(props);
  return (
    <section aria-label="Resumen de transacciones" data-transaction-slot="transaction-summary">
      <h2>Resumen</h2>
      {props.partial ? (
        <p className="text-sm text-muted-foreground">
          Solo transacciones cargadas que coinciden con los filtros.
        </p>
      ) : null}
      {currencies.length !== 1 ? (
        <p className="text-sm text-muted-foreground">
          {props.transactions.length}{" "}
          {props.transactions.length === 1 ? "transacción" : "transacciones"} en total
        </p>
      ) : null}
      {currencies.map((currency) => (
        <CurrencySummary key={currency} currency={currency} props={props} />
      ))}
      <dl data-transaction-slot="transaction-summary-facts">
        <SummaryLine label="Primera transacción" value={range.first} />
        <SummaryLine label="Última transacción" value={range.last} />
      </dl>
    </section>
  );
};
