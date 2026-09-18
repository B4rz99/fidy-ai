import assert from "node:assert/strict";
import { BunCrypto } from "@effect/platform-bun";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { WhatsAppBusinessPhoneNumberId } from "~/shell/channels/whatsapp/model";
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
      Layer.provide(BunCrypto.layer),
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            KAPSO_API_KEY: apiKey,
            OPENAI_API_KEY: "private-openai-key",
            MISTRAL_API_KEY: "private-mistral-key",
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

const makeSentryOutbound = (
  httpClient: HttpClient.HttpClient,
  authToken = "private-sentry-token"
): Effect.Effect<OutboundHttpService, Config.ConfigError, Scope.Scope> =>
  Layer.build(
    OutboundHttp.sentryLayer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ SENTRY_AUTH_TOKEN: authToken })
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

it.effect("owns Resend destinations, authorization, idempotency, and bodyless retrieval", () =>
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
    const receivedEmailId = ResendReceivedEmailId.make("received-1");

    yield* outbound.execute({
      _tag: "ResendEmailDelivery",
      idempotencyKey: "delivery-1",
      body: '{"subject":"bounded"}',
    });
    yield* outbound.execute({ _tag: "ResendReceivedEmail", receivedEmailId });
    yield* outbound.execute({
      _tag: "ResendAttachment",
      receivedEmailId,
      attachmentId: "inline/1",
    });
    yield* outbound.execute({
      _tag: "ResendInboundDownload",
      downloadUrl: "https://inbound-cdn.resend.com/signed/image?signature=private",
    });

    expect(observed).toEqual([
      {
        url: "https://api.resend.com/emails",
        authorization: Option.some("Bearer re_test_only_resend_key_324000000"),
        idempotencyKey: Option.some("delivery-1"),
        body: '{"subject":"bounded"}',
      },
      {
        url: "https://api.resend.com/emails/receiving/received-1",
        authorization: Option.some("Bearer re_test_only_resend_key_324000000"),
        idempotencyKey: Option.none(),
        body: "",
      },
      {
        url: "https://api.resend.com/emails/receiving/received-1/attachments/inline%2F1",
        authorization: Option.some("Bearer re_test_only_resend_key_324000000"),
        idempotencyKey: Option.none(),
        body: "",
      },
      {
        url: "https://inbound-cdn.resend.com/signed/image?signature=private",
        authorization: Option.none(),
        idempotencyKey: Option.none(),
        body: "",
      },
    ]);
  })
);

it.effect("owns hosted-inference destinations, credentials, and retained headers", () =>
  Effect.gen(function* () {
    const observed: Array<Readonly<{ url: string; authorization: string; body: string }>> = [];
    const outbound = yield* makeTestOutbound(
      HttpClient.make((request) => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        observed.push({
          url: request.url,
          authorization: new Headers(request.headers).get("authorization") ?? "",
          body,
        });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("{}", {
              status: 429,
              headers: { "retry-after": "5", "x-private-coordinate": "private" },
            })
          )
        );
      })
    );

    const openAi = yield* outbound.execute({
      _tag: "OpenAiInputTokens",
      body: '{"model":"test"}',
    });
    const mistral = yield* outbound.execute({
      _tag: "MistralChatCompletions",
      body: '{"messages":[]}',
    });

    expect(observed).toEqual([
      {
        url: "https://api.openai.com/v1/responses/input_tokens",
        authorization: "Bearer private-openai-key",
        body: '{"model":"test"}',
      },
      {
        url: "https://api.mistral.ai/v1/chat/completions",
        authorization: "Bearer private-mistral-key",
        body: '{"messages":[]}',
      },
    ]);
    expect(openAi.headers).toEqual({ "retry-after": "5" });
    expect(mistral.headers).toEqual({});
    expectNotInspected(outbound, "private-openai-key");
    expectNotInspected(outbound, "private-mistral-key");
  })
);

it.effect("rejects an unsafe Resend download destination before transport", () =>
  Effect.gen(function* () {
    let requests = 0;
    const outbound = yield* makeTestOutbound(
      HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unused")));
      })
    );

    const exit = yield* outbound
      .execute({ _tag: "ResendInboundDownload", downloadUrl: "http://127.0.0.1/private" })
      .pipe(Effect.exit);

    assert.deepStrictEqual(
      exit,
      Exit.fail(
        new OutboundHttpFailure({
          reason: "invalid-destination",
          responseStatus: Option.none(),
          responseHeaders: {},
        })
      )
    );
    expect(requests).toBe(0);
  })
);

it.effect("loads all operator Sentry account credentials as redacted values", () =>
  Effect.gen(function* () {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const outbound = yield* makeSentryOutbound(
      HttpClient.make((request) => {
        requests.push(request);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("[]", {
              headers: {
                link: '<https://sentry.io/next>; rel="next"; results="false"',
                "x-private-coordinate": "private-response-header",
              },
            })
          )
        );
      })
    );

    const response = yield* outbound.execute({
      _tag: "SentryAccount",
      resource: {
        _tag: "ProjectEnvironments",
        organizationSlug: Redacted.make("private-organization"),
        projectSlug: Redacted.make("private-project"),
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(
      "https://sentry.io/api/0/projects/private-organization/private-project/environments/"
    );
    expect(requests[0]?.headers.authorization).toBe("Bearer private-sentry-token");
    expect(response.headers).toEqual({
      link: '<https://sentry.io/next>; rel="next"; results="false"',
    });
  })
);

it.effect("rejects a destination outside the service authority before transport", () =>
  Effect.gen(function* () {
    let requests = 0;
    const outbound = yield* makeSentryOutbound(
      HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unexpected")));
      }),
      "private-sentry-token"
    );
    expectNotInspected(outbound, "private-sentry-token");

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
    expect(String(exit)).not.toContain("private-sentry-token");
    expect(String(exit)).not.toContain("private-support-body");
  })
);

it.effect("rejects a non-Access destination before support transport", () =>
  Effect.gen(function* () {
    let requests = 0;
    const outbound = makeCloudflareAccessOutboundHttp({
      accessToken: Redacted.make("private-access-token"),
      httpClient: HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unexpected")));
      }),
    });

    const failure = yield* Effect.flip(outbound.execute(kapsoRequest));

    expect(failure.reason).toBe("transport-failed");
    expect(requests).toBe(0);
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

    const sentryFailure = yield* Effect.flip(
      outbound.execute({
        _tag: "SentryAccount",
        resource: {
          _tag: "Organization",
          organizationSlug: Redacted.make("private-organization"),
        },
      })
    );
    const cloudflareFailure = yield* Effect.flip(
      outbound.execute({
        _tag: "CloudflareAccessSupportRecovery",
        body: "private-support-body",
      })
    );

    expect(sentryFailure.reason).toBe("transport-failed");
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
    const unannotatedExit = Exit.isFailure(exit)
      ? Exit.fail(Option.getOrThrow(Cause.findErrorOption(exit.cause)))
      : exit;

    assert.deepStrictEqual(
      unannotatedExit,
      Exit.fail(
        new OutboundHttpFailure({
          reason: "response-too-large",
          responseStatus: Option.some(200),
          responseHeaders: {},
        })
      )
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
      expect.arrayContaining(["b3", "baggage", "sentry-trace", "traceparent", "tracestate"])
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

it.effect("projects a Sentry transport failure without credentials or account locators", () =>
  Effect.gen(function* () {
    const authToken = "private-sentry-token-sentinel";
    const organization = "private-sentry-organization-sentinel";
    const outbound = yield* makeSentryOutbound(
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: coordinateBearingReason("TransportError", request),
          })
        )
      ),
      authToken
    );
    expectNotInspected(outbound, authToken);

    const exit = yield* outbound
      .execute({
        _tag: "SentryAccount",
        resource: {
          _tag: "Organization",
          organizationSlug: Redacted.make(organization),
        },
      })
      .pipe(Effect.exit);
    const rendered = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";

    expect(rendered).not.toContain(authToken);
    expect(rendered).not.toContain(organization);
    expect(rendered).not.toContain("transport-private-sentinel");
  })
);

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
      const unannotatedExit = Exit.isFailure(exit)
        ? Exit.fail(Option.getOrThrow(Cause.findErrorOption(exit.cause)))
        : exit;
      assert.deepStrictEqual(
        unannotatedExit,
        Exit.fail(
          new OutboundHttpFailure({
            reason: "transport-failed",
            responseStatus: expectedStatus,
            responseHeaders: {},
          })
        )
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
    const unannotatedExit = Exit.isFailure(exit)
      ? Exit.fail(Option.getOrThrow(Cause.findErrorOption(exit.cause)))
      : exit;
    assert.deepStrictEqual(
      unannotatedExit,
      Exit.fail(
        new OutboundHttpFailure({
          reason: "response-body-failed",
          responseStatus: Option.some(200),
          responseHeaders: {},
        })
      )
    );
    const failure = Option.getOrThrow(
      Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
    );
    const rendered = yield* Schema.encodeEffect(UnknownJsonString)(failure);

    expect(failure.reason).toBe("response-body-failed");
    expect(rendered).not.toContain("stream-private-sentinel");
    expect(rendered).not.toContain("credential-private-sentinel");
  })
);
