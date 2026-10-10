import { Context, Data, Effect, Layer, type Option, Schema } from "effect";
import { makeCliReleaseOutboundHttp } from "../../src/shell/outbound-http/operations";
import { FetchHttpClient, HttpClient } from "effect/http";

class ReleaseUnavailable extends Data.TaggedError("ReleaseUnavailable") {}
const ReleaseVersion = Schema.String.check(Schema.isPattern(/^[0-9]+\.[0-9]+\.[0-9]+\n?$/u));
const maximumBytes = 64;
const successStatus = 200;

const latestVersion = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* makeCliReleaseOutboundHttp(client)
    .readLatest()
    .pipe(Effect.mapError(() => new ReleaseUnavailable()));
  if (response.status !== successStatus || response.body.byteLength > maximumBytes) {
    return yield* new ReleaseUnavailable();
  }
  const text = new TextDecoder().decode(response.body);
  const version = yield* Schema.decodeEffect(ReleaseVersion)(text).pipe(
    Effect.mapError(() => new ReleaseUnavailable())
  );
  return new Response(`${version.trim()}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}).pipe(
  Effect.timeout("15 seconds"),
  Effect.orElseSucceed(
    () =>
      new Response("CLI release unavailable.\n", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
  )
);

/** Serves the published release pointer without credentials or Core authority; upstream failures never become versions. */
export const cliDistributionResponse = (
  request: Request
): Effect.Effect<Option.Option<Response>> => {
  if (new URL(request.url).pathname !== "/cli/latest.txt") return Effect.succeedNone;
  if (request.method !== "GET") {
    return Effect.succeedSome(new Response(null, { status: 405, headers: { allow: "GET" } }));
  }
  return Effect.gen(function* () {
    const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
    );
    return yield* latestVersion.pipe(
      Effect.asSome,
      Effect.provideService(HttpClient.HttpClient, Context.get(clients, HttpClient.HttpClient))
    );
  }).pipe(Effect.scoped);
};
