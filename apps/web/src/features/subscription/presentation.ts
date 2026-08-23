import type { CanonicalSuccess } from "@/transport/client";
import { formatMoney } from "@/ui/money";

/** Offers returned by subscription.listSubscriptionOffers. */
export type SubscriptionOffers = CanonicalSuccess<"subscription.listSubscriptionOffers">["data"];
export type SubscriptionOffer = SubscriptionOffers[number];
export type PriceRevisionId = SubscriptionOffer["id"];

const periodPresentation: Readonly<
  Record<
    SubscriptionOffer["billingPeriod"],
    Readonly<{ selectionLabel: string; billingUnit: string }>
  >
> = {
  weekly: { selectionLabel: "semanal", billingUnit: "semana" },
  monthly: { selectionLabel: "mensual", billingUnit: "mes" },
  yearly: { selectionLabel: "anual", billingUnit: "año" },
};

const paymentMethodLabels: Readonly<Record<SubscriptionOffer["paymentMethods"][number], string>> = {
  card: "Tarjeta",
  nequi: "Nequi",
  daviplata: "DaviPlata",
};
/** Presentation-only projection of one canonical PriceRevision. */
export type SubscriptionOfferPresentation = Readonly<{
  id: PriceRevisionId;
  selectionLabel: string;
  billingUnit: string;
  moneyText: string;
  renewalText: string;
  cancellationText: string;
  paymentMethodLabels: readonly [string, string, string];
}>;

/** Converts server-owned semantic terms into Spanish Colombia display copy. */
export const presentSubscriptionOffer = (
  offer: SubscriptionOffer
): SubscriptionOfferPresentation => {
  const period = periodPresentation[offer.billingPeriod];
  return {
    id: offer.id,
    selectionLabel: period.selectionLabel,
    billingUnit: period.billingUnit,
    moneyText: formatMoney({ locale: "es-CO", money: offer.money }),
    renewalText: "Tu suscripción se renueva automáticamente al terminar cada período.",
    cancellationText:
      "Puedes cancelar renovaciones futuras y conservarás el acceso hasta terminar el período pagado.",
    paymentMethodLabels: [
      paymentMethodLabels[offer.paymentMethods[0]],
      paymentMethodLabels[offer.paymentMethods[1]],
      paymentMethodLabels[offer.paymentMethods[2]],
    ],
  };
};
