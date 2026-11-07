import { type InitialBrowserRequest, initialRequestFetch } from "./initial-request";
import {
  BrowserBootstrapApi,
  type BrowserSessionBinding,
  type BrowserSessionInitialContext,
} from "@fidy/server/browser-bootstrap";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { browserHttpClientLayer } from "./browser-http-policy";

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
