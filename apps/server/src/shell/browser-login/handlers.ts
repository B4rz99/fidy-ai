import { Effect, Layer, Option, Redacted, Semaphore } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
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
import { logoutWebSession } from "~/shell/web-session/service";

const WebAuthNoStoreLive = HttpRouter.middleware((httpEffect) =>
  Effect.map(httpEffect, (response) =>
    HttpServerResponse.setHeader(response, "cache-control", "no-store")
  )
).layer;

const maximumConcurrentStarts = 8;
const maximumConcurrentRedemptions = 4;
const concurrentStartAdmission = Semaphore.makeUnsafe(maximumConcurrentStarts);
const concurrentRedemptionAdmission = Semaphore.makeUnsafe(maximumConcurrentRedemptions);
const temporarilyUnavailable = HttpServerResponse.json(browserLoginUnavailableBody, {
  status: 503,
}).pipe(Effect.orDie);

const handleAdmittedStart = Effect.fn("BrowserLogin.handleAdmittedStart")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const address = Option.getOrElse(request.remoteAddress, () => "unknown");
  return yield* startBrowserLoginPairing(address).pipe(
    Effect.catchTags({
      BrowserLoginStartRateLimited: ({ retryAfterSeconds }) =>
        HttpServerResponse.json(browserLoginUnavailableBody, {
          status: 429,
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

export const webSessionCookieName = "__Host-fidy_session";
const webSessionCookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: "strict",
  path: "/",
  maxAge: "30 days",
} as const;
const expiredWebSessionCookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: "strict",
  path: "/",
} as const;

const handleAdmittedRedemption = Effect.fn("BrowserLogin.handleAdmittedRedemption")(function* (
  payload: RedeemBrowserLoginPairingPayload
) {
  const redeemed = yield* redeemBrowserLoginPairing(payload).pipe(
    Effect.catchTags({
      BrowserLoginPairingInvalid: () =>
        HttpServerResponse.json(browserLoginPairingInvalidBody, { status: 400 }).pipe(Effect.orDie),
      BrowserLoginPollingRateLimited: ({ retryAfterSeconds }) =>
        HttpServerResponse.json(
          { error: { code: "rate_limited", retryAfterSeconds } },
          { status: 429, headers: { "retry-after": String(retryAfterSeconds) } }
        ).pipe(Effect.orDie),
    })
  );
  if (HttpServerResponse.isHttpServerResponse(redeemed)) return redeemed;
  if (redeemed.status === "pending_approval") return redeemed;
  const response = yield* HttpServerResponse.json({ status: "authenticated" }).pipe(Effect.orDie);
  return HttpServerResponse.setCookieUnsafe(
    response,
    webSessionCookieName,
    Redacted.value(redeemed.sessionBearer),
    webSessionCookieOptions
  );
});

const handleRedeemPairing = Effect.fn("BrowserLogin.handleRedeemPairing")(function* (
  payload: RedeemBrowserLoginPairingPayload
) {
  const admitted = yield* concurrentRedemptionAdmission.withPermitsIfAvailable(1)(
    handleAdmittedRedemption(payload)
  );
  return yield* Option.match(admitted, {
    onNone: () => temporarilyUnavailable,
    onSome: Effect.succeed,
  });
});

const handleLogout = Effect.fn("WebSession.handleLogout")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  yield* logoutWebSession(request.cookies[webSessionCookieName] ?? "");
  return HttpServerResponse.expireCookieUnsafe(
    HttpServerResponse.empty({ status: 204 }),
    webSessionCookieName,
    expiredWebSessionCookieOptions
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
