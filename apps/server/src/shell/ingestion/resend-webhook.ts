import { Effect, Option, Semaphore } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { collectBoundedBytes } from "~/shell/_shared/bounded-bytes";
import {
  ResendWebhookPayloadTooLarge,
  forwardedEmailIngestion,
  maximumResendWebhookBytes,
} from "./forwarded-email-ingestion";

const publicWebhookConcurrentRequests = 32;
const tooManyRequestsStatus = 429;
const retryAfterSeconds = "60";
const publicWebhookCapacity = Semaphore.makeUnsafe(publicWebhookConcurrentRequests);
const retryLater = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status: tooManyRequestsStatus }).pipe(
    HttpServerResponse.setHeader("retry-after", retryAfterSeconds)
  );

/** Thin HTTP adapter for the deep Forwarded Email Ingestion interface. */
export const ResendWebhookLive = HttpRouter.add("POST", "/webhooks/resend", (request) =>
  publicWebhookCapacity
    .withPermits(1)(
      Effect.gen(function* () {
        const body = yield* collectBoundedBytes(request.stream, maximumResendWebhookBytes).pipe(
          Effect.mapError(() => new ResendWebhookPayloadTooLarge())
        );
        if (Option.isNone(body)) return yield* new ResendWebhookPayloadTooLarge();
        const disposition = yield* forwardedEmailIngestion.receiveResendWebhook({
          exactBody: body.value,
          headers: request.headers,
        });
        return disposition.outcome === "accepted"
          ? yield* HttpServerResponse.json({ accepted: true }, { status: 202 })
          : retryLater();
      })
    )
    .pipe(
      Effect.timeoutOption("1 second"),
      Effect.map(Option.getOrElse(retryLater)),
      Effect.catchTags({
        InvalidResendWebhookProof: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
        InvalidResendWebhookPayload: () =>
          Effect.succeed(HttpServerResponse.empty({ status: 400 })),
        ResendWebhookPayloadTooLarge: () =>
          Effect.succeed(HttpServerResponse.empty({ status: 413 })),
        ResendWebhookRateExceeded: () => Effect.succeed(retryLater()),
      })
    )
);
