import { browserSessionBindingHeader } from "@fidy/server/browser-transport";
import { Effect, Layer, Semaphore } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

/** Immutable expected session for one mounted application; the cookie remains sole authority. */
export type BrowserSessionLifetime = Readonly<{
  binding: string;
  signal: AbortSignal;
  recheck: () => void;
}>;

const concurrentRequests = 2;
const requestPermits = new WeakMap<AbortSignal, Semaphore.Semaphore>();
const permitsFor = (signal: AbortSignal): Semaphore.Semaphore => {
  const existing = requestPermits.get(signal);
  if (existing !== undefined) return existing;
  const permits = Semaphore.makeUnsafe(concurrentRequests);
  requestPermits.set(signal, permits);
  return permits;
};

/** Coordinates this page's clients within their shared session; admission remains server-owned. */
export const coordinateBrowserRequests = ({
  transport,
  signal,
}: Readonly<{
  transport: Layer.Layer<HttpClient.HttpClient>;
  signal: AbortSignal;
}>): Layer.Layer<HttpClient.HttpClient> => {
  const permits = permitsFor(signal);
  return HttpClient.layerMergedContext(
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.makeWith(
        (request) => permits.withPermits(1)(client.postprocess(request)),
        client.preprocess
      )
    )
  ).pipe(Layer.provide(transport));
};

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
      lifetime.recheck();
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
