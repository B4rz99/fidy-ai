import { Data, DateTime, Effect, Option, Schema } from "effect";
import { E164PhoneNumber } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppDeliveryKey,
  WhatsAppMediaId,
  WhatsAppProviderMessageId,
  type WhatsAppInboundContent,
  type WhatsAppInboundEvent,
  type WhatsAppWebhookReceipt,
} from "./model";

/** Maximum raw Kapso delivery accepted before payload decoding. */
export const maxKapsoWebhookBytes = 1_048_576;
/** Kapso's documented maximum number of events in one buffered delivery. */
export const maxKapsoDeliveryEvents = 100;

/** Signature is absent, malformed, or does not authenticate the exact raw bytes. */
export class InvalidKapsoSignature extends Data.TaggedError("InvalidKapsoSignature")<{}> {}
/** Raw webhook bytes exceed Fidy's fixed launch resource bound. */
export class KapsoPayloadTooLarge extends Data.TaggedError("KapsoPayloadTooLarge")<{}> {}
/** Authentic JSON does not match the supported Kapso v2 message projection. */
export class InvalidKapsoPayload extends Data.TaggedError("InvalidKapsoPayload")<{}> {}
/** Authentic buffered delivery exceeds Kapso's documented event maximum. */
export class KapsoBatchTooLarge extends Data.TaggedError("KapsoBatchTooLarge")<{}> {}

const rawMessageFields = {
  id: WhatsAppProviderMessageId,
  timestamp: Schema.String.check(Schema.isPattern(/^[0-9]{1,16}$/u)),
  from: Schema.String,
};
const RawTextMessage = Schema.Struct({
  ...rawMessageFields,
  type: Schema.Literal("text"),
  text: Schema.Struct({ body: TranscriptText }),
});
const RawVoiceMessage = Schema.Struct({
  ...rawMessageFields,
  type: Schema.Literal("audio"),
  audio: Schema.Struct({ id: WhatsAppMediaId }),
  kapso: Schema.Struct({ transcript: Schema.Struct({ text: TranscriptText }) }),
});
const RawKapsoEvent = Schema.Struct({
  message: Schema.Union([RawTextMessage, RawVoiceMessage]),
  phone_number_id: WhatsAppBusinessPhoneNumberId,
});
const RawKapsoEnvelope = Schema.Union([
  RawKapsoEvent,
  Schema.Struct({
    batch: Schema.Literal(true),
    data: Schema.NonEmptyArray(RawKapsoEvent),
  }),
]);

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const normalizePhoneNumber = (phoneNumber: string) =>
  Schema.decodeUnknownEffect(E164PhoneNumber)(
    phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`
  );

const projectEvent = Effect.fn("Kapso.projectWebhookEvent")(function* (
  raw: typeof RawKapsoEvent.Type,
  receivedAt: DateTime.Utc
) {
  const phoneNumber = yield* normalizePhoneNumber(raw.message.from);
  const seconds = Number(raw.message.timestamp);
  if (!Number.isSafeInteger(seconds)) return yield* new InvalidKapsoPayload();
  const parsedOccurredAt = DateTime.make(seconds * 1_000);
  if (Option.isNone(parsedOccurredAt)) return yield* new InvalidKapsoPayload();
  const occurredAt = DateTime.toUtc(parsedOccurredAt.value);
  if (DateTime.Order(occurredAt, DateTime.add(receivedAt, { minutes: 5 })) > 0) {
    return yield* new InvalidKapsoPayload();
  }
  const content: WhatsAppInboundContent =
    raw.message.type === "text"
      ? { _tag: "Text", text: raw.message.text.body }
      : {
          _tag: "VoiceTranscript",
          text: raw.message.kapso.transcript.text,
          mediaId: raw.message.audio.id,
        };
  return {
    messageEvidence: {
      channel: "whatsapp",
      provider: "kapso",
      providerMessageId: raw.message.id,
    },
    phoneNumber,
    businessPhoneNumberId: raw.phone_number_id,
    occurredAt,
    receivedAt,
    content,
  } satisfies WhatsAppInboundEvent;
});

/**
 * Authenticates at most 1 MiB of exact raw bytes with a lowercase/uppercase hexadecimal
 * HMAC-SHA256 signature and a secret of at least 16 characters before parsing. deliveryKey is the
 * provider retry key; receivedAt is Fidy's receipt clock used for the five-minute future-timestamp
 * tolerance. Projects at most 100 supported v2 events. Fails with InvalidKapsoSignature,
 * KapsoPayloadTooLarge, KapsoBatchTooLarge, or InvalidKapsoPayload and reveals no decoded content
 * when authentication fails.
 */
export const decodeKapsoWebhook = Effect.fn("Kapso.decodeWebhook")(function* (input: {
  readonly rawBody: Uint8Array;
  readonly secret: string;
  readonly signature: string;
  readonly deliveryKey: string;
  readonly receivedAt: DateTime.Utc;
}) {
  if (input.rawBody.byteLength > maxKapsoWebhookBytes) {
    return yield* new KapsoPayloadTooLarge();
  }
  if (input.secret.length < 16) return yield* new InvalidKapsoSignature();
  const expected = new Bun.CryptoHasher("sha256", input.secret).update(input.rawBody).digest("hex");
  if (!constantTimeEqual(expected, input.signature.toLowerCase())) {
    return yield* new InvalidKapsoSignature();
  }
  const deliveryKey = yield* Schema.decodeUnknownEffect(WhatsAppDeliveryKey)(
    input.deliveryKey
  ).pipe(Effect.mapError(() => new InvalidKapsoPayload()));
  const unknown = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
    new TextDecoder().decode(input.rawBody)
  ).pipe(Effect.mapError(() => new InvalidKapsoPayload()));
  const envelope = yield* Schema.decodeUnknownEffect(RawKapsoEnvelope)(unknown).pipe(
    Effect.mapError(() => new InvalidKapsoPayload())
  );
  const rawEvents = "data" in envelope ? envelope.data : [envelope];
  if (rawEvents.length > maxKapsoDeliveryEvents) {
    return yield* new KapsoBatchTooLarge();
  }
  const events = yield* Effect.forEach(
    rawEvents,
    (event) => projectEvent(event, input.receivedAt),
    {
      concurrency: 1,
    }
  ).pipe(Effect.mapError(() => new InvalidKapsoPayload()));
  const [first, ...rest] = events;
  return { deliveryKey, events: [first, ...rest] } satisfies WhatsAppWebhookReceipt;
});
