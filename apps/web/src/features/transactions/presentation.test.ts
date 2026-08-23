import { BigDecimal, DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";
import { formatMoney } from "@/ui/money";
import {
  type TransactionPresentationCategory,
  type TransactionPresentationRecord,
  deriveCurrentMonthPeriod,
  presentTransactionRows,
} from "./presentation";

const category: TransactionPresentationCategory = {
  id: "24000000-0000-4000-8000-000000000001",
  label: "Restaurantes",
};

const transaction = (
  overrides?: Partial<TransactionPresentationRecord>
): TransactionPresentationRecord => ({
  id: "24000000-0000-4000-8000-000000000002",
  money: {
    amount: BigDecimal.fromStringUnsafe("25000"),
    currency: "COP",
  },
  counterparty: Option.some("El Corral"),
  direction: "outflow",
  categoryId: category.id,
  occurredAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
  ...overrides,
});

describe("current-month Transaction presentation", () => {
  it("derives DST-correct half-open UTC bounds from the User's local calendar month", () => {
    const period = deriveCurrentMonthPeriod({
      now: DateTime.makeUnsafe("2026-03-15T12:00:00Z"),
      timeZone: "America/New_York",
    });

    expect(DateTime.formatIso(period.from)).toBe("2026-03-01T05:00:00.000Z");
    expect(DateTime.formatIso(period.to)).toBe("2026-04-01T04:00:00.000Z");
    expect(period.timeZone).toBe("America/New_York");
  });

  it("formats a large fractional Money value exactly with standard Currency digits", () => {
    const formatted = formatMoney({
      locale: "es-CO",
      money: {
        amount: BigDecimal.fromStringUnsafe("9007199254740993.12"),
        currency: "USD",
      },
    });

    expect(formatted).toBe("USD 9.007.199.254.740.993,12");
    expect(
      formatMoney({
        locale: "es-CO",
        money: {
          amount: BigDecimal.fromStringUnsafe("25000"),
          currency: "COP",
        },
      })
    ).toBe("COP 25.000,00");
  });

  it("joins Category labels and presents Counterparty, expense or income, Money, and local date", () => {
    const rows = presentTransactionRows({
      categories: [category],
      counterpartyFallback: "Contraparte no identificada",
      locale: "es-CO",
      timeZone: "America/Bogota",
      transactions: [
        transaction(),
        transaction({
          id: "24000000-0000-4000-8000-000000000003",
          counterparty: Option.none(),
          direction: "inflow",
          money: {
            amount: BigDecimal.fromStringUnsafe("19.9"),
            currency: "USD",
          },
        }),
      ],
    });

    expect(rows).toEqual([
      {
        id: "24000000-0000-4000-8000-000000000002",
        categoryLabel: "Restaurantes",
        counterpartyLabel: "El Corral",
        direction: "outflow",
        transactionTypeLabel: "Gasto",
        moneyText: "COP 25.000,00",
        occurredOnText: "20-07-2026",
      },
      {
        id: "24000000-0000-4000-8000-000000000003",
        categoryLabel: "Restaurantes",
        counterpartyLabel: "Contraparte no identificada",
        direction: "inflow",
        transactionTypeLabel: "Ingreso",
        moneyText: "USD 19,90",
        occurredOnText: "20-07-2026",
      },
    ]);
  });
});
