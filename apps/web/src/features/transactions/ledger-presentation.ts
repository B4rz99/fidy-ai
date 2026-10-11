import { BigDecimal, DateTime, Option } from "effect";
import { formatMoney } from "@/transport/money";
import { type Filters, type Model } from "./model";
import { type Transaction, type TransactionListRow, presentTransactionRows } from "./presentation";

export const hasTransactionFilters = (filters: Filters): boolean =>
  filters.search.trim().length > 0 ||
  filters.direction !== "all" ||
  filters.categoryId !== "all" ||
  filters.date !== "";
const matching = (
  configuration: Readonly<{ transaction: Transaction; filters: Filters; timeZone: string }>
): boolean => {
  const { transaction, filters, timeZone } = configuration;
  const text =
    `${Option.getOrElse(transaction.counterparty, () => "")} ${Option.getOrElse(transaction.notes, () => "")}`.toLocaleLowerCase(
      "es-CO"
    );
  if (!text.includes(filters.search.trim().toLocaleLowerCase("es-CO"))) return false;
  if (filters.direction !== "all" && transaction.direction !== filters.direction) return false;
  if (filters.categoryId !== "all" && transaction.categoryId !== filters.categoryId) return false;
  return (
    filters.date === "" ||
    DateTime.formatIsoDate(
      DateTime.setZone(transaction.occurredAt, DateTime.zoneMakeNamedUnsafe(timeZone))
    ) === filters.date
  );
};
export const filteredTransactions = (model: Model): ReadonlyArray<Transaction> =>
  model.query.transactions.filter((transaction) =>
    matching({ transaction, filters: model.filters, timeZone: model.query.timeZone })
  );
export const ledgerRows = (model: Model): ReadonlyArray<TransactionListRow> => {
  if (Option.isNone(model.query.user)) return [];
  const user = model.query.user.value;
  const rows = presentTransactionRows({
    categories: model.query.categories,
    transactions: filteredTransactions(model),
    locale: user.locale,
    timeZone: user.timeZone,
    counterpartyFallback: "Contraparte no identificada",
  });
  if (model.sort === "default") return rows;
  const [field, order] = model.sort.split(":");
  if (field !== "counterpartyLabel" && field !== "categoryLabel") return rows;
  const factor = order === "desc" ? -1 : 1;
  return rows.toSorted(
    (left, right) => factor * left[field].localeCompare(right[field], user.locale)
  );
};
export const dailyLedgerTotal = ({
  rows,
  locale,
}: Readonly<{ rows: ReadonlyArray<TransactionListRow>; locale: string }>): string =>
  Array.from(new Set(rows.map((row) => row.money.currency)))
    .map((currency) =>
      formatMoney({
        locale,
        money: {
          currency,
          amount: BigDecimal.sumAll(
            rows.flatMap((row) =>
              row.money.currency !== currency
                ? []
                : [
                    row.direction === "inflow"
                      ? row.money.amount
                      : BigDecimal.negate(row.money.amount),
                  ]
            )
          ),
        },
      })
    )
    .join(" · ");
export const transactionsEditable = (model: Model): boolean =>
  model.query.status === "Ready" &&
  !model.query.stale &&
  !model.query.waiting &&
  !model.working &&
  model.feedback === "";
