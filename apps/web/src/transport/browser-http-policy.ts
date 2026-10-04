import { ResourceLimited } from "@fidy/server/client";
import { type Duration, Effect, Function, Layer, Option, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

/** Browser API boundary whose transport budget follows the sensitivity and response shape it owns. */
export type BrowserHttpBoundary = "canonical" | "enrollment" | "web-auth" | "hosted-turn";

type BrowserHttpPolicy = Readonly<{
  deadline: Duration.Input;
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
  "hosted-turn": {
    deadline: "135 seconds",
    maximumResponseBytes: canonicalResponseKibibytes * bytesPerKibibyte,
  },
};

const diagnosticsUrl = "https://browser-api.invalid";
const disableAutomaticHttpSpan = (): boolean => true;
const safeResponseHeaders = ["content-type"] as const;
const resourceLimitedStatus = 429;
const maximumResourceRetries = 6;
const maximumResourceDelaySeconds = 5;
const millisecondsPerSecond = 1_000;
const RetrySeconds = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(maximumResourceDelaySeconds)
);
const redirectStatusMinimum = 300;
const redirectStatusMaximumExclusive = 400;
const noContentStatus = 204;
const resetContentStatus = 205;
const notModifiedStatus = 304;
const responseStatusForbidsBody = (status: number): boolean =>
  status === noContentStatus || status === resetContentStatus || status === notModifiedStatus;

const diagnosticsRequest = (
  request: HttpClientRequest.HttpClientRequest
): HttpClientRequest.HttpClientRequest => HttpClientRequest.make(request.method)(diagnosticsUrl);

const projectResponseHeaders = (
  response: HttpClientResponse.HttpClientResponse
): Headers.Headers => {
  const retry = Schema.decodeUnknownOption(RetrySeconds)(response.headers["retry-after"]);
  const values: Array<readonly [string, string]> = [];
  for (const name of safeResponseHeaders) {
    const value = Option.fromUndefinedOr(response.headers[name]);
    if (Option.isSome(value)) values.push([name, value.value]);
  }
  if (Option.isSome(retry)) values.push(["retry-after", String(retry.value)]);
  return Headers.fromInput(values);
};

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
  let sanitizedReason: HttpClientError.HttpClientError["reason"];
  switch (reason._tag) {
    case "TransportError":
      sanitizedReason = new HttpClientError.TransportError({ request });
      break;
    case "EncodeError":
      sanitizedReason = new HttpClientError.EncodeError({ request });
      break;
    case "InvalidUrlError":
      sanitizedReason = new HttpClientError.InvalidUrlError({ request });
      break;
    case "StatusCodeError":
      sanitizedReason = new HttpClientError.StatusCodeError({
        request,
        response: diagnosticsResponse(request, reason.response),
      });
      break;
    case "DecodeError":
      sanitizedReason = new HttpClientError.DecodeError({
        request,
        response: diagnosticsResponse(request, reason.response),
      });
      break;
    case "EmptyBodyError":
      sanitizedReason = new HttpClientError.EmptyBodyError({
        request,
        response: diagnosticsResponse(request, reason.response),
      });
      break;
  }
  return new HttpClientError.HttpClientError({ reason: sanitizedReason });
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
    return yield* responseFailure(response.request, response, "response body too large");
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
    return yield* responseFailure(response.request, response, "response body too large");
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
  body: Uint8Array<ArrayBuffer>,
  status: number,
  headers: Headers.Headers
): Response => {
  const response = new Response(responseStatusForbidsBody(status) ? null : body, {
    status,
    headers,
  });
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

const resourceRefusalDelay = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<Option.Option<number>> =>
  Effect.gen(function* () {
    if (response.status !== resourceLimitedStatus) return Option.none();
    const seconds = Schema.decodeUnknownOption(RetrySeconds)(response.headers["retry-after"]);
    if (Option.isNone(seconds)) return Option.none();
    const body = yield* response.json.pipe(Effect.option);
    if (Option.isNone(body)) return Option.none();
    const refusal = Schema.decodeOption(Schema.toCodecJson(ResourceLimited))(body.value);
    return Option.isSome(refusal)
      ? Option.some(seconds.value * millisecondsPerSecond)
      : Option.none();
  });

/** A declared resource refusal proves non-admission, unlike a transport failure or uncertain 5xx. */
const retryResourceRefusals = (
  attempt: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
  Effect.gen(function* () {
    for (let retried = 0; retried < maximumResourceRetries; retried++) {
      const response = yield* attempt;
      const delay = yield* resourceRefusalDelay(response);
      if (Option.isNone(delay)) return response;
      yield* Effect.sleep(delay.value);
    }
    return yield* attempt;
  });

const makePolicyClient = (
  client: HttpClient.HttpClient,
  apiOrigin: string,
  boundary: BrowserHttpBoundary
): HttpClient.HttpClient => {
  const policy = browserHttpPolicies[boundary];
  return HttpClient.transform(client, (responseEffect, request) => {
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
    const admittedResponse =
      boundary === "canonical" ? retryResourceRefusals(boundedRetries) : boundedRetries;
    return admittedResponse.pipe(
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
};

/**
 * Places browser HTTP policy beneath one generated API client. `boundary` selects that API
 * surface's deadline and response-byte budget. `apiOrigin` must be a validated URL origin and is
 * the only destination the resulting client will send to. `httpClient` supplies the underlying
 * browser or test transport. Requests include browser credentials, disable caching and automatic
 * redirects, and expose only sanitized transport failures; only GET and HEAD transport failures
 * retry, once. Canonical requests can additionally retry a declared, unadmitted resource refusal
 * with bounded Retry-After pacing inside the same absolute deadline. Uncertain mutations and
 * enrollment/authentication refusals are never automatically replayed.
 */
export const browserHttpClientLayer: {
  (
    boundary: BrowserHttpBoundary,
    apiOrigin: string
  ): (httpClient: Layer.Layer<HttpClient.HttpClient>) => Layer.Layer<HttpClient.HttpClient>;
  (
    httpClient: Layer.Layer<HttpClient.HttpClient>,
    boundary: BrowserHttpBoundary,
    apiOrigin: string
  ): Layer.Layer<HttpClient.HttpClient>;
} = Function.dual(
  3,
  (
    httpClient: Layer.Layer<HttpClient.HttpClient>,
    boundary: BrowserHttpBoundary,
    apiOrigin: string
  ): Layer.Layer<HttpClient.HttpClient> =>
    Layer.effect(
      HttpClient.HttpClient,
      Effect.map(HttpClient.HttpClient, (client) => makePolicyClient(client, apiOrigin, boundary))
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
    )
);
