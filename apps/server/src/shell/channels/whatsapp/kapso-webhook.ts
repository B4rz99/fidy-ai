import { UnknownJsonString } from "~/schema-compatibility";
import { Data, DateTime, Effect, Array as EffectArray, Option, Schema } from "effect";
import { Model } from "effect/unstable/schema";
import {
  E164PhoneNumber,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  WhatsAppParentBusinessScopedUserId,
  WhatsAppUsername,
} from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import {
  DisclosureDeliveryCorrelationToken,
  type DisclosureDeliveryFailureReason,
} from "./disclosure-model";
import { classifyKapsoMetaFailureCode } from "./kapso-failure";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppDeliveryKey,
  type WhatsAppIdentityChangeEvent,
  type WhatsAppInboundContent,
  type WhatsAppInboundEvent,
  WhatsAppMediaId,
  type WhatsAppMessageEvidence,
  WhatsAppProviderMessageId,
  type WhatsAppWebhookReceipt,
} from "./model";

/** Maximum raw Kapso delivery accepted before payload decoding. */
export const maxKapsoWebhookBytes = 1_048_576;
/** Kapso's documented maximum number of events in one buffered delivery. */
export const maxKapsoDeliveryEvents = 100;

const hmacSha256HexLength = 64;
const minimumWebhookSecretLength = 16;
const millisecondsPerSecond = 1_000;

/** Signature is absent, malformed, or does not authenticate the exact raw bytes. */
export class InvalidKapsoSignature extends Data.TaggedError("InvalidKapsoSignature")<{}> {}
/** Raw webhook bytes exceed Fidy's fixed launch resource bound. */
export class KapsoPayloadTooLarge extends Data.TaggedError("KapsoPayloadTooLarge")<{}> {}
/** Authentic JSON does not match the supported Kapso v2 message projection. */
export class InvalidKapsoPayload extends Data.TaggedError("InvalidKapsoPayload")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return "The authentic Kapso payload did not match the supported projection";
  }
}

const invalidKapsoPayload = (cause: unknown): InvalidKapsoPayload =>
  new InvalidKapsoPayload({ cause });
const invalidKapsoInvariant = (reason: string): InvalidKapsoPayload =>
  invalidKapsoPayload(new Error(reason));
/** Authentic buffered delivery exceeds Kapso's documented event maximum. */
export class KapsoBatchTooLarge extends Data.TaggedError("KapsoBatchTooLarge")<{}> {}

const rawMessageFields = {
  id: WhatsAppProviderMessageId,
  timestamp: Schema.String.check(Schema.isPattern(/^[0-9]{1,16}$/u)),
  from: Model.optionalOption(Schema.String),
  from_user_id: Model.optionalOption(WhatsAppBusinessScopedUserId),
  from_parent_user_id: Model.optionalOption(WhatsAppParentBusinessScopedUserId),
  username: Model.optionalOption(WhatsAppUsername),
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
  conversation: Schema.Struct({
    phone_number: Model.optionalOption(Schema.String),
    business_scoped_user_id: Model.optionalOption(WhatsAppBusinessScopedUserId),
    parent_business_scoped_user_id: Model.optionalOption(WhatsAppParentBusinessScopedUserId),
    username: Model.optionalOption(WhatsAppUsername),
  }),
  phone_number_id: WhatsAppBusinessPhoneNumberId,
});
const RawKapsoEnvelope = Schema.Union([
  RawKapsoEvent,
  Schema.Struct({
    batch: Schema.Literal(true),
    data: Schema.NonEmptyArray(RawKapsoEvent),
  }),
]);

const RawDisclosureStatus = Schema.Struct({
  id: WhatsAppProviderMessageId,
  status: Schema.Literals(["sent", "delivered", "failed"]),
  timestamp: Schema.String.check(Schema.isPattern(/^[0-9]{1,16}$/u)),
  biz_opaque_callback_data: DisclosureDeliveryCorrelationToken,
  errors: Model.optionalOption(Schema.Array(Schema.Struct({ code: Schema.Int }))),
});
const RawDisclosureLifecycleEvent = Schema.Struct({
  message: Schema.Struct({
    id: WhatsAppProviderMessageId,
    kapso: Schema.Struct({ statuses: Schema.Array(RawDisclosureStatus) }),
  }),
  phone_number_id: WhatsAppBusinessPhoneNumberId,
});

type KapsoDisclosureLifecycleEvidenceBase = Readonly<{
  correlationToken: DisclosureDeliveryCorrelationToken;
  messageEvidence: WhatsAppMessageEvidence;
  occurredAt: DateTime.Utc;
}>;

/** Authenticated, metadata-only lifecycle evidence projected from a Kapso webhook. */
export type KapsoDisclosureLifecycleEvidence = KapsoDisclosureLifecycleEvidenceBase &
  (
    | Readonly<{ readonly outcome: "sent" }>
    | Readonly<{ readonly outcome: "accepted" }>
    | Readonly<{
        readonly outcome: "failed";
        readonly reason: DisclosureDeliveryFailureReason;
        readonly automaticRetry: boolean;
      }>
  );

const RawMetaEnvelope = Schema.Struct({
  object: Schema.Literal("whatsapp_business_account"),
  entry: Schema.Array(
    Schema.Struct({
      changes: Schema.Array(
        Schema.Struct({
          value: Schema.Struct({ messages: Schema.optional(Schema.Array(Schema.Unknown)) }),
        })
      ),
    })
  ),
});
const RawMetaMessageType = Schema.Struct({
  type: Schema.optional(Schema.String),
  system: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
});
const RawIdentityChangeMessage = Schema.Struct({
  id: WhatsAppProviderMessageId,
  timestamp: Schema.String.check(Schema.isPattern(/^[0-9]{1,16}$/u)),
  type: Schema.Literal("system"),
  system: Schema.Struct({
    body: Schema.String,
    wa_id: Schema.optional(Schema.String),
    user_id: WhatsAppBusinessScopedUserId,
    parent_user_id: Schema.optional(WhatsAppParentBusinessScopedUserId),
    type: Schema.Literal("user_changed_user_id"),
  }),
});

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== hmacSha256HexLength || right.length !== hmacSha256HexLength) return false;
  let difference = 0;
  for (let index = 0; index < hmacSha256HexLength; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const normalizePhoneNumber = (
  phoneNumber: string
): Effect.Effect<E164PhoneNumber, Schema.SchemaError> =>
  Schema.decodeEffect(E164PhoneNumber)(
    phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`
  );

const authenticateAndDecodeKapsoBody = Effect.fn("Kapso.authenticateAndDecodeBody")(
  function* (input: {
    readonly rawBody: Uint8Array;
    readonly secret: string;
    readonly signature: string;
  }) {
    if (input.rawBody.byteLength > maxKapsoWebhookBytes) {
      return yield* new KapsoPayloadTooLarge();
    }
    if (input.secret.length < minimumWebhookSecretLength) {
      return yield* new InvalidKapsoSignature();
    }
    const expected = new Bun.CryptoHasher("sha256", input.secret)
      .update(input.rawBody)
      .digest("hex");
    if (!constantTimeEqual(expected, input.signature.toLowerCase())) {
      return yield* new InvalidKapsoSignature();
    }
    return yield* Schema.decodeEffect(UnknownJsonString)(
      new TextDecoder().decode(input.rawBody)
    ).pipe(Effect.mapError(invalidKapsoPayload));
  }
);

const parseOccurredAt = Effect.fn("Kapso.parseOccurredAt")(function* (
  timestamp: string,
  receivedAt: DateTime.Utc
) {
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) {
    return yield* invalidKapsoInvariant("Kapso timestamp was not a safe integer");
  }
  const parsed = DateTime.make(seconds * millisecondsPerSecond);
  if (Option.isNone(parsed)) {
    return yield* invalidKapsoInvariant("Kapso timestamp was outside the supported date range");
  }
  const occurredAt = DateTime.toUtc(parsed.value);
  if (DateTime.Order(occurredAt, DateTime.add(receivedAt, { minutes: 5 })) > 0) {
    return yield* invalidKapsoInvariant("Kapso timestamp exceeded the future-time tolerance");
  }
  return occurredAt;
});

const projectEvent = Effect.fn("Kapso.projectWebhookEvent")(function* (
  raw: typeof RawKapsoEvent.Type,
  businessPortfolioId: WhatsAppBusinessPortfolioId,
  receivedAt: DateTime.Utc
) {
  const messageBsuid = raw.message.from_user_id;
  const conversationBsuid = raw.conversation.business_scoped_user_id;
  if (
    Option.isSome(messageBsuid) &&
    Option.isSome(conversationBsuid) &&
    messageBsuid.value !== conversationBsuid.value
  ) {
    return yield* invalidKapsoInvariant("Kapso message and conversation BSUIDs disagreed");
  }
  const businessScopedUserId = Option.orElse(messageBsuid, () => conversationBsuid);
  if (Option.isNone(businessScopedUserId)) {
    return yield* invalidKapsoInvariant("Kapso event carried no portfolio-scoped BSUID");
  }

  const rawPhone = Option.orElse(raw.message.from, () => raw.conversation.phone_number);
  const phoneNumber = yield* Option.match(rawPhone, {
    onNone: () => Effect.succeed(Option.none<E164PhoneNumber>()),
    onSome: (phone) => normalizePhoneNumber(phone).pipe(Effect.map(Option.some)),
  });
  const occurredAt = yield* parseOccurredAt(raw.message.timestamp, receivedAt);
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
    caller: {
      businessPortfolioId,
      businessScopedUserId: businessScopedUserId.value,
      parentBusinessScopedUserId: Option.orElse(
        raw.message.from_parent_user_id,
        () => raw.conversation.parent_business_scoped_user_id
      ),
      username: Option.orElse(raw.message.username, () => raw.conversation.username),
      phoneNumber,
    },
    businessPhoneNumberId: raw.phone_number_id,
    occurredAt,
    receivedAt,
    content,
  } satisfies WhatsAppInboundEvent;
});

/**
 * Authenticates at most 1 MiB of exact raw bytes with a lowercase/uppercase hexadecimal
 * HMAC-SHA256 signature and a secret of at least 16 characters before parsing. `deliveryKey` is the
 * provider retry key; `businessPortfolioId` is trusted deployment context, must satisfy the
 * Business Portfolio schema, and is projected into every caller rather than read from the payload.
 * `receivedAt` is Fidy's receipt clock used for the five-minute future-timestamp tolerance. Projects
 * at most 100 supported v2 events. Fails with InvalidKapsoSignature,
 * KapsoPayloadTooLarge, KapsoBatchTooLarge, or InvalidKapsoPayload and reveals no decoded content
 * when authentication fails.
 */
export const decodeKapsoWebhook = Effect.fn("Kapso.decodeWebhook")(function* (input: {
  readonly rawBody: Uint8Array;
  readonly secret: string;
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
  if (rawEvents.length > maxKapsoDeliveryEvents) {
    return yield* new KapsoBatchTooLarge();
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

/** Kapso event names routed through disclosure lifecycle reconciliation. */
export const DisclosureLifecycleEventName = Schema.Literals([
  "whatsapp.message.sent",
  "whatsapp.message.delivered",
  "whatsapp.message.failed",
]);
const lifecycleFailure = (
  code: number
): Readonly<{ reason: DisclosureDeliveryFailureReason; automaticRetry: boolean }> => {
  const disposition = classifyKapsoMetaFailureCode(code);
  return { reason: disposition.safeReason, automaticRetry: disposition.automaticRetry };
};

/** Projects one provider-held raw status into the same metadata-only evidence used by webhooks. */
const projectDecodedDisclosureLifecycleStatus = Effect.fn(
  "Kapso.projectDecodedDisclosureLifecycleStatus"
)(function* (input: {
  readonly status: typeof RawDisclosureStatus.Type;
  readonly receivedAt: DateTime.Utc;
}) {
  const providerStatus = input.status;
  const occurredAt = yield* parseOccurredAt(providerStatus.timestamp, input.receivedAt);
  const evidence = {
    correlationToken: providerStatus.biz_opaque_callback_data,
    messageEvidence: {
      channel: "whatsapp" as const,
      provider: "kapso" as const,
      providerMessageId: providerStatus.id,
    },
    occurredAt,
  };
  if (providerStatus.status === "failed") {
    const errorCode = Option.getOrUndefined(providerStatus.errors)?.at(0)?.code ?? 0;
    return {
      ...evidence,
      outcome: "failed" as const,
      ...lifecycleFailure(errorCode),
    } satisfies KapsoDisclosureLifecycleEvidence;
  }
  if (providerStatus.status === "sent") {
    return { ...evidence, outcome: "sent" as const } satisfies KapsoDisclosureLifecycleEvidence;
  }
  return { ...evidence, outcome: "accepted" as const } satisfies KapsoDisclosureLifecycleEvidence;
});

const lifecycleStatus = (
  eventName: typeof DisclosureLifecycleEventName.Type
): "sent" | "delivered" | "failed" => {
  switch (eventName) {
    case "whatsapp.message.sent":
      return "sent";
    case "whatsapp.message.delivered":
      return "delivered";
    case "whatsapp.message.failed":
      return "failed";
  }
};

const latestDisclosureLifecycleStatus = Effect.fn("Kapso.latestDisclosureLifecycleStatus")(
  function* (statuses: ReadonlyArray<typeof RawDisclosureStatus.Type>, receivedAt: DateTime.Utc) {
    const projected = yield* Effect.forEach(statuses, (status) =>
      projectDecodedDisclosureLifecycleStatus({ status, receivedAt }).pipe(
        Effect.map((evidence) => ({ evidence, status }))
      )
    );
    return projected.reduce<
      Option.Option<{
        readonly evidence: KapsoDisclosureLifecycleEvidence;
        readonly status: typeof RawDisclosureStatus.Type;
      }>
    >(
      (latest, candidate) =>
        Option.isNone(latest) ||
        DateTime.Order(candidate.evidence.occurredAt, latest.value.evidence.occurredAt) > 0
          ? Option.some(candidate)
          : latest,
      Option.none()
    );
  }
);

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
export const decodeKapsoDisclosureLifecycleWebhook = Effect.fn(
  "Kapso.decodeDisclosureLifecycleWebhook"
)(function* (input: {
  readonly rawBody: Uint8Array;
  readonly secret: string;
  readonly signature: string;
  readonly eventName: string;
  readonly receivedAt: DateTime.Utc;
}) {
  const unknown = yield* authenticateAndDecodeKapsoBody(input);
  const eventName = yield* Schema.decodeUnknownEffect(DisclosureLifecycleEventName)(
    input.eventName
  ).pipe(Effect.mapError(invalidKapsoPayload));
  const status = lifecycleStatus(eventName);
  const raw = yield* Schema.decodeUnknownEffect(RawDisclosureLifecycleEvent)(unknown).pipe(
    Effect.mapError(invalidKapsoPayload)
  );
  const latest = yield* latestDisclosureLifecycleStatus(
    raw.message.kapso.statuses,
    input.receivedAt
  );
  if (Option.isNone(latest)) {
    return yield* new InvalidKapsoPayload({ cause: "missing provider status" });
  }
  if (latest.value.status.status !== status || latest.value.status.id !== raw.message.id) {
    return yield* new InvalidKapsoPayload({ cause: "event/status mismatch" });
  }
  return latest.value.evidence;
});

const projectIdentityChange = Effect.fn("Kapso.projectIdentityChange")(function* (
  message: unknown,
  businessPortfolioId: WhatsAppBusinessPortfolioId,
  receivedAt: DateTime.Utc
) {
  const type = yield* Schema.decodeUnknownEffect(RawMetaMessageType)(message).pipe(
    Effect.mapError(invalidKapsoPayload)
  );
  if (type.type !== "system" || type.system?.type !== "user_changed_user_id") {
    return Option.none<WhatsAppIdentityChangeEvent>();
  }
  const raw = yield* Schema.decodeUnknownEffect(RawIdentityChangeMessage)(message).pipe(
    Effect.mapError(invalidKapsoPayload)
  );
  const changedIds = Option.fromNullishOr(/ changed from (\S+) to (\S+)$/u.exec(raw.system.body));
  if (Option.isNone(changedIds)) {
    return yield* invalidKapsoInvariant("Kapso identity-change body named no BSUID transition");
  }
  const previousBsuid = yield* Schema.decodeUnknownEffect(WhatsAppBusinessScopedUserId)(
    changedIds.value[1]
  ).pipe(Effect.mapError(invalidKapsoPayload));
  const replacementBsuid = yield* Schema.decodeUnknownEffect(WhatsAppBusinessScopedUserId)(
    changedIds.value[2]
  ).pipe(Effect.mapError(invalidKapsoPayload));
  if (replacementBsuid !== raw.system.user_id) {
    return yield* invalidKapsoInvariant("Kapso identity-change replacement BSUIDs disagreed");
  }
  const phoneNumber = yield* Option.match(Option.fromNullishOr(raw.system.wa_id), {
    onNone: () => Effect.succeed(Option.none<E164PhoneNumber>()),
    onSome: (phone) => normalizePhoneNumber(phone).pipe(Effect.map(Option.some)),
  });
  const occurredAt = yield* parseOccurredAt(raw.timestamp, receivedAt);
  return Option.some({
    messageEvidence: {
      channel: "whatsapp",
      provider: "kapso",
      providerMessageId: raw.id,
    },
    previousCaller: { businessPortfolioId, businessScopedUserId: previousBsuid },
    replacement: {
      businessScopedUserId: replacementBsuid,
      parentBusinessScopedUserId: Option.fromNullishOr(raw.system.parent_user_id),
      username: Option.none(),
      phoneNumber,
    },
    occurredAt,
  } satisfies WhatsAppIdentityChangeEvent);
});

/**
 * Authenticates the exact raw Meta bytes forwarded by Kapso with a 64-character hexadecimal
 * HMAC-SHA256 signature and a secret of at least 16 characters. `businessPortfolioId` is trusted
 * deployment context; `receivedAt` bounds future provider timestamps. The body is limited to 1 MiB
 * and 100 events. Structured `user_changed_user_id` messages are returned as immutable events;
 * unrelated events are omitted. Invalid proof, configuration, JSON, identity fields, timestamps,
 * event count, or body size fail with the corresponding Kapso boundary error before any write.
 */
export const decodeKapsoIdentityWebhook = Effect.fn("Kapso.decodeIdentityWebhook")(
  function* (input: {
    readonly rawBody: Uint8Array;
    readonly secret: string;
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
    if (messages.length > maxKapsoDeliveryEvents) return yield* new KapsoBatchTooLarge();

    const projected = yield* Effect.forEach(
      messages,
      (message) => projectIdentityChange(message, businessPortfolioId, input.receivedAt),
      { concurrency: 1 }
    );
    const changes: ReadonlyArray<WhatsAppIdentityChangeEvent> = EffectArray.getSomes(projected);
    return changes;
  }
);
