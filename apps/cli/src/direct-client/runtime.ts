import {
  CanonicalAllowance,
  PATPairingApi,
  PATPairingInvalidApi,
  PATPairingPollingRateLimitedApi,
  PATPairingRateLimitedApi,
  PATPairingUnavailableApi,
  canonicalAllowanceHeaders,
} from "@fidy/server/client";
import { Clock, DateTime, Effect, Option, Redacted, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { CliFailure, apiOrigin } from "../credential/contract";
import { type PairingClient, PollingDelayed } from "../login/contract";

const maximumResponseBytes = 16_384;
const maximumRequestBytes = 16_384;
const requestDeadline = "15 seconds";
const maximumRetrySeconds = 86_400;
const millisecondsPerSecond = 1000;
const RetrySeconds = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(maximumRetrySeconds)
);
const RetryDate = Schema.String.check(
  Schema.isPattern(
    /^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u
  )
);
const retryDelay = (header: unknown, now: number): Option.Option<number> => {
  const seconds = Schema.decodeUnknownOption(Schema.String.check(Schema.isPattern(/^[0-9]+$/u)))(
    header
  ).pipe(Option.flatMap(Schema.decodeUnknownOption(RetrySeconds)));
  if (Option.isSome(seconds)) return seconds;
  return Schema.decodeUnknownOption(RetryDate)(header).pipe(
    Option.flatMap(DateTime.make),
    Option.map((date) =>
      Math.min(
        maximumRetrySeconds,
        Math.max(0, Math.ceil((DateTime.toEpochMillis(date) - now) / millisecondsPerSecond))
      )
    )
  );
};

const collectResponse = Effect.fn(function* (
  response: HttpClientResponse.HttpClientResponse,
  byteLimit: number
) {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  yield* Stream.runForEachWhile(response.stream, (chunk) =>
    Effect.sync(() => {
      size += chunk.byteLength;
      if (size > byteLimit) return false;
      chunks.push(chunk);
      return true;
    })
  );
  if (
    size > byteLimit ||
    (response.status >= redirectStatusMinimum && response.status < clientFailureMinimum)
  ) {
    return yield* new CliFailure({ reason: "TransportUnavailable" });
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return HttpClientResponse.fromWeb(
    response.request,
    new Response(bytes, {
      status: response.status,
      headers: { "content-type": response.headers["content-type"] ?? "application/octet-stream" },
    })
  );
});
const redirectStatusMinimum = 300;
const clientFailureMinimum = 400;

const validDestination = (request: HttpClientRequest.HttpClientRequest): boolean => {
  if (!URL.canParse(request.url)) return false;
  const url = new URL(request.url);
  return url.origin === apiOrigin && url.username === "" && url.password === "" && url.hash === "";
};

const maximumAllowanceHeaderCharacters = 64;
const projectAllowance = (
  headers: Readonly<Record<string, string>>
): Option.Option<CanonicalAllowance> => {
  const header = (name: string): Option.Option<string> =>
    Schema.decodeUnknownOption(
      Schema.String.check(Schema.isMaxLength(maximumAllowanceHeaderCharacters))
    )(headers[name]);
  return Schema.decodeUnknownOption(Schema.toCodecJson(CanonicalAllowance))({
    allowance: Option.getOrUndefined(header(canonicalAllowanceHeaders.allowance)),
    limit: Option.getOrUndefined(header(canonicalAllowanceHeaders.limit)),
    remaining: Option.getOrUndefined(header(canonicalAllowanceHeaders.remaining)),
    resetsAt: Option.getOrUndefined(header(canonicalAllowanceHeaders.resetsAt)),
  });
};

/** Fixed-origin policy for derived clients. No automatic telemetry, redirects or unbounded bytes escape. */
export const makeProtectedClient = (
  options: Readonly<{
    client: HttpClient.HttpClient;
    allowQuery: boolean;
    maximumResponseBytes: number;
    maximumRequestBytes: number;
    captureRetry: (seconds: number) => void;
    captureAllowance: (allowance: Option.Option<CanonicalAllowance>) => void;
  }>
): HttpClient.HttpClient.With<CliFailure | HttpClientError.HttpClientError> =>
  HttpClient.transform(options.client, (execute, request) => {
    if (
      request.body._tag !== "Empty" &&
      (request.body._tag !== "Uint8Array" ||
        request.body.body.byteLength > options.maximumRequestBytes)
    ) {
      return Effect.fail(new CliFailure({ reason: "TransportUnavailable" }));
    }
    if (
      !validDestination(request) ||
      (!options.allowQuery &&
        (new URL(request.url).search !== "" || request.urlParams.params.length !== 0))
    ) {
      return Effect.fail(new CliFailure({ reason: "TransportUnavailable" }));
    }
    return execute.pipe(
      Effect.tap((response) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            options.captureAllowance(projectAllowance(response.headers));
            const retry = retryDelay(response.headers["retry-after"], now);
            if (Option.isSome(retry)) options.captureRetry(retry.value);
            return undefined;
          })
        )
      ),
      Effect.flatMap((response) => collectResponse(response, options.maximumResponseBytes)),
      Effect.mapError(() => new CliFailure({ reason: "TransportUnavailable" })),
      Effect.timeoutOrElse({
        duration: requestDeadline,
        orElse: () => Effect.fail(new CliFailure({ reason: "TransportUnavailable" })),
      }),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
      }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.scoped
    );
  });

/** Bootstrap policy disallows query coordinates as well as foreign origins. */
export const protectClient = (
  client: HttpClient.HttpClient
): HttpClient.HttpClient.With<CliFailure | HttpClientError.HttpClientError> =>
  makeProtectedClient({
    client,
    allowQuery: false,
    maximumResponseBytes,
    maximumRequestBytes,
    captureRetry: () => {},
    captureAllowance: () => {},
  });

const safeStartFailure = (failure: unknown): CliFailure => {
  if (Schema.is(PATPairingInvalidApi)(failure)) return new CliFailure({ reason: "PairingInvalid" });
  if (Schema.is(PATPairingRateLimitedApi)(failure)) {
    return new CliFailure({ reason: "SourceLimited" });
  }
  if (Schema.is(PATPairingUnavailableApi)(failure)) {
    return new CliFailure({ reason: "DependencyUnavailable" });
  }
  return new CliFailure({ reason: "TransportUnavailable" });
};
const safeClaimFailure = (failure: unknown): CliFailure | PollingDelayed => {
  if (Schema.is(PATPairingPollingRateLimitedApi)(failure)) {
    return new PollingDelayed({ retryAfterSeconds: failure.error.retryAfterSeconds });
  }
  const closed = safeStartFailure(failure);
  return closed.reason === "TransportUnavailable"
    ? new CliFailure({ reason: "ClaimAmbiguous" })
    : closed;
};

/** Constructs only the server-derived bootstrap client. Lost claims are never retried here. */
export const makePairingClient = Effect.fn(function* (httpClient: HttpClient.HttpClient) {
  const client = yield* HttpApiClient.makeWith(PATPairingApi, {
    httpClient: protectClient(httpClient),
    baseUrl: apiOrigin,
  });
  const pairing: PairingClient = {
    start: (request) =>
      client.patPairing.start({ payload: request }).pipe(Effect.mapError(safeStartFailure)),
    claim: (started) =>
      client.patPairing
        .claim({
          payload: {
            pairingId: started.pairingId,
            privateDeviceCode: Redacted.value(started.privateDeviceCode),
          },
        })
        .pipe(Effect.mapError(safeClaimFailure)),
  };
  return pairing;
});
