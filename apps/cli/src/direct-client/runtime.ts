import { ownNativeFetch } from "@fidy/server/native-http";
import {
  CanonicalAllowance,
  PATPairingApi,
  PATPairingInvalidApi,
  PATPairingPollingRateLimitedApi,
  PATPairingRateLimitedApi,
  PATPairingUnavailableApi,
  TelemetryTraceId,
  canonicalAllowanceHeaders,
  telemetryTraceHeader,
} from "@fidy/server/client";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  type HttpBody,
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { CliFailure, apiOrigin } from "../credential/contract";
import { type PairingClient, PollingDelayed } from "../login/contract";

const maximumResponseBytes = 16_384;

const noContentStatus = 204;

const resetContentStatus = 205;

const notModifiedStatus = 304;

const noBodyStatuses = new Set([noContentStatus, resetContentStatus, notModifiedStatus]);

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

  if (!noBodyStatuses.has(response.status)) {
    yield* Stream.runForEachWhile(response.stream, (chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength;

        if (size > byteLimit) return false;

        if (chunk.byteLength > 0) chunks.push(chunk);

        return true;
      })
    );
  }

  if (
    size > byteLimit ||
    (response.status >= redirectStatusMinimum && response.status < clientFailureMinimum)
  ) {
    return yield* new CliFailure({ reason: "TransportUnavailable", cause: Option.none() });
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return HttpClientResponse.fromWeb(
    response.request,
    new Response(noBodyStatuses.has(response.status) ? null : bytes, {
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

const projectTrace = (
  headers: Readonly<Record<string, string>>
): Option.Option<typeof TelemetryTraceId.Type> =>
  Schema.decodeUnknownOption(TelemetryTraceId)(headers[telemetryTraceHeader.toLowerCase()]);

const boundedBody = (body: HttpBody.HttpBody, maximumBytes: number): boolean =>
  Match.value(body).pipe(
    Match.tag("Empty", () => true),
    Match.tag("Uint8Array", (bytes) => bytes.body.byteLength <= maximumBytes),
    Match.orElse(() => false)
  );

export const protectedHttpClient = (
  options: Readonly<{
    client: HttpClient.HttpClient;
    allowQuery: boolean;
    maximumResponseBytes: number;
    maximumRequestBytes: number;
    captureRetry: (seconds: number) => void;
    captureAllowance: (allowance: Option.Option<CanonicalAllowance>) => void;
    captureTrace: (traceId: Option.Option<typeof TelemetryTraceId.Type>) => void;
  }>
): HttpClient.HttpClient.With<CliFailure | HttpClientError.HttpClientError> =>
  HttpClient.transform(options.client, (execute, request) => {
    if (!boundedBody(request.body, options.maximumRequestBytes)) {
      return Effect.fail(new CliFailure({ reason: "TransportUnavailable", cause: Option.none() }));
    }

    if (
      !validDestination(request) ||
      (!options.allowQuery &&
        (new URL(request.url).search !== "" || request.urlParams.params.length !== 0))
    ) {
      return Effect.fail(new CliFailure({ reason: "TransportUnavailable", cause: Option.none() }));
    }

    const captureMetadata = (
      response: HttpClientResponse.HttpClientResponse
    ): Effect.Effect<void> =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          options.captureAllowance(projectAllowance(response.headers));
          options.captureTrace(projectTrace(response.headers));
          const retry = retryDelay(response.headers["retry-after"], now);

          if (Option.isSome(retry)) options.captureRetry(retry.value);

          return undefined;
        })
      );

    return Effect.gen(function* () {
      const fetch = yield* FetchHttpClient.Fetch;

      return yield* execute.pipe(
        Effect.tap(captureMetadata),
        Effect.flatMap((response) => collectResponse(response, options.maximumResponseBytes)),
        Effect.mapError(
          (cause) => new CliFailure({ reason: "TransportUnavailable", cause: Option.some(cause) })
        ),
        Effect.timeoutOrElse({
          duration: requestDeadline,
          orElse: () =>
            Effect.fail(new CliFailure({ reason: "TransportUnavailable", cause: Option.none() })),
        }),
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          credentials: "omit",
        }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provideService(FetchHttpClient.Fetch, ownNativeFetch(fetch)),
        Effect.scoped
      );
    });
  });

export const protectClient = (
  client: HttpClient.HttpClient
): HttpClient.HttpClient.With<CliFailure | HttpClientError.HttpClientError> =>
  protectedHttpClient({
    client,
    allowQuery: false,
    maximumResponseBytes,
    maximumRequestBytes,
    captureRetry: () => {},
    captureAllowance: () => {},
    captureTrace: () => {},
  });

const safeStartFailure = (failure: unknown): CliFailure => {
  if (Schema.is(PATPairingInvalidApi)(failure)) {
    return new CliFailure({ reason: "PairingInvalid", cause: Option.none() });
  }

  if (Schema.is(PATPairingRateLimitedApi)(failure)) {
    return new CliFailure({ reason: "SourceLimited", cause: Option.none() });
  }

  if (Schema.is(PATPairingUnavailableApi)(failure)) {
    return new CliFailure({ reason: "DependencyUnavailable", cause: Option.none() });
  }

  return new CliFailure({ reason: "TransportUnavailable", cause: Option.none() });
};

const safeClaimFailure = (failure: unknown): CliFailure | PollingDelayed => {
  if (Schema.is(PATPairingPollingRateLimitedApi)(failure)) {
    return new PollingDelayed({ retryAfterSeconds: failure.error.retryAfterSeconds });
  }

  const closed = safeStartFailure(failure);

  return closed.reason === "TransportUnavailable"
    ? new CliFailure({ reason: "ClaimAmbiguous", cause: Option.none() })
    : closed;
};

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

export class PairingService extends Context.Service<PairingService, PairingClient>()(
  "@fidy/cli/direct-client/runtime/PairingService"
) {
  static readonly make = Effect.flatMap(HttpClient.HttpClient, makePairingClient);

  static readonly layer = Layer.effect(this, this.make);
}

export { authenticateAccess } from "./internal/operator-access";
