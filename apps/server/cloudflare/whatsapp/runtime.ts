import { refuseVoice } from "./internal/voice-refusal";
import {
  nativeDeliveryRequest as nativeDeliveryRequestOwned,
  routeWhatsAppStatus as routeWhatsAppStatusOwned,
} from "./internal/native-delivery";
import { receiveIngress } from "./internal/ingress";

export const receiveWhatsAppWebhook: typeof receiveIngress = (environment) =>
  receiveIngress(environment);

export const nativeDeliveryRequest: typeof nativeDeliveryRequestOwned = (...args) =>
  nativeDeliveryRequestOwned(...args);

export const routeWhatsAppStatus: typeof routeWhatsAppStatusOwned = (...args) =>
  routeWhatsAppStatusOwned(...args);

export const nativeVoiceRefusal: typeof refuseVoice = (input) => refuseVoice(input);
