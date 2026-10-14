import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

const noContentStatus = 204;
const resetContentStatus = 205;
const notModifiedStatus = 304;
const noBodyStatuses = new Set([noContentStatus, resetContentStatus, notModifiedStatus]);

/** Native cancellation can remain pending after the local reader is no longer owned. */
const ownResponseBody = (response: Response, signal: Option.Option<AbortSignal>): Response => {
  if (response.body === null) return response;
  const reader: ReadableStreamDefaultReader<unknown> = response.body.getReader();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (Option.isSome(signal)) signal.value.removeEventListener("abort", cancel);
    reader.releaseLock();
  };
  const cancel = (): void => {
    if (released) return;
    reader.cancel().catch(() => undefined);
    release();
  };
  if (Option.isSome(signal)) {
    signal.value.addEventListener("abort", cancel, { once: true });
    if (signal.value.aborted) cancel();
  }
  if (noBodyStatuses.has(response.status)) {
    cancel();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller): Promise<void> =>
        reader
          .read()
          .then((chunk) => {
            if (released) return;
            if (chunk.done) {
              release();
              controller.close();
            } else {
              controller.enqueue(Schema.decodeUnknownSync(Schema.Uint8Array)(chunk.value));
            }
          })
          .catch((error: unknown) => {
            if (released) return;
            cancel();
            controller.error(error);
          }),
      cancel,
    },
    { highWaterMark: 0 }
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const ownedNativeFetch = (native: typeof fetch): typeof fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      native(input, init).then((value) =>
        ownResponseBody(value, Option.fromNullishOr(init?.signal))
      ),
    { preconnect: native.preconnect }
  );

/** Release tooling owns native response cleanup without waiting for remote cancellation. */
export const ReleaseHttpLive = HttpClient.layerMergedContext(
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.transformResponse(client, (response) =>
      Effect.gen(function* () {
        const native = yield* FetchHttpClient.Fetch;
        return yield* response.pipe(
          Effect.provideService(FetchHttpClient.Fetch, ownedNativeFetch(native))
        );
      })
    )
  )
).pipe(Layer.provide(FetchHttpClient.layer));
