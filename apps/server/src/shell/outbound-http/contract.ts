import { Data, type Option } from "effect";
import type { WhatsAppBusinessPhoneNumberId } from "~/shell/channels/whatsapp/model";

/** Closed coordinate-free reason reported by the Outbound HTTP interface. */
export type OutboundHttpFailureReason =
  | "response-body-failed"
  | "response-too-large"
  | "transport-failed";

/**
 * Transport failure containing only response facts an adapter may safely use for provider
 * interpretation. It never carries a destination, credential, request, response body, or cause.
 */
export class OutboundHttpFailure extends Data.TaggedError("OutboundHttpFailure")<{
  readonly reason: OutboundHttpFailureReason;
  readonly responseStatus: Option.Option<number>;
  /** Only the destination policy's explicitly retained protocol headers. */
  readonly responseHeaders: Readonly<Record<string, string>>;
}> {}

/** Response whose body has passed the destination policy's actual streamed-byte bound. */
export type OutboundHttpResponse = Readonly<{
  readonly status: number;
  /** Only the destination policy's explicitly retained protocol headers. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}>;

/** Values needed to encode and sign one Wompi transaction without exposing signing authority. */
export type WompiTransactionBody = Readonly<{
  readonly amountInCents: number;
  readonly currency: string;
  readonly billingEmail: string;
  readonly sourceId: number;
  readonly reference: string;
}>;

/**
 * One provider call accepted by Outbound HTTP. Its tag selects a fixed method, origin, credentials,
 * response bound, retained headers, redirect behavior, and trace policy. Wompi transaction signing
 * stays inside the interface because its integrity secret is transport authority; all other
 * provider request bodies remain encoded by their owning adapter.
 */
export type OutboundHttpRequest =
  | Readonly<{
      readonly _tag: "KapsoMessages";
      readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
      readonly body: string;
    }>
  | Readonly<{ readonly _tag: "WompiMerchant" }>
  | Readonly<{
      readonly _tag: "WompiCreatePaymentSource";
      readonly body: string;
    }>
  | Readonly<{
      readonly _tag: "WompiVerifyPaymentSource";
      readonly sourceId: number;
    }>
  | Readonly<{
      readonly _tag: "WompiCreateTransaction";
      readonly body: WompiTransactionBody;
    }>
  | Readonly<{
      readonly _tag: "WompiFindTransaction";
      readonly transactionId: string;
    }>;
