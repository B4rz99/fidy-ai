import { createContext } from "react";
import type { SubscriptionOffers } from "./presentation";

export type OffersPreview = (offers: SubscriptionOffers) => SubscriptionOffers;

export const OffersPreviewContext = createContext<OffersPreview>((offers) => offers);
