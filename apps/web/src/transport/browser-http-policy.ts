import {
  ResourceLimited,
  TelemetryTraceId,
  connectionBrowserPaths,
  telemetryTraceHeader,
} from "@fidy/server/browser-bootstrap";
import {
  Cause,
  Clock,
  Console,
  type Duration,
  Effect,
  Exit,
  Function,
  Layer,
  Option,
  Schema,
  type Scope,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { ownBrowserResponse } from "./browser-response-lifetime";

const ownBrowserFetch = (nativeFetch: typeof globalThis.fetch): typeof globalThis.fetch =>
  Object.assign(
    (
      input: Parameters<typeof nativeFetch>[0],
      init?: Parameters<typeof nativeFetch>[1]
    ): Promise<Response> =>
      nativeFetch(input, init).then((response) =>
        ownBrowserResponse({ response, signal: Option.fromNullishOr(init?.signal) })
      ),
    nativeFetch
  );

const ownNativeResponses = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transformResponse(client, (response) =>
    Effect.flatMap(FetchHttpClient.Fetch, (nativeFetch) =>
      response.pipe(Effect.provideService(FetchHttpClient.Fetch, ownBrowserFetch(nativeFetch)))
    )
  );

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
const traceResponseHeader = telemetryTraceHeader.toLowerCase();
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
  const trace = Schema.decodeUnknownOption(TelemetryTraceId)(response.headers[traceResponseHeader]);
  if (Option.isSome(trace)) values.push([telemetryTraceHeader, trace.value]);
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
      if (chunk.byteLength > 0) chunks.push(chunk);
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
  // Use the active realm’s ArrayBuffer so jsdom accepts the reconstructed browser response.
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

const maximumDiagnosticMilliseconds = 86_400_000;
const maximumDiagnosticAttempts = 14;
type TransportObservation = {
  attempts: number;
  traceId: Option.Option<typeof TelemetryTraceId.Type>;
  statusClass: Option.Option<"2xx" | "3xx" | "4xx" | "5xx">;
  deadlineExceeded: boolean;
};

type TransportExit = Exit.Exit<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError
>;
const firstFailureStatus = 400;
const firstServerFailureStatus = 500;
const firstSuccessStatus = 200;

const transportOutcome = (
  exit: TransportExit
): "succeeded" | "rejected" | "failed" | "interrupted" => {
  if (Exit.isFailure(exit)) return Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed";
  if (exit.value.status >= firstServerFailureStatus) return "failed";
  return exit.value.status >= firstFailureStatus ? "rejected" : "succeeded";
};

const responseStatusClass = (status: number): TransportObservation["statusClass"] => {
  if (status >= firstServerFailureStatus) return Option.some("5xx");
  if (status >= firstFailureStatus) return Option.some("4xx");
  if (status >= redirectStatusMinimum) return Option.some("3xx");
  return status >= firstSuccessStatus ? Option.some("2xx") : Option.none();
};

const observeResponse = (
  observation: TransportObservation,
  response: HttpClientResponse.HttpClientResponse
): void => {
  observation.traceId = Schema.decodeUnknownOption(TelemetryTraceId)(
    response.headers[traceResponseHeader]
  );
  observation.statusClass = responseStatusClass(response.status);
};

const diagnosticError = (
  observation: TransportObservation,
  exit: TransportExit
): Readonly<{ error: string }> | Readonly<Record<never, never>> => {
  if (observation.deadlineExceeded) return { error: "timeout" };
  if (Exit.isSuccess(exit) || Cause.hasInterrupts(exit.cause)) return {};
  const failure = Cause.findErrorOption(exit.cause);
  return Option.isSome(failure)
    ? { error: failure.value.reason._tag }
    : { error: "unexpected_defect" };
};

const exportTransportDiagnostic = ({
  boundary,
  observation,
  durationMilliseconds,
  exit,
}: Readonly<{
  boundary: BrowserHttpBoundary;
  observation: TransportObservation;
  durationMilliseconds: number;
  exit: TransportExit;
}>): void => {
  const record = {
    component: "browser",
    operation: "browser.transport",
    boundary,
    outcome: transportOutcome(exit),
    attempts: Math.min(maximumDiagnosticAttempts, observation.attempts),
    durationMilliseconds: Math.min(
      maximumDiagnosticMilliseconds,
      Math.max(0, Math.floor(durationMilliseconds))
    ),
    ...(Option.isSome(observation.traceId) ? { traceId: observation.traceId.value } : {}),
    ...(Option.isSome(observation.statusClass)
      ? { statusClass: observation.statusClass.value }
      : {}),
    ...diagnosticError(observation, exit),
  };
  try {
    Effect.runSync(Console.info("fidy.browser.transport", record));
  } catch {}
};

type PolicyExecution = Readonly<{
  client: HttpClient.HttpClient.With<HttpClientError.HttpClientError, Scope.Scope>;
  apiOrigin: string;
  boundary: BrowserHttpBoundary;
  observation: TransportObservation;
}>;

const canRetryResourceRefusal = (
  boundary: BrowserHttpBoundary,
  request: HttpClientRequest.HttpClientRequest,
  continuation: boolean
): boolean =>
  boundary === "canonical" ||
  continuation ||
  (boundary === "web-auth" && isSafeRetryRequest(request));

const executePolicyRequest = (
  request: HttpClientRequest.HttpClientRequest,
  execution: PolicyExecution
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => {
  let destination: URL;
  try {
    destination = new URL(request.url);
  } catch {
    return Effect.fail(requestFailure(request, "request destination invalid"));
  }
  if (destination.origin !== execution.apiOrigin) {
    return Effect.fail(requestFailure(request, "request destination origin refused"));
  }
  const continuation =
    execution.boundary === "web-auth" &&
    Object.values(connectionBrowserPaths).some((path) => path === destination.pathname);
  const policy = browserHttpPolicies[execution.boundary];
  const deadline = continuation ? "35 seconds" : policy.deadline;
  const attempt = Effect.suspend(() => {
    execution.observation.attempts++;
    return execution.client.postprocess(Effect.succeed(request));
  }).pipe(
    Effect.tap((response) => Effect.sync(() => observeResponse(execution.observation, response))),
    Effect.mapError(sanitizeHttpClientError),
    Effect.flatMap((response) =>
      materializeResponse(request, response, policy.maximumResponseBytes)
    ),
    Effect.scoped
  );
  const boundedRetries = isSafeRetryRequest(request)
    ? attempt.pipe(Effect.retry({ times: 1, while: isRetryableTransportFailure }))
    : attempt;
  const admittedResponse = canRetryResourceRefusal(execution.boundary, request, continuation)
    ? retryResourceRefusals(boundedRetries)
    : boundedRetries;
  return admittedResponse.pipe(
    Effect.timeoutOrElse({
      duration: deadline,
      orElse: () => {
        execution.observation.deadlineExceeded = true;
        return Effect.fail(requestFailure(request, "browser request deadline exceeded"));
      },
    }),
    Effect.provideService(HttpClient.TracerDisabledWhen, disableAutomaticHttpSpan),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false)
  );
};

const finishDiagnostic =
  (
    options: Readonly<{
      startedAt: number;
      boundary: BrowserHttpBoundary;
      observation: TransportObservation;
    }>
  ): ((exit: TransportExit) => Effect.Effect<void>) =>
  (exit) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((finishedAt) =>
        exportTransportDiagnostic({
          boundary: options.boundary,
          observation: options.observation,
          durationMilliseconds: finishedAt - options.startedAt,
          exit,
        })
      )
    );

const makePolicyClient = (
  client: HttpClient.HttpClient,
  apiOrigin: string,
  boundary: BrowserHttpBoundary
): HttpClient.HttpClient => {
  const scopedClient = HttpClient.withScope(client);
  return HttpClient.makeWith(
    (requestEffect) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const observation: TransportObservation = {
          attempts: 0,
          traceId: Option.none(),
          statusClass: Option.none(),
          deadlineExceeded: false,
        };
        const execution = { client: scopedClient, apiOrigin, boundary, observation };
        return yield* Effect.flatMap(requestEffect, (request) =>
          executePolicyRequest(request, execution)
        ).pipe(Effect.onExit(finishDiagnostic({ startedAt, boundary, observation })));
      }),
    client.preprocess
  );
};

/**
 * Places browser HTTP policy beneath one generated API client. `boundary` selects that API
 * surface's deadline and response-byte budget. `apiOrigin` must be a validated URL origin and is
 * the only destination the resulting client will send to. `httpClient` supplies the underlying
 * browser or test transport. Requests include browser credentials, disable caching and automatic
 * redirects, and expose only sanitized transport failures; only GET and HEAD transport failures
 * retry, once. Canonical requests and safe web-auth reads can additionally retry a declared, unadmitted resource refusal
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
    HttpClient.layerMergedContext(
      Effect.map(HttpClient.HttpClient, (client) =>
        makePolicyClient(ownNativeResponses(client), apiOrigin, boundary)
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
    )
);
