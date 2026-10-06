import type {
  DisclosureDeliveryCorrelationToken,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../../src/shell/consent/contract";

/** Authenticated disclosure delivery facts; recording them never grants Consent. */
export type ConsentDeliveryInput = Readonly<{
  correlationToken: DisclosureDeliveryCorrelationToken;
  phoneNumberId: WhatsAppBusinessPhoneNumberId;
  messageId: WhatsAppProviderMessageId;
  occurredAtMs: number;
  receivedAtMs: number;
}>;

/** Pre-User Consent work is reached only after the WhatsApp owner authenticates exact inbound bytes. */
export type ConsentIngressEnvironment = Readonly<{
  DB: D1Database;
  KAPSO_API_KEY: string;
  onAccepted: (id: string) => void;
}>;
