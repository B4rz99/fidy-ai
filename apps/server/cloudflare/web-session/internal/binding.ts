import { sessionCookie, sessionDigest } from "./credentials";
import { WebSessionId } from "../../../src/core/web-session/contract";
import {
  browserSessionBindingHeader,
  browserSessionBindingPath,
} from "~/shell/browser-transport/contract";
import { webAuthenticationEndpoints } from "../../../src/shell/web-authentication/contract";
import {
  microsoftProviderPaths,
  providerPaths,
} from "../../../src/shell/provider-authentication/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { BrowserSessionBinding } from "../../../src/shell/web-session/contract";
import { authenticate, currentSessionLookup, decodeSessionLookup } from "./authentication";
import { noSession, unavailable } from "./support";
import type {
  CanonicalBrowserBinding,
  WebSessionRequest,
  WebSessionSnapshotContext,
} from "../contract";
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

export const snapshotBinding = (request: Request): Promise<CanonicalBrowserBinding> => {
  if (!hasSessionCookie(request)) return Promise.resolve({ kind: "independent" });
  const binding = Schema.decodeUnknownOption(WebSessionId)(
    request.headers.get(browserSessionBindingHeader)
  );
  const token = sessionCookie(request);
  if (Option.isNone(binding) || Option.isNone(token)) {
    return Promise.resolve({ kind: "cookie", material: Option.none() });
  }
  return sessionDigest(token.value).then((digest) => ({
    kind: "cookie",
    material: Option.some({ digest, binding }),
  }));
};

export const acceptsSnapshotBinding = (
  input: Pick<WebSessionSnapshotContext, "db" | "current" | "execute"> &
    Readonly<{ binding: CanonicalBrowserBinding }>
): boolean => {
  if (input.binding.kind === "independent") return true;
  if (Option.isNone(input.binding.material)) return false;
  const lookup = currentSessionLookup({
    ...input.binding.material.value,
    current: input.current,
    freshness: "live",
    requireConsent: false,
  });
  const statement = input.db.prepare(lookup.statement.sql).bind(...lookup.statement.params);
  return Option.isSome(
    decodeSessionLookup({ lookup, row: input.execute([statement])[0]?.results[0] })
  );
};

const bindingMatches = (session: Option.Option<{ id: string }>, request: Request): boolean =>
  Option.isSome(session) && request.headers.get(browserSessionBindingHeader) === session.value.id;

const boundCurrentUserRead = (request: Request, path: string): boolean =>
  path === webAuthenticationEndpoints.currentUser.path &&
  request.method === "GET" &&
  request.headers.has(browserSessionBindingHeader) &&
  !request.headers.has("authorization");

const ownerChecksBinding = (request: Request, path: string): boolean =>
  independentProofPaths.has(path) || boundCurrentUserRead(request, path);

/** Protect cookie-bearing ingress before any owner work; bootstrap discloses only public identity. */
export const bindingResponse = ({
  request,
  db,
}: WebSessionRequest): Effect.Effect<Option.Option<Response>> =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname;
    if (ownerChecksBinding(request, path)) {
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
      try: () =>
        authenticate({
          request,
          db,
          current,
          freshness: "live",
          requireConsent: false,
          binding: Option.none(),
        }),
      catch: () => undefined,
    });
    if (bootstrap) {
      return Option.some(
        Response.json(
          yield* Schema.encodeUnknownEffect(BrowserSessionBinding)({
            binding: Option.match(session, { onNone: () => null, onSome: (value) => value.id }),
            initial: Option.none(),
          }),
          { headers: { "cache-control": "no-store" } }
        )
      );
    }
    return bindingMatches(session, request) ? Option.none() : Option.some(noSession());
  }).pipe(Effect.orElseSucceed(() => Option.some(unavailable())));
