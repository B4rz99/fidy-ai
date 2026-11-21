import { refuseVoice } from "./internal/voice-refusal";
import {
  nativeDeliveryRequest as nativeDeliveryRequestOwned,
  routeWhatsAppStatus as routeWhatsAppStatusOwned,
} from "./internal/native-delivery";
import { Effect } from "effect";
import { WhatsAppUnavailable } from "./contract";
import { receiveIngress } from "./internal/ingress";
import { sweepExpiredWhatsAppWindows as sweepExpiredWhatsAppWindowsOwned } from "./internal/whatsapp-turn";

export const receiveWhatsAppWebhook: typeof receiveIngress = (environment) =>
  receiveIngress(environment);

export const sweepExpiredWhatsAppWindows = (
  input: Parameters<typeof sweepExpiredWhatsAppWindowsOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof sweepExpiredWhatsAppWindowsOwned>>,
  WhatsAppUnavailable
> => sweepExpiredWhatsAppWindowsOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const nativeDeliveryRequest: typeof nativeDeliveryRequestOwned = (...args) =>
  nativeDeliveryRequestOwned(...args);
export const routeWhatsAppStatus: typeof routeWhatsAppStatusOwned = (...args) =>
  routeWhatsAppStatusOwned(...args);

export const nativeVoiceRefusal: typeof refuseVoice = (input) => refuseVoice(input);
