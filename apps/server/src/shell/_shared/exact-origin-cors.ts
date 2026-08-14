import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

const forbidden = HttpServerResponse.empty({
  status: 403,
  headers: {
    "cache-control": "no-store",
    vary: "Origin",
  },
});
const allowedRequestHeaders = ["authorization", "content-type"] as const;
const allowedRequestHeaderSet = new Set<string>(allowedRequestHeaders);

const mergeVary = (current: Option.Option<string>, required: ReadonlyArray<string>): string => {
  const fields = [...Option.getOrElse(current, () => "").split(","), ...required]
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  if (fields.includes("*")) return "*";
  return Array.from(new Map(fields.map((field) => [field.toLowerCase(), field])).values()).join(
    ", "
  );
};

const requestedHeadersAreAllowed = (header: Option.Option<string>): boolean => {
  if (Option.isNone(header) || header.value.trim().length === 0) return true;
  return header.value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .every((name) => name.length > 0 && allowedRequestHeaderSet.has(name));
};

const acceptedResponse = (
  response: HttpServerResponse.HttpServerResponse,
  origin: string
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeaders(response, {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: mergeVary(Option.fromUndefinedOr(response.headers.vary), ["Origin"]),
  });

const acceptedPreflight = (
  origin: string,
  allowedMethods: ReadonlyArray<string>
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": allowedMethods.join(", "),
      "access-control-allow-headers": allowedRequestHeaders.join(", "),
      vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    },
  });

const preflightIsAllowed = (
  request: HttpServerRequest.HttpServerRequest,
  allowedMethods: ReadonlySet<string>
): boolean => {
  const method = request.headers["access-control-request-method"];
  return (
    method !== undefined &&
    allowedMethods.has(method.toUpperCase()) &&
    requestedHeadersAreAllowed(
      Option.fromUndefinedOr(request.headers["access-control-request-headers"])
    )
  );
};

type ExactOriginCors = <E, R>(
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
>;

/**
 * Builds global browser-boundary middleware for one validated `allowedOrigin`.
 * Requests without Origin pass through without CORS headers; every other origin
 * is rejected before route behavior. Exact-origin requests receive credentialed
 * headers, while OPTIONS requests additionally require one of `methods` and
 * only the fixed authorization/content-type header set. The middleware has no
 * external side effects and represents rejected requests as HTTP 403 responses.
 */
export const makeExactOriginCors = ({
  allowedOrigin,
  methods,
}: {
  readonly allowedOrigin: string;
  readonly methods: ReadonlyArray<string>;
}): ExactOriginCors => {
  const allowedMethods = new Set(methods);
  return (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const origin = request.headers.origin;
      if (origin === undefined) return yield* httpEffect;
      if (origin !== allowedOrigin) return forbidden;
      if (request.method !== "OPTIONS") {
        return yield* Effect.map(httpEffect, (response) => acceptedResponse(response, origin));
      }
      return preflightIsAllowed(request, allowedMethods)
        ? acceptedPreflight(origin, methods)
        : forbidden;
    });
};
