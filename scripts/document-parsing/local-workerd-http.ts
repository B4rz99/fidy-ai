import { Data, Effect, ManagedRuntime, Stream } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

const maximumResponseBytes = Number("1048576");
const noBodyStatuses = new Set([Number("204"), Number("205"), Number("304")]);
const runtime = ManagedRuntime.make(FetchHttpClient.layer);

class WorkerdResponseTooLarge extends Data.TaggedError("WorkerdResponseTooLarge")<{
  readonly maximumBytes: number;
}> {}

class WorkerdRequestInterrupted extends Data.TaggedError("WorkerdRequestInterrupted") {}
type WorkerdRequest = Readonly<
  { readonly port: number; readonly path: string; readonly signal: AbortSignal } & (
    | { readonly method: "GET" }
    | {
        readonly method: "POST";
        readonly body: string | Uint8Array;
        readonly headers: Readonly<Record<string, string>>;
      }
  )
>;

/**
 * Sends a loopback proof request without tracing its potentially secret headers. The caller
 * owns the returned response body and must consume or cancel it; streaming is capped at 1 MiB,
 * and the supplied signal aborts both the pending request and any later body read.
 */
export const requestWorkerd = (options: WorkerdRequest): Promise<Response> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const url = `http://127.0.0.1:${options.port}${options.path}`;
      const request =
        options.method === "GET"
          ? HttpClientRequest.get(url)
          : HttpClientRequest.post(url).pipe(
              HttpClientRequest.setBody(HttpBody.raw(options.body)),
              HttpClientRequest.setHeaders(options.headers)
            );
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(request);
      if (noBodyStatuses.has(response.status)) {
        return new Response(null, { status: response.status, headers: response.headers });
      }
      const interrupted = Effect.callback<never, WorkerdRequestInterrupted>((resume) => {
        const abort = (): void => resume(Effect.fail(new WorkerdRequestInterrupted()));
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
        return Effect.sync(() => options.signal.removeEventListener("abort", abort));
      });
      let bytes = 0;
      const stream = response.stream.pipe(
        Stream.interruptWhen(interrupted),
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength;
          return bytes <= maximumResponseBytes
            ? Effect.succeed(chunk)
            : Effect.fail(new WorkerdResponseTooLarge({ maximumBytes: maximumResponseBytes }));
        })
      );
      return new Response(Stream.toReadableStream(stream, { strategy: { highWaterMark: 0 } }), {
        status: response.status,
        headers: response.headers,
      });
    }).pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true)),
    { signal: options.signal }
  );

/** Releases the local-only HTTP runtime when the proof process is finished. */
export const closeWorkerdHttp = (): Promise<void> => runtime.dispose();
