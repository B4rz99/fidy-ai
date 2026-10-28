import { BigDecimal } from "effect";
import { formatMoney } from "@/transport/money";
import type { TransactionListRow } from "./presentation";

type LedgerDay = Readonly<{
  date: string;
  label: string;
  total: string;
  rows: ReadonlyArray<TransactionListRow>;
}>;
const dailyTotals = (rows: ReadonlyArray<TransactionListRow>, locale: string): string =>
  Array.from(
    Map.groupBy(rows, (row) => row.money.currency),
    ([currency, items]) =>
      formatMoney({
        locale,
        money: {
          currency,
          amount: BigDecimal.sumAll(
            items.map((row) =>
              row.direction === "inflow" ? row.money.amount : BigDecimal.negate(row.money.amount)
            )
          ),
        },
      })
  ).join(" · ");

/** Canonical date order takes priority over the selected within-day sort. */
export const presentLedgerDays = (
  rows: ReadonlyArray<TransactionListRow>,
  sortedRows: ReadonlyArray<TransactionListRow>,
  locale: string
): ReadonlyArray<LedgerDay> => {
  const sortedDays = Map.groupBy(sortedRows, (row) => row.occurredOnText);
  return Array.from(
    Map.groupBy(rows, (row) => row.occurredOnText),
    ([date, items]) => ({
      date,
      label: items[0]?.dateLabel ?? date,
      total: dailyTotals(items, locale),
      rows: sortedDays.get(date) ?? [],
    })
  );
};
