import { webAuthenticationEndpoints } from "@fidy/server/web-authentication-contract";
import { Cause, Effect, Option } from "effect";
import { redeemBrowserPairing, startBrowserPairing } from "../../browser-login/operations";
import {
  completeBrowserPairingEmail,
  completeEmailReplacement,
  requestEmailReplacement,
  startBrowserPairingEmail,
  verifyOnboarding,
} from "../../email-authentication/operations";
import { supportRecoveryPath } from "../../recovery/contract";
import { handleSupportRecovery, rotateBackupRecoveryCode } from "../../recovery/operations";
import { handlePATRequest, patRoute } from "../../tokens/operations";
import { currentWebSessionUser, logoutWebSession } from "../../web-session/operations";
import type { WebAuthenticationRequest } from "../contract";

type AuthenticationHandler = (input: WebAuthenticationRequest) => Promise<Response>;
const handlers = {
  startPairing: ({ db }): Promise<Response> => startBrowserPairing(db),
  redeemPairing: redeemBrowserPairing,
  logout: logoutWebSession,
  verifyEmail: verifyOnboarding,
  startEmail: ({ request, db, publish }): Promise<Response> =>
    startBrowserPairingEmail({ request, db, onAccepted: (id) => publish("browserPairing", id) }),
  completeEmail: completeBrowserPairingEmail,
  requestReplacement: ({ request, db, publish }): Promise<Response> =>
    requestEmailReplacement({ request, db, onAccepted: (id) => publish("emailReplacement", id) }),
  completeReplacement: completeEmailReplacement,
  rotateRecovery: rotateBackupRecoveryCode,
  currentUser: currentWebSessionUser,
} satisfies Record<keyof typeof webAuthenticationEndpoints, AuthenticationHandler>;
const handlersByName: ReadonlyMap<string, AuthenticationHandler> = new Map(
  Object.entries(handlers)
);
const routes = Object.entries(webAuthenticationEndpoints).map(([name, endpoint]) => {
  const handle = handlersByName.get(name);
  if (handle === undefined) throw new Error("Unimplemented Web Authentication operation");
  return { path: endpoint.path, method: endpoint.method, handle };
});

export const ownsPath = (path: string): boolean =>
  path === supportRecoveryPath || patRoute(path) || routes.some((route) => route.path === path);

const unavailable = (): Response =>
  Response.json(
    { status: "unavailable" },
    {
      status: 503,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    }
  );
const methodNotAllowed = (): Response =>
  Response.json(
    { status: "method_not_allowed" },
    {
      status: 405,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        allow: "GET",
      },
    }
  );

const supportResponse = ({
  request,
  db,
  support,
  telemetry,
}: WebAuthenticationRequest): Effect.Effect<Response> => {
  if (request.method !== "POST") return Effect.succeed(methodNotAllowed());
  return telemetry.rootSpan(
    {
      component: "api",
      operation: "http.supportRecovery",
      trigger: "api",
      spanOperation: "http.server",
      workKind: "http_request",
      metadata: { _tag: "Http", method: "POST", route: supportRecoveryPath, status: Option.none() },
    },
    handleSupportRecovery({ request, db, config: support }).pipe(
      Effect.catchCauseIf(Cause.hasDies, () =>
        telemetry
          .captureFailure({
            _tag: "Defect",
            component: "api",
            operation: "http.supportRecovery",
            error: "unexpected_defect",
            cause: undefined,
          })
          .pipe(Effect.as(unavailable()))
      )
    )
  );
};

export const respond = (input: WebAuthenticationRequest): Effect.Effect<Response> => {
  const path = new URL(input.request.url).pathname;
  if (path === supportRecoveryPath) return supportResponse(input);
  if (patRoute(path)) {
    return Effect.tryPromise({ try: () => handlePATRequest(input), catch: () => undefined }).pipe(
      Effect.orElseSucceed(unavailable)
    );
  }
  const route = routes.find((candidate) => candidate.path === path);
  if (route === undefined) {
    return Effect.succeed(
      Response.json(
        { status: "not_found" },
        {
          status: 404,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          },
        }
      )
    );
  }
  if (input.request.method !== route.method) return Effect.succeed(methodNotAllowed());
  const work = Effect.tryPromise({ try: () => route.handle(input), catch: () => undefined }).pipe(
    Effect.orElseSucceed(unavailable)
  );
  return path === webAuthenticationEndpoints.requestReplacement.path ||
    path === webAuthenticationEndpoints.completeReplacement.path
    ? work.pipe(Effect.withSpan("emailReplacement.browser"))
    : work;
};
