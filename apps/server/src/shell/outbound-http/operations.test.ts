import assert from "node:assert/strict";
import { TestCrypto } from "~/shell/testing/crypto";
import { WhatsAppBusinessPhoneNumberId } from "~/shell/channels/whatsapp/model";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { expect, it } from "@effect/vitest";
import {
  Cause,
  type Config,
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
  type Scope,
  Stream,
  Tracer,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { OutboundHttpFailure } from "./contract";
import { makeCloudflareAccessOutboundHttp } from "~/shell/outbound-http/internal/outbound-http";
import { OutboundHttp, type OutboundHttpService } from "./operations";
import { expectNotInspected } from "~/shell/testing/credential-failure";

const kapsoRequest = {
  _tag: "KapsoMessages" as const,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
  body: '{"messaging_product":"whatsapp"}',
};

const makeTestOutbound = (
  httpClient: HttpClient.HttpClient,
  apiKey = "private-kapso-key"
): Effect.Effect<OutboundHttpService, Config.ConfigError, Scope.Scope> =>
  Layer.build(
    OutboundHttp.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
      Layer.provide(TestCrypto),
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            KAPSO_API_KEY: apiKey,
            RESEND_API_KEY: "re_test_only_resend_key_324000000",
            WOMPI_ENVIRONMENT: "sandbox",
            WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
          })
        )
      )
    )
  ).pipe(Effect.map((context) => Context.get(context, OutboundHttp)));

it.effect("keeps the configured Kapso API key redacted while sending it only as a header", () =>
  Effect.gen(function* () {
    let observedUrl = "";
    let observedApiKey = "";
    let observedBody = "";
    const outbound = yield* makeTestOutbound(
      HttpClient.make((request) => {
        observedUrl = request.url;
        observedApiKey = new Headers(request.headers).get("x-api-key") ?? "";
        if (request.body._tag === "Uint8Array") {
          observedBody = new TextDecoder().decode(request.body.body);
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("response", { status: 202 }))
        );
      })
    );
    expectNotInspected(outbound, "private-kapso-key");

    const response = yield* outbound.execute(kapsoRequest);

    expect(observedUrl).toBe("https://api.kapso.ai/meta/whatsapp/v24.0/123456789/messages");
    expect(observedApiKey).toBe("private-kapso-key");
    expect(observedBody).toBe(kapsoRequest.body);
    expect(response).toEqual({
      status: 202,
      headers: {},
      body: new TextEncoder().encode("response"),
    });
  })
);

it.effect("owns the Resend delivery destination, authorization, and idempotency", () =>
  Effect.gen(function* () {
    const observed: Array<{
      readonly url: string;
      readonly authorization: Option.Option<string>;
      readonly idempotencyKey: Option.Option<string>;
      readonly body: string;
    }> = [];
    const outbound = yield* makeTestOutbound(
      HttpClient.make((request) => {
        const headers = new Headers(request.headers);
        observed.push({
          url: request.url,
          authorization: Option.fromNullishOr(headers.get("authorization")),
          idempotencyKey: Option.fromNullishOr(headers.get("idempotency-key")),
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
      })
    );
    yield* outbound.execute({
      _tag: "ResendEmailDelivery",
      idempotencyKey: "delivery-1",
      body: '{"subject":"bounded"}',
    });
    expect(observed).toEqual([
      {
        url: "https://api.resend.com/emails",
        authorization: Option.some("Bearer re_test_only_resend_key_324000000"),
        idempotencyKey: Option.some("delivery-1"),
        body: '{"subject":"bounded"}',
      },
    ]);
  })
);

it.effect("executes only the closed Cloudflare Access operation", () =>
  Effect.gen(function* () {
    let observedToken = "";
    const outbound = makeCloudflareAccessOutboundHttp({
      accessToken: Redacted.make("private-cloudflare-access-token"),
      httpClient: HttpClient.make((request) => {
        observedToken = new Headers(request.headers).get("cf-access-token") ?? "";
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
      }),
    });

    const response = yield* outbound.execute({
      _tag: "CloudflareAccessSupportRecovery",
      body: "{}",
    });
    const rejected = yield* outbound.execute(kapsoRequest).pipe(Effect.flip);

    expect(response.status).toBe(200);
    expect(observedToken).toBe("private-cloudflare-access-token");
    expect(rejected.reason).toBe("transport-failed");
  })
);

it.effect("rejects a destination outside the service authority before transport", () =>
  Effect.gen(function* () {
    let requests = 0;
    const outbound = yield* makeTestOutbound(
      HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unexpected")));
      })
    );

    const exit = yield* outbound
      .execute({
        _tag: "CloudflareAccessSupportRecovery",
        body: "private-support-body",
      })
      .pipe(Effect.exit);
    const unannotatedExit = Exit.isFailure(exit)
      ? Exit.fail(Option.getOrThrow(Cause.findErrorOption(exit.cause)))
      : exit;

    assert.deepStrictEqual(
      unannotatedExit,
      Exit.fail(
        new OutboundHttpFailure({
          reason: "transport-failed",
          responseStatus: Option.none(),
          responseHeaders: {},
        })
      )
    );
    expect(requests).toBe(0);
    expect(String(exit)).not.toContain("private-support-body");
  })
);

it.effect("rejects operational requests from the runtime provider group before transport", () =>
  Effect.gen(function* () {
    let requests = 0;
    const outbound = yield* makeTestOutbound(
      HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unexpected")));
      })
    );

    const cloudflareFailure = yield* Effect.flip(
      outbound.execute({
        _tag: "CloudflareAccessSupportRecovery",
        body: "private-support-body",
      })
    );

    expect(cloudflareFailure.reason).toBe("transport-failed");
    expect(requests).toBe(0);
  })
);

it.effect("bounds the streamed Kapso response before exposing bytes and cancels overflow", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const outbound = yield* makeTestOutbound(
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller): void => {
                  controller.enqueue(new Uint8Array(64 * 1_024));
                  controller.enqueue(new Uint8Array([1]));
                },
                cancel: (): void => {
                  cancelled = true;
                },
              })
            )
          )
        )
      )
    );

    const exit = yield* outbound.execute(kapsoRequest).pipe(Effect.exit);
    const failure = Option.getOrThrow(
      Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
    );

    expect(failure).toEqual(
      new OutboundHttpFailure({
        reason: "response-too-large",
        responseStatus: Option.some(200),
        responseHeaders: {},
      })
    );
    expect(cancelled).toBe(true);
  })
);

it.effect("bounds Wompi response streams at the provider-specific limit before decoding", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const outbound = yield* makeTestOutbound(
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller): void => {
                  controller.enqueue(new Uint8Array(16 * 1_024));
                  controller.enqueue(new Uint8Array([1]));
                },
                cancel: (): void => {
                  cancelled = true;
                },
              })
            )
          )
        )
      )
    );

    const failure = yield* Effect.flip(outbound.execute({ _tag: "WompiMerchant" }));

    expect(failure).toEqual(
      new OutboundHttpFailure({
        reason: "response-too-large",
        responseStatus: Option.some(200),
        responseHeaders: {},
      })
    );
    expect(cancelled).toBe(true);
  })
);

it.effect("releases the owned response body when streaming is interrupted", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const outbound = yield* makeTestOutbound(
      HttpClient.make((request) => {
        const response = HttpClientResponse.fromWeb(request, new Response());
        Object.defineProperty(response, "stream", {
          value: Stream.fromEffect(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined))
            )
          ),
        });
        return Effect.succeed(response);
      })
    );
    const fiber = yield* outbound
      .execute(kapsoRequest)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);

    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(cancelled);
    const exit = yield* Fiber.await(fiber);

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  })
);

it.effect(
  "interrupts Kapso transport without converting cancellation into a transport failure",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const outbound = yield* makeTestOutbound(
        HttpClient.make(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined))
          )
        )
      );
      const fiber = yield* outbound
        .execute(kapsoRequest)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);

      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(cancelled);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    })
);

it.effect("does not follow redirects or propagate trace coordinates to Kapso", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const redirectOptions: Array<Option.Option<string>> = [];
    let propagatedHeaders = new Headers();
    const redirectFetch: typeof globalThis.fetch = Object.assign(
      (_input: string | URL | globalThis.Request, init?: RequestInit) => {
        redirectOptions.push(Option.fromUndefinedOr(init?.redirect));
        propagatedHeaders = new Headers(init?.headers);
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/credential-target" },
          })
        );
      },
      { preconnect: (): void => undefined }
    );
    const fetchLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, redirectFetch))
    );
    const context = yield* Layer.build(fetchLayer);
    const outbound = yield* makeTestOutbound(Context.get(context, HttpClient.HttpClient));

    const response = yield* outbound
      .execute(kapsoRequest)
      .pipe(
        Effect.withSpan("safe.parent"),
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(HttpClient.TracerPropagationEnabled, true)
      );

    expect(response.status).toBe(302);
    expect(redirectOptions).toEqual([Option.some("error")]);
    expect(Array.from(propagatedHeaders.keys())).not.toEqual(
      expect.arrayContaining(["b3", "baggage", "traceparent", "tracestate"])
    );
    expect(spans.map((span) => span.name)).toEqual(["safe.parent", "provider.request"]);
    const recorded = spans
      .flatMap((span) => [span.name, ...span.attributes.keys(), ...span.attributes.values()])
      .join("|");
    expect(recorded).not.toContain("api.kapso.ai");
    expect(recorded).not.toContain("123456789");
    expect(recorded).not.toContain("private-kapso-key");
    expect(recorded).not.toContain("attacker.example");
  })
);

const transportFailureTags = [
  "TransportError",
  "EncodeError",
  "InvalidUrlError",
  "StatusCodeError",
  "DecodeError",
  "EmptyBodyError",
] as const;

const coordinateBearingReason = (
  tag: (typeof transportFailureTags)[number],
  request: HttpClientRequest.HttpClientRequest
): HttpClientError.HttpClientErrorReason => {
  const response = HttpClientResponse.fromWeb(
    request,
    new Response(null, {
      status: 503,
      headers: { "x-private-coordinate": "response-private-sentinel" },
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

it.effect.each(transportFailureTags)(
  "projects the $ failure without transport coordinates",
  (tag) =>
    Effect.gen(function* () {
      const outbound = yield* makeTestOutbound(
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: coordinateBearingReason(tag, request),
            })
          )
        ),
        "credential-private-sentinel"
      );

      const exit = yield* outbound
        .execute({
          _tag: "KapsoMessages",
          businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("987654321"),
          body: "private-body-sentinel",
        })
        .pipe(Effect.exit);

      const expectedStatus = ["StatusCodeError", "DecodeError", "EmptyBodyError"].includes(tag)
        ? Option.some(503)
        : Option.none<number>();
      const failure = Option.getOrThrow(
        Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
      );
      expect(failure).toEqual(
        new OutboundHttpFailure({
          reason: "transport-failed",
          responseStatus: expectedStatus,
          responseHeaders: {},
        })
      );
      const rendered = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
      for (const sentinel of [
        "credential-private-sentinel",
        "private-body-sentinel",
        "transport-private-sentinel",
        "response-private-sentinel",
      ]) {
        expect(rendered).not.toContain(sentinel);
      }
    })
);

it.effect("projects a hostile response-stream failure without its coordinates", () =>
  Effect.gen(function* () {
    const outbound = yield* makeTestOutbound(
      HttpClient.make((request) => {
        const response = HttpClientResponse.fromWeb(request, new Response());
        Object.defineProperty(response, "stream", {
          value: Stream.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "stream-private-sentinel",
              }),
            })
          ),
        });
        return Effect.succeed(response);
      }),
      "credential-private-sentinel"
    );

    const exit = yield* outbound.execute(kapsoRequest).pipe(Effect.exit);
    const failure = Option.getOrThrow(
      Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
    );
    expect(failure).toEqual(
      new OutboundHttpFailure({
        reason: "response-body-failed",
        responseStatus: Option.some(200),
        responseHeaders: {},
      })
    );
    const rendered = yield* Schema.encodeEffect(UnknownJsonString)(failure);

    expect(failure.reason).toBe("response-body-failed");
    expect(rendered).not.toContain("stream-private-sentinel");
    expect(rendered).not.toContain("credential-private-sentinel");
  })
);
