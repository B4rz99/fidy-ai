import {
  DisclosureDeliveryCorrelationToken,
  type DisclosureDeliveryFailureReason,
  HostedDeliveryCorrelationToken,
  InvalidWhatsAppPayload,
  InvalidWhatsAppSignature,
  WhatsAppBusinessPhoneNumberId,
  type WhatsAppDisclosureLifecycleEvidence,
  WhatsAppDocumentFileName,
  type WhatsAppHostedLifecycleEvidence,
  type WhatsAppIdentityChangeEvent,
  type WhatsAppInboundContent,
  type WhatsAppInboundEvent,
  type WhatsAppLifecycleAuthentication,
  WhatsAppMediaId,
  WhatsAppPayloadTooLarge,
  WhatsAppProviderMessageId,
  type WhatsAppStatusLookupAdmission,
  WhatsAppStatusUnavailable,
  maxWhatsAppFutureTimestampMinutes,
  maxWhatsAppWebhookBytes,
} from "~/shell/channels/whatsapp/contract";
import { DateTime, Effect, Option, Redacted, Result, Schema } from "effect";
import { Hex } from "effect/encoding";
import { Model } from "effect/schema";
import {
  E164PhoneNumber,
  type WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  WhatsAppParentBusinessScopedUserId,
  WhatsAppUsername,
} from "~/core/identity/contract";
import { TranscriptText } from "~/core/agent/contract";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { classifyKapsoMetaFailureCode } from "./kapso-failure";
import { type OutboundHttpService } from "~/shell/outbound-http/operations";
import { okStatus } from "~/shell/public-http/contract";

const hmacSha256Bytes = 32;

const minimumWebhookSecretLength = 16;

const millisecondsPerSecond = 1_000;

export const invalidKapsoPayload = (_cause: unknown): InvalidWhatsAppPayload =>
  new InvalidWhatsAppPayload();

const invalidKapsoInvariant = (_reason: string): InvalidWhatsAppPayload =>
  new InvalidWhatsAppPayload();

const rawMessageFields = {
  id: WhatsAppProviderMessageId,
  context: Model.optionalOption(Schema.Struct({ id: WhatsAppProviderMessageId })),
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
  kapso: Schema.optional(Schema.Unknown),
});

const RawImageMessage = Schema.Struct({
  ...rawMessageFields,
  type: Schema.Literal("image"),
  image: Schema.Struct({
    id: WhatsAppMediaId,
    caption: Model.optionalOption(TranscriptText),
  }),
});

const RawDocumentMessage = Schema.Struct({
  ...rawMessageFields,
  type: Schema.Literal("document"),
  document: Schema.Struct({
    id: WhatsAppMediaId,
    filename: Model.optionalOption(WhatsAppDocumentFileName),
    caption: Model.optionalOption(TranscriptText),
  }),
});

const RawKapsoEvent = Schema.Struct({
  message: Schema.Union([RawTextMessage, RawVoiceMessage, RawImageMessage, RawDocumentMessage]),
  conversation: Schema.Struct({
    phone_number: Model.optionalOption(Schema.String),
    business_scoped_user_id: Model.optionalOption(WhatsAppBusinessScopedUserId),
    parent_business_scoped_user_id: Model.optionalOption(WhatsAppParentBusinessScopedUserId),
    username: Model.optionalOption(WhatsAppUsername),
  }),
  phone_number_id: WhatsAppBusinessPhoneNumberId,
});

export const RawKapsoEnvelope = Schema.Union([
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
  biz_opaque_callback_data: Schema.String.check(Schema.isUUID()),
  errors: Model.optionalOption(Schema.Array(Schema.Struct({ code: Schema.Int }))),
});

const RawReceiptStatus = Schema.Struct({
  ...RawDisclosureStatus.fields,
  status: Schema.Literals(["sent", "delivered", "failed", "read"]),
  biz_opaque_callback_data: Model.optionalOption(Schema.String.check(Schema.isUUID())),
});

const RawReceiptEvent = Schema.Struct({
  message: Schema.Struct({
    id: WhatsAppProviderMessageId,
    kapso: Schema.Struct({ statuses: Schema.NonEmptyArray(RawReceiptStatus) }),
  }),
  phone_number_id: WhatsAppBusinessPhoneNumberId,
});

const RawLifecycleHint = Schema.Struct({
  message: Schema.Struct({
    id: WhatsAppProviderMessageId,
    kapso: Schema.Struct({
      direction: Schema.Literal("outbound"),
      status: Schema.Literals(["sent", "delivered", "failed"]),
      statuses: Model.optionalOption(Schema.Unknown),
    }),
  }),
  phone_number_id: WhatsAppBusinessPhoneNumberId,
});

const RawStoredMessage = Schema.Struct({
  id: WhatsAppProviderMessageId,
  kapso: Schema.Struct({
    direction: Schema.Literal("outbound"),
    phone_number_id: WhatsAppBusinessPhoneNumberId,
    statuses: Schema.NonEmptyArray(RawReceiptStatus),
  }),
});

export const RawMetaEnvelope = Schema.Struct({
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

/**
 * Strictly decodes the hexadecimal claim to the one digest length the contract promises, then
 * compares it to the expected digest with the platform constant-time equality primitive.
 */
const authenticatesDigest = (signature: string, expected: Uint8Array): boolean => {
  const decoded = Hex.decode(signature);
  if (Result.isFailure(decoded)) return false;
  const provided = decoded.success;
  let difference = provided.byteLength ^ expected.byteLength;
  for (let index = 0; index < hmacSha256Bytes; index += 1) {
    difference |= (provided[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
};

const normalizePhoneNumber = (
  phoneNumber: string
): Effect.Effect<E164PhoneNumber, Schema.SchemaError> =>
  Schema.decodeEffect(E164PhoneNumber)(
    phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`
  );

export const authenticateAndDecodeKapsoBody = Effect.fn(function* (input: {
  readonly rawBody: Uint8Array;
  readonly secret: Redacted.Redacted<string>;
  readonly signature: string;
}) {
  if (input.rawBody.byteLength > maxWhatsAppWebhookBytes) {
    return yield* new WhatsAppPayloadTooLarge();
  }
  const secret = Redacted.value(input.secret);
  if (secret.length < minimumWebhookSecretLength) {
    return yield* new InvalidWhatsAppSignature();
  }
  const expected = yield* Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle
        .importKey(
          "raw",
          new TextEncoder().encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        )
        .then((key) => globalThis.crypto.subtle.sign("HMAC", key, Uint8Array.from(input.rawBody)))
        .then((digest) => new Uint8Array(digest)),
    catch: () => new InvalidWhatsAppSignature(),
  });
  if (!authenticatesDigest(input.signature, expected)) {
    return yield* new InvalidWhatsAppSignature();
  }
  return yield* Schema.decodeEffect(UnknownJsonString)(
    new TextDecoder().decode(input.rawBody)
  ).pipe(Effect.mapError(invalidKapsoPayload));
});

const parseOccurredAt = Effect.fn(function* (timestamp: string, receivedAt: DateTime.Utc) {
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) {
    return yield* invalidKapsoInvariant("Kapso timestamp was not a safe integer");
  }
  const parsed = DateTime.make(seconds * millisecondsPerSecond);
  if (Option.isNone(parsed)) {
    return yield* invalidKapsoInvariant("Kapso timestamp was outside the supported date range");
  }
  const occurredAt = DateTime.toUtc(parsed.value);
  if (
    DateTime.Order(
      occurredAt,
      DateTime.add(receivedAt, { minutes: maxWhatsAppFutureTimestampMinutes })
    ) > 0
  ) {
    return yield* invalidKapsoInvariant("Kapso timestamp exceeded the future-time tolerance");
  }
  return occurredAt;
});

const projectInboundContent = (
  message: typeof RawKapsoEvent.Type.message
): WhatsAppInboundContent => {
  if (message.type === "text") return { _tag: "Text", text: message.text.body };
  if (message.type === "image") {
    return { _tag: "Image", mediaId: message.image.id, caption: message.image.caption };
  }
  if (message.type === "document") {
    return {
      _tag: "Document",
      mediaId: message.document.id,
      fileName: message.document.filename,
      caption: message.document.caption,
    };
  }
  const kapso = Schema.decodeUnknownOption(Schema.Struct({ transcript: Schema.Unknown }))(
    message.kapso
  );
  const transcript = Schema.decodeUnknownOption(Schema.Struct({ text: TranscriptText }))(
    Option.getOrUndefined(kapso)?.transcript
  );
  if (Option.isNone(transcript) || transcript.value.text.trim().length === 0) {
    return { _tag: "UnusableVoiceTranscript" };
  }
  return { _tag: "VoiceTranscript", text: transcript.value.text, mediaId: message.audio.id };
};

export const projectEvent = Effect.fn(function* (
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
    onSome: (phone) => normalizePhoneNumber(phone).pipe(Effect.asSome),
  });
  const occurredAt = yield* parseOccurredAt(raw.message.timestamp, receivedAt);
  const content = projectInboundContent(raw.message);
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
    replyToMessageId: Option.map(raw.message.context, ({ id }) => id),
  } satisfies WhatsAppInboundEvent;
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
const projectDecodedDisclosureLifecycleStatus = Effect.fn(function* (input: {
  readonly status: typeof RawDisclosureStatus.Type;
  readonly receivedAt: DateTime.Utc;
}) {
  const providerStatus = input.status;
  const occurredAt = yield* parseOccurredAt(providerStatus.timestamp, input.receivedAt);
  const evidence = {
    correlationToken: DisclosureDeliveryCorrelationToken.make(
      providerStatus.biz_opaque_callback_data
    ),
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
    } satisfies WhatsAppDisclosureLifecycleEvidence;
  }
  if (providerStatus.status === "sent") {
    return { ...evidence, outcome: "sent" as const } satisfies WhatsAppDisclosureLifecycleEvidence;
  }
  return {
    ...evidence,
    outcome: "accepted" as const,
  } satisfies WhatsAppDisclosureLifecycleEvidence;
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

const latestDisclosureLifecycleStatus = Effect.fn(function* (
  statuses: ReadonlyArray<typeof RawDisclosureStatus.Type>,
  receivedAt: DateTime.Utc
) {
  const projected = yield* Effect.forEach(statuses, (status) =>
    projectDecodedDisclosureLifecycleStatus({ status, receivedAt }).pipe(
      Effect.map((evidence) => ({ evidence, status }))
    )
  );
  return projected.reduce<
    Option.Option<{
      readonly evidence: WhatsAppDisclosureLifecycleEvidence;
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
});

const projectReceiptHistory = Effect.fn(function* (
  statuses: ReadonlyArray<typeof RawReceiptStatus.Type>,
  requested: "sent" | "delivered" | "failed",
  receivedAt: DateTime.Utc
) {
  yield* Effect.forEach(statuses, (status) => parseOccurredAt(status.timestamp, receivedAt));
  const tokens = statuses.map((status) => status.biz_opaque_callback_data);
  const token = tokens[0] ?? Option.none<string>();
  if (
    tokens.some((candidate) => Option.getOrUndefined(candidate) !== Option.getOrUndefined(token))
  ) {
    return yield* invalidKapsoInvariant("inconsistent status correlation");
  }
  const selected = statuses.filter((status) => status.status === requested);
  if (selected.length === 0) return { _tag: "Absent" as const };
  if (Option.isNone(token)) return { _tag: "Uncorrelated" as const };
  const correlated = yield* Effect.forEach(selected, (status) =>
    Schema.decodeUnknownEffect(RawDisclosureStatus)({
      id: status.id,
      status: status.status,
      timestamp: status.timestamp,
      ...Option.match(status.errors, { onNone: () => ({}), onSome: (errors) => ({ errors }) }),
      biz_opaque_callback_data: token.value,
    }).pipe(Effect.mapError(invalidKapsoPayload))
  );
  const latest = yield* latestDisclosureLifecycleStatus(correlated, receivedAt);
  if (Option.isNone(latest)) return { _tag: "Absent" as const };
  return { _tag: "Correlated" as const, value: latest.value };
});

export const lookupLifecycleStatus = Effect.fn(function* (
  input: Readonly<{
    outboundHttp: OutboundHttpService;
    businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
    messageId: WhatsAppProviderMessageId;
    status: "sent" | "delivered" | "failed";
    receivedAt: DateTime.Utc;
  }>
) {
  const response = yield* input.outboundHttp
    .execute({
      _tag: "KapsoMessageStatus",
      businessPhoneNumberId: input.businessPhoneNumberId,
      messageId: input.messageId,
    })
    .pipe(
      Effect.mapError(() => new WhatsAppStatusUnavailable()),
      Effect.timeoutOrElse({
        duration: "8 seconds",
        orElse: () => Effect.fail(new WhatsAppStatusUnavailable()),
      })
    );
  if (response.status !== okStatus) return yield* new WhatsAppStatusUnavailable();
  const stored = yield* Schema.decodeEffect(Schema.fromJsonString(RawStoredMessage))(
    new TextDecoder().decode(response.body)
  ).pipe(Effect.mapError(invalidKapsoPayload));
  if (
    stored.id !== input.messageId ||
    stored.kapso.phone_number_id !== input.businessPhoneNumberId ||
    stored.kapso.statuses.some((status) => status.id !== stored.id)
  ) {
    return yield* invalidKapsoInvariant("lookup coordinates disagreed");
  }
  const projected = yield* projectReceiptHistory(
    stored.kapso.statuses,
    input.status,
    input.receivedAt
  );
  return projected._tag === "Correlated"
    ? {
        ...projected,
        value: { ...projected.value, businessPhoneNumberId: input.businessPhoneNumberId },
      }
    : projected;
});

const resolveLifecycleHint = Effect.fn(function* (
  input: Readonly<{
    body: unknown;
    eventName: typeof DisclosureLifecycleEventName.Type;
    receivedAt: DateTime.Utc;
    lookup: Option.Option<OutboundHttpService>;
    admitLookup: WhatsAppStatusLookupAdmission;
  }>
) {
  const { eventName, receivedAt, lookup } = input;
  const hint = yield* Schema.decodeUnknownEffect(RawLifecycleHint)(input.body).pipe(
    Effect.mapError(invalidKapsoPayload)
  );
  if (
    Option.isSome(hint.message.kapso.statuses) ||
    Option.isNone(lookup) ||
    hint.message.kapso.status !== lifecycleStatus(eventName)
  ) {
    return yield* invalidKapsoInvariant("invalid lifecycle hint");
  }
  yield* input.admitLookup({
    businessPhoneNumberId: hint.phone_number_id,
    messageId: hint.message.id,
    receivedAt,
    status: lifecycleStatus(eventName),
  });
  const latest = yield* lookupLifecycleStatus({
    outboundHttp: lookup.value,
    businessPhoneNumberId: hint.phone_number_id,
    messageId: hint.message.id,
    status: lifecycleStatus(eventName),
    receivedAt,
  });
  if (latest._tag === "Absent") return yield* invalidKapsoInvariant("missing provider status");
  return latest._tag === "Uncorrelated" ? Option.none() : Option.some(latest.value);
});

const projectReceiptEvent = Effect.fn(function* (
  raw: typeof RawReceiptEvent.Type,
  eventName: typeof DisclosureLifecycleEventName.Type,
  receivedAt: DateTime.Utc
) {
  if (raw.message.kapso.statuses.some((status) => status.id !== raw.message.id)) {
    return yield* invalidKapsoInvariant("event/status mismatch");
  }
  const latest = yield* projectReceiptHistory(
    raw.message.kapso.statuses,
    lifecycleStatus(eventName),
    receivedAt
  );
  if (latest._tag === "Absent") return yield* invalidKapsoInvariant("missing provider status");
  if (latest._tag === "Uncorrelated") return Option.none();
  const times = yield* Effect.forEach(raw.message.kapso.statuses, (status) =>
    parseOccurredAt(status.timestamp, receivedAt)
  );
  const newest = times.reduce(
    (index, time, candidate) =>
      DateTime.Order(time, times[index] ?? time) > 0 ? candidate : index,
    0
  );
  if (raw.message.kapso.statuses[newest]?.status !== lifecycleStatus(eventName)) {
    return yield* invalidKapsoInvariant("event/status mismatch");
  }
  return Option.some({ ...latest.value, businessPhoneNumberId: raw.phone_number_id });
});

/** One authenticated event and its latest chronological status, shared across delivery purposes. */
export const decodeLifecycleStatus = Effect.fn(function* (
  input: WhatsAppLifecycleAuthentication,
  lookup: Option.Option<OutboundHttpService> = Option.none(),
  admitLookup: WhatsAppStatusLookupAdmission = (): Effect.Effect<void, WhatsAppStatusUnavailable> =>
    Effect.fail(new WhatsAppStatusUnavailable())
) {
  const unknown = yield* authenticateAndDecodeKapsoBody(input);
  const eventName = yield* Schema.decodeUnknownEffect(DisclosureLifecycleEventName)(
    input.eventName
  ).pipe(Effect.mapError(invalidKapsoPayload));
  const full = Schema.decodeUnknownOption(RawReceiptEvent)(unknown);
  if (Option.isNone(full)) {
    return yield* resolveLifecycleHint({
      body: unknown,
      eventName,
      receivedAt: input.receivedAt,
      lookup,
      admitLookup,
    });
  }
  return yield* projectReceiptEvent(full.value, eventName, input.receivedAt);
});

export const projectHostedStatus = (
  latest: Readonly<{
    status: typeof RawDisclosureStatus.Type;
    evidence: WhatsAppDisclosureLifecycleEvidence;
    businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  }>
): WhatsAppHostedLifecycleEvidence => {
  const status = latest.status;
  const evidence = {
    correlationToken: HostedDeliveryCorrelationToken.make(status.biz_opaque_callback_data),
    messageEvidence: latest.evidence.messageEvidence,
    businessPhoneNumberId: latest.businessPhoneNumberId,
    occurredAt: latest.evidence.occurredAt,
  };
  return status.status === "failed"
    ? {
        ...evidence,
        outcome: "failed",
        reason: latest.evidence.outcome === "failed" ? latest.evidence.reason : "invalid_response",
      }
    : { ...evidence, outcome: status.status };
};

export const projectIdentityChange = Effect.fn(function* (
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
    onSome: (phone) => normalizePhoneNumber(phone).pipe(Effect.asSome),
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
