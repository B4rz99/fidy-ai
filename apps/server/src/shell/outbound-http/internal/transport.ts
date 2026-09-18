import { Cause, Effect, Exit, Option, Stream } from "effect";
import { Headers, HttpClient } from "effect/unstable/http";
import type { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type { TelemetryCode } from "~/shell/observability/contract";
import {
  projectExternalHttpOutcome,
  projectExternalHttpRequest,
  projectExternalHttpResponse,
} from "~/shell/observability/operations";
import { collectBoundedBytes } from "~/shell/_shared/bounded-bytes";
import { OutboundHttpFailure, type OutboundHttpResponse } from "~/shell/outbound-http/contract";

/** External provider selected by one closed transport policy. */
type OutboundHttpProvider = TelemetryCode<"provider">;

type OutboundHttpPolicy = Readonly<{
  propagateTrace: boolean;
  redactedHeaders: ReadonlyArray<string>;
  retainedResponseHeaders: ReadonlyArray<string>;
}>;

const outboundHttpPolicies: Readonly<Record<OutboundHttpProvider, OutboundHttpPolicy>> = {
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
  mistral: {
    propagateTrace: false,
    redactedHeaders: ["authorization"],
    retainedResponseHeaders: [],
  },
  openai: {
    propagateTrace: false,
    redactedHeaders: ["authorization", "openai-organization", "openai-project"],
    retainedResponseHeaders: ["retry-after"],
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

const retainedHeaders = (headers: Headers.Headers, names: ReadonlyArray<string>): Headers.Headers =>
  Headers.fromInput(
    Object.fromEntries(names.flatMap((name) => (name in headers ? [[name, headers[name]]] : [])))
  );

const transportFailure = (
  error: HttpClientError.HttpClientError,
  retainedHeaderNames: ReadonlyArray<string>
): OutboundHttpFailure => {
  switch (error.reason._tag) {
    case "StatusCodeError":
    case "DecodeError":
    case "EmptyBodyError":
      return new OutboundHttpFailure({
        reason: "transport-failed",
        responseStatus: Option.some(error.reason.response.status),
        responseHeaders: retainedHeaders(error.reason.response.headers, retainedHeaderNames),
      });
    case "TransportError":
    case "EncodeError":
    case "InvalidUrlError":
      return new OutboundHttpFailure({
        reason: "transport-failed",
        responseStatus: Option.none(),
        responseHeaders: Headers.empty,
      });
  }
};

const collectResponse = (
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes: number,
  retainedHeaderNames: ReadonlyArray<string>
): Effect.Effect<OutboundHttpResponse, OutboundHttpFailure> => {
  const responseHeaders = retainedHeaders(response.headers, retainedHeaderNames);
  const declaredLength = Number(response.headers["content-length"] ?? 0);
  const read =
    declaredLength > maximumBytes
      ? Effect.scoped(Stream.toPull(response.stream).pipe(Effect.as(Option.none<Uint8Array>())))
      : collectBoundedBytes(response.stream, maximumBytes);
  return read.pipe(
    Effect.catchIf(
      (error: HttpClientError.HttpClientError) => error.reason._tag === "EmptyBodyError",
      () => Effect.succeedSome<Uint8Array>(new Uint8Array(0))
    ),
    Effect.mapError(
      () =>
        new OutboundHttpFailure({
          reason: "response-body-failed",
          responseStatus: Option.some(response.status),
          responseHeaders,
        })
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new OutboundHttpFailure({
              reason: "response-too-large",
              responseStatus: Option.some(response.status),
              responseHeaders,
            })
          ),
        onSome: (body) =>
          Effect.succeed({ status: response.status, headers: responseHeaders, body }),
      })
    )
  );
};

const transportOutcome = <A, E>(exit: Exit.Exit<A, E>): "response" | "interrupted" | "failure" => {
  if (Exit.isSuccess(exit)) return "response";
  return Cause.hasInterrupts(exit.cause) ? "interrupted" : "failure";
};

const annotateOutcome = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
  exit.pipe(transportOutcome, projectExternalHttpOutcome, Effect.annotateCurrentSpan);

const suppressHeaders = (): boolean => false;
const suppressAutomaticSpan = (): boolean => true;

type ProviderTransport = Readonly<{
  execute: (
    request: HttpClientRequest.HttpClientRequest,
    maximumResponseBytes: number
  ) => Effect.Effect<OutboundHttpResponse, OutboundHttpFailure>;
}>;

/** Builds the private raw-client adapter behind the published Outbound HTTP service. */
export const makeProviderTransport =
  (provider: OutboundHttpProvider) =>
  (client: HttpClient.HttpClient): ProviderTransport => {
    const policy = outboundHttpPolicies[provider];
    const protectedClient = HttpClient.transform(client, (requestEffect) =>
      Effect.gen(function* () {
        const inheritedRedactions = yield* Headers.CurrentRedactedNames;
        return yield* requestEffect.pipe(
          Effect.provideService(Headers.CurrentRedactedNames, [
            ...inheritedRedactions,
            ...policy.redactedHeaders,
          ]),
          Effect.provideService(HttpClient.TracerHeaderFilter, suppressHeaders),
          Effect.provideService(HttpClient.TracerPropagationEnabled, policy.propagateTrace),
          Effect.provideService(HttpClient.TracerDisabledWhen, suppressAutomaticSpan)
        );
      })
    );

    return {
      execute: (request, maximumResponseBytes) =>
        protectedClient.execute(request).pipe(
          Effect.mapError((error) => transportFailure(error, policy.retainedResponseHeaders)),
          Effect.tap((response) =>
            Effect.annotateCurrentSpan(projectExternalHttpResponse(response.status))
          ),
          Effect.flatMap((response) =>
            collectResponse(response, maximumResponseBytes, policy.retainedResponseHeaders)
          ),
          Effect.exit,
          Effect.tap(annotateOutcome),
          Effect.withSpan("provider.request", {
            kind: "client",
            attributes: projectExternalHttpRequest(request.method, provider),
          }),
          Effect.flatMap(
            Exit.match({
              onFailure: Effect.failCause,
              onSuccess: Effect.succeed,
            })
          )
        ),
    };
  };
