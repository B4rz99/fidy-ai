import { browserSessionBindingHeader } from "@fidy/server/browser-transport";
import { type InitialBrowserRequest, initialRequestFetch } from "./initial-request";
import {
  BrowserBootstrapApi,
  type BrowserSessionBinding,
  type BrowserSessionInitialContext,
} from "@fidy/server/browser-bootstrap";
import { Clock, Context, Effect, Layer, Option, Semaphore } from "effect";
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

export type BrowserSessionObservation = Readonly<{
  binding: string;
  initial: Option.Option<BrowserSessionInitialContext>;
  receivedAt: number;
}>;

const observeBindingReply = (
  result: typeof BrowserSessionBinding.Type
): Effect.Effect<BrowserSessionObservation> =>
  Effect.map(Clock.currentTimeMillis, (receivedAt) => ({
    binding: result.binding ?? "none",
    initial: result.initial,
    receivedAt,
  }));

/** The initial context is an owned, live observation; ordinary resume requests only public binding. */
type BootstrapClient = HttpApiClient.Client<typeof BrowserBootstrapApi.groups.browserSession>;
export type BrowserSessionEntryFailure = Effect.Error<
  ReturnType<BootstrapClient["browserSession"]["binding"]>
>;
export const loadBrowserSessionEntry = ({
  apiOrigin,
  context: includeContext,
  request,
}: Readonly<{
  apiOrigin: string;
  context: boolean;
  request: Option.Option<InitialBrowserRequest>;
}>): Effect.Effect<BrowserSessionObservation, BrowserSessionEntryFailure> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      FetchHttpClient.layer.pipe(browserHttpClientLayer("web-auth", apiOrigin))
    );
    const client = yield* HttpApiClient.makeWith(BrowserBootstrapApi, {
      baseUrl: apiOrigin,
      httpClient: Context.get(context, HttpClient.HttpClient),
    });
    const result = yield* client.browserSession.binding({
      query: includeContext
        ? {
            context: Option.exists(request, (value) => value.transactions)
              ? "transactions"
              : "application",
          }
        : {},
    });
    const entry = yield* observeBindingReply(result);
    if (!includeContext || Option.isNone(entry.initial)) return entry;
    // Every private entry needs current-cookie proof, including an unprepared fallback.
    const latest = yield* client.browserSession.binding({ query: {} });
    return (latest.binding ?? "none") === entry.binding
      ? entry
      : yield* observeBindingReply({ ...latest, initial: Option.none() });
  }).pipe(
    Effect.provideServiceEffect(
      FetchHttpClient.Fetch,
      Option.match(request, {
        onNone: () => FetchHttpClient.Fetch,
        onSome: (initial) => Effect.succeed(initialRequestFetch(initial)),
      })
    ),
    Effect.scoped
  );

/** Read public session identity without loading User data or renewing/replacing a cookie. */
export const loadBrowserSessionBinding = ({
  apiOrigin,
}: Readonly<{ apiOrigin: string }>): Effect.Effect<string, BrowserSessionEntryFailure> =>
  loadBrowserSessionEntry({ apiOrigin, context: false, request: Option.none() }).pipe(
    Effect.map((entry) => entry.binding)
  );

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
