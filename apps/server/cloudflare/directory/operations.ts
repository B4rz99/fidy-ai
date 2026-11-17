import { patRouteProof } from "../tokens/operations";

import { Effect, Option, Schema } from "effect";
import {
  canonicalAdmissionUnavailable,
  noAuthority,
  rateLimited,
} from "../canonical-admission/operations";
import { readBoundWebSessionProof } from "../web-session/operations";
import {
  PATRoute,
  SessionRoute,
  type UserStoreBindings,
  directoryName,
  patRouteHeader,
  patRouteUrl,
  sessionRouteUrl,
  sourcePressureUrl,
} from "./contract";

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
