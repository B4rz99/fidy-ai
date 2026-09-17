import { Effect } from "effect";
import {
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

/** The one private Cluster runner route shared by runner ingress and egress. */
export const clusterRunnerPath = "/_fidy/cluster";

/** The credential header protected by Cluster egress and interpreted by Cluster ingress. */
export const clusterAuthorizationHeader = "authorization";

/** The constant request coordinate retained by every projected Cluster transport failure. */
export const projectedClusterRunnerRequestUrl = `http://cluster.invalid${clusterRunnerPath}`;

// Cluster deliberately owns this closed set instead of sharing the external-provider projection:
// changes to either transport's failure contract must not constrain the other transport.
const httpClientErrorReasonClasses = {
  TransportError: HttpClientError.TransportError,
  EncodeError: HttpClientError.EncodeError,
  InvalidUrlError: HttpClientError.InvalidUrlError,
  StatusCodeError: HttpClientError.StatusCodeError,
  DecodeError: HttpClientError.DecodeError,
  EmptyBodyError: HttpClientError.EmptyBodyError,
} as const satisfies Readonly<Record<HttpClientError.HttpClientErrorReason["_tag"], unknown>>;

/** True only for the closed Effect HTTP failure-reason set accepted by Cluster projection. */
export const isClusterHttpClientErrorReason = (
  value: unknown
): value is HttpClientError.HttpClientErrorReason =>
  Object.values(httpClientErrorReasonClasses).some((reasonClass) => value instanceof reasonClass);

const projectedResponse = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(request, new Response(null, { status: response.status }));

/**
 * Rebuilds a Cluster transport failure over one constant request coordinate. The failure retains
 * only its reason kind and, when a response exists, its status; request coordinates, credentials,
 * response headers, and response bodies never survive projection.
 */
export const projectClusterHttpClientError = (
  error: HttpClientError.HttpClientError
): HttpClientError.HttpClientError => {
  const request = HttpClientRequest.make(error.request.method)(projectedClusterRunnerRequestUrl);
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
          response: projectedResponse(request, reason.response),
        }),
      });
    case "DecodeError":
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.DecodeError({
          request,
          response: projectedResponse(request, reason.response),
        }),
      });
    case "EmptyBodyError":
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.EmptyBodyError({
          request,
          response: projectedResponse(request, reason.response),
        }),
      });
  }
};

/**
 * Protects a client after the caller has attached the Cluster credential. Execution extends the
 * inherited redaction set with the credential header, excludes every HTTP header from tracing,
 * disables trace propagation and automatic coordinate-bearing client spans, and maps failures to
 * the coordinate-free Cluster contract. Successful responses remain available to the RPC protocol.
 */
export const protectClusterHttpClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transform(client, (requestEffect) =>
    Effect.gen(function* () {
      const inheritedRedactions = yield* Headers.CurrentRedactedNames;
      return yield* requestEffect.pipe(
        Effect.provideService(Headers.CurrentRedactedNames, [
          ...inheritedRedactions,
          clusterAuthorizationHeader,
        ]),
        Effect.provideService(HttpClient.TracerHeaderFilter, () => false),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(projectClusterHttpClientError)
      );
    })
  );
