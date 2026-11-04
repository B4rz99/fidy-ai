import { captureRecoveryNativeObserver } from "../recovery-lifecycle/operations";
import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

const noContentStatus = 204;
const resetContentStatus = 205;
const notModifiedStatus = 304;
const noBodyStatuses = new Set([noContentStatus, resetContentStatus, notModifiedStatus]);

/** Native cancellation can remain pending after the local reader is no longer owned. */
type Observe = ReturnType<typeof captureRecoveryNativeObserver>;

type BodyOwnership = Readonly<{
  response: Response;
  signal: Option.Option<AbortSignal>;
  observe: Observe;
}>;
const ownResponseBody = ({ response, signal, observe }: BodyOwnership): Response => {
  if (response.body === null) return response;
  const reader: ReadableStreamDefaultReader<unknown> = response.body.getReader();
  const settled = Promise.withResolvers<void>();
  observe(() => settled.promise).catch(() => undefined);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (Option.isSome(signal)) signal.value.removeEventListener("abort", cancel);
    reader.releaseLock();
  };
  const cancel = (): void => {
    if (released) return;
    observe(() => reader.cancel()).then(settled.resolve, settled.reject);
    release();
  };
  if (Option.isSome(signal)) {
    signal.value.addEventListener("abort", cancel, { once: true });
    if (signal.value.aborted) cancel();
  }
  if (noBodyStatuses.has(response.status)) {
    cancel();
    return new Response(null, response);
  }
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller): Promise<void> => {
        if (released) {
          controller.close();
          return Promise.resolve();
        }
        return observe(() => reader.read())
          .then((chunk) => {
            if (released) return;
            if (chunk.done) {
              release();
              settled.resolve();
              controller.close();
            } else {
              controller.enqueue(Schema.decodeUnknownSync(Schema.Uint8Array)(chunk.value));
            }
          })
          .catch((error: unknown) => {
            if (released) return;
            cancel();
            controller.error(error);
          });
      },
      cancel,
    },
    { highWaterMark: 0 }
  );
  return new Response(body, response);
};

const ownedNativeFetch = (native: typeof fetch): typeof fetch => {
  const observe = captureRecoveryNativeObserver();
  return Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      observe(() =>
        native(input, init).then((response) =>
          ownResponseBody({ response, signal: Option.fromNullishOr(init?.signal), observe })
        )
      ),
    { preconnect: native.preconnect }
  );
};

/** Resolve the caller's native transport for every request while retaining local body ownership. */
export const OutboundHttpLive = HttpClient.layerMergedContext(
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
