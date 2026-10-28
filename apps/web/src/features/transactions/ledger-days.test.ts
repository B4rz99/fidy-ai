import { BigDecimal } from "effect";
import { expect, it } from "vitest";
import { presentLedgerDays } from "./ledger-days";
import type { TransactionListRow } from "./presentation";

const row = (id: string, overrides: Partial<TransactionListRow> = {}): TransactionListRow => ({
  id,
  categoryId: "category",
  categoryLabel: "Restaurantes",
  counterpartyLabel: id,
  direction: "outflow",
  transactionTypeLabel: "Gasto",
  moneyText: "",
  money: { currency: "COP", amount: BigDecimal.fromStringUnsafe("0.10") },
  dateLabel: "28 de octubre de 2026",
  occurredOnText: "28-10-2026",
  ...overrides,
});

it("keeps newest days first while sorting within each day and totaling exact amounts separately by Currency", () => {
  const newest = row("Zulu", {
    money: { currency: "COP", amount: BigDecimal.fromStringUnsafe("9007199254740993.12") },
    direction: "inflow",
  });
  const debit = row("Alpha");
  const foreign = row("Bravo", {
    money: { currency: "USD", amount: BigDecimal.fromStringUnsafe("0.01") },
  });
  const older = row("Earlier", {
    occurredOnText: "27-10-2026",
    dateLabel: "27 de octubre de 2026",
  });
  const days = presentLedgerDays(
    [newest, debit, foreign, older],
    [debit, foreign, older, newest],
    "es-CO"
  );
  expect(
    days.map((day) => ({
      date: day.date,
      label: day.label,
      total: day.total,
      ids: day.rows.map((item) => item.id),
    }))
  ).toEqual([
    {
      date: "28-10-2026",
      label: "28 de octubre de 2026",
      total: "$ 9.007.199.254.740.993,02 · -$ 0,01",
      ids: ["Alpha", "Bravo", "Zulu"],
    },
    { date: "27-10-2026", label: "27 de octubre de 2026", total: "-$ 0,10", ids: ["Earlier"] },
  ]);
  expect(presentLedgerDays([], [], "es-CO")).toEqual([]);
});
