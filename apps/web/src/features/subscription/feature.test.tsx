import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BigDecimal } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SubscriptionOffersView } from "./feature";
import { PriceRevisionId } from "@/transport/client";
import type { SubscriptionOffers } from "./presentation";

const renewalTerms = {
  automaticRenewal: true,
  renewalReminder: "none",
  cancellation: "future-renewals-only",
  paidAccessEnds: "paid-period-end",
} as const;
const paymentMethods = ["card", "nequi", "daviplata"] as const;
const offers: SubscriptionOffers = [
  {
    id: PriceRevisionId.make("22700000-0000-4000-8000-000000000001"),
    money: { amount: BigDecimal.fromStringUnsafe("9900"), currency: "COP" },
    billingPeriod: "weekly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    renewalTerms,
    paymentMethods,
  },
  {
    id: PriceRevisionId.make("22700000-0000-4000-8000-000000000002"),
    money: { amount: BigDecimal.fromStringUnsafe("28900"), currency: "COP" },
    billingPeriod: "monthly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    renewalTerms,
    paymentMethods,
  },
  {
    id: PriceRevisionId.make("22700000-0000-4000-8000-000000000003"),
    money: { amount: BigDecimal.fromStringUnsafe("289900"), currency: "COP" },
    billingPeriod: "yearly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    renewalTerms,
    paymentMethods,
  },
];

afterEach(cleanup);

describe("Subscription offer presentation", () => {
  it("shows shared renewal terms once before revealing only the MVP payment methods", () => {
    render(<SubscriptionOffersView state={{ _tag: "Ready", offers }} />);

    expect(screen.getByRole("heading", { name: "Mejora tu suscripción" })).toBeVisible();
    expect(screen.getByText("COP 9.900,00/semana")).toBeVisible();
    expect(screen.getByText("COP 28.900,00/mes")).toBeVisible();
    expect(screen.getByText("COP 289.900,00/año")).toBeVisible();
    expect(screen.queryByText(/Elige la frecuencia que prefieras/iu)).not.toBeInTheDocument();
    const terms = within(screen.getByRole("region", { name: "Condiciones de suscripción" }));
    expect(terms.getByText(/se renueva automáticamente/iu)).toBeVisible();
    expect(
      terms.getByText(/conservarás el acceso hasta terminar el período pagado/iu)
    ).toBeVisible();
    expect(screen.queryByText(/no enviaremos un recordatorio/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/Precio final|No se cobra IVA/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/Colombia · Cobro/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Métodos de pago" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Elegir mensual" }));

    const methods = within(screen.getByRole("region", { name: "Métodos de pago" }));
    expect(methods.getByText("Tarjeta")).toBeVisible();
    expect(methods.getByText("Nequi")).toBeVisible();
    expect(methods.getByText("DaviPlata")).toBeVisible();
    expect(methods.queryByText(/PSE|efectivo|Bancolombia/iu)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Oferta mensual seleccionada" })).toBeVisible();
  });
});
