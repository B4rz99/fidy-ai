import { Effect, Layer, Stream } from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

/** Browser API boundary whose transport budget follows the sensitivity and response shape it owns. */
export type BrowserHttpBoundary = "canonical" | "enrollment" | "web-auth";

type BrowserHttpPolicy = Readonly<{
  deadline: string;
  maximumResponseBytes: number;
}>;

const bytesPerKibibyte = 1_024;
const canonicalResponseKibibytes = 1_024;
const webAuthResponseKibibytes = 64;
const enrollmentResponseKibibytes = 256;
const browserHttpPolicies: Readonly<Record<BrowserHttpBoundary, BrowserHttpPolicy>> = {
  canonical: {
    deadline: "15 seconds",
    maximumResponseBytes: canonicalResponseKibibytes * bytesPerKibibyte,
  },
  "web-auth": {
    deadline: "10 seconds",
    maximumResponseBytes: webAuthResponseKibibytes * bytesPerKibibyte,
  },
  enrollment: {
    deadline: "20 seconds",
    maximumResponseBytes: enrollmentResponseKibibytes * bytesPerKibibyte,
  },
};

const diagnosticsUrl = "https://browser-api.invalid";
const disableAutomaticHttpSpan = (): boolean => true;
const safeResponseHeaders = ["content-type"] as const;
const redirectStatusMinimum = 300;
const redirectStatusMaximumExclusive = 400;

const diagnosticsRequest = (
  request: HttpClientRequest.HttpClientRequest
): HttpClientRequest.HttpClientRequest => HttpClientRequest.make(request.method)(diagnosticsUrl);

const projectResponseHeaders = (response: HttpClientResponse.HttpClientResponse): Headers.Headers =>
  Headers.fromInput(
    Object.fromEntries(
      safeResponseHeaders.flatMap((name) =>
        name in response.headers ? [[name, response.headers[name]]] : []
      )
    )
  );

const diagnosticsResponse = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    diagnosticsRequest(request),
    new Response(null, {
      status: response.status,
      headers: projectResponseHeaders(response),
    })
  );

const sanitizeHttpClientError = (
  error: HttpClientError.HttpClientError
): HttpClientError.HttpClientError => {
  const request = diagnosticsRequest(error.request);
  const reason = error.reason;
  switch (reason._tag) {
    case "TransportError":
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request }),
      });
    case "EncodeError":
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.EncodeError({ request }),
      });
    case "InvalidUrlError":
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.InvalidUrlError({ request }),
      });
    case "StatusCodeError":
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.StatusCodeError({
          request,
          response: diagnosticsResponse(request, reason.response),
        }),
      });
    case "DecodeError":
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.DecodeError({
          request,
          response: diagnosticsResponse(request, reason.response),
        }),
      });
    case "EmptyBodyError":
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.EmptyBodyError({
          request,
          response: diagnosticsResponse(request, reason.response),
        }),
      });
  }
};

const requestFailure = (
  request: HttpClientRequest.HttpClientRequest,
  description: string
): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: diagnosticsRequest(request),
      description,
    }),
  });

const responseFailure = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
  description: string
): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.DecodeError({
      request: diagnosticsRequest(request),
      response: diagnosticsResponse(request, response),
      description,
    }),
  });

const collectBoundedBytes = Effect.fn(function* (
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes: number
) {
  const declaredLength = Number(response.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    yield* Effect.scoped(Stream.toPull(response.stream).pipe(Effect.asVoid));
    return yield* Effect.fail(
      responseFailure(response.request, response, "response body too large")
    );
  }

  const chunks: Array<Uint8Array> = [];
  let byteLength = 0;
  yield* Stream.runForEachWhile(response.stream, (chunk) =>
    Effect.sync(() => {
      if (byteLength + chunk.byteLength > maximumBytes) {
        byteLength = maximumBytes + 1;
        return false;
      }
      chunks.push(chunk);
      byteLength += chunk.byteLength;
      return true;
    })
  ).pipe(
    Effect.catchIf(
      (error: HttpClientError.HttpClientError) => error.reason._tag === "EmptyBodyError",
      () => Effect.void
    )
  );

  if (byteLength > maximumBytes) {
    return yield* Effect.fail(
      responseFailure(response.request, response, "response body too large")
    );
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});

const boundedWebResponse = (
  body: Uint8Array,
  status: number,
  headers: Headers.Headers
): Response => {
  const response = new Response(body, { status, headers });
  // Expose the exact bounded bytes as an ArrayBuffer from the active browser realm. Besides
  // avoiding another implementation-defined body conversion, this keeps jsdom's realm check
  // equivalent to a real browser response.
  if (typeof window !== "undefined") {
    const realmBody = new window.Uint8Array(body.byteLength);
    realmBody.set(body);
    Object.defineProperty(response, "arrayBuffer", {
      value: () => Promise.resolve(realmBody.buffer),
    });
  }
  return response;
};

const materializeResponse = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes: number
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => {
  if (
    response.status >= redirectStatusMinimum &&
    response.status < redirectStatusMaximumExclusive
  ) {
    return Effect.fail(responseFailure(request, response, "redirect response refused"));
  }
  return collectBoundedBytes(response, maximumBytes).pipe(
    Effect.map((body) =>
      HttpClientResponse.fromWeb(
        diagnosticsRequest(request),
        boundedWebResponse(body, response.status, projectResponseHeaders(response))
      )
    ),
    Effect.mapError(sanitizeHttpClientError)
  );
};

const isSafeRetryRequest = (request: HttpClientRequest.HttpClientRequest): boolean =>
  request.method === "GET" || request.method === "HEAD";

const isRetryableTransportFailure = (error: HttpClientError.HttpClientError): boolean =>
  error.reason._tag === "TransportError";

const makePolicyClient = (
  client: HttpClient.HttpClient,
  apiOrigin: string,
  policy: BrowserHttpPolicy
): HttpClient.HttpClient =>
  HttpClient.transform(client, (responseEffect, request) => {
    let destination: URL;
    try {
      destination = new URL(request.url);
    } catch {
      return Effect.fail(requestFailure(request, "request destination invalid"));
    }
    if (destination.origin !== apiOrigin) {
      return Effect.fail(requestFailure(request, "request destination origin refused"));
    }

    const attempt = responseEffect.pipe(
      Effect.mapError(sanitizeHttpClientError),
      Effect.flatMap((response) =>
        materializeResponse(request, response, policy.maximumResponseBytes)
      )
    );
    const boundedRetries = isSafeRetryRequest(request)
      ? attempt.pipe(Effect.retry({ times: 1, while: isRetryableTransportFailure }))
      : attempt;
    return boundedRetries.pipe(
      Effect.timeoutOrElse({
        duration: policy.deadline,
        orElse: () => Effect.fail(requestFailure(request, "browser request deadline exceeded")),
      }),
      // The browser has no telemetry exporter; AsyncResult owns safe defect presentation. Suppress
      // Effect's URL/header span instead of creating a second, credential-bearing diagnostic path.
      Effect.provideService(HttpClient.TracerDisabledWhen, disableAutomaticHttpSpan),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false)
    );
  });

/**
 * Places the browser's destination, deadline, redirect, response-byte, retry, credential, and
 * diagnostic policy beneath one generated API client. Only GET and HEAD transport failures retry,
 * once; mutations and response/decode failures are never replayed.
 */
export const browserHttpClientLayer = (
  boundary: BrowserHttpBoundary,
  apiOrigin: string,
  httpClient: Layer.Layer<HttpClient.HttpClient>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      makePolicyClient(client, apiOrigin, browserHttpPolicies[boundary])
    )
  ).pipe(
    Layer.provide(
      httpClient.pipe(
        Layer.provide(
          Layer.succeed(FetchHttpClient.RequestInit, {
            credentials: "include",
            redirect: "manual",
            cache: "no-store",
          })
        )
      )
    )
  );
