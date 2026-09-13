import { Function } from "effect";
import {
  Headers,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

/**
 * The closed set of HTTP client failure reason classes, keyed by the tag each class carries. A new
 * Effect reason kind fails typecheck here rather than silently escaping the guard below.
 */
const httpClientErrorReasonClasses = {
  TransportError: HttpClientError.TransportError,
  EncodeError: HttpClientError.EncodeError,
  InvalidUrlError: HttpClientError.InvalidUrlError,
  StatusCodeError: HttpClientError.StatusCodeError,
  DecodeError: HttpClientError.DecodeError,
  EmptyBodyError: HttpClientError.EmptyBodyError,
} as const satisfies Readonly<Record<HttpClientError.HttpClientErrorReason["_tag"], unknown>>;

/**
 * True only for values constructed by one of the closed set of HTTP client failure reason classes.
 * Transports that receive a bare reason (for example `RpcClient` re-wraps a response-stream failure)
 * use this before routing the value back through `projectHttpClientError`; a caller that cannot
 * recognize a cause must drop it rather than pass it through.
 */
export const isHttpClientErrorReason = (
  value: unknown
): value is HttpClientError.HttpClientErrorReason =>
  Object.values(httpClientErrorReasonClasses).some((reasonClass) => value instanceof reasonClass);

/** Selects only the named allowlisted protocol headers, never raw response headers. */
export const retainedResponseHeaders: {
  (headers: Headers.Headers, names: ReadonlyArray<string>): Headers.Headers;
  (names: ReadonlyArray<string>): (headers: Headers.Headers) => Headers.Headers;
} = Function.dual(2, (headers: Headers.Headers, names: ReadonlyArray<string>): Headers.Headers =>
  Headers.fromInput(
    Object.fromEntries(names.flatMap((name) => (name in headers ? [[name, headers[name]]] : [])))
  )
);

/** One constant failure coordinate and the allowlisted response headers a projected failure keeps. */
export type HttpClientErrorProjection = Readonly<{
  projectedRequestUrl: string;
  retainedResponseHeaders: ReadonlyArray<string>;
}>;

const projectedResponse = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
  retainedResponseHeaderNames: ReadonlyArray<string>
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(null, {
      status: response.status,
      headers: retainedResponseHeaders(response.headers, retainedResponseHeaderNames),
    })
  );

/**
 * Rebuilds an `HttpClientError` over one constant request coordinate, preserving only the closed
 * reason kind and, for response reasons, the HTTP status and the named allowlisted protocol
 * headers. A credentialed adapter projects every failure through this before it can be inspected,
 * logged, traced, or serialized, so a diagnostic can never carry the credential, an internal
 * destination, a query, a response body, or a response header outside the allowlist.
 */
export const projectHttpClientError =
  (projection: HttpClientErrorProjection) =>
  (error: HttpClientError.HttpClientError): HttpClientError.HttpClientError => {
    const request = HttpClientRequest.make(error.request.method)(projection.projectedRequestUrl);
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
            response: projectedResponse(
              request,
              reason.response,
              projection.retainedResponseHeaders
            ),
          }),
        });
      case "DecodeError":
        return new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({
            request,
            response: projectedResponse(
              request,
              reason.response,
              projection.retainedResponseHeaders
            ),
          }),
        });
      case "EmptyBodyError":
        return new HttpClientError.HttpClientError({
          reason: new HttpClientError.EmptyBodyError({
            request,
            response: projectedResponse(
              request,
              reason.response,
              projection.retainedResponseHeaders
            ),
          }),
        });
    }
  };
