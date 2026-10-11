import { BigDecimal, Option, Schema } from "effect";
import { expect, it } from "vitest";
import { Category } from "@/transport/client";
import { formatMoney } from "@/transport/money";
import {
  dailyLedgerTotal,
  filteredTransactions,
  hasTransactionFilters,
  ledgerRows,
  transactionsEditable,
} from "./ledger-presentation";
import { emptyFilters, initialModel } from "./model";
import { category, ready, record, user } from "./test-fixtures";

it.each([
  { search: " semanaL " },
  { direction: "inflow" },
  { categoryId: "missing" },
  { date: "2026-10-08" },
])("recognizes each active ledger filter", (filter) => {
  expect(hasTransactionFilters({ ...emptyFilters, ...filter })).toBe(true);
});

it("treats whitespace as an empty search and matches notes without a counterparty", () => {
  expect(hasTransactionFilters({ ...emptyFilters, search: "  " })).toBe(false);
  const model = {
    ...ready,
    filters: { ...emptyFilters, search: "SEMANAL" },
    query: { ...ready.query, transactions: [{ ...record, counterparty: Option.none() }] },
  };
  expect(filteredTransactions(model)).toHaveLength(1);
  expect(
    filteredTransactions({ ...model, filters: { ...emptyFilters, search: "missing" } })
  ).toEqual([]);
  expect(
    filteredTransactions({
      ...ready,
      query: {
        ...ready.query,
        transactions: [{ ...record, counterparty: Option.none(), notes: Option.none() }],
      },
    })
  ).toHaveLength(1);
});

it.each([
  [{ direction: "inflow" }, 0],
  [{ direction: "outflow" }, 1],
  [{ categoryId: "missing" }, 0],
  [{ categoryId: category.id }, 1],
  [{ date: "2026-10-09" }, 0],
  [{ date: "2026-10-08" }, 1],
] as const)("filters canonical rows in the User's local date", (filter, count) => {
  expect(filteredTransactions({ ...ready, filters: { ...emptyFilters, ...filter } })).toHaveLength(
    count
  );
});

it("withholds user-specific rows until identity is available", () => {
  expect(ledgerRows(initialModel)).toEqual([]);
});

it.each([
  "counterpartyLabel:asc",
  "counterpartyLabel:desc",
  "categoryLabel:asc",
  "categoryLabel:desc",
])("sorts %s without changing canonical records", (sort) => {
  const second = {
    ...record,
    counterparty: Option.some("Zorro"),
    categoryId: Schema.decodeSync(Category.fields.id)("24000000-0000-4000-8000-000000000004"),
  };
  const model = { ...ready, sort, query: { ...ready.query, transactions: [record, second] } };
  const labels = ledgerRows(model).map((row) =>
    sort.startsWith("counterparty") ? row.counterpartyLabel : row.categoryLabel
  );
  const expected = labels.toSorted((left, right) => left.localeCompare(right, user.locale));
  expect(labels).toEqual(sort.endsWith("desc") ? expected.toReversed() : expected);
  expect(model.query.transactions).toEqual([record, second]);
});

it("preserves canonical order for default and unsupported sort fields", () => {
  expect(ledgerRows({ ...ready, sort: "moneyText:desc" })).toEqual(ledgerRows(ready));
});

it("totals each currency separately and applies income and expense signs", () => {
  const rows = ledgerRows(ready);
  const row = rows[0];
  expect(row).toBeDefined();
  if (row === undefined) throw new Error("Missing fixture row");
  const cop = { currency: "COP" as const, amount: BigDecimal.fromStringUnsafe("25000") };
  const usd = { currency: "USD" as const, amount: BigDecimal.fromStringUnsafe("10") };
  expect(
    dailyLedgerTotal({
      rows: [row, { ...row, direction: "inflow", money: usd }],
      locale: user.locale,
    })
  ).toBe(
    `${formatMoney({ locale: user.locale, money: { ...cop, amount: BigDecimal.negate(cop.amount) } })} · ${formatMoney({ locale: user.locale, money: usd })}`
  );
  expect(dailyLedgerTotal({ rows: [], locale: user.locale })).toBe("");
});

it.each([
  { working: true },
  { feedback: "uncertain" },
  { query: { ...ready.query, status: "Failed" as const } },
  { query: { ...ready.query, stale: true } },
  { query: { ...ready.query, waiting: true } },
])("blocks editing while canonical state is uncertain", (change) => {
  expect(transactionsEditable({ ...ready, ...change })).toBe(false);
  expect(transactionsEditable(ready)).toBe(true);
});
