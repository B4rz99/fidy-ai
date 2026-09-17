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

/** Kapso's fixed message-creation destination; its origin and credential remain private. */
export type KapsoMessagesDestination = Readonly<{
  readonly _tag: "KapsoMessages";
  readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
}>;

/**
 * One provider call accepted by Outbound HTTP. The destination selects fixed method, origin,
 * credentials, response bound, retained headers, redirects, and trace policy; callers retain only
 * provider request-body encoding.
 */
export type OutboundHttpRequest = Readonly<{
  readonly destination: KapsoMessagesDestination;
  readonly body: string;
}>;
