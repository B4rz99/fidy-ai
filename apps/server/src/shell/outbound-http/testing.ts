import { Effect, Function, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

/** Raw request visible only to Outbound HTTP transport tests and compatibility adapter fixtures. */
export type TestOutboundTransportRequest = HttpClientRequest.HttpClientRequest;

export type TestOutboundTransport = HttpClient.HttpClient;
export type TestOutboundTransportError = HttpClientError.HttpClientError;

/** Test transport callback kept behind the Outbound HTTP owner instead of provider test modules. */
export type TestOutboundTransportHandler = (
  request: TestOutboundTransportRequest,
  signal: AbortSignal
) => Effect.Effect<Response, HttpClientError.HttpClientError>;

/** Builds the raw transport layer used only underneath a published Outbound HTTP layer in tests. */
export const testOutboundTransportLayer = (
  handler: TestOutboundTransportHandler
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, _url, signal) =>
      handler(request, signal).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response))
      )
    )
  );

export const makeTestOutboundTransport = (
  handler: (
    request: TestOutboundTransportRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, TestOutboundTransportError>
): TestOutboundTransport =>
  HttpClient.makeWith<TestOutboundTransportError, never, TestOutboundTransportError, never>(
    (request) => Effect.flatMap(request, handler),
    Effect.succeed
  );

export const testOutboundTransportResponse: {
  (
    response: Response
  ): (request: TestOutboundTransportRequest) => HttpClientResponse.HttpClientResponse;
  (
    request: TestOutboundTransportRequest,
    response: Response
  ): HttpClientResponse.HttpClientResponse;
} = Function.dual(2, (request: TestOutboundTransportRequest, response: Response) =>
  HttpClientResponse.fromWeb(request, response)
);

export const testOutboundTransportFromClientLayer = (
  transport: TestOutboundTransport
): Layer.Layer<HttpClient.HttpClient> => Layer.succeed(HttpClient.HttpClient, transport);

export const testFetchOutboundTransportLayer = FetchHttpClient.layer;
export const TestOutboundFetch = FetchHttpClient.Fetch;
