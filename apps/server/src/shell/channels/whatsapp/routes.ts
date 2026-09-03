import {
  Config,
  type Crypto,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import {
  type HttpBody,
  HttpRouter,
  type HttpServerError,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { type PersistedQueue } from "effect/unstable/persistence";
import type { SqlClient } from "effect/unstable/sql";
import {
  TelemetryAttempt,
  TelemetryCount,
  TelemetryDuration,
  TelemetryHttpStatus,
} from "~/shell/observability/protocol";
import { Telemetry } from "~/shell/observability/telemetry";
import type { OnboardingConsentRequired } from "~/shell/agent/agent-service";
import { admitAgentConversationTurn } from "~/shell/agent/conversation";
import type { AgentConversationAdmission } from "~/shell/agent/conversation";
import { reassociateWhatsAppIdentity } from "~/shell/identity/repo";
import { makeBoundedBytes } from "./bounded-bytes";
import type { KapsoClient, KapsoSendFailed } from "./kapso-client";
import type { WhatsAppDeliveryKey, WhatsAppInboundEvent } from "./model";
import {
  type ConsentDisclosureDeliveryUnavailable,
  applyConsentDisclosureLifecycle,
} from "./disclosure-delivery";
import { deliverWhatsAppOnboardingOutcome } from "./outbound";
import {
  DisclosureLifecycleEventName,
  type InvalidKapsoPayload,
  InvalidKapsoSignature,
  type KapsoBatchTooLarge,
  KapsoPayloadTooLarge,
  decodeKapsoDisclosureLifecycleWebhook,
  decodeKapsoIdentityWebhook,
  decodeKapsoWebhook,
  maxKapsoWebhookBytes,
} from "./kapso-webhook";
import {
  type WhatsAppInboundCapacityExceeded,
  type WhatsAppRateLimitExceeded,
  type WhatsAppReceiptInProgress,
  type WhatsAppReceiptInvalid,
  claimWhatsAppReceipt,
  completeWhatsAppReceipt,
  consumeWhatsAppIngressBudget,
  enqueueWhatsAppTurn,
  markWhatsAppReceiptOutboundStarted,
  releaseWhatsAppReceipt,
} from "./repo";

const concurrentWebhookBodyReads = 32;

class KapsoBodyReadTimeout extends Data.TaggedError("KapsoBodyReadTimeout")<{}> {}
class KapsoBodyReadCapacityExceeded extends Data.TaggedError("KapsoBodyReadCapacityExceeded")<{}> {}
class WhatsAppIdentityChangeDeferred extends Data.TaggedError(
  "WhatsAppIdentityChangeDeferred"
)<{}> {}

const kapsoBodyReadErrorResponses = {
  KapsoPayloadTooLarge: () => Effect.succeed(HttpServerResponse.empty({ status: 413 })),
  KapsoBodyReadCapacityExceeded: () => Effect.succeed(HttpServerResponse.empty({ status: 429 })),
  KapsoBodyReadTimeout: () => Effect.succeed(HttpServerResponse.empty({ status: 408 })),
} as const;

const readBoundedBody = (
  request: HttpServerRequest.HttpServerRequest,
  bodyReaders: Semaphore.Semaphore
): Effect.Effect<
  Uint8Array,
  | HttpServerError.HttpServerError
  | KapsoBodyReadCapacityExceeded
  | KapsoBodyReadTimeout
  | KapsoPayloadTooLarge
> =>
  bodyReaders
    .withPermitsIfAvailable(1)(
      Effect.gen(function* () {
        const bytes = makeBoundedBytes(maxKapsoWebhookBytes);
        yield* Stream.runForEach(request.stream, (chunk) =>
          bytes.append(chunk) ? Effect.void : new KapsoPayloadTooLarge()
        );
        return bytes.materialize();
      }).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new KapsoBodyReadTimeout()),
        })
      )
    )
    .pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new KapsoBodyReadCapacityExceeded()),
          onSome: Effect.succeed,
        })
      )
    );

type ReceiptClaim = Parameters<typeof releaseWhatsAppReceipt>[0];
type InboundEventOutcome = "enqueued" | "duplicate" | "onboarding-turn";

const chargeIngressBudgets = (
  event: WhatsAppInboundEvent
): Effect.Effect<void, WhatsAppRateLimitExceeded, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    yield* consumeWhatsAppIngressBudget(
      { _tag: "Global" },
      event.messageEvidence.providerMessageId,
      event.receivedAt
    );
    yield* consumeWhatsAppIngressBudget(
      { _tag: "Caller", caller: event.caller },
      event.messageEvidence.providerMessageId,
      event.receivedAt
    );
  });

const enqueueAuthorizedTurn = (
  event: WhatsAppInboundEvent,
  deliveryKey: WhatsAppDeliveryKey,
  admission: Extract<AgentConversationAdmission, { readonly _tag: "AuthorizedTurn" }>
): Effect.Effect<
  "duplicate" | "enqueued",
  OnboardingConsentRequired | WhatsAppInboundCapacityExceeded | WhatsAppRateLimitExceeded,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    yield* consumeWhatsAppIngressBudget(
      { _tag: "User", userId: admission.userId },
      event.messageEvidence.providerMessageId,
      event.receivedAt
    );
    const telemetry = yield* Effect.serviceOption(Telemetry);
    const enqueueResult = yield* Option.match(telemetry, {
      onNone: () =>
        enqueueWhatsAppTurn({ admission, event, deliveryKey, propagation: Option.none() }),
      onSome: (service) =>
        service.span(
          {
            component: "whatsapp",
            operation: "whatsapp.publishTurn",
            trigger: "kapso_webhook",
            spanOperation: "queue.publish",
            workKind: "queue_publication",
            metadata: {
              _tag: "Queue",
              attempt: TelemetryAttempt.make(1),
              inputCount: TelemetryCount.make(1),
              delayMilliseconds: TelemetryDuration.make(0),
            },
          },
          Effect.gen(function* () {
            const propagation = yield* service.captureDurableContext;
            return yield* enqueueWhatsAppTurn({ admission, event, deliveryKey, propagation });
          })
        ),
    });
    return enqueueResult.inserted ? ("enqueued" as const) : ("duplicate" as const);
  });

const deliverConsentTurn = (
  event: WhatsAppInboundEvent,
  admission: Exclude<AgentConversationAdmission, { readonly _tag: "AuthorizedTurn" }>,
  claim: ReceiptClaim
): Effect.Effect<
  "onboarding-turn",
  | ConsentDisclosureDeliveryUnavailable
  | KapsoSendFailed
  | Schema.SchemaError
  | WhatsAppReceiptInvalid,
  Crypto.Crypto | KapsoClient | PersistedQueue.PersistedQueueFactory | SqlClient.SqlClient
> =>
  Effect.as(
    deliverWhatsAppOnboardingOutcome(event, admission, markWhatsAppReceiptOutboundStarted(claim)),
    "onboarding-turn" as const
  );

const admitInboundEvent = (
  event: WhatsAppInboundEvent,
  deliveryKey: WhatsAppDeliveryKey,
  claim: ReceiptClaim
): Effect.Effect<
  InboundEventOutcome,
  | Config.ConfigError
  | ConsentDisclosureDeliveryUnavailable
  | KapsoSendFailed
  | OnboardingConsentRequired
  | Schema.SchemaError
  | WhatsAppInboundCapacityExceeded
  | WhatsAppRateLimitExceeded
  | WhatsAppReceiptInvalid,
  Crypto.Crypto | KapsoClient | PersistedQueue.PersistedQueueFactory | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    yield* chargeIngressBudgets(event);
    const admission = yield* admitAgentConversationTurn({
      caller: event.caller,
      content: { _tag: "Text", text: event.content.text },
      message: event.messageEvidence,
      receivedAt: event.occurredAt,
    });
    const outcome: InboundEventOutcome =
      admission._tag === "AuthorizedTurn"
        ? yield* enqueueAuthorizedTurn(event, deliveryKey, admission)
        : yield* deliverConsentTurn(event, admission, claim);
    yield* completeWhatsAppReceipt(claim, event.receivedAt);
    return outcome;
  }).pipe(Effect.onError(() => releaseWhatsAppReceipt(claim)));

type KapsoMessageWebhookHandler = (
  request: HttpServerRequest.HttpServerRequest
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  | Config.ConfigError
  | ConsentDisclosureDeliveryUnavailable
  | HttpBody.HttpBodyError
  | HttpServerError.HttpServerError
  | InvalidKapsoPayload
  | InvalidKapsoSignature
  | KapsoBatchTooLarge
  | KapsoBodyReadCapacityExceeded
  | KapsoBodyReadTimeout
  | KapsoPayloadTooLarge
  | KapsoSendFailed
  | OnboardingConsentRequired
  | Schema.SchemaError
  | WhatsAppInboundCapacityExceeded
  | WhatsAppRateLimitExceeded
  | WhatsAppReceiptInProgress
  | WhatsAppReceiptInvalid,
  Crypto.Crypto | KapsoClient | PersistedQueue.PersistedQueueFactory | SqlClient.SqlClient
>;

const isDisclosureLifecycleEvent = Schema.is(DisclosureLifecycleEventName);

const handleKapsoDisclosureLifecycleWebhook = Effect.fn(function* (
  request: HttpServerRequest.HttpServerRequest,
  secret: string,
  bodyReaders: Semaphore.Semaphore
) {
  const signature = request.headers["x-webhook-signature"] ?? "";
  if (!/^[0-9a-f]{64}$/iu.test(signature)) return yield* new InvalidKapsoSignature();
  const rawBody = yield* readBoundedBody(request, bodyReaders);
  const evidence = yield* decodeKapsoDisclosureLifecycleWebhook({
    rawBody,
    secret,
    signature,
    eventName: request.headers["x-webhook-event"] ?? "",
    receivedAt: yield* DateTime.now,
  });
  const resolution = yield* applyConsentDisclosureLifecycle(evidence);
  return yield* HttpServerResponse.json({ resolution });
});

const processKapsoInboundReceipt = Effect.fn(function* (
  receipt: Effect.Success<ReturnType<typeof decodeKapsoWebhook>>
) {
  let consentTurns = 0;
  let enqueued = 0;
  let duplicates = 0;
  for (const event of receipt.events) {
    const claim = yield* claimWhatsAppReceipt(
      event.messageEvidence.providerMessageId,
      receipt.deliveryKey,
      event.receivedAt
    );
    if (Option.isNone(claim)) {
      duplicates += 1;
      continue;
    }
    const outcome = yield* admitInboundEvent(event, receipt.deliveryKey, claim.value);
    if (outcome === "enqueued") enqueued += 1;
    else if (outcome === "duplicate") duplicates += 1;
    else consentTurns += 1;
  }
  return { decoded: receipt.events.length, consentTurns, enqueued, duplicates };
});

const handleKapsoWebhook = (
  secret: string,
  businessPortfolioId: string,
  bodyReaders: Semaphore.Semaphore
): KapsoMessageWebhookHandler =>
  Effect.fn("WhatsApp.handleKapsoWebhook")(function* (
    request: HttpServerRequest.HttpServerRequest
  ) {
    const eventName = request.headers["x-webhook-event"] ?? "";
    if (isDisclosureLifecycleEvent(eventName)) {
      return yield* handleKapsoDisclosureLifecycleWebhook(request, secret, bodyReaders);
    }
    const signature = request.headers["x-webhook-signature"] ?? "";
    if (!/^[0-9a-f]{64}$/iu.test(signature)) return yield* new InvalidKapsoSignature();
    const rawBody = yield* readBoundedBody(request, bodyReaders);
    const receivedAt = yield* DateTime.now;
    const deliveryKey = request.headers["x-idempotency-key"] ?? "";
    const receipt = yield* decodeKapsoWebhook({
      rawBody,
      secret,
      signature,
      deliveryKey,
      businessPortfolioId,
      receivedAt,
    });

    const telemetry = yield* Effect.serviceOption(Telemetry);
    const work = processKapsoInboundReceipt(receipt).pipe(
      Effect.flatMap((summary) => HttpServerResponse.json(summary))
    );
    return yield* Option.match(telemetry, {
      onNone: () => work,
      onSome: (service) =>
        service.rootSpan(
          {
            component: "whatsapp",
            operation: "http.kapsoWebhook",
            trigger: "kapso_webhook",
            spanOperation: "http.server",
            workKind: "http_request",
            metadata: {
              _tag: "Http",
              method: "POST",
              route: "/webhooks/kapso",
              status: Option.none(),
            },
          },
          Effect.tap(work, (response) =>
            service.recordResponseStatus(TelemetryHttpStatus.make(response.status))
          )
        ),
    });
  });

const handleKapsoIdentityWebhook = (
  secret: string,
  businessPortfolioId: string,
  bodyReaders: Semaphore.Semaphore
): ((
  request: HttpServerRequest.HttpServerRequest
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  | HttpBody.HttpBodyError
  | HttpServerError.HttpServerError
  | InvalidKapsoPayload
  | InvalidKapsoSignature
  | KapsoBatchTooLarge
  | KapsoBodyReadCapacityExceeded
  | KapsoBodyReadTimeout
  | KapsoPayloadTooLarge
  | Schema.SchemaError
  | WhatsAppIdentityChangeDeferred,
  SqlClient.SqlClient
>) =>
  Effect.fn("WhatsApp.handleKapsoIdentityWebhook")(function* (
    request: HttpServerRequest.HttpServerRequest
  ) {
    const signature = request.headers["x-webhook-signature"] ?? "";
    if (!/^[0-9a-f]{64}$/iu.test(signature)) return yield* new InvalidKapsoSignature();
    const rawBody = yield* readBoundedBody(request, bodyReaders);
    const receivedAt = yield* DateTime.now;
    const changes = yield* decodeKapsoIdentityWebhook({
      rawBody,
      secret,
      signature,
      businessPortfolioId,
      receivedAt,
    });
    const acknowledged = yield* Effect.forEach(changes, (change) =>
      reassociateWhatsAppIdentity(
        change.previousCaller,
        {
          businessScopedUserId: change.replacement.businessScopedUserId,
          parentBusinessScopedUserId: change.replacement.parentBusinessScopedUserId,
          username: change.replacement.username,
          phoneNumber: change.replacement.phoneNumber,
          verifiedAt: change.occurredAt,
        },
        change.messageEvidence.providerMessageId
      )
    ).pipe(Effect.map((results) => results.filter(Option.isSome).length));
    if (acknowledged !== changes.length) return yield* new WhatsAppIdentityChangeDeferred();
    return yield* HttpServerResponse.json({ decoded: changes.length, acknowledged });
  });

/**
 * Adds authenticated Kapso message/lifecycle POST `/webhooks/kapso` and exact Meta forwarding POST
 * `/webhooks/kapso/meta` using KAPSO_WEBHOOK_SECRET and the trusted
 * WHATSAPP_BUSINESS_PORTFOLIO_ID. At most 32 bodies are read concurrently; exact bytes are bounded
 * and authenticated before decoding or writes. Message admission and lifecycle reconciliation
 * return JSON summaries; authentication, malformed/batch, body-size/timeout, body-read/rate
 * capacity, and queue-capacity failures map to 401, 400, 413/408, 429, and 503 respectively.
 */
export const KapsoWebhookLive = Layer.unwrap(
  Effect.gen(function* () {
    const secret = yield* Config.redacted("KAPSO_WEBHOOK_SECRET");
    const businessPortfolioId = yield* Config.string("WHATSAPP_BUSINESS_PORTFOLIO_ID");
    const bodyReaders = yield* Semaphore.make(concurrentWebhookBodyReads);
    const messageRoute = HttpRouter.add("POST", "/webhooks/kapso", (request) =>
      handleKapsoWebhook(
        Redacted.value(secret),
        businessPortfolioId,
        bodyReaders
      )(request).pipe(
        Effect.catchTags({
          ...kapsoBodyReadErrorResponses,
          InvalidKapsoSignature: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
          InvalidKapsoPayload: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
          KapsoBatchTooLarge: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
          WhatsAppInboundCapacityExceeded: () =>
            Effect.succeed(HttpServerResponse.empty({ status: 503 })),
          WhatsAppRateLimitExceeded: () =>
            Effect.succeed(HttpServerResponse.empty({ status: 429 })),
          WhatsAppReceiptInProgress: () =>
            Effect.succeed(HttpServerResponse.empty({ status: 503 })),
          ConsentDisclosureDeliveryUnavailable: () =>
            Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        })
      )
    );
    const identityRoute = HttpRouter.add("POST", "/webhooks/kapso/meta", (request) =>
      handleKapsoIdentityWebhook(
        Redacted.value(secret),
        businessPortfolioId,
        bodyReaders
      )(request).pipe(
        Effect.catchTags({
          ...kapsoBodyReadErrorResponses,
          InvalidKapsoSignature: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
          InvalidKapsoPayload: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
          KapsoBatchTooLarge: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
          WhatsAppIdentityChangeDeferred: () =>
            Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        })
      )
    );
    return Layer.merge(messageRoute, identityRoute);
  })
);
