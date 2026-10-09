import { makeStatusLookupAdmission } from "./status-admission";
import { receiveWhatsAppProviderHandoff } from "../../provider-authentication/runtime";
import { TranscriptText } from "../../../src/core/agent/contract";
import { Sha256Digest } from "../../../src/shell/consent/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import {
  type WhatsAppInboundEvent,
  maxWhatsAppFutureTimestampMinutes,
  maxWhatsAppWebhookBytes,
} from "../../../src/shell/channels/whatsapp/contract";
import { authenticateWhatsAppInbound } from "../../../src/shell/channels/whatsapp/operations";
import {
  makeLifecycleVerifier,
  makeVoiceUnavailableSender,
} from "../../../src/shell/channels/whatsapp/runtime";
import { DisclosureDeliveryCorrelationToken } from "../../../src/core/provider-evidence/contract";
import {
  Context,
  Crypto,
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
import { type UserId } from "../../../src/core/identity/contract";
import { approveBrowserPairing } from "../../browser-login/operations";
import { recordConsentDelivery } from "../../consent/ingress/operations";
import { makeConsentIngress } from "../../consent/ingress/runtime";
import { findWhatsAppUser, prepareWhatsAppIdentity } from "../../identity/operations";
import {
  cloudflareWorkerTelemetry,
  observeProviderFetch,
} from "../../runtime/telemetry/operations";
import {
  type WhatsAppIngressEnvironment as Environment,
  type WhatsAppAuthenticatedInbound as WebhookInbound,
} from "../contract";
import { acceptWhatsAppMedia } from "../../ingestion/operations";
import { findInsightDeliveryUser } from "./insight-delivery";
import { findDeliveryUser } from "./proactivity-delivery";
import { findWeeklyQuestionUser } from "./weekly-question";
import { findWhatsAppDeliveryUser } from "./whatsapp-turn";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_RATE_LIMITED = 429;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNAVAILABLE = 503;
const hourMs = 3_600_000;
const dayMs = 86_400_000;
const maxInitiatingEventAgeMs =
  dayMs - Duration.toMillis(Duration.minutes(maxWhatsAppFutureTimestampMinutes));
type TextInbound = WebhookInbound &
  Readonly<{
    event: WhatsAppInboundEvent & {
      content: Extract<WhatsAppInboundEvent["content"], { _tag: "Text" }>;
    };
  }>;

/** Bound the actual streamed raw bytes, not the untrusted Content-Length claim. */
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
          chunks.push(chunk);
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
        } catch {
          // Foreign cancellation must not prevent releasing the owned reader lock.
        }
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

const sendVoiceRefusal = (
  environment: Environment,
  input: WebhookInbound,
  userId: UserId
): Effect.Effect<Response, void, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const sent = yield* Effect.exit(
      makeVoiceUnavailableSender({
        apiKey: Redacted.make(environment.KAPSO_API_KEY),
        httpClient,
      })({ caller: input.event.caller, phoneNumberId: input.event.businessPhoneNumberId })
    ).pipe(
      Effect.tap((exit) =>
        Effect.annotateCurrentSpan("outcome", Exit.isSuccess(exit) ? "succeeded" : "failed")
      ),
      Effect.withSpan("whatsapp.voice.refusal")
    );
    // An ambiguous send is never replayed: the claim precedes provider I/O.
    const settled = yield* attempt(() =>
      environment.DB.prepare(`UPDATE hosted_voice_refusals SET outcome = ?
        WHERE portfolio_id = ? AND message_id = ? AND user_id = ? AND outcome = 'started'`)
        .bind(
          Exit.isSuccess(sent) ? "accepted" : "failed",
          input.event.caller.businessPortfolioId,
          input.event.messageEvidence.providerMessageId,
          userId
        )
        .run()
    );
    return answer(Exit.isSuccess(sent) && settled.meta.changes === 1 ? HTTP_OK : HTTP_UNAVAILABLE);
  });

const prepareVoiceRefusal = (
  environment: Environment,
  input: WebhookInbound,
  userId: UserId
): D1PreparedStatement => {
  const protectedClaim = protectConsentStatement({
    subject: { _tag: "User", userId },
    requirement: "active",
    statement: {
      sql: `INSERT INTO hosted_voice_refusals
        (portfolio_id, message_id, user_id, claimed_at_ms)
        SELECT ?, ?, w.userId, ? FROM identity_associations AS w
        WHERE w.userId = ? AND w.businessPortfolioId = ? AND w.businessScopedUserId = ?
          AND (SELECT count(*) FROM hosted_voice_refusals
            WHERE user_id = w.userId AND claimed_at_ms > ?) < 5`,
      params: [
        input.event.caller.businessPortfolioId,
        input.event.messageEvidence.providerMessageId,
        input.receivedAtMs,
        userId,
        input.event.caller.businessPortfolioId,
        input.event.caller.businessScopedUserId,
        input.receivedAtMs - hourMs,
      ],
    },
  });
  return prepareWhatsAppIdentity({
    db: environment.DB,
    userId,
    statement: {
      sql: `${protectedClaim.sql} ON CONFLICT (portfolio_id, message_id) DO NOTHING`,
      params: protectedClaim.params,
    },
  });
};

const refuseVoice = (
  environment: Environment,
  input: WebhookInbound,
  userId: UserId
): Effect.Effect<Response, void, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (environment.KAPSO_API_KEY.length === 0) return answer(HTTP_UNAVAILABLE);
    const claimed = yield* attempt(() => prepareVoiceRefusal(environment, input, userId).run());
    if (claimed.meta.changes !== 1) {
      const replay = yield* attempt(() =>
        environment.DB.prepare(`SELECT outcome FROM hosted_voice_refusals
          WHERE portfolio_id = ? AND message_id = ? AND user_id = ?`)
          .bind(
            input.event.caller.businessPortfolioId,
            input.event.messageEvidence.providerMessageId,
            userId
          )
          .first()
      );
      if (replay === null) return answer(HTTP_RATE_LIMITED);
      const outcome = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ outcome: Schema.Literals(["started", "accepted", "failed"]) })
      )(replay).pipe(Effect.mapError(() => undefined));
      return answer(outcome.outcome === "accepted" ? HTTP_OK : HTTP_UNAVAILABLE);
    }
    return yield* sendVoiceRefusal(environment, input, userId);
  });

const routeHostedInbound = (
  environment: Environment,
  input: WebhookInbound
): Effect.Effect<Option.Option<Response>, void, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const known = yield* findWhatsAppUser({
      db: environment.DB,
      portfolioId: input.event.caller.businessPortfolioId,
      bsuid: input.event.caller.businessScopedUserId,
    }).pipe(Effect.mapError(() => undefined));
    if (Option.isNone(known)) {
      return input.event.content._tag === "Image"
        ? Option.some(answer(HTTP_UNAVAILABLE))
        : Option.none();
    }
    if (input.event.content._tag === "Image") {
      return Option.some(
        yield* acceptWhatsAppMedia({ db: environment.DB, userId: known.value, event: input.event })
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
): Effect.Effect<Response, void, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const approval =
      /^Aprueba el código de inicio de sesión ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})$/u.exec(
        input.event.content.text.trim()
      );
    if (approval !== null) {
      const code = approval[1];
      if (code === undefined) return answer(HTTP_CONFLICT);
      return yield* approveBrowserPairing({
        db: environment.DB,
        input: {
          portfolioId: environment.WHATSAPP_BUSINESS_PORTFOLIO_ID,
          bsuid: input.event.caller.businessScopedUserId,
          messageId: input.event.messageEvidence.providerMessageId,
          publicCode: code,
          occurredAtMs: DateTime.toEpochMillis(input.event.occurredAt),
          receivedAtMs: input.receivedAtMs,
        },
      });
    }
    if (/^(Confirmo|Rechazo) asociación /u.test(input.event.content.text.trim())) {
      const confirmation = yield* receiveWhatsAppProviderHandoff({ environment, inbound: input });
      return Option.getOrElse(confirmation, () => answer(HTTP_CONFLICT));
    }
    const hosted = yield* routeHostedInbound(environment, input);
    if (Option.isSome(hosted)) return hosted.value;
    const handoff = yield* receiveWhatsAppProviderHandoff({ environment, inbound: input });
    if (Option.isSome(handoff)) return handoff.value;
    const httpClient = yield* HttpClient.HttpClient;
    const consent = yield* makeConsentIngress({ environment, httpClient })(input);
    if (consent.status !== HTTP_OK) return consent;
    const next = yield* receiveWhatsAppProviderHandoff({ environment, inbound: input });
    return Option.getOrElse(next, () => consent);
  });

const handleInbound = (
  base: WebhookBase,
  request: Request,
  environment: Environment
): Effect.Effect<Response, void, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.exit(
      authenticateWhatsAppInbound({
        ...base,
        deliveryKey: request.headers.get("x-idempotency-key") ?? "",
        businessPortfolioId: environment.WHATSAPP_BUSINESS_PORTFOLIO_ID,
      })
    );
    if (Exit.isFailure(decoded)) return answer(HTTP_UNAUTHORIZED);
    // Never partially settle a buffered retry delivery or re-admit stale signed events.
    if (decoded.value.events.length !== 1) return answer(HTTP_UNPROCESSABLE);
    if (
      DateTime.toEpochMillis(decoded.value.events[0].occurredAt) + maxInitiatingEventAgeMs <=
      DateTime.toEpochMillis(base.receivedAt)
    ) {
      return answer(HTTP_CONFLICT);
    }
    const cryptoService = yield* Crypto.Crypto;
    const digest = Sha256Digest.make(
      Hex.encode(yield* cryptoService.digest("SHA-256", base.rawBody).pipe(Effect.orDie))
    );
    const input = {
      event: decoded.value.events[0],
      deliveryKey: decoded.value.deliveryKey,
      digest,
      receivedAtMs: DateTime.toEpochMillis(base.receivedAt),
    };
    // Only typed text may operate the pre-User Consent and credential control surface.
    if (input.event.content._tag !== "Text") {
      const hosted = yield* routeHostedInbound(environment, input);
      return Option.isSome(hosted) ? hosted.value : answer(HTTP_UNPROCESSABLE);
    }
    return yield* routeTextInbound(environment, {
      ...input,
      event: { ...input.event, content: input.event.content },
    });
  });

const findHostedStatusUser = (
  input: Parameters<typeof findInsightDeliveryUser>[0]
): Effect.Effect<Option.Option<UserId>, void> =>
  Effect.gen(function* () {
    const candidates = [
      findDeliveryUser(input).pipe(Effect.mapError(() => undefined)),
      findInsightDeliveryUser(input).pipe(Effect.mapError(() => undefined)),
      findWeeklyQuestionUser(input).pipe(Effect.mapError(() => undefined)),
      findWhatsAppDeliveryUser(input).pipe(Effect.mapError(() => undefined)),
    ];
    for (const candidate of candidates) {
      const user = yield* candidate;
      if (Option.isSome(user)) return user;
    }
    return Option.none();
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
        admitLookup: makeStatusLookupAdmission(environment.DB),
        apiKey: Redacted.make(environment.KAPSO_API_KEY),
        httpClient,
      })({ ...base, eventName })
    );
    if (Result.isFailure(hosted)) {
      return answer(
        hosted.failure._tag === "WhatsAppStatusUnavailable" ? HTTP_UNAVAILABLE : HTTP_UNAUTHORIZED
      );
    }
    const lookup = {
      db: environment.DB,
      correlationToken: hosted.success.correlationToken,
      businessPhoneNumberId: hosted.success.businessPhoneNumberId,
    };
    const user = yield* findHostedStatusUser(lookup);
    if (Option.isSome(user)) {
      return yield* attempt(() =>
        environment.onHostedStatus({
          userId: user.value,
          correlationToken: hosted.success.correlationToken,
          businessPhoneNumberId: hosted.success.businessPhoneNumberId,
          providerMessageId: hosted.success.messageEvidence.providerMessageId,
          outcome: hosted.success.outcome,
          occurredAtMs: DateTime.toEpochMillis(hosted.success.occurredAt),
          receivedAtMs: DateTime.toEpochMillis(base.receivedAt),
        })
      );
    }
    return eventName === "whatsapp.message.delivered"
      ? yield* recordConsentDelivery({
          db: environment.DB,
          input: {
            correlationToken: DisclosureDeliveryCorrelationToken.make(
              hosted.success.correlationToken
            ),
            phoneNumberId: hosted.success.businessPhoneNumberId,
            messageId: hosted.success.messageEvidence.providerMessageId,
            occurredAtMs: DateTime.toEpochMillis(hosted.success.occurredAt),
            receivedAtMs: DateTime.toEpochMillis(base.receivedAt),
          },
        })
      : answer(HTTP_OK);
  });

const isLifecycleEvent = (name: string): boolean =>
  name === "whatsapp.message.sent" ||
  name === "whatsapp.message.delivered" ||
  name === "whatsapp.message.failed";

const handleWebhook = (
  request: Request,
  environment: Environment
): Effect.Effect<Response, void, Crypto.Crypto | HttpClient.HttpClient> =>
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

const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    attempt(() =>
      crypto.subtle.digest(algorithm, new Uint8Array(data)).then((buffer) => new Uint8Array(buffer))
    ).pipe(Effect.orDie),
});

const answer = (status: number): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

/** Keep foreign I/O failures distinct from an absent result; the ingress maps them to 503. */
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });

/** One authenticated, bounded provider ingress. No decision can bypass provider delivery proof. */
export const receiveIngress =
  (environment: Environment): ((request: Request) => Effect.Effect<Response>) =>
  (request) =>
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(FetchHttpClient.layer);
        return yield* handleWebhook(request, environment).pipe(
          Effect.provideService(HttpClient.HttpClient, Context.get(clients, HttpClient.HttpClient)),
          Effect.provideService(Crypto.Crypto, workerCrypto)
        );
      })
    ).pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        observeProviderFetch(globalThis.fetch, {
          provider: "kapso",
          environment,
          telemetry: cloudflareWorkerTelemetry,
        })
      ),
      Effect.catchCause(() => Effect.succeed(answer(HTTP_UNAVAILABLE)))
    );
