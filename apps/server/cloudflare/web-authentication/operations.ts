import { webAuthenticationEndpoints } from "../../src/shell/web-authentication/contract";
import { Cause, Effect, Option } from "effect";
import { redeemBrowserPairing, startBrowserPairing } from "../browser-login/operations";
import {
  completeBrowserPairingEmail,
  completeEmailReplacement,
  requestEmailReplacement,
  startBrowserPairingEmail,
} from "../email-authentication/operations";
import { supportRecoveryPath } from "../recovery/contract";
import { handleSupportRecovery, rotateBackupRecoveryCode } from "../recovery/operations";
import { handlePATRequest, patRoute } from "../tokens/operations";
import { currentWebSessionUser, logoutWebSession } from "../web-session/operations";
import type { WebAuthenticationRequest } from "./contract";
import type { BrowserPairingUnavailable } from "../browser-login/contract";

type AuthenticationHandler = (
  input: WebAuthenticationRequest
) => Effect.Effect<Response, Cause.UnknownError | BrowserPairingUnavailable | void>;
const handlers = {
  startPairing: ({ db }): Effect.Effect<Response, BrowserPairingUnavailable> =>
    startBrowserPairing(db),
  redeemPairing: redeemBrowserPairing,
  logout: (input): Effect.Effect<Response, void> => logoutWebSession(input),
  startEmail: ({ request, db, publish }): Effect.Effect<Response, Cause.UnknownError> =>
    Effect.tryPromise(() =>
      startBrowserPairingEmail({ request, db, onAccepted: (id) => publish("browserPairing", id) })
    ),
  completeEmail: (input): Effect.Effect<Response, Cause.UnknownError> =>
    Effect.tryPromise(() => completeBrowserPairingEmail(input)),
  requestReplacement: ({ request, db, publish }): Effect.Effect<Response, Cause.UnknownError> =>
    Effect.tryPromise(() =>
      requestEmailReplacement({ request, db, onAccepted: (id) => publish("emailReplacement", id) })
    ),
  completeReplacement: (input): Effect.Effect<Response, Cause.UnknownError> =>
    Effect.tryPromise(() => completeEmailReplacement(input)),
  rotateRecovery: (input): Effect.Effect<Response, Cause.UnknownError> =>
    Effect.tryPromise(() => rotateBackupRecoveryCode(input)),
  currentUser: (input): Effect.Effect<Response> => currentWebSessionUser(input),
} satisfies Record<keyof typeof webAuthenticationEndpoints, AuthenticationHandler>;
const handlersByName: ReadonlyMap<string, AuthenticationHandler> = new Map(
  Object.entries(handlers)
);
const routes = Object.entries(webAuthenticationEndpoints).map(([name, endpoint]) => {
  const handle = handlersByName.get(name);
  if (handle === undefined) throw new Error("Unimplemented Web Authentication operation");
  return { path: endpoint.path, method: endpoint.method, handle };
});

/** Recognize only owner-declared browser, PAT and private recovery paths; matching grants no authority. */
export const ownsWebAuthenticationPath = (path: string): boolean =>
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

/**
 * Coordinate one existing authentication operation through its owner. Proof, User binding,
 * one-use consumption, session issuance and persistence remain owner-authoritative. Origin and
 * ingress policy must already have run; this private composition does not replace them.
 */
export const handleWebAuthentication = (
  input: WebAuthenticationRequest
): Effect.Effect<Response> => {
  const path = new URL(input.request.url).pathname;
  if (path === supportRecoveryPath) return supportResponse(input);
  if (patRoute(path)) {
    return handlePATRequest(input).pipe(Effect.orElseSucceed(unavailable));
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
  const work = route.handle(input).pipe(Effect.orElseSucceed(unavailable));
  return path === webAuthenticationEndpoints.requestReplacement.path ||
    path === webAuthenticationEndpoints.completeReplacement.path
    ? work.pipe(Effect.withSpan("emailReplacement.browser"))
    : work;
};
