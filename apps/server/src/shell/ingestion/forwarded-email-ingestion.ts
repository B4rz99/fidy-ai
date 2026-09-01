import { Webhook } from "svix";
import {
  Config,
  Context,
  type Crypto,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { type SqlClient } from "effect/unstable/sql";
import {
  maximumEmailAddressCharacters,
  maximumEmailRecipients,
} from "~/core/ingestion/email-policy";
import { ResendReceivedEmailId, ResendWebhookDeliveryId } from "~/core/ingestion/reference";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";
import { forwardingLocalPartForDomain } from "./email-address";
import {
  admitAuthenticatedResendWebhookEvent,
  completeAuthenticatedResendWebhookEvent,
  resolveForwardingAddress,
} from "./email-forwarding-repo";
import { type NotificationEmailExtractor } from "./email-extractor";
import { processNextForwardedEmail } from "./email-worker";
import { runEmailIngestRetention } from "./email-retention";
import { admitForwardedEmail, enableEmailForwardingInScope } from "./mutations";
import { type ResendReceivingClient } from "./resend-receiving-client";
import { getEmailForwarding } from "./queries";

/** Maximum exact webhook body accepted before signature verification. */
export const maximumResendWebhookBytes = 65_536;

/** The supplied Svix proof was absent, stale, or invalid. */
export class InvalidResendWebhookProof extends Data.TaggedError("InvalidResendWebhookProof")<{}> {}
/** The authenticated webhook did not match the closed Resend event schema. */
export class InvalidResendWebhookPayload extends Data.TaggedError(
  "InvalidResendWebhookPayload"
)<{}> {}
/** The exact webhook body exceeded the public route's fixed byte bound. */
export class ResendWebhookPayloadTooLarge extends Data.TaggedError(
  "ResendWebhookPayloadTooLarge"
)<{}> {}
/** Admission was refused by either the cheap public or authenticated-provider limiter. */
export class ResendWebhookRateExceeded extends Data.TaggedError("ResendWebhookRateExceeded")<{}> {}

const maximumSvixTimestampCharacters = 32;
const maximumSvixSignatureCharacters = 1_024;
const backlogRetryAfterSeconds = 60;

const ResendEmailReceivedEvent = Schema.Struct({
  type: Schema.Literal("email.received"),
  data: Schema.Struct({
    email_id: ResendReceivedEmailId,
    to: Schema.NonEmptyArray(
      Schema.String.check(Schema.isMaxLength(maximumEmailAddressCharacters))
    ).check(Schema.isMaxLength(maximumEmailRecipients)),
  }),
});

const ResendWebhookProof = Schema.Struct({
  id: ResendWebhookDeliveryId,
  timestamp: Schema.NonEmptyString.check(Schema.isMaxLength(maximumSvixTimestampCharacters)),
  signature: Schema.NonEmptyString.check(Schema.isMaxLength(maximumSvixSignatureCharacters)),
});

/** Exact signed bytes and normalized headers supplied by the HTTP adapter. */
export type ResendWebhookInput = Readonly<{
  exactBody: Uint8Array;
  headers: Readonly<Record<string, string>>;
}>;

/** Privacy-uniform public disposition for authenticated provider delivery. */
export type ResendWebhookDisposition =
  | Readonly<{ readonly outcome: "accepted" }>
  | Readonly<{ readonly outcome: "retry-later"; readonly retryAfterSeconds: number }>;

const authenticateResendEvent = Effect.fn(function* (input: ResendWebhookInput) {
  if (input.exactBody.byteLength > maximumResendWebhookBytes) {
    return yield* new ResendWebhookPayloadTooLarge();
  }
  const proof = yield* Schema.decodeUnknownEffect(ResendWebhookProof)({
    id: input.headers["svix-id"],
    timestamp: input.headers["svix-timestamp"],
    signature: input.headers["svix-signature"],
  }).pipe(Effect.mapError(() => new InvalidResendWebhookProof()));
  const secret = yield* Config.redacted("RESEND_WEBHOOK_SECRET");
  const verified = yield* Effect.try({
    try: () =>
      new Webhook(Redacted.value(secret)).verify(Buffer.from(input.exactBody), {
        "svix-id": proof.id,
        "svix-timestamp": proof.timestamp,
        "svix-signature": proof.signature,
      }),
    catch: () => new InvalidResendWebhookProof(),
  });
  const event = yield* Schema.decodeUnknownEffect(ResendEmailReceivedEvent)(verified).pipe(
    Effect.mapError(() => new InvalidResendWebhookPayload())
  );
  return { event, deliveryId: proof.id };
});

const resolveSingleRecipientUser = Effect.fn(function* (recipients: ReadonlyArray<string>) {
  const { ingestDomain } = yield* externalEndpoints;
  const localParts = recipients.flatMap((recipient) =>
    Option.toArray(forwardingLocalPartForDomain(recipient, ingestDomain))
  );
  const resolved = yield* Effect.forEach([...new Set(localParts)], resolveForwardingAddress);
  const userIds = [
    ...new Map(resolved.flatMap(Option.toArray).map((userId) => [String(userId), userId])).values(),
  ];
  // Multiple Users cannot safely share evidence because the recipient list contains both
  // permanent addresses. Unknown and ambiguous recipient sets therefore share no admission.
  return userIds.length === 1 ? Option.fromUndefinedOr(userIds[0]) : Option.none();
});

const receiveResendWebhook = Effect.fn(function* (input: ResendWebhookInput) {
  const { event, deliveryId } = yield* authenticateResendEvent(input);
  const providerAdmission = yield* admitAuthenticatedResendWebhookEvent(deliveryId);
  if (providerAdmission === "rate-exceeded") return yield* new ResendWebhookRateExceeded();
  if (providerAdmission === "replay") return { outcome: "accepted" } as const;

  const userId = yield* resolveSingleRecipientUser(event.data.to);
  if (Option.isSome(userId)) {
    const admission = yield* admitForwardedEmail({
      userId: userId.value,
      receivedEmailId: event.data.email_id,
      webhookDeliveryId: deliveryId,
      receivedAt: yield* DateTime.now,
    });
    if (admission === "rate-exceeded") return yield* new ResendWebhookRateExceeded();
    if (admission === "backlog-full") {
      return { outcome: "retry-later", retryAfterSeconds: backlogRetryAfterSeconds } as const;
    }
  }
  yield* completeAuthenticatedResendWebhookEvent(deliveryId);
  return { outcome: "accepted" } as const;
});

/**
 * Deep caller interface for forwarding status and authenticated admission. Repository transitions,
 * allowance locking, Consent coordination, and recipient resolution remain private implementation.
 */
export const forwardedEmailIngestion = {
  enable: enableEmailForwardingInScope,
  getStatus: getEmailForwarding,
  receiveResendWebhook,
} as const;

type ForwardedEmailProcessorDependencies =
  | Crypto.Crypto
  | SqlClient.SqlClient
  | ResendReceivingClient
  | NotificationEmailExtractor;

const makeForwardedEmailProcessor = Effect.gen(function* () {
  const dependencies = yield* Effect.context<ForwardedEmailProcessorDependencies>();
  const provide = <A, E>(
    effect: Effect.Effect<A, E, ForwardedEmailProcessorDependencies>
  ): Effect.Effect<A, E> => Effect.provide(effect, dependencies);
  return {
    processNext: provide(processNextForwardedEmail()),
    expireEvidence: provide(Effect.flatMap(DateTime.now, runEmailIngestRetention)),
  } as const;
});

/** Hosted-worker facet of Forwarded Email Ingestion; callers cannot reach lifecycle transitions. */
export class ForwardedEmailProcessor extends Context.Service<
  ForwardedEmailProcessor,
  Effect.Success<typeof makeForwardedEmailProcessor>
>()("@fidy/server/shell/ingestion/forwarded-email-ingestion/ForwardedEmailProcessor") {
  static readonly layer = Layer.effect(ForwardedEmailProcessor, makeForwardedEmailProcessor);
}

/** Hosted poller using only the processor facet of the deep module. */
export const ForwardedEmailProcessorWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const processor = yield* ForwardedEmailProcessor;
    yield* processor.processNext.pipe(
      Effect.catchCause(() => Effect.logError("Forwarded email iteration failed")),
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkScoped
    );
  })
);

/** Hosted personal-evidence expiry loop using the same processor facet. */
export const ForwardedEmailEvidenceRetentionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const processor = yield* ForwardedEmailProcessor;
    yield* processor.expireEvidence.pipe(
      Effect.catchCause(() => Effect.logError("Email ingestion retention failed")),
      Effect.repeat(Schedule.spaced("1 day")),
      Effect.forkScoped
    );
  })
);
