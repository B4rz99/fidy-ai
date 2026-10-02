import {
  decodeKapsoDisclosureLifecycleWebhook,
  decodeKapsoHostedLifecycleWebhook,
  decodeKapsoIdentityWebhook,
  decodeKapsoWebhook,
} from "~/shell/channels/whatsapp/internal/kapso-webhook";

/** Authenticate bounded exact bytes before projecting inbound caller evidence; this grants no User authority. */
export const authenticateWhatsAppInbound: typeof decodeKapsoWebhook = (input) =>
  decodeKapsoWebhook(input);
/** Authenticate and project only correlated disclosure status; send acceptance is not visible delivery. */
export const authenticateDisclosureStatus: typeof decodeKapsoDisclosureLifecycleWebhook = (input) =>
  decodeKapsoDisclosureLifecycleWebhook(input);
/** Authenticate correlated hosted delivery evidence, preserving sent versus delivered semantics. */
export const authenticateHostedStatus: typeof decodeKapsoHostedLifecycleWebhook = (input) =>
  decodeKapsoHostedLifecycleWebhook(input);
/** Authenticate an immutable BSUID-change observation; Identity alone decides the stable association. */
export const authenticateIdentityChange: typeof decodeKapsoIdentityWebhook = (input) =>
  decodeKapsoIdentityWebhook(input);
