import { Config, Data, DateTime, Effect, Layer, Option, Redacted, Semaphore, Stream } from "effect";
import { HttpRouter, HttpServerResponse, type HttpServerRequest } from "effect/unstable/http";
import { admitAgentConversationTurn } from "~/shell/agent/conversation";
import { reassociateWhatsAppIdentity } from "~/shell/identity/repo";
import { makeBoundedBytes } from "./bounded-bytes";
import { deliverWhatsAppConsentOutcome } from "./outbound";
import {
  decodeKapsoIdentityWebhook,
  decodeKapsoWebhook,
  InvalidKapsoSignature,
  KapsoPayloadTooLarge,
  maxKapsoWebhookBytes,
} from "./kapso-webhook";
import {
  claimWhatsAppReceipt,
  completeWhatsAppReceipt,
  consumeWhatsAppIngressBudget,
  enqueueWhatsAppTurn,
  markWhatsAppReceiptOutboundStarted,
  releaseWhatsAppReceipt,
} from "./repo";

class KapsoBodyReadTimeout extends Data.TaggedError("KapsoBodyReadTimeout")<{}> {}
class WhatsAppIdentityChangeDeferred extends Data.TaggedError(
  "WhatsAppIdentityChangeDeferred"
)<{}> {}

const readBoundedBody = (request: HttpServerRequest.HttpServerRequest) =>
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
  );

const handleKapsoWebhook = (secret: string, businessPortfolioId: string) =>
  Effect.fn("WhatsApp.handleKapsoWebhook")(function* (
    request: HttpServerRequest.HttpServerRequest
  ) {
    const signature = request.headers["x-webhook-signature"] ?? "";
    if (!/^[0-9a-f]{64}$/iu.test(signature)) return yield* new InvalidKapsoSignature();
    const rawBody = yield* readBoundedBody(request);
    const deliveryKey = request.headers["x-idempotency-key"] ?? "";
    const receivedAt = yield* DateTime.now;
    const receipt = yield* decodeKapsoWebhook({
      rawBody,
      secret,
      signature,
      deliveryKey,
      businessPortfolioId,
      receivedAt,
    });

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
      yield* Effect.gen(function* () {
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
        const admission = yield* admitAgentConversationTurn({
          caller: event.caller,
          content: { _tag: "Text", text: event.content.text },
          message: event.messageEvidence,
          receivedAt: event.occurredAt,
        });
        if (admission._tag === "AuthorizedTurn") {
          yield* consumeWhatsAppIngressBudget(
            { _tag: "User", userId: admission.userId },
            event.messageEvidence.providerMessageId,
            event.receivedAt
          );
          const enqueueResult = yield* enqueueWhatsAppTurn({
            admission,
            event,
            deliveryKey: receipt.deliveryKey,
          });
          if (enqueueResult.inserted) enqueued += 1;
          else duplicates += 1;
        } else {
          yield* deliverWhatsAppConsentOutcome(
            event,
            admission,
            markWhatsAppReceiptOutboundStarted(claim.value)
          );
          consentTurns += 1;
        }
        yield* completeWhatsAppReceipt(claim.value, event.receivedAt);
      }).pipe(Effect.onError(() => releaseWhatsAppReceipt(claim.value)));
    }
    return yield* HttpServerResponse.json({
      decoded: receipt.events.length,
      consentTurns,
      enqueued,
      duplicates,
    });
  });

const handleKapsoIdentityWebhook = (secret: string, businessPortfolioId: string) =>
  Effect.fn("WhatsApp.handleKapsoIdentityWebhook")(function* (
    request: HttpServerRequest.HttpServerRequest
  ) {
    const signature = request.headers["x-webhook-signature"] ?? "";
    if (!/^[0-9a-f]{64}$/iu.test(signature)) return yield* new InvalidKapsoSignature();
    const rawBody = yield* readBoundedBody(request);
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
 * Adds buffered message POST `/webhooks/kapso` and exact Meta forwarding POST
 * `/webhooks/kapso/meta` using KAPSO_WEBHOOK_SECRET and the trusted
 * WHATSAPP_BUSINESS_PORTFOLIO_ID. At most 32 bodies are read concurrently; exact bytes are bounded
 * and authenticated before decoding or writes. Successful durable admission returns a JSON summary;
 * authentication, malformed/batch, body-size/timeout, rate, and queue-capacity failures map to
 * 401, 400, 413/408, 429, and 503 respectively.
 */
export const KapsoWebhookLive = Layer.unwrap(
  Effect.gen(function* () {
    const secret = yield* Config.redacted("KAPSO_WEBHOOK_SECRET");
    const businessPortfolioId = yield* Config.string("WHATSAPP_BUSINESS_PORTFOLIO_ID");
    const bodyReaders = yield* Semaphore.make(32);
    const messageRoute = HttpRouter.add("POST", "/webhooks/kapso", (request) =>
      bodyReaders
        .withPermitsIfAvailable(1)(
          handleKapsoWebhook(
            Redacted.value(secret),
            businessPortfolioId
          )(request).pipe(
            Effect.catchTags({
              InvalidKapsoSignature: () =>
                Effect.succeed(HttpServerResponse.empty({ status: 401 })),
              KapsoPayloadTooLarge: () => Effect.succeed(HttpServerResponse.empty({ status: 413 })),
              KapsoBodyReadTimeout: () => Effect.succeed(HttpServerResponse.empty({ status: 408 })),
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
        )
        .pipe(Effect.map(Option.getOrElse(() => HttpServerResponse.empty({ status: 429 }))))
    );
    const identityRoute = HttpRouter.add("POST", "/webhooks/kapso/meta", (request) =>
      bodyReaders
        .withPermitsIfAvailable(1)(
          handleKapsoIdentityWebhook(
            Redacted.value(secret),
            businessPortfolioId
          )(request).pipe(
            Effect.catchTags({
              InvalidKapsoSignature: () =>
                Effect.succeed(HttpServerResponse.empty({ status: 401 })),
              KapsoPayloadTooLarge: () => Effect.succeed(HttpServerResponse.empty({ status: 413 })),
              KapsoBodyReadTimeout: () => Effect.succeed(HttpServerResponse.empty({ status: 408 })),
              InvalidKapsoPayload: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
              KapsoBatchTooLarge: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
              WhatsAppIdentityChangeDeferred: () =>
                Effect.succeed(HttpServerResponse.empty({ status: 503 })),
            })
          )
        )
        .pipe(Effect.map(Option.getOrElse(() => HttpServerResponse.empty({ status: 429 }))))
    );
    return Layer.merge(messageRoute, identityRoute);
  })
);
