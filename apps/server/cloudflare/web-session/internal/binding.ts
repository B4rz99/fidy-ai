import { webAuthenticationEndpoints } from "../../../src/shell/web-authentication/contract";
import {
  microsoftProviderPaths,
  providerPaths,
} from "../../../src/shell/provider-authentication/contract";
import { Clock, Effect, Option, Schema } from "effect";
import {
  BrowserSessionBinding,
  browserSessionBindingHeader,
  browserSessionBindingPath,
} from "../../../src/shell/web-session/contract";
import { authenticate } from "./authentication";
import { noSession, unavailable } from "./support";
import type { WebSessionRequest } from "../contract";
import { connectionCallbackPath } from "../../connections/contract";

const independentProofPaths = new Set<string>([
  connectionCallbackPath,
  ...Object.values(providerPaths),
  ...Object.values(microsoftProviderPaths),
  webAuthenticationEndpoints.startPairing.path,
  webAuthenticationEndpoints.redeemPairing.path,
  webAuthenticationEndpoints.startEmail.path,
  webAuthenticationEndpoints.completeEmail.path,
]);

const hasSessionCookie = (request: Request): boolean =>
  (request.headers.get("cookie") ?? "")
    .split(";")
    .some((value) => value.trim().startsWith("__Host-fidy_session="));

const bindingMatches = (session: Option.Option<{ id: string }>, request: Request): boolean =>
  Option.isSome(session) && request.headers.get(browserSessionBindingHeader) === session.value.id;

/** Protect cookie-bearing ingress before any owner work; bootstrap discloses only public identity. */
export const bindingResponse = ({
  request,
  db,
}: WebSessionRequest): Effect.Effect<Option.Option<Response>> =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname;
    if (independentProofPaths.has(path)) {
      return Option.none();
    }
    const bootstrap = path === browserSessionBindingPath;
    if (bootstrap && request.method !== "GET") {
      return Option.some(new Response(null, { status: 405 }));
    }
    if (!bootstrap && !hasSessionCookie(request)) {
      return Option.none();
    }
    const current = yield* Clock.currentTimeMillis;
    const session = yield* Effect.tryPromise({
      try: () => authenticate({ request, db, current, freshness: "live", requireConsent: false }),
      catch: () => undefined,
    });
    if (bootstrap) {
      return Option.some(
        Response.json(
          yield* Schema.decodeEffect(BrowserSessionBinding)({
            binding: Option.match(session, { onNone: () => null, onSome: (value) => value.id }),
          }),
          { headers: { "cache-control": "no-store" } }
        )
      );
    }
    return bindingMatches(session, request) ? Option.none() : Option.some(noSession());
  }).pipe(Effect.orElseSucceed(() => Option.some(unavailable())));
