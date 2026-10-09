import {
  WhatsAppBatchTooLarge,
  WhatsAppDeliveryKey,
  type WhatsAppIdentityChangeEvent,
  type WhatsAppLifecycleAuthentication,
  type WhatsAppWebhookReceipt,
  maxWhatsAppDeliveryEvents,
} from "./contract";
import { type DateTime, Effect, Array as EffectArray, Option, type Redacted, Schema } from "effect";
import { WhatsAppBusinessPortfolioId } from "~/core/identity/contract";
import {
  RawKapsoEnvelope,
  RawMetaEnvelope,
  authenticateAndDecodeKapsoBody,
  decodeLifecycleStatus,
  invalidKapsoPayload,
  projectEvent,
  projectHostedStatus,
  projectIdentityChange,
} from "~/shell/channels/whatsapp/internal/kapso-webhook";

/**
 * Authenticates at most 1 MiB of exact raw bytes with a strictly decoded hexadecimal HMAC-SHA256
 * signature compared in constant time and a secret of at least 16 characters before parsing.
 * `deliveryKey` is the provider retry key; `businessPortfolioId` is trusted deployment context,
 * must satisfy the Business Portfolio schema, and is projected into every caller rather than read
 * from the payload.
 * `receivedAt` is Fidy's receipt clock used for the five-minute future-timestamp tolerance. Projects
 * at most 100 supported v2 events. Fails with InvalidWhatsAppSignature,
 * WhatsAppPayloadTooLarge, WhatsAppBatchTooLarge, or InvalidWhatsAppPayload and reveals no decoded content
 * when authentication fails.
 */
export const authenticateWhatsAppInbound = Effect.fn(function* (input: {
  readonly rawBody: Uint8Array;
  readonly secret: Redacted.Redacted<string>;
  readonly signature: string;
  readonly deliveryKey: string;
  readonly businessPortfolioId: string;
  readonly receivedAt: DateTime.Utc;
}) {
  const unknown = yield* authenticateAndDecodeKapsoBody(input);
  const deliveryKey = yield* Schema.decodeEffect(WhatsAppDeliveryKey)(input.deliveryKey).pipe(
    Effect.mapError(invalidKapsoPayload)
  );
  const businessPortfolioId = yield* Schema.decodeEffect(WhatsAppBusinessPortfolioId)(
    input.businessPortfolioId
  ).pipe(Effect.mapError(invalidKapsoPayload));
  const envelope = yield* Schema.decodeUnknownEffect(RawKapsoEnvelope)(unknown).pipe(
    Effect.mapError(invalidKapsoPayload)
  );
  const rawEvents = "data" in envelope ? envelope.data : [envelope];
  if (rawEvents.length > maxWhatsAppDeliveryEvents) {
    return yield* new WhatsAppBatchTooLarge();
  }
  const events = yield* Effect.forEach(
    rawEvents,
    (event) => projectEvent(event, businessPortfolioId, input.receivedAt),
    {
      concurrency: 1,
    }
  ).pipe(Effect.mapError(invalidKapsoPayload));
  const [first, ...rest] = events;
  return { deliveryKey, events: [first, ...rest] } satisfies WhatsAppWebhookReceipt;
});

/**
 * Authenticates the exact raw Kapso status before projecting a hosted reply's provider evidence.
 * `sent` and `delivered` remain distinct; only `delivered` can prove channel delivery. A callback
 * must be correlated with an existing User-owned attempt before changing a Turn. No body or
 * recipient evidence escapes this projection.
 */
export const authenticateHostedStatus = Effect.fn(function* (
  input: WhatsAppLifecycleAuthentication
) {
  const latest = yield* decodeLifecycleStatus(input);
  if (Option.isNone(latest)) return yield* invalidKapsoPayload("uncorrelated hosted status");
  return projectHostedStatus(latest.value);
});

/**
 * Authenticates at most 1 MiB of exact raw bytes with the configured 16+-character secret and a
 * hexadecimal HMAC-SHA256 `signature` before parsing. `eventName` must be one supported disclosure
 * lifecycle event and must match the body's latest chronological status; `receivedAt` bounds future provider time.
 * Failed statuses are retryable only for the allowlisted transient Meta error codes; unknown or
 * absent failure codes fail terminally. Projects only opaque correlation and safe provider metadata.
 * Invalid proof, configuration, JSON,
 * event/status mismatch, timestamp, or body size fails with the corresponding Kapso boundary error
 * before any state change.
 */
export const authenticateDisclosureStatus = Effect.fn(function* (
  input: WhatsAppLifecycleAuthentication
) {
  const latest = yield* decodeLifecycleStatus(input);
  if (Option.isNone(latest)) return yield* invalidKapsoPayload("uncorrelated disclosure status");
  return { ...latest.value.evidence, businessPhoneNumberId: latest.value.businessPhoneNumberId };
});

/**
 * Authenticates the exact raw Meta bytes forwarded by Kapso with a 64-character hexadecimal
 * HMAC-SHA256 signature and a secret of at least 16 characters. `businessPortfolioId` is trusted
 * deployment context; `receivedAt` bounds future provider timestamps. The body is limited to 1 MiB
 * and 100 events. Structured `user_changed_user_id` messages are returned as immutable events;
 * unrelated events are omitted. Invalid proof, configuration, JSON, identity fields, timestamps,
 * event count, or body size fail with the corresponding Kapso boundary error before any write.
 */
export const authenticateIdentityChange = Effect.fn(function* (input: {
  readonly rawBody: Uint8Array;
  readonly secret: Redacted.Redacted<string>;
  readonly signature: string;
  readonly businessPortfolioId: string;
  readonly receivedAt: DateTime.Utc;
}) {
  const unknown = yield* authenticateAndDecodeKapsoBody(input);
  const businessPortfolioId = yield* Schema.decodeEffect(WhatsAppBusinessPortfolioId)(
    input.businessPortfolioId
  ).pipe(Effect.mapError(invalidKapsoPayload));
  const envelope = yield* Schema.decodeUnknownEffect(RawMetaEnvelope)(unknown).pipe(
    Effect.mapError(invalidKapsoPayload)
  );
  const messages = envelope.entry.flatMap((entry) =>
    entry.changes.flatMap((change) => change.value.messages ?? [])
  );
  if (messages.length > maxWhatsAppDeliveryEvents) return yield* new WhatsAppBatchTooLarge();

  const projected = yield* Effect.forEach(
    messages,
    (message) => projectIdentityChange(message, businessPortfolioId, input.receivedAt),
    { concurrency: 1 }
  );
  const changes: ReadonlyArray<WhatsAppIdentityChangeEvent> = EffectArray.getSomes(projected);
  return changes;
});
