import { BigDecimal } from "effect";
import type { SubscriptionOffer, SubscriptionOffers } from "./presentation";

export type PreviewDataset = "demo" | "worst";

const amounts = ["99999999999.99", "0.01", "123456789012.50"];

const defaultAmount = "0";

const fixtureOffer = (offer: SubscriptionOffer, index: number): SubscriptionOffer => ({
  ...offer,
  money: {
    ...offer.money,
    amount: BigDecimal.fromStringUnsafe(amounts[index % amounts.length] ?? defaultAmount),
  },
});

export const fixtureOffers = ({
  offers,
  dataset,
}: Readonly<{ offers: SubscriptionOffers; dataset: PreviewDataset }>): SubscriptionOffers => {
  if (dataset === "demo") return offers;

  return [fixtureOffer(offers[0], 0), fixtureOffer(offers[1], 1), fixtureOffer(offers[2], 2)];
};
