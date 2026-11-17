import { Effect, Option, Schema } from "effect";
import { canonicalAdmissionUnavailable, noAuthority } from "../canonical-admission/operations";
import { readBoundWebSessionProof } from "../web-session/operations";
import { SessionRoute, type UserStoreBindings, directoryName, sessionRouteUrl } from "./contract";

const missingRouteStatus = 404;

export const routeBrowserHistory = ({
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
      USER_STORE.getByName(route.userId).fetch(
        new Request(request.url, { headers: request.headers, signal })
      )
    );
  }).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())));
