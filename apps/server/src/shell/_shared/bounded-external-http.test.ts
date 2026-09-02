import { expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Option, Tracer } from "effect";
import * as RecordUtils from "effect/Record";
import {
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  EnvelopeRecorder,
  TelemetryEnvelopeRecording,
} from "~/shell/observability/envelope-recorder";
import { TelemetryAttempt, TelemetryHttpStatus } from "~/shell/observability/protocol";
import { Telemetry } from "~/shell/observability/telemetry";
import { transactionEnvelopePayloads } from "~/shell/testing/telemetry-envelope-fixtures";
import { type ExternalHttpProvider, makeBoundedExternalHttpClient } from "./bounded-external-http";

const failureSentinels = [
  "private-user-sentinel",
  "query-private-sentinel",
  "transport-private-sentinel",
  "credential-private-sentinel",
  "response-private-sentinel",
] as const;

const expectSanitizedFailure = (exit: Exit.Exit<unknown, unknown>): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const renderedFailure = Cause.pretty(exit.cause);
    for (const sentinel of failureSentinels) expect(renderedFailure).not.toContain(sentinel);
  }
};

const expectEndedSpanExit = (
  span: Option.Option<Tracer.NativeSpan>,
  expected: "Success" | "Failure"
): void => {
  const recordedSpan = Option.getOrThrow(span);
  expect(recordedSpan.status._tag).toBe("Ended");
  if (recordedSpan.status._tag !== "Ended") return;
  expect(recordedSpan.status.exit._tag).toBe(expected);
  if (Exit.isFailure(recordedSpan.status.exit)) expectSanitizedFailure(recordedSpan.status.exit);
};

const httpClientErrorReasonTags = [
  "TransportError",
  "EncodeError",
  "InvalidUrlError",
  "StatusCodeError",
  "DecodeError",
  "EmptyBodyError",
] as const;

const coordinateBearingReason = (
  tag: (typeof httpClientErrorReasonTags)[number],
  request: HttpClientRequest.HttpClientRequest
): HttpClientError.HttpClientErrorReason => {
  const response = HttpClientResponse.fromWeb(
    request,
    new Response(null, {
      status: 503,
      headers: { "x-provider-coordinate": "response-private-sentinel" },
    })
  );
  const properties = { request, description: "transport-private-sentinel" };
  switch (tag) {
    case "TransportError":
      return new HttpClientError.TransportError(properties);
    case "EncodeError":
      return new HttpClientError.EncodeError(properties);
    case "InvalidUrlError":
      return new HttpClientError.InvalidUrlError(properties);
    case "StatusCodeError":
      return new HttpClientError.StatusCodeError({ ...properties, response });
    case "DecodeError":
      return new HttpClientError.DecodeError({ ...properties, response });
    case "EmptyBodyError":
      return new HttpClientError.EmptyBodyError({ ...properties, response });
  }
};

const providerCredentialHeaders: Readonly<Record<ExternalHttpProvider, ReadonlyArray<string>>> = {
  "cloudflare-access": ["cf-access-token"],
  kapso: ["x-api-key"],
  openai: ["authorization", "openai-organization", "openai-project"],
  resend: ["authorization", "idempotency-key"],
  sentry: ["authorization"],
  wompi: ["authorization"],
};

it.effect("returns only status, headers, and body after enforcing the response byte maximum", () =>
  Effect.gen(function* () {
    const transport = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "x-safe": "coordinate" } })
        )
      )
    );
    const client = transport.pipe(makeBoundedExternalHttpClient("kapso"));

    const response = yield* client.execute(HttpClientRequest.get("https://provider.example"), 4);
    const oversized = yield* client
      .execute(HttpClientRequest.get("https://provider.example"), 3)
      .pipe(Effect.flip);

    expect(Object.keys(response).sort()).toEqual(["body", "headers", "status"]);
    expect(response.body).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(response.headers["x-safe"]).toBeUndefined();
    expect(oversized).toMatchObject({ _tag: "ExternalHttpFailure", reason: "response-too-large" });
  })
);

it.effect(
  "suppresses coordinate-bearing automatic spans and propagation for every external provider",
  () =>
    Effect.gen(function* () {
      for (const provider of RecordUtils.keys(providerCredentialHeaders)) {
        const spans: Array<Tracer.NativeSpan> = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        let sentHeaders = new globalThis.Headers();
        const client = HttpClient.make((request) => {
          sentHeaders = new globalThis.Headers(request.headers);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: 204,
                headers: { "x-provider-coordinate": "response-private-sentinel" },
              })
            )
          );
        }).pipe(makeBoundedExternalHttpClient(provider));

        yield* client
          .execute(
            HttpClientRequest.get(
              `https://${provider}.example/private-user-sentinel?token=query-private-sentinel`,
              {
                headers: Object.fromEntries(
                  providerCredentialHeaders[provider].map((name) => [
                    name,
                    `${name}-private-sentinel`,
                  ])
                ),
              }
            ),
            1_024
          )
          .pipe(
            Effect.withSpan("safe.provider.operation"),
            Effect.provideService(Tracer.Tracer, tracer),
            Effect.provideService(HttpClient.TracerPropagationEnabled, true)
          );

        expect(spans.map((span) => span.name)).toEqual([
          "safe.provider.operation",
          "provider.request",
        ]);
        const providerSpan = spans.find((span) => span.name === "provider.request");
        expect(providerSpan?.attributes).toMatchObject(
          new Map([
            ["fidy.provider", provider],
            ["http.request.method", "GET"],
            ["http.response.status_class", "2xx"],
            ["fidy.transport_outcome", "response"],
          ])
        );
        expect(providerSpan?.status._tag).toBe("Ended");
        expect(Array.from(sentHeaders.keys())).not.toEqual(
          expect.arrayContaining(["b3", "baggage", "sentry-trace", "traceparent", "tracestate"])
        );
        const recorded = spans
          .flatMap((span) => [span.name, ...span.attributes.keys(), ...span.attributes.values()])
          .join("|");
        expect(recorded).not.toContain("private-user-sentinel");
        expect(recorded).not.toContain("query-private-sentinel");
        expect(recorded).not.toContain("response-private-sentinel");
        expect(recorded).not.toContain("private-sentinel");
      }
    })
);

it.effect("ends a failed provider span without attaching the coordinate-bearing failure", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const url = "https://provider.example/private-user-sentinel?token=query-private-sentinel";
    const client = HttpClient.make((request) => {
      const response = HttpClientResponse.fromWeb(
        request,
        new Response(null, {
          status: 503,
          headers: { "x-provider-coordinate": "response-private-sentinel" },
        })
      );
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.StatusCodeError({
            request,
            response,
            description: "transport-private-sentinel",
          }),
        })
      );
    }).pipe(makeBoundedExternalHttpClient("kapso"));

    const exit = yield* client
      .execute(
        HttpClientRequest.get(url, {
          headers: { authorization: "credential-private-sentinel" },
        }),
        1_024
      )
      .pipe(
        Effect.withSpan("safe.parent.operation"),
        Effect.exit,
        Effect.provideService(Tracer.Tracer, tracer)
      );

    expectSanitizedFailure(exit);
    const providerSpan = spans.find((span) => span.name === "provider.request");
    expect(providerSpan?.attributes.get("fidy.transport_outcome")).toBe("failure");
    expectEndedSpanExit(Option.fromUndefinedOr(providerSpan), "Success");
    expectEndedSpanExit(
      Option.fromUndefinedOr(spans.find((span) => span.name === "safe.parent.operation")),
      "Failure"
    );
    const recorded = spans
      .flatMap((span) => [span.name, ...span.attributes.keys(), ...span.attributes.values()])
      .join("|");
    expect(recorded).not.toContain("private-user-sentinel");
    expect(recorded).not.toContain("query-private-sentinel");
    expect(recorded).not.toContain("transport-private-sentinel");
  })
);

it.effect.each(httpClientErrorReasonTags)("sanitizes the $ failure variant", (tag) =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({ reason: coordinateBearingReason(tag, request) })
      )
    ).pipe(makeBoundedExternalHttpClient("kapso"));

    const exit = yield* client
      .execute(
        HttpClientRequest.get(
          "https://provider.example/private-user-sentinel?token=query-private-sentinel",
          { headers: { authorization: "credential-private-sentinel" } }
        ),
        1_024
      )
      .pipe(Effect.exit);

    expectSanitizedFailure(exit);
    if (Exit.isFailure(exit)) {
      const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      expect(failure).toMatchObject({
        _tag: "ExternalHttpFailure",
        reason: "transport-failed",
      });
    }
  })
);

it.effect("exports safe provider telemetry without URL, query, or header coordinates", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(TelemetryEnvelopeRecording);
      const telemetry = Context.get(services, Telemetry);
      const recorder = Context.get(services, EnvelopeRecorder);
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("response-private-sentinel", {
              status: 202,
              headers: { "x-provider-coordinate": "provider-private-sentinel" },
            })
          )
        )
      ).pipe(makeBoundedExternalHttpClient("kapso"));
      const forbidden = [
        "private-user-sentinel",
        "query-private-sentinel",
        "credential-private-sentinel",
        "response-private-sentinel",
        "provider-private-sentinel",
      ] as const;

      yield* telemetry.span(
        {
          component: "kapso",
          operation: "whatsapp.sendText",
          trigger: "queue",
          spanOperation: "http.client",
          workKind: "provider_call",
          metadata: {
            _tag: "Provider",
            provider: "kapso",
            attempt: TelemetryAttempt.make(1),
            status: Option.none(),
          },
        },
        client
          .execute(
            HttpClientRequest.get(`https://kapso.example/${forbidden[0]}?token=${forbidden[1]}`, {
              headers: { "x-api-key": forbidden[2] },
            }),
            1_024
          )
          .pipe(
            Effect.tap((response) =>
              telemetry.recordResponseStatus(TelemetryHttpStatus.make(response.status))
            ),
            Effect.tap(() =>
              telemetry.recordOutcome({
                outcome: "succeeded",
                error: Option.none(),
                retryable: false,
              })
            )
          )
      );

      const envelopes = yield* recorder.serializedEnvelopes;
      const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");
      for (const value of forbidden) expect(serialized).not.toContain(value);
      const data = transactionEnvelopePayloads(envelopes)[0]?.contexts.trace.data;
      expect(data).toMatchObject({
        "fidy.operation": "whatsapp.sendText",
        "fidy.provider": "kapso",
        "fidy.outcome": "succeeded",
        "http.response.status_code": 202,
        "http.response.status_class": "2xx",
      });
      expect(data?.["fidy.duration_milliseconds"]).toBeTypeOf("number");
    })
  )
);

it.effect("installs each provider's credential redaction policy at the transport boundary", () =>
  Effect.gen(function* () {
    for (const provider of RecordUtils.keys(providerCredentialHeaders)) {
      let redactedNames: ReadonlyArray<string | RegExp> = [];
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          redactedNames = yield* Headers.CurrentRedactedNames;
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
        })
      ).pipe(makeBoundedExternalHttpClient(provider));

      yield* client.execute(HttpClientRequest.get(`https://${provider}.example/operation`), 1_024);

      for (const header of providerCredentialHeaders[provider]) {
        expect(Headers.isRedactedName(header, redactedNames)).toBe(true);
      }
    }
  })
);
