import { Effect, Layer, Option, Redacted, Schema, Semaphore } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller, webSessionCookieName } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import {
  type RedeemBrowserLoginPairingPayload,
  WebAuthApi,
  browserLoginPairingInvalidBody,
  browserLoginUnavailableBody,
} from "~/web-auth-api";
import { approveBrowserLoginPairing } from "./mutations";
import {
  purgeBrowserLoginAnonymousEvidence,
  redeemBrowserLoginPairing,
  startBrowserLoginPairing,
} from "./service";
import {
  initialWebSessionCookieOptions,
  webSessionCookieOptions,
} from "~/shell/web-session/cookie";
import { logoutWebSession } from "~/shell/web-session/service";
import {
  type DeclaredOutcome,
  type SpanDescriptor,
  TelemetryHttpStatus,
} from "~/shell/observability/protocol";
import { Telemetry, type TelemetryService } from "~/shell/observability/telemetry";

const WebAuthNoStoreLive = HttpRouter.middleware((httpEffect) =>
  Effect.map(httpEffect, (response) =>
    HttpServerResponse.setHeader(response, "cache-control", "no-store")
  )
).layer;

const maximumConcurrentStarts = 8;
const maximumConcurrentRedemptions = 4;
const authenticatedStatus = 200;
const pendingStatus = 202;
const invalidStatus = 400;
const rateLimitedStatus = 429;
const unavailableStatus = 503;
const concurrentStartAdmission = Semaphore.makeUnsafe(maximumConcurrentStarts);
const concurrentRedemptionAdmission = Semaphore.makeUnsafe(maximumConcurrentRedemptions);
const temporarilyUnavailable = HttpServerResponse.json(browserLoginUnavailableBody, {
  status: unavailableStatus,
}).pipe(Effect.orDie);

const handleAdmittedStart = Effect.fn("BrowserLogin.handleAdmittedStart")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const address = Option.getOrElse(request.remoteAddress, () => "unknown");
  return yield* startBrowserLoginPairing(address).pipe(
    Effect.catchTags({
      BrowserLoginStartRateLimited: ({ retryAfterSeconds }) =>
        HttpServerResponse.json(browserLoginUnavailableBody, {
          status: rateLimitedStatus,
          headers: { "retry-after": String(retryAfterSeconds) },
        }).pipe(Effect.orDie),
      BrowserLoginCapacityExceeded: () => temporarilyUnavailable,
    })
  );
});

const handleStartPairing = Effect.fn("BrowserLogin.handleStartPairing")(function* () {
  const admitted = yield* concurrentStartAdmission.withPermitsIfAvailable(1)(handleAdmittedStart());
  return yield* Option.match(admitted, {
    onNone: () => temporarilyUnavailable,
    onSome: Effect.succeed,
  });
});

const BrowserLoginEvidenceRetentionLive = Layer.effectDiscard(
  purgeBrowserLoginAnonymousEvidence().pipe(
    Effect.delay("10 minutes"),
    Effect.forever,
    Effect.forkScoped
  )
);

type RedeemedBrowserLoginPairing = Effect.Success<ReturnType<typeof redeemBrowserLoginPairing>>;
type RedemptionResponse =
  | HttpServerResponse.HttpServerResponse
  | Extract<RedeemedBrowserLoginPairing, { readonly status: "pending_approval" }>;

type ObservedRedemption = {
  readonly response: RedemptionResponse;
  readonly status: TelemetryHttpStatus;
  readonly outcome: DeclaredOutcome;
};

const observedRedemption = (
  response: RedemptionResponse,
  status: number,
  outcome: DeclaredOutcome
): ObservedRedemption => ({
  response,
  status: Schema.decodeUnknownSync(TelemetryHttpStatus)(status),
  outcome,
});
const succeededRedemption: DeclaredOutcome = {
  outcome: "succeeded",
  error: Option.none(),
  retryable: false,
};
const invalidRedemption: DeclaredOutcome = {
  outcome: "rejected",
  error: Option.some("pairing_invalid"),
  retryable: false,
};
const rateLimitedRedemption: DeclaredOutcome = {
  outcome: "failed",
  error: Option.some("rate_limited"),
  retryable: true,
};

const handleAdmittedRedemption = Effect.fn("BrowserLogin.handleAdmittedRedemption")(function* (
  payload: RedeemBrowserLoginPairingPayload
) {
  const result = yield* redeemBrowserLoginPairing(payload).pipe(
    Effect.map((redeemed) => ({ _tag: "Redeemed" as const, redeemed })),
    Effect.catchTags({
      BrowserLoginPairingInvalid: () =>
        HttpServerResponse.json(browserLoginPairingInvalidBody, { status: invalidStatus }).pipe(
          Effect.orDie,
          Effect.map((response) => ({ _tag: "Invalid" as const, response }))
        ),
      BrowserLoginPollingRateLimited: ({ retryAfterSeconds }) =>
        HttpServerResponse.json(
          { error: { code: "rate_limited", retryAfterSeconds } },
          {
            status: rateLimitedStatus,
            headers: { "retry-after": String(retryAfterSeconds) },
          }
        ).pipe(
          Effect.orDie,
          Effect.map((response) => ({ _tag: "RateLimited" as const, response }))
        ),
    })
  );
  switch (result._tag) {
    case "Invalid":
      return observedRedemption(result.response, invalidStatus, invalidRedemption);
    case "RateLimited":
      return observedRedemption(result.response, rateLimitedStatus, rateLimitedRedemption);
    case "Redeemed": {
      if (result.redeemed.status === "pending_approval") {
        return observedRedemption(result.redeemed, pendingStatus, succeededRedemption);
      }
      const response = yield* HttpServerResponse.json({ status: "authenticated" }).pipe(
        Effect.orDie
      );
      return observedRedemption(
        HttpServerResponse.setCookieUnsafe(
          response,
          webSessionCookieName,
          Redacted.value(result.redeemed.sessionBearer),
          initialWebSessionCookieOptions
        ),
        authenticatedStatus,
        succeededRedemption
      );
    }
  }
});

const redemptionDescriptor: SpanDescriptor = {
  component: "api",
  operation: "browserLogin.redeemPairing",
  trigger: "api",
  spanOperation: "http.server",
  workKind: "http_request",
  metadata: {
    _tag: "Http",
    method: "POST",
    route: "/web/pairings/redeem",
    status: Option.none(),
  },
};

const recordRedemptionObservation = (
  telemetry: TelemetryService,
  redemption: ObservedRedemption
): Effect.Effect<void> =>
  Effect.all(
    [
      telemetry.recordResponseStatus(redemption.status),
      telemetry.recordOutcome(redemption.outcome),
    ],
    { discard: true }
  );

const handleRedeemPairing = Effect.fn("BrowserLogin.handleRedeemPairing")(function* (
  payload: RedeemBrowserLoginPairingPayload
) {
  const telemetry = yield* Telemetry;
  return yield* telemetry.rootSpan(
    redemptionDescriptor,
    Effect.gen(function* () {
      const admitted = yield* concurrentRedemptionAdmission.withPermitsIfAvailable(1)(
        handleAdmittedRedemption(payload)
      );
      const redemption = Option.isSome(admitted)
        ? admitted.value
        : observedRedemption(yield* temporarilyUnavailable, unavailableStatus, {
            outcome: "failed",
            error: Option.some("capacity_exceeded"),
            retryable: true,
          });
      yield* recordRedemptionObservation(telemetry, redemption);
      return redemption.response;
    })
  );
});

const handleLogout = Effect.fn("WebSession.handleLogout")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  yield* logoutWebSession(request.cookies[webSessionCookieName] ?? "");
  return HttpServerResponse.expireCookieUnsafe(
    HttpServerResponse.empty({ status: 204 }),
    webSessionCookieName,
    webSessionCookieOptions
  );
});

const BrowserLoginWebAuthHandlersLive = HttpApiBuilder.group(
  WebAuthApi,
  "browserLogin",
  (handlers) =>
    handlers
      .handle("startPairing", handleStartPairing)
      .handle("redeemPairing", ({ payload }) => handleRedeemPairing(payload))
      .handle("logout", handleLogout)
);

/** Canonical route exists for derivation but its policy rejects every transferable bearer. */
export const BrowserLoginLive = HttpApiBuilder.group(FidyApi, "browserLogin", (handlers) =>
  handlers.handle("approvePairing", ({ payload }) =>
    Effect.gen(function* () {
      const caller = yield* ResolvedCaller;
      return yield* approveBrowserLoginPairing({
        userId: caller.subjectUserId,
        publicCode: payload.publicCode,
      });
    })
  )
);

const BrowserLoginWebAuthRoutesLive = HttpApiBuilder.layer(WebAuthApi).pipe(
  Layer.provide(WebAuthNoStoreLive),
  Layer.provide(BrowserLoginWebAuthHandlersLive)
);

/** Unauthenticated direct-browser routes plus independent anonymous-evidence retention. */
export const BrowserLoginWebAuthLive = Layer.merge(
  BrowserLoginWebAuthRoutesLive,
  BrowserLoginEvidenceRetentionLive
);
