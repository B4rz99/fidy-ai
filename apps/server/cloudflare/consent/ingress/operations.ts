import { recordDelivery } from "./internal/ingress";
/** Record authenticated disclosure delivery without changing historical replay or decision timing. */
export const recordConsentDelivery: typeof recordDelivery = (input) => recordDelivery(input);
