import { browserSessionBindingHeader } from "../../src/shell/browser-transport/contract";
import {
  DirectoryWriteUnavailable,
  ExternalEventKey,
  type ExternalEventNamespace,
  ExternalEventRoute,
  PATRoute,
  SessionRoute,
  type UserStoreBindings,
  directoryName,
  externalLookupUrl,
  externalReserveUrl,
  patRouteHeader,
  patRouteUrl,
  sessionRouteUrl,
  sourcePressureUrl,
} from "./contract";
import {
  absentSessionResponse,
  readBoundWebSessionProof,
  sessionCookie,
  sessionDigest,
} from "../web-session/operations";
import { patRouteProof } from "../tokens/operations";

import { Effect, Option, Schema } from "effect";
import {
  canonicalAdmissionUnavailable,
  noAuthority,
  rateLimited,
} from "../canonical-admission/operations";

const noContentStatus = 204;

const missingStatus = 404;

const missingRouteStatus = 404;
const unauthorizedStatus = 401;
const pressureStatus = 429;

export const routeSessionRequest = ({
  request,
  environment,
}: Readonly<{
  request: Request;
  environment: Partial<UserStoreBindings>;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const lookup = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));
    if (Option.isNone(lookup)) return noAuthority();
    const { DIRECTORY, USER_STORE } = environment;
    if (DIRECTORY === undefined || USER_STORE === undefined) return canonicalAdmissionUnavailable();
    const response = yield* Effect.tryPromise((signal) =>
      DIRECTORY.getByName(directoryName).fetch(sessionRouteUrl, {
        method: "POST",
        body: new Uint8Array(lookup.value.digest).buffer,
        signal,
      })
    );
    if (response.status === missingRouteStatus) return noAuthority();
    if (!response.ok) return canonicalAdmissionUnavailable();
    const route = yield* Effect.tryPromise(() => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SessionRoute))
    );
    if (route.sessionId !== lookup.value.binding) return noAuthority();
    return yield* Effect.tryPromise((signal) =>
      USER_STORE.getByName(route.userId).fetch(new Request(request, { signal }))
    );
  }).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())));

const includesMountedSession = (request: Request): boolean =>
  (request.headers.get("cookie") ?? "")
    .split(";")
    .some((cookie) => cookie.trim().startsWith("__Host-fidy_session="));

/** A Directory PAT lookup cannot grant authority. Forward the exact record reference for the User's local check. */
export const routePATRequest = Effect.fn(
  function* ({
    request,
    environment,
  }: Readonly<{ request: Request; environment: Partial<UserStoreBindings> }>) {
    const { DIRECTORY, USER_STORE } = environment;
    if (DIRECTORY === undefined || USER_STORE === undefined) return canonicalAdmissionUnavailable();
    // Public ingress selects the browser credential when a session cookie is present.
    if (includesMountedSession(request)) return noAuthority();
    const directory = DIRECTORY.getByName(directoryName);
    const refused = Effect.gen(function* () {
      const source = request.headers.get("x-canonical-source");
      if (source === null) return noAuthority();
      const pressure = yield* Effect.tryPromise((signal) =>
        directory.fetch(sourcePressureUrl, { method: "POST", body: source, signal })
      );
      if (pressure.status === pressureStatus) return rateLimited();
      return pressure.ok ? noAuthority() : canonicalAdmissionUnavailable();
    });
    const proof = patRouteProof(request);
    if (Option.isNone(proof)) return yield* refused;
    const lookup = yield* Effect.tryPromise((signal) =>
      directory.fetch(patRouteUrl, { method: "POST", body: proof.value.shortId, signal })
    );
    if (lookup.status === missingRouteStatus) return yield* refused;
    if (!lookup.ok) return canonicalAdmissionUnavailable();
    const route = yield* Schema.decodeUnknownEffect(PATRoute)(
      yield* Effect.tryPromise(() => lookup.json())
    );
    const headers = new Headers(request.headers);
    headers.set(patRouteHeader, route.patId);
    const response = yield* Effect.tryPromise((signal) =>
      USER_STORE.getByName(route.userId).fetch(new Request(request, { headers, signal }))
    );
    return response.status === unauthorizedStatus ? yield* refused : response;
  },
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

/** Forward a declared independent proof path to the unique pre-User owner. */
export const routeBootstrapRequest = ({
  request,
  environment,
}: Readonly<{
  request: Request;
  environment: Partial<UserStoreBindings>;
}>): Effect.Effect<Response> =>
  Effect.tryPromise((signal) => {
    if (environment.DIRECTORY === undefined) throw new Error("Directory unavailable");
    return environment.DIRECTORY.getByName(directoryName).fetch(new Request(request, { signal }));
  }).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())));

const browserContextRefusal = ({
  request,
  url,
  origin,
}: Readonly<{ request: Request; url: URL; origin: string }>): Option.Option<Response> => {
  if (url.searchParams.size > 0) {
    if (request.headers.get("origin") !== origin) {
      return Option.some(new Response(null, { status: 403 }));
    }
    if (
      url.searchParams.size !== 1 ||
      !["application", "transactions"].includes(url.searchParams.get("context") ?? "")
    ) {
      return Option.some(new Response(null, { status: 400 }));
    }
  }
  return Option.none();
};
const matchesMountedRoute = (request: Request, session: string): boolean => {
  const expected = request.headers.get(browserSessionBindingHeader);
  return (
    expected === session ||
    (expected === null && new URL(request.url).pathname === "/web/session/binding")
  );
};
/** Resolve the bearer for bootstrap and logout. The named User checks the exact current cookie and optional mounted binding. */
export const routeBrowserSession = Effect.fn(
  function* (
    request: Request,
    environment: Partial<UserStoreBindings> & Readonly<{ BROWSER_ORIGIN: string }>
  ) {
    const url = new URL(request.url);
    const rejected = browserContextRefusal({ request, url, origin: environment.BROWSER_ORIGIN });
    if (Option.isSome(rejected)) return rejected.value;
    const cookie = sessionCookie(request);
    if (Option.isNone(cookie)) return absentSessionResponse(url.pathname);
    const { DIRECTORY, USER_STORE } = environment;
    if (DIRECTORY === undefined || USER_STORE === undefined) return canonicalAdmissionUnavailable();
    const digest = yield* Effect.tryPromise(() => sessionDigest(cookie.value));
    const response = yield* Effect.tryPromise((signal) =>
      DIRECTORY.getByName(directoryName).fetch(sessionRouteUrl, {
        method: "POST",
        body: new Uint8Array(digest).buffer,
        signal,
      })
    );
    if (response.status === missingStatus) return absentSessionResponse(url.pathname);
    if (!response.ok) return canonicalAdmissionUnavailable();
    const route = yield* Schema.decodeUnknownEffect(SessionRoute)(
      yield* Effect.tryPromise(() => response.json())
    );
    if (!matchesMountedRoute(request, route.sessionId)) return noAuthority();
    const headers = new Headers(request.headers);
    headers.set(browserSessionBindingHeader, route.sessionId);
    return yield* Effect.tryPromise((signal) =>
      USER_STORE.getByName(route.userId).fetch(new Request(request, { headers, signal }))
    );
  },
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const reserveExternalEventRoute = Effect.fn(function* (
  directory: ExternalEventNamespace,
  route: typeof ExternalEventRoute.Type
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ExternalEventRoute))(route);
  const reply = yield* Effect.tryPromise((signal) =>
    directory.getByName(directoryName).fetch(externalReserveUrl, { method: "POST", body, signal })
  );
  if (reply.status !== noContentStatus) return yield* new DirectoryWriteUnavailable();
});
export const lookupExternalEventRoute = Effect.fn(function* (
  directory: ExternalEventNamespace,
  key: typeof ExternalEventKey.Type
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ExternalEventKey))(key);
  const reply = yield* Effect.tryPromise((signal) =>
    directory.getByName(directoryName).fetch(externalLookupUrl, { method: "POST", body, signal })
  );
  if (reply.status === missingRouteStatus) return Option.none<typeof ExternalEventRoute.Type>();
  if (!reply.ok) return yield* new DirectoryWriteUnavailable();
  return Option.some(
    yield* Schema.decodeUnknownEffect(ExternalEventRoute)(
      yield* Effect.tryPromise(() => reply.json())
    )
  );
});
