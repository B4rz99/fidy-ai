import { WebAuthApi, browserSessionBindingHeader } from "@fidy/server/client";
import { Context, Effect, Layer, type Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { browserHttpClientLayer } from "./browser-http-policy";

/** Immutable expected session for one mounted application; the cookie remains sole authority. */
export type BrowserSessionLifetime = Readonly<{
  binding: string;
  signal: AbortSignal;
  expired: () => void;
}>;

/** Read public session identity without loading User data or renewing/replacing a cookie. */
export const loadBrowserSessionBinding = ({
  apiOrigin,
}: Readonly<{ apiOrigin: string }>): Effect.Effect<
  string,
  HttpClientError.HttpClientError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      FetchHttpClient.layer.pipe(browserHttpClientLayer("web-auth", apiOrigin))
    );
    const client = yield* HttpApiClient.makeWith(WebAuthApi, {
      baseUrl: apiOrigin,
      httpClient: Context.get(context, HttpClient.HttpClient),
    });
    const result = yield* client.browserSession.binding();
    return result.binding ?? "none";
  }).pipe(Effect.scoped);

const closedFailure = (): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: HttpClientRequest.get("https://browser-api.invalid"),
      description: "browser authentication lifetime ended",
    }),
  });
const lifetimeEnded = (
  signal: AbortSignal
): Effect.Effect<never, HttpClientError.HttpClientError> =>
  Effect.callback((resume) => {
    const ended = (): void => resume(Effect.fail(closedFailure()));
    if (signal.aborted) {
      ended();
      return;
    }
    signal.addEventListener("abort", ended, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", ended));
  });

const unauthorizedStatus = 401;
const acceptResponse =
  (
    lifetime: BrowserSessionLifetime
  ): ((
    response: HttpClientResponse.HttpClientResponse
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>) =>
  (response) => {
    if (lifetime.signal.aborted) {
      return Effect.fail(closedFailure());
    }
    if (response.status === unauthorizedStatus && lifetime.binding !== "none") {
      lifetime.expired();
    }
    return Effect.succeed(response);
  };

/** Bind every client to one immutable lifetime; retirement cancels I/O and suppresses late replies. */
export const bindBrowserSession = ({
  transport,
  lifetime,
}: Readonly<{
  transport: Layer.Layer<HttpClient.HttpClient>;
  lifetime: BrowserSessionLifetime;
}>): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.makeWith(
        (
          request: Effect.Effect<
            HttpClientRequest.HttpClientRequest,
            HttpClientError.HttpClientError
          >
        ) =>
          Effect.suspend(() => {
            if (lifetime.signal.aborted) {
              return Effect.fail(closedFailure());
            }
            return client
              .postprocess(request)
              .pipe(
                Effect.raceFirst(lifetimeEnded(lifetime.signal)),
                Effect.flatMap(acceptResponse(lifetime))
              );
          }),
        (request) =>
          client.preprocess(
            HttpClientRequest.setHeader(request, browserSessionBindingHeader, lifetime.binding)
          )
      )
    )
  ).pipe(Layer.provide(transport));
