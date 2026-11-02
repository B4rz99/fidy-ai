import { DateTime, Option, Schema } from "effect";
import { type CanonicalInput, type CanonicalSuccess, Currency } from "@/transport/client";
import { parseMoneyInput } from "@/transport/money-input";

export type TransactionFilters = Readonly<{
  text: string;
  from: string;
  to: string;
  amount: string;
  currency: string;
  direction: string;
}>;
export type TransactionSearch = Readonly<{
  filters: CanonicalInput<"transactions.listTransactions">["query"];
  text: Option.Option<string>;
}>;
export const emptyTransactionFilters: TransactionFilters = {
  text: "",
  from: "",
  to: "",
  amount: "",
  currency: "",
  direction: "",
};
const maximumSearchLength = 80;
const transactionPageSize = 20;
const localMidnight = (date: string, timeZone: string): DateTime.Zoned =>
  DateTime.makeZonedUnsafe(`${date}T00:00:00`, { timeZone, adjustForTimeZone: true });
const dateFilters = ({
  draft,
  timeZone,
}: Readonly<{ draft: TransactionFilters; timeZone: string }>): Pick<
  TransactionSearch["filters"],
  "from" | "to"
> => ({
  ...(draft.from === "" ? {} : { from: DateTime.toUtc(localMidnight(draft.from, timeZone)) }),
  ...(draft.to === ""
    ? {}
    : { to: DateTime.toUtc(DateTime.add(localMidnight(draft.to, timeZone), { days: 1 })) }),
});
const invalidDraft = (draft: TransactionFilters): boolean => {
  const text = draft.text.trim();
  return (
    (text !== "" && (text.length < 2 || text.length > maximumSearchLength)) ||
    (draft.from !== "" && draft.to !== "" && draft.from > draft.to)
  );
};
export const transactionSearch = ({
  draft,
  timeZone,
}: Readonly<{ draft: TransactionFilters; timeZone: string }>): Option.Option<TransactionSearch> => {
  if (invalidDraft(draft)) return Option.none();
  const currency = Schema.decodeUnknownOption(Currency)(draft.currency);
  const amount = Option.flatMap(currency, (value) =>
    parseMoneyInput({ text: draft.amount, currency: value })
  );
  if (draft.amount !== "" && Option.isNone(amount)) return Option.none();
  const filters: TransactionSearch["filters"] = {
    limit: transactionPageSize,
    ...dateFilters({ draft, timeZone }),
    ...Option.match(currency, { onNone: () => ({}), onSome: (currency) => ({ currency }) }),
    ...Option.match(amount, { onNone: () => ({}), onSome: (money) => ({ amount: money.amount }) }),
  };
  if (draft.direction === "inflow" || draft.direction === "outflow") {
    return Option.some({
      filters: { ...filters, direction: draft.direction },
      text: Option.fromNullishOr(draft.text.trim() || undefined),
    });
  }
  return Option.some({ filters, text: Option.fromNullishOr(draft.text.trim() || undefined) });
};
export const transactionDate = ({
  transaction,
  timeZone,
}: Readonly<{
  transaction: CanonicalSuccess<"transactions.listTransactions">["data"][number];
  timeZone: string;
}>): string =>
  DateTime.format(transaction.occurredAt, {
    locale: "es-CO",
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export const transactionScope = ({
  query,
  timeZone,
}: Readonly<{ query: TransactionSearch; timeZone: string }>): string => {
  const { filters } = query;
  const date = (value: DateTime.Utc): string =>
    DateTime.format(value, {
      locale: "es-CO",
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  const direction =
    filters.direction === undefined
      ? "Todas las direcciones"
      : { inflow: "Entradas", outflow: "Salidas" }[filters.direction];
  return [
    filters.currency ?? "Todas las monedas",
    direction,
    ...Option.toArray(Option.map(query.text, (text) => `Texto: ${text}`)),
    filters.from === undefined ? "Sin fecha inicial" : `Desde ${date(filters.from)}`,
    filters.to === undefined
      ? "Sin fecha final"
      : `Hasta ${date(DateTime.subtract(filters.to, { milliseconds: 1 }))}`,
  ].join(" · ");
};
