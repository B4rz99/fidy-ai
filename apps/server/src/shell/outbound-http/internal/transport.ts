import { Cause, Effect, Exit, Option, Schema, Stream } from "effect";
import {
  Headers,
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import {
  type DeclaredOutcome,
  TelemetryAttempt,
  type TelemetryCode,
  TelemetryHttpStatus,
  type TelemetryService,
} from "~/shell/observability/contract";
import {
  Telemetry,
  projectExternalHttpOutcome,
  projectExternalHttpRequest,
  projectExternalHttpResponse,
} from "~/shell/observability/operations";
import { collectBoundedBytes } from "./bounded-bytes";
import { OutboundHttpFailure, type OutboundHttpResponse } from "~/shell/outbound-http/contract";

/** External provider selected by one closed transport policy. */
type OutboundHttpProvider = Exclude<
  TelemetryCode<"provider">,
  "cloudflare-workers" | "cloudflare-workers-ai"
>;

type OutboundHttpPolicy = Readonly<{
  propagateTrace: boolean;
  redactedHeaders: ReadonlyArray<string>;
  retainedResponseHeaders: ReadonlyArray<string>;
}>;

const outboundHttpPolicies: Readonly<Record<OutboundHttpProvider, OutboundHttpPolicy>> = {
  github: { propagateTrace: false, redactedHeaders: [], retainedResponseHeaders: ["location"] },
  microsoft: { propagateTrace: false, redactedHeaders: [], retainedResponseHeaders: [] },
  google: { propagateTrace: false, redactedHeaders: [], retainedResponseHeaders: [] },
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
  resend: {
    propagateTrace: false,
    redactedHeaders: ["authorization", "idempotency-key"],
    retainedResponseHeaders: [],
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

type TransportExit = Exit.Exit<OutboundHttpResponse, OutboundHttpFailure>;
const serverFailureStatus = 500;
const rejectedStatus = 400;

const responseStatus = (exit: TransportExit): Option.Option<TelemetryHttpStatus> => {
  const status = Exit.isSuccess(exit)
    ? Option.some(exit.value.status)
    : Option.flatMap(Cause.findErrorOption(exit.cause), (failure) => failure.responseStatus);
  return Option.flatMap(status, Schema.decodeUnknownOption(TelemetryHttpStatus));
};

const providerOutcome = (exit: TransportExit): DeclaredOutcome => {
  if (Exit.isFailure(exit)) {
    if (
      Cause.hasInterrupts(exit.cause) &&
      !Cause.hasDies(exit.cause) &&
      !Cause.hasFails(exit.cause)
    ) {
      return { outcome: "interrupted", error: Option.none(), retryable: false };
    }
    const failure = Cause.findErrorOption(exit.cause);
    const error = Cause.hasDies(exit.cause)
      ? "unexpected_defect"
      : Option.match(failure, {
          onNone: () => "provider_unavailable" as const,
          onSome: (value) => {
            switch (value.reason) {
              case "response-too-large":
                return "capacity_exceeded";
              case "response-body-failed":
                return "invalid_response";
              case "transport-failed":
              case "invalid-destination":
                return "provider_unavailable";
            }
          },
        });
    return { outcome: "failed", error: Option.some(error), retryable: false };
  }
  if (exit.value.status >= serverFailureStatus) {
    return { outcome: "failed", error: Option.some("provider_unavailable"), retryable: false };
  }
  if (exit.value.status >= rejectedStatus) {
    return { outcome: "rejected", error: Option.none(), retryable: false };
  }
  return { outcome: "succeeded", error: Option.none(), retryable: false };
};

const recordProviderExit = (
  telemetry: TelemetryService,
  exit: TransportExit
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const status = responseStatus(exit);
    if (Option.isSome(status)) yield* telemetry.recordResponseStatus(status.value);
    yield* telemetry.recordOutcome(providerOutcome(exit));
  });

const observeProviderAttempt = (
  provider: OutboundHttpProvider,
  work: Effect.Effect<OutboundHttpResponse, OutboundHttpFailure>
): Effect.Effect<OutboundHttpResponse, OutboundHttpFailure> =>
  Effect.flatMap(Effect.serviceOption(Telemetry), (service) =>
    Option.match(service, {
      onNone: () => work,
      onSome: (telemetry) =>
        telemetry.span(
          {
            component: "api",
            operation: "provider.request",
            trigger: "api",
            spanOperation: "http.client",
            workKind: "provider_call",
            metadata: {
              _tag: "Provider",
              provider,
              attempt: TelemetryAttempt.make(1),
              status: Option.none(),
            },
          },
          Effect.onExit(work, (exit) => recordProviderExit(telemetry, exit))
        ),
    })
  );

const suppressHeaders = (): boolean => false;
const suppressAutomaticSpan = (): boolean => true;

type ProviderTransport = Readonly<{
  execute: (
    request: HttpClientRequest.HttpClientRequest,
    maximumResponseBytes: number
  ) => Effect.Effect<OutboundHttpResponse, OutboundHttpFailure>;
}>;

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
          ),
          (work) => observeProviderAttempt(provider, work)
        ),
    };
  };
