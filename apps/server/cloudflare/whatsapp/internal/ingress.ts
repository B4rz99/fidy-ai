import { localDocumentUrl, localMediaUrl } from "../../ingestion/contract";
import { directoryName, replaceIdentityUrl, whatsappOwnerUrl } from "../../directory/contract";
import {
  type WhatsAppIngressEnvironment as Environment,
  VoiceRefusal,
  type WhatsAppAuthenticatedInbound as WebhookInbound,
  WhatsAppLifecycleWork,
  voiceRefusalUrl,
} from "../contract";
import { Digest, SecureRandom } from "effect/crypto";
import { OutboundHttpLive, installedProviderFetch } from "../../outbound-http/runtime";
import { makeNativeStatusAdmission } from "./registered-send";
import { routeNativeInvitation } from "../../provider-authentication/runtime";
import { TranscriptText } from "../../../src/core/agent/contract";
import { Sha256Digest } from "../../../src/shell/consent/contract";
import {
  type WhatsAppInboundEvent,
  maxWhatsAppFutureTimestampMinutes,
  maxWhatsAppWebhookBytes,
} from "../../../src/shell/channels/whatsapp/contract";
import {
  authenticateIdentityChange,
  authenticateWhatsAppInbound,
} from "../../../src/shell/channels/whatsapp/operations";
import { makeLifecycleVerifier } from "../../../src/shell/channels/whatsapp/runtime";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { Hex } from "effect/encoding";
import { FetchHttpClient, HttpClient } from "effect/http";
import { UserId } from "../../../src/core/identity/contract";
import { cloudflareWorkerTelemetry } from "../../runtime/telemetry/operations";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNAVAILABLE = 503;
const dayMs = 86_400_000;
const maxInitiatingEventAgeMs =
  dayMs - Duration.toMillis(Duration.minutes(maxWhatsAppFutureTimestampMinutes));
type TextInbound = WebhookInbound &
  Readonly<{
    event: WhatsAppInboundEvent & {
      content: Extract<WhatsAppInboundEvent["content"], { _tag: "Text" }>;
    };
  }>;

const boundedBody = (request: Request): Effect.Effect<Option.Option<Uint8Array>, void> => {
  const stream = request.body;
  if (stream === null) return Effect.succeedSome(new Uint8Array());
  return Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const chunks: Array<Uint8Array> = [];
        let length = 0;
        for (;;) {
          const part = yield* attempt(() => reader.read());
          if (part.done) break;
          const chunk: unknown = part.value;
          if (!(chunk instanceof Uint8Array)) return Option.none();
          length += chunk.byteLength;
          if (length > maxWhatsAppWebhookBytes) return Option.none();
          if (chunk.byteLength > 0) chunks.push(chunk);
        }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return Option.some(body);
      }),
    (reader) =>
      Effect.sync(() => {
        try {
          reader.cancel().catch(() => undefined);
        } catch {}
      }).pipe(
        Effect.ensuring(
          Effect.try({ try: () => reader.releaseLock(), catch: () => undefined }).pipe(
            Effect.ignore
          )
        )
      )
  );
};

type WebhookBase = Readonly<{
  rawBody: Uint8Array;
  secret: Redacted.Redacted<string>;
  signature: string;
  receivedAt: DateTime.Utc;
}>;

const refuseVoice = Effect.fn(function* (
  environment: Environment,
  input: WebhookInbound,
  userId: UserId
) {
  const users = environment.USER_STORE;
  if (users === undefined) return answer(HTTP_UNAVAILABLE);
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(VoiceRefusal)))({
    userId,
    caller: input.event.caller,
    message: input.event.messageEvidence.providerMessageId,
    endpoint: input.event.businessPhoneNumberId,
    occurredAt: DateTime.toEpochMillis(input.event.occurredAt),
  }).pipe(Effect.mapError(() => undefined));
  return yield* attempt(() =>
    users.getByName(userId).fetch(voiceRefusalUrl, { method: "POST", body })
  );
});
const routeHostedInbound = (
  environment: Environment,
  input: WebhookInbound,
  resolved?: UserId
): Effect.Effect<Option.Option<Response>, void, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const known =
      resolved === undefined ? yield* findOwner(environment, input) : Option.some(resolved);
    if (known instanceof Response) return Option.some(known);
    if (Option.isNone(known)) {
      return input.event.content._tag === "Image"
        ? Option.some(answer(HTTP_UNAVAILABLE))
        : Option.none();
    }
    if (input.event.content._tag === "Image") {
      return Option.some(
        yield* routeAttachment(environment, input, {
          userId: known.value,
          mediaId: input.event.content.mediaId,
          caption: Option.some(Option.getOrElse(input.event.content.caption, () => "")),
        })
      );
    }
    if (input.event.content._tag === "UnusableVoiceTranscript") {
      return Option.some(yield* refuseVoice(environment, input, known.value));
    }
    const content = input.event.content;
    const text =
      content._tag === "Document" ? TranscriptText.make("Adjunté un extracto.") : content.text;
    const response = yield* attempt(() =>
      environment.onHostedText({
        userId: known.value,
        portfolioId: input.event.caller.businessPortfolioId,
        bsuid: input.event.caller.businessScopedUserId,
        messageId: input.event.messageEvidence.providerMessageId,
        businessPhoneNumberId: input.event.businessPhoneNumberId,
        sandboxPhone:
          input.event.businessPhoneNumberId === environment.WHATSAPP_SANDBOX_PHONE_NUMBER_ID
            ? input.event.caller.phoneNumber
            : Option.none(),
        occurredAtMs: DateTime.toEpochMillis(input.event.occurredAt),
        receivedAtMs: input.receivedAtMs,
        text,
        replyToMessageId: input.event.replyToMessageId,
        ...(content._tag === "Document" ? { document: content } : {}),
      })
    );
    return Option.some(response);
  });

const routeTextInbound = (
  environment: Environment,
  input: TextInbound
): Effect.Effect<
  Response,
  void,
  Digest.Digest | SecureRandom.SecureRandom | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const selected = yield* routeNativeInvitation(environment, input);
    if (selected instanceof Response) return selected;
    return Option.getOrElse(yield* routeHostedInbound(environment, input, selected), () =>
      answer(HTTP_CONFLICT)
    );
  });
const missingRecipient = 404;
const findOwner = Effect.fn(function* (environment: Environment, input: WebhookInbound) {
  const directory = environment.DIRECTORY;
  if (directory === undefined) return answer(HTTP_UNAVAILABLE);
  const { businessPortfolioId: portfolio, businessScopedUserId: bsuid } = input.event.caller;
  const route = yield* attempt(() =>
    directory
      .getByName(directoryName)
      .fetch(whatsappOwnerUrl, { method: "POST", body: JSON.stringify({ portfolio, bsuid }) })
  );
  if (route.status === missingRecipient) return Option.none<UserId>();
  if (!route.ok) return answer(HTTP_UNAVAILABLE);
  const target = yield* Schema.decodeUnknownEffect(Schema.Struct({ userId: UserId }))(
    yield* attempt(() => route.json())
  ).pipe(Effect.mapError(() => undefined));
  return Option.some(target.userId);
});
const routeAttachment = Effect.fn(function* (
  environment: Environment,
  input: WebhookInbound,
  { userId, mediaId, caption }: { userId: UserId; mediaId: string; caption: Option.Option<string> }
) {
  const users = environment.USER_STORE;
  if (users === undefined) return answer(HTTP_UNAVAILABLE);
  const { businessPortfolioId: portfolio, businessScopedUserId: bsuid } = input.event.caller;
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    userId,
    ...(Option.isSome(caption) ? { caption: caption.value } : {}),
    portfolio,
    bsuid,
    message: input.event.messageEvidence.providerMessageId,
    endpoint: input.event.businessPhoneNumberId,
    mediaId,
    occurredAt: DateTime.toEpochMillis(input.event.occurredAt),
    receivedAt: input.receivedAtMs,
  }).pipe(Effect.mapError(() => undefined));
  return yield* attempt(() =>
    users
      .getByName(userId)
      .fetch(Option.isNone(caption) ? localDocumentUrl : localMediaUrl, { method: "POST", body })
  );
});
const routeDocument = Effect.fn(function* (
  environment: Environment,
  input: WebhookInbound,
  mediaId: string
) {
  const owner = yield* findOwner(environment, input);
  if (owner instanceof Response) return owner;
  return Option.isNone(owner)
    ? answer(HTTP_UNPROCESSABLE)
    : yield* routeAttachment(environment, input, {
        userId: owner.value,
        mediaId,
        caption: Option.none(),
      });
});
const routeIdentityChange = Effect.fn(function* (base: WebhookBase, environment: Environment) {
  const changes = yield* Effect.exit(
    authenticateIdentityChange({
      ...base,
      businessPortfolioId: environment.WHATSAPP_BUSINESS_PORTFOLIO_ID,
    })
  );
  if (Exit.isFailure(changes) || changes.value.length !== 1) return answer(HTTP_UNAUTHORIZED);
  const [change] = changes.value;
  if (change === undefined) return answer(HTTP_UNPROCESSABLE);
  const occurred = DateTime.toEpochMillis(change.occurredAt);
  if (occurred + maxInitiatingEventAgeMs <= DateTime.toEpochMillis(base.receivedAt)) {
    return answer(HTTP_CONFLICT);
  }
  const directory = environment.DIRECTORY?.getByName(directoryName);
  if (directory === undefined) return answer(HTTP_UNAVAILABLE);
  const scope = change.previousCaller.businessPortfolioId;
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    id: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
      "whatsapp",
      scope,
      change.messageEvidence.providerMessageId,
    ]).pipe(Effect.mapError(() => undefined)),
    kind: "whatsapp",
    scope,
    prior_key: change.previousCaller.businessScopedUserId,
    next_key: change.replacement.businessScopedUserId,
    occurred_at_ms: occurred,
    expires_at_ms: occurred + maxInitiatingEventAgeMs,
    expected_user: null,
  }).pipe(Effect.mapError(() => undefined));
  return yield* attempt(() =>
    directory.fetch(replaceIdentityUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  );
});
const handleInbound = (
  base: WebhookBase,
  request: Request,
  environment: Environment
): Effect.Effect<
  Response,
  void,
  Digest.Digest | SecureRandom.SecureRandom | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.exit(
      authenticateWhatsAppInbound({
        ...base,
        deliveryKey: request.headers.get("x-idempotency-key") ?? "",
        businessPortfolioId: environment.WHATSAPP_BUSINESS_PORTFOLIO_ID,
      })
    );
    if (Exit.isFailure(decoded)) return yield* routeIdentityChange(base, environment);
    if (decoded.value.events.length !== 1) return answer(HTTP_UNPROCESSABLE);
    if (
      DateTime.toEpochMillis(decoded.value.events[0].occurredAt) + maxInitiatingEventAgeMs <=
      DateTime.toEpochMillis(base.receivedAt)
    ) {
      return answer(HTTP_CONFLICT);
    }
    const cryptoService = yield* Digest.Digest;
    const digest = Sha256Digest.make(
      Hex.encode(yield* cryptoService.digest(Digest.sha256, base.rawBody).pipe(Effect.orDie))
    );
    const input = {
      event: decoded.value.events[0],
      deliveryKey: decoded.value.deliveryKey,
      digest,
      receivedAtMs: DateTime.toEpochMillis(base.receivedAt),
    };
    if (input.event.content._tag === "Document") {
      return yield* routeDocument(environment, input, input.event.content.mediaId);
    }
    if (input.event.content._tag !== "Text") {
      const hosted = yield* routeHostedInbound(environment, input);
      return Option.isSome(hosted) ? hosted.value : answer(HTTP_UNPROCESSABLE);
    }
    return yield* routeTextInbound(environment, {
      ...input,
      event: { ...input.event, content: input.event.content },
    });
  });

const handleHostedLifecycle = (
  base: WebhookBase,
  eventName: string,
  environment: Environment
): Effect.Effect<Response, void, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const hosted = yield* Effect.result(
      makeLifecycleVerifier({
        admitLookup: makeNativeStatusAdmission(environment),
        apiKey: Redacted.make(environment.KAPSO_API_KEY),
        httpClient,
      })({ ...base, eventName })
    );
    if (Result.isFailure(hosted)) {
      return answer(
        hosted.failure._tag === "WhatsAppStatusUnavailable" ? HTTP_UNAVAILABLE : HTTP_UNAUTHORIZED
      );
    }
    if (Option.isNone(hosted.success)) return answer(HTTP_OK);
    const evidence = hosted.success.value;
    const queue = environment.HOSTED_WHATSAPP_QUEUE;
    if (queue === undefined) return answer(HTTP_UNAVAILABLE);
    const work = yield* Schema.decodeEffect(WhatsAppLifecycleWork)({
      _tag: "WhatsAppLifecycleEvent",
      portfolio: environment.WHATSAPP_BUSINESS_PORTFOLIO_ID,
      ...(Option.isNone(evidence.recipientUserId)
        ? {}
        : { recipientUserId: evidence.recipientUserId.value }),
      ...(evidence.businessPhoneNumberId !== environment.WHATSAPP_SANDBOX_PHONE_NUMBER_ID ||
      Option.isNone(evidence.recipientPhone)
        ? {}
        : { recipientPhone: evidence.recipientPhone.value }),
      correlationToken: evidence.correlationToken,
      businessPhoneNumberId: evidence.businessPhoneNumberId,
      providerMessageId: evidence.messageEvidence.providerMessageId,
      outcome: evidence.outcome,
      occurredAtMs: DateTime.toEpochMillis(evidence.occurredAt),
      receivedAtMs: DateTime.toEpochMillis(base.receivedAt),
    }).pipe(Effect.mapError(() => undefined));
    yield* attempt(() => queue.send(work));
    return answer(HTTP_OK);
  });

const isLifecycleEvent = (name: string): boolean =>
  name === "whatsapp.message.sent" ||
  name === "whatsapp.message.delivered" ||
  name === "whatsapp.message.failed";

const handleWebhook = (
  request: Request,
  environment: Environment
): Effect.Effect<
  Response,
  void,
  Digest.Digest | SecureRandom.SecureRandom | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (
      request.headers.get("content-length") !== null &&
      Number(request.headers.get("content-length")) > maxWhatsAppWebhookBytes
    ) {
      return answer(HTTP_PAYLOAD_TOO_LARGE);
    }
    const rawBody = yield* boundedBody(request);
    if (Option.isNone(rawBody)) return answer(HTTP_PAYLOAD_TOO_LARGE);
    const receivedAt = yield* DateTime.now;
    const base = {
      rawBody: rawBody.value,
      secret: Redacted.make(environment.KAPSO_WEBHOOK_SECRET),
      signature: request.headers.get("x-webhook-signature") ?? "",
      receivedAt,
    };
    const eventName = request.headers.get("x-webhook-event");
    if (eventName !== null && isLifecycleEvent(eventName)) {
      return yield* handleHostedLifecycle(base, eventName, environment);
    }
    if (eventName !== "whatsapp.message.received") return answer(HTTP_UNPROCESSABLE);
    return yield* handleInbound(base, request, environment);
  });

const workerSecureRandom = SecureRandom.make((size) =>
  crypto.getRandomValues(new Uint8Array(size))
);
const workerDigest = Effect.runSync(Digest.Digest.pipe(Effect.provide(Digest.layerWebCrypto)));

const answer = (status: number): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });

export const receiveIngress =
  (environment: Environment): ((request: Request) => Effect.Effect<Response>) =>
  (request) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fetcher = yield* installedProviderFetch({
          provider: "kapso",
          environment,
          telemetry: cloudflareWorkerTelemetry,
        });
        const clients = yield* Layer.build(OutboundHttpLive).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fetcher)
        );
        return yield* handleWebhook(request, environment).pipe(
          Effect.provideService(HttpClient.HttpClient, Context.get(clients, HttpClient.HttpClient)),
          Effect.provideService(Digest.Digest, workerDigest),
          Effect.provideService(SecureRandom.SecureRandom, workerSecureRandom),
          Effect.provideService(FetchHttpClient.Fetch, fetcher)
        );
      })
    ).pipe(Effect.catchCause(() => Effect.succeed(answer(HTTP_UNAVAILABLE))));
