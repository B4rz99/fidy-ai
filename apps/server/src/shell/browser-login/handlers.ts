import { Effect, Layer, Option, Semaphore } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { browserLoginUnavailableBody } from "./errors";
import { approveBrowserLoginPairing } from "./mutations";
import { purgeBrowserLoginAnonymousEvidence, startBrowserLoginPairing } from "./service";
import { WebAuthApi } from "./web-auth-api";

const WebAuthNoStoreLive = HttpRouter.middleware((httpEffect) =>
  Effect.map(httpEffect, (response) =>
    HttpServerResponse.setHeader(response, "cache-control", "no-store")
  )
).layer;

const maximumConcurrentStarts = 8;
const concurrentStartAdmission = Semaphore.makeUnsafe(maximumConcurrentStarts);
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

const BrowserLoginWebAuthHandlersLive = HttpApiBuilder.group(
  WebAuthApi,
  "browserLogin",
  (handlers) => handlers.handle("startPairing", handleStartPairing)
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
