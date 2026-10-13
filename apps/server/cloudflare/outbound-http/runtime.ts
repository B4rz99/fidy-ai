import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

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
    // Start remote cancellation, but do not make local scope closure await provider code.
    reader.cancel().catch(() => undefined);
    release();
  };
  if (Option.isSome(signal)) {
    signal.value.addEventListener("abort", cancel, { once: true });
    if (signal.value.aborted) cancel();
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

/** Owner-native fetch keeps Effect's generic HTTP seam while bounding local body cleanup. */
export const outboundFetchHttpClientLayer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.effect(
      FetchHttpClient.Fetch,
      Effect.gen(function* () {
        const fetch = yield* FetchHttpClient.Fetch;
        return Object.assign(
          (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
            fetch(input, init).then((response) =>
              ownResponseBody(response, Option.fromNullishOr(init?.signal))
            ),
          { preconnect: fetch.preconnect }
        );
      })
    )
  )
);
