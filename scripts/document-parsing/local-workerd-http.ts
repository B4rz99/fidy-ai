import { Data, Effect, Layer, ManagedRuntime, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";

const maximumResponseBytes = 1_048_576;
const noContentStatus = 204;
const resetContentStatus = 205;
const notModifiedStatus = 304;
const noBodyStatuses = new Set([noContentStatus, resetContentStatus, notModifiedStatus]);
/** Native cancellation can remain pending after the local reader is no longer owned. */
const ownResponseBody = (response: Response, signal: Option.Option<AbortSignal>): Response => {
  if (response.body === null) return response;
  const reader: Pick<
    ReadableStreamDefaultReader<unknown>,
    "read" | "cancel" | "releaseLock"
  > = response.body.getReader();
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

/** Proof tooling owns native cancellation and releases response readers locally. */
export const ProofHttpLive = HttpClient.layerMergedContext(
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

const runtime = ManagedRuntime.make(ProofHttpLive);

class WorkerdResponseTooLarge extends Data.TaggedError("WorkerdResponseTooLarge")<{
  readonly maximumBytes: number;
}> {}

type WorkerdRequest = Readonly<
  {
    readonly port: number;
    readonly path: string;
    readonly signal: AbortSignal;
  } & (
    | { readonly method: "GET" }
    | {
        readonly method: "POST";
        readonly body: string | Uint8Array;
        readonly headers: Readonly<Record<string, string>>;
      }
  )
>;

/**
 * Materializes a loopback proof response within one owned 30-second HTTP lifetime. At most
 * 1 MiB is retained; the supplied signal and deadline abort headers and unfinished bodies.
 * The returned response contains only buffered bytes and no live transport resource.
 */
const requestProof = (
  options: WorkerdRequest,
  origin: Option.Option<string> = Option.none()
): Promise<Response> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const baseUrl = Option.getOrElse(origin, () => `http://127.0.0.1:${options.port}`);
      const url = new URL(options.path, baseUrl).href;
      const request =
        options.method === "GET"
          ? HttpClientRequest.get(url)
          : HttpClientRequest.post(url).pipe(
              HttpClientRequest.setBody(HttpBody.raw(options.body)),
              HttpClientRequest.setHeaders(options.headers)
            );
      const client = yield* HttpClient.HttpClient;
      const response = yield* HttpClient.withScope(client).execute(request);
      if (noBodyStatuses.has(response.status)) {
        return new Response(null, { status: response.status, headers: response.headers });
      }
      let bytes = 0;
      const chunks: Array<Uint8Array> = [];
      yield* Stream.runForEach(response.stream, (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > maximumResponseBytes) {
          return Effect.fail(new WorkerdResponseTooLarge({ maximumBytes: maximumResponseBytes }));
        }
        if (chunk.byteLength > 0) chunks.push(chunk);
        return Effect.void;
      });
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(body, { status: response.status, headers: response.headers });
    }).pipe(
      Effect.scoped,
      Effect.timeout("30 seconds"),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
    ),
    { signal: options.signal }
  );

/** Sends a bounded loopback request to the local proof runtime. */
export const requestWorkerd = (options: WorkerdRequest): Promise<Response> => requestProof(options);

/** Sends a bounded request to the owned HTTPS Cloudflare Preview. */
export const requestHostedProof = (
  options: WorkerdRequest & Readonly<{ origin: string }>
): Promise<Response> => requestProof(options, Option.some(options.origin));

/** Releases the local-only HTTP runtime when the proof process is finished. */
export const closeWorkerdHttp = (): Promise<void> => runtime.dispose();
