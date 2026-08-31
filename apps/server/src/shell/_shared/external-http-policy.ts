import { Cause, Effect, Exit, Layer } from "effect";
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

/** External providers reached by production Effect HTTP clients. */
export type ExternalHttpProvider = TelemetryCode<"provider">;

type ExternalHttpPolicy = Readonly<{
  /** Whether Fidy trace coordinates may cross this provider boundary. */
  propagateTrace: boolean;
  /** Provider-specific credential and request-identity headers protected in addition to defaults. */
  redactedHeaders: ReadonlyArray<string>;
}>;

const excludeHttpHeaders = (): boolean => false;
const suppressAutomaticHttpSpan = (): boolean => true;
const externalRequestSpan = "provider.request";

const annotateResponse = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<void> =>
  Effect.annotateCurrentSpan(projectExternalHttpResponse(response.status));

const annotateTransportOutcome = (
  exit: Exit.Exit<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
): Effect.Effect<void> => {
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
  "cloudflare-access": { propagateTrace: false, redactedHeaders: ["cf-access-token"] },
  kapso: { propagateTrace: false, redactedHeaders: ["x-api-key"] },
  openai: {
    propagateTrace: false,
    redactedHeaders: ["authorization", "openai-organization", "openai-project"],
  },
  resend: {
    propagateTrace: false,
    redactedHeaders: ["authorization", "idempotency-key"],
  },
  sentry: { propagateTrace: false, redactedHeaders: ["authorization"] },
  wompi: { propagateTrace: false, redactedHeaders: ["authorization"] },
};

/**
 * Returns a view of an HTTP client that exports only low-cardinality provider, method, status-class,
 * transport-outcome, and latency coordinates. It never exports request or response coordinates and
 * applies the provider's explicit credential-redaction and trace-propagation policy.
 */
export const makeExternalHttpClient =
  (provider: ExternalHttpProvider) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient => {
    const policy = externalHttpPolicies[provider];
    return HttpClient.transform(client, (requestEffect, request) => {
      // Effect's automatic HTTP span always includes full URL, path, and query coordinates. Suppress
      // that implementation span, then replace it with one rebuilt exclusively from closed values.
      const protectedRequest = Effect.gen(function* () {
        const inheritedRedactions = yield* Headers.CurrentRedactedNames;
        return yield* requestEffect.pipe(
          Effect.provideService(Headers.CurrentRedactedNames, [
            ...inheritedRedactions,
            ...policy.redactedHeaders,
          ]),
          Effect.provideService(HttpClient.TracerHeaderFilter, excludeHttpHeaders),
          Effect.provideService(HttpClient.TracerPropagationEnabled, policy.propagateTrace),
          Effect.provideService(HttpClient.TracerDisabledWhen, suppressAutomaticHttpSpan)
        );
      });
      return protectedRequest.pipe(
        Effect.tap(annotateResponse),
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
        ),
        Effect.mapError(sanitizeHttpClientError)
      );
    });
  };

/** Provides a provider-protected view of the ambient production HTTP transport. */
export const externalHttpClientLayer = (
  provider: ExternalHttpProvider
): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, makeExternalHttpClient(provider))
  );
