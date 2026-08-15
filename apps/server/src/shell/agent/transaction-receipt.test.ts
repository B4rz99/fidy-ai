import { BigDecimal, DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";
import { IanaTimeZone } from "~/core/_shared/context";
import { Money } from "~/core/_shared/money";
import { categoryIds } from "~/core/categories/taxonomy";
import { formatMoneyEsCo, renderTransactionReceipt } from "./transaction-receipt";

describe("transaction receipt", () => {
  it("formats exact Money without losing digits to floating-point conversion", () => {
    const money = Money.make({
      amount: BigDecimal.fromStringUnsafe("9999999999999999.99"),
      currency: "COP",
    });

    expect(formatMoneyEsCo(money)).toBe("9.999.999.999.999.999,99 COP");
  });

  it("omits insignificant fractional zeros from whole Money", () => {
    const money = Money.make({
      amount: BigDecimal.fromStringUnsafe("124000"),
      currency: "COP",
    });

    expect(formatMoneyEsCo(money)).toBe("124.000 COP");
  });

  it("shows the persisted inflow fields, notes, and local calendar date", () => {
    const receipt = renderTransactionReceipt({
      locale: "es-CO",
      output: {
        data: {
          id: "10000000-0000-4000-8000-000000000099",
          money: { amount: "1000.5", currency: "USD" },
          counterparty: "Nómina **mensual**",
          direction: "inflow",
          categoryId: categoryIds.ingresos,
          notes: "Pago de _abril_",
          occurredAt: "2026-04-02T12:00:00.000Z",
          createdAt: "2026-04-03T12:00:00.000Z",
        },
        next: [],
      },
      timeZone: IanaTimeZone.make("America/Bogota"),
      turnStartedAt: DateTime.makeUnsafe("2026-04-03T12:00:00.000Z"),
    });

    expect(Option.getOrThrow(receipt)).toBe(
      "✅ **Ingreso guardado**\n\n**Valor:** 1.000,50 USD\n**Contraparte:** Nómina \\*\\*mensual\\*\\*\n**Categoría:** Ingresos\n**Fecha:** 2/04/2026\n**Nota:** Pago de \\_abril\\_"
    );
  });

  it("omits the Counterparty line when capture identifies none", () => {
    const receipt = renderTransactionReceipt({
      locale: "es-CO",
      output: {
        data: {
          id: "10000000-0000-4000-8000-000000000099",
          money: { amount: "9000", currency: "COP" },
          direction: "outflow",
          categoryId: categoryIds.restaurantes,
          occurredAt: "2026-04-03T12:00:00.000Z",
          createdAt: "2026-04-03T12:00:00.000Z",
        },
        next: [],
      },
      timeZone: IanaTimeZone.make("America/Bogota"),
      turnStartedAt: DateTime.makeUnsafe("2026-04-03T12:00:00.000Z"),
    });

    expect(Option.getOrThrow(receipt)).toBe(
      "✅ **Gasto guardado**\n\n**Valor:** 9.000 COP\n**Categoría:** Restaurantes\n**Fecha:** Hoy"
    );
  });

  it("declines to present malformed canonical output as a saved Transaction", () => {
    expect(
      Option.isNone(
        renderTransactionReceipt({
          locale: "es-CO",
          output: { data: { counterparty: "Missing fields" }, next: [] },
          timeZone: IanaTimeZone.make("America/Bogota"),
          turnStartedAt: DateTime.makeUnsafe("2026-04-03T12:00:00.000Z"),
        })
      )
    ).toBe(true);
  });
});
