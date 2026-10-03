import {
  PATPairingApi,
  PATPairingInvalidApi,
  PATPairingPollingRateLimitedApi,
  PATPairingRateLimitedApi,
  PATPairingUnavailableApi,
} from "@fidy/server/client";
import { Effect, Redacted, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { CliFailure, apiOrigin } from "../credential/contract";
import { type PairingClient, PollingDelayed } from "../login/contract";

const maximumResponseBytes = 16_384;
const maximumRequestBytes = 16_384;
const requestDeadline = "15 seconds";

const collectResponse = Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  yield* Stream.runForEachWhile(response.stream, (chunk) =>
    Effect.sync(() => {
      size += chunk.byteLength;
      if (size > maximumResponseBytes) return false;
      chunks.push(chunk);
      return true;
    })
  );
  if (
    size > maximumResponseBytes ||
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
      headers: { "content-type": "application/json" },
    })
  );
});
const redirectStatusMinimum = 300;
const clientFailureMinimum = 400;

const validDestination = (request: HttpClientRequest.HttpClientRequest): boolean => {
  if (!URL.canParse(request.url)) return false;
  const url = new URL(request.url);
  return (
    url.origin === apiOrigin &&
    url.search === "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    request.urlParams.params.length === 0
  );
};

/** Fixed-origin policy for derived clients. No automatic telemetry, redirects or unbounded bytes escape. */
export const protectClient = (
  client: HttpClient.HttpClient
): HttpClient.HttpClient.With<CliFailure | HttpClientError.HttpClientError> =>
  HttpClient.transform(client, (execute, request) => {
    if (
      request.body._tag !== "Empty" &&
      (request.body._tag !== "Uint8Array" || request.body.body.byteLength > maximumRequestBytes)
    ) {
      return Effect.fail(new CliFailure({ reason: "TransportUnavailable" }));
    }
    if (!validDestination(request)) {
      return Effect.fail(new CliFailure({ reason: "TransportUnavailable" }));
    }
    return execute.pipe(
      Effect.flatMap(collectResponse),
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
