import { Data, Effect, ManagedRuntime, Option, Stream } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";

const maximumResponseBytes = 1_048_576;
const noContentStatus = 204;
const resetContentStatus = 205;
const notModifiedStatus = 304;
const noBodyStatuses = new Set([noContentStatus, resetContentStatus, notModifiedStatus]);
const runtime = ManagedRuntime.make(FetchHttpClient.layer);

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
      const chunks = yield* Stream.runCollect(
        response.stream.pipe(
          Stream.mapEffect((chunk) => {
            bytes += chunk.byteLength;
            return bytes <= maximumResponseBytes
              ? Effect.succeed(chunk)
              : Effect.fail(new WorkerdResponseTooLarge({ maximumBytes: maximumResponseBytes }));
          })
        )
      );
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
