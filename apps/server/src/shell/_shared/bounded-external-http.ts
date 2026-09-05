import { Cause, Data, Effect, Exit, Layer, Option, Stream } from "effect";
import {
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  projectExternalHttpOutcome,
  projectExternalHttpRequest,
  projectExternalHttpResponse,
} from "~/shell/observability/projectors";
import type { TelemetryCode } from "~/shell/observability/registry";
import { collectBoundedBytes } from "./bounded-bytes";

/** External providers reached by production Effect HTTP clients. */
export type ExternalHttpProvider = TelemetryCode<"provider">;

type ExternalHttpPolicy = Readonly<{
  /** Whether Fidy trace coordinates may cross this provider boundary. */
  propagateTrace: boolean;
  /** Provider-specific credential and request-identity headers protected in addition to defaults. */
  redactedHeaders: ReadonlyArray<string>;
  /** Response headers the owning adapter needs for provider protocol decisions. */
  retainedResponseHeaders: ReadonlyArray<string>;
}>;

const excludeHttpHeaders = (): boolean => false;
const suppressAutomaticHttpSpan = (): boolean => true;
const externalRequestSpan = "provider.request";

const annotateResponse = (response: { readonly status: number }): Effect.Effect<void> =>
  Effect.annotateCurrentSpan(projectExternalHttpResponse(response.status));

const annotateTransportOutcome = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) {
    return Effect.annotateCurrentSpan(projectExternalHttpOutcome("response"));
  }
  return Effect.annotateCurrentSpan(
    projectExternalHttpOutcome(Cause.hasInterrupts(exit.cause) ? "interrupted" : "failure")
  );
};

const sanitizedRequestUrl = "https://external.invalid";

const sanitizedResponse = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(request, new Response(null, { status: response.status }));

const sanitizeHttpClientError = (
  error: HttpClientError.HttpClientError
): HttpClientError.HttpClientError => {
  const request = HttpClientRequest.make(error.request.method)(sanitizedRequestUrl);
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
          response: sanitizedResponse(request, reason.response),
        }),
      });
    case "DecodeError":
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.DecodeError({
          request,
          response: sanitizedResponse(request, reason.response),
        }),
      });
    case "EmptyBodyError":
      return new HttpClientError.HttpClientError({
        reason: new HttpClientError.EmptyBodyError({
          request,
          response: sanitizedResponse(request, reason.response),
        }),
      });
  }
};

const externalHttpPolicies: Readonly<Record<ExternalHttpProvider, ExternalHttpPolicy>> = {
  "cloudflare-access": {
    propagateTrace: false,
    redactedHeaders: ["cf-access-token"],
    retainedResponseHeaders: [],
  },
  kapso: {
    propagateTrace: false,
    redactedHeaders: ["x-api-key"],
    retainedResponseHeaders: [],
  },
  openai: {
    propagateTrace: false,
    redactedHeaders: ["authorization", "openai-organization", "openai-project"],
    retainedResponseHeaders: [],
  },
  resend: {
    propagateTrace: false,
    redactedHeaders: ["authorization", "idempotency-key"],
    retainedResponseHeaders: [],
  },
  sentry: {
    propagateTrace: false,
    redactedHeaders: ["authorization"],
    retainedResponseHeaders: ["link"],
  },
  wompi: {
    propagateTrace: false,
    redactedHeaders: ["authorization"],
    retainedResponseHeaders: [],
  },
};

const makeProtectedHttpClient =
  (provider: ExternalHttpProvider) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient => {
    const policy = externalHttpPolicies[provider];
    return HttpClient.transform(client, (requestEffect) =>
      Effect.gen(function* () {
        const inheritedRedactions = yield* Headers.CurrentRedactedNames;
        return yield* requestEffect.pipe(
          Effect.provideService(Headers.CurrentRedactedNames, [
            ...inheritedRedactions,
            ...policy.redactedHeaders,
          ]),
          Effect.provideService(HttpClient.TracerHeaderFilter, excludeHttpHeaders),
          Effect.provideService(HttpClient.TracerPropagationEnabled, policy.propagateTrace),
          Effect.provideService(HttpClient.TracerDisabledWhen, suppressAutomaticHttpSpan),
          Effect.mapError(sanitizeHttpClientError)
        );
      })
    );
  };

const collectBoundedResponseBytes = Effect.fn(function* (
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes: number
) {
  const declaredLength = Number(response.headers["content-length"] ?? 0);
  const read =
    declaredLength > maximumBytes
      ? Effect.scoped(Stream.toPull(response.stream).pipe(Effect.as(Option.none<Uint8Array>())))
      : collectBoundedBytes(response.stream, maximumBytes);
  return yield* read.pipe(
    Effect.catchIf(
      (error: HttpClientError.HttpClientError) => error.reason._tag === "EmptyBodyError",
      () => Effect.succeed(Option.some<Uint8Array>(new Uint8Array(0)))
    )
  );
});

type ExternalHttpFailureReason = "response-body-failed" | "response-too-large" | "transport-failed";

/** Closed coordinate-free failure from bounded provider transport. */
export class ExternalHttpFailure extends Data.TaggedError("ExternalHttpFailure")<{
  reason: ExternalHttpFailureReason;
  responseStatus: Option.Option<number>;
}> {}

/** Provider response whose body has already proved its configured byte bound. */
export type BoundedExternalHttpResponse = Readonly<{
  status: number;
  headers: Headers.Headers;
  body: Uint8Array;
}>;

/** Ordinary provider transport that never exposes a raw response body or stream. */
export type BoundedExternalHttpClient = Readonly<{
  execute: (
    request: HttpClientRequest.HttpClientRequest,
    maximumResponseBytes: number
  ) => Effect.Effect<BoundedExternalHttpResponse, ExternalHttpFailure>;
}>;

const failureResponseStatus = (error: HttpClientError.HttpClientError): Option.Option<number> => {
  switch (error.reason._tag) {
    case "StatusCodeError":
    case "DecodeError":
    case "EmptyBodyError":
      return Option.some(error.reason.response.status);
    case "TransportError":
    case "EncodeError":
    case "InvalidUrlError":
      return Option.none();
  }
};

const retainedHeaders = (
  response: HttpClientResponse.HttpClientResponse,
  names: ReadonlyArray<string>
): Headers.Headers =>
  Headers.fromInput(
    Object.fromEntries(
      names.flatMap((name) => (name in response.headers ? [[name, response.headers[name]]] : []))
    )
  );

const materializeBoundedResponse = (
  response: HttpClientResponse.HttpClientResponse,
  maximumResponseBytes: number,
  retainedResponseHeaderNames: ReadonlyArray<string>
): Effect.Effect<BoundedExternalHttpResponse, ExternalHttpFailure> =>
  collectBoundedResponseBytes(response, maximumResponseBytes).pipe(
    Effect.mapError(
      () =>
        new ExternalHttpFailure({
          reason: "response-body-failed",
          responseStatus: Option.some(response.status),
        })
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ExternalHttpFailure({
              reason: "response-too-large",
              responseStatus: Option.some(response.status),
            })
          ),
        onSome: (body) =>
          Effect.succeed({
            status: response.status,
            headers: retainedHeaders(response, retainedResponseHeaderNames),
            body,
          }),
      })
    )
  );

/**
 * Returns an ordinary provider client that applies transport policy and materializes only a bounded
 * body. Raw response streams remain private to this module.
 */
export const makeBoundedExternalHttpClient =
  (provider: ExternalHttpProvider) =>
  (client: HttpClient.HttpClient): BoundedExternalHttpClient => {
    const policy = externalHttpPolicies[provider];
    const protectedClient = client.pipe(makeProtectedHttpClient(provider));
    return {
      execute: (request, maximumResponseBytes) => {
        const boundedRequest = protectedClient.execute(request).pipe(
          Effect.tap(annotateResponse),
          Effect.mapError(
            (error) =>
              new ExternalHttpFailure({
                reason: "transport-failed",
                responseStatus: failureResponseStatus(error),
              })
          ),
          Effect.flatMap((response) =>
            materializeBoundedResponse(
              response,
              maximumResponseBytes,
              policy.retainedResponseHeaders
            )
          )
        );
        return boundedRequest.pipe(
          Effect.exit,
          Effect.tap(annotateTransportOutcome),
          Effect.withSpan(externalRequestSpan, {
            kind: "client",
            attributes: projectExternalHttpRequest(request.method, provider),
          }),
          Effect.flatMap(
            Exit.match({
              onFailure: Effect.failCause,
              onSuccess: Effect.succeed,
            })
          )
        );
      },
    };
  };

/**
 * Bounds a provider library whose public client contract requires `HttpClient`. The reconstructed
 * response is private to that library and is backed only by already-bounded bytes.
 */
export const boundedProviderLibraryHttpClientLayer = (options: {
  provider: ExternalHttpProvider;
  maximumResponseBytes: number;
}): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (httpClient) => {
      const boundedClient = httpClient.pipe(makeBoundedExternalHttpClient(options.provider));
      return HttpClient.make((request) =>
        boundedClient.execute(request, options.maximumResponseBytes).pipe(
          Effect.map((response) =>
            HttpClientResponse.fromWeb(
              request,
              new Response(response.body, {
                status: response.status,
                headers: response.headers,
              })
            )
          ),
          Effect.mapError(
            () =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: HttpClientRequest.make(request.method)(sanitizedRequestUrl),
                }),
              })
          )
        )
      );
    })
  );
