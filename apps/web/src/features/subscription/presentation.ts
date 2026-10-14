import type { CanonicalSuccess } from "@/transport/client";
import { formatMoney } from "@/transport/money";

export type SubscriptionOffers = CanonicalSuccess<"subscription.listSubscriptionOffers">["data"];
export type SubscriptionOffer = SubscriptionOffers[number];
export type PriceId = SubscriptionOffer["id"];

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

export type SubscriptionOfferPresentation = Readonly<{
  id: PriceId;
  selectionLabel: string;
  billingUnit: string;
  moneyText: string;
  renewalText: string;
  cancellationText: string;
}>;

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
  };
};
