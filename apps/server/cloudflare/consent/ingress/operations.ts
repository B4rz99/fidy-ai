import { receiveConsentText as receiveText, recordDelivery } from "../internal/ingress";
/** Apply a pending Consent decision only to authenticated typed text and exact-body replay evidence. */
export const receiveConsentText: typeof receiveText = (input) => receiveText(input);
/** Record authenticated disclosure delivery without changing historical replay or decision timing. */
export const recordConsentDelivery: typeof recordDelivery = (input) => recordDelivery(input);
