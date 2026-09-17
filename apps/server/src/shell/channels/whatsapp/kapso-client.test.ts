import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { expect, it } from "@effect/vitest";
import {
  Cause,
  type Config,
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { TestClock } from "effect/testing";
import { E164PhoneNumber, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import {
  OutboundHttpFailure,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
} from "~/shell/outbound-http/contract";
import { OutboundHttp, type OutboundHttpService } from "~/shell/outbound-http/operations";
import { type KapsoClientService, makeKapsoClientService } from "./kapso-client";
import { DisclosureDeliveryCorrelationToken } from "./disclosure-model";
import { WhatsAppBusinessPhoneNumberId } from "./model";

const sendInput = (
  overrides: Partial<Parameters<KapsoClientService["sendText"]>[0]> = {}
): Parameters<KapsoClientService["sendText"]>[0] => ({
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
  destination: {
    recipient: WhatsAppBusinessScopedUserId.make("CO.573001234567"),
    sandboxPhone: Option.some(E164PhoneNumber.make("+573001234567")),
  },
  text: TranscriptText.make("hola"),
  opaqueCallbackData: Option.none(),
  ...overrides,
});

const makeRealOutboundHttp = (
  httpClient: HttpClient.HttpClient
): Effect.Effect<OutboundHttpService, Config.ConfigError, Scope.Scope> =>
  Layer.build(
    OutboundHttp.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ KAPSO_API_KEY: "test-api-key" })
        )
      )
    )
  ).pipe(Effect.map((context) => Context.get(context, OutboundHttp)));

const fakeOutboundHttp = (response: () => Response): OutboundHttpService => ({
  execute: () => {
    const providerResponse = response();
    return Effect.tryPromise({
      try: () => providerResponse.arrayBuffer(),
      catch: () =>
        new OutboundHttpFailure({
          reason: "response-body-failed",
          responseStatus: Option.none(),
          responseHeaders: {},
        }),
    }).pipe(
      Effect.map(
        (body) =>
          ({
            status: providerResponse.status,
            headers: {},
            body: new Uint8Array(body),
          }) satisfies OutboundHttpResponse
      )
    );
  },
});

const makeService = (
  outboundHttp: OutboundHttpService,
  deliveryMode: "bsuid" | "sandbox-phone" = "bsuid"
): KapsoClientService => makeKapsoClientService({ deliveryMode, outboundHttp });

const responseWithStatusOutsideFetchRange = (): Response => {
  const response = Response.json({}, { status: 599 });
  Object.defineProperties(response, {
    ok: { value: false },
    status: { value: 600 },
  });
  return response;
};

it.effect("encodes the BSUID message for the published Kapso destination", () =>
  Effect.gen(function* () {
    let outboundRequest: Option.Option<OutboundHttpRequest> = Option.none();
    const service = makeService({
      execute: (request) => {
        outboundRequest = Option.some(request);
        return Effect.succeed({
          status: 200,
          headers: {},
          body: new TextEncoder().encode(
            JSON.stringify({
              messaging_product: "whatsapp",
              messages: [{ id: "wamid.bsuid-outbound" }],
            })
          ),
        });
      },
    });
    const correlationToken = DisclosureDeliveryCorrelationToken.make(
      "11111111-1111-4111-8111-111111111111"
    );

    yield* service.sendText(
      sendInput({
        opaqueCallbackData: Option.some(correlationToken),
      })
    );

    const request = Option.getOrThrow(outboundRequest);
    expect(request.destination).toEqual({
      _tag: "KapsoMessages",
      businessPhoneNumberId: "123456789",
    });
    const requestBody = yield* Schema.decodeEffect(UnknownJsonString)(request.body);
    expect(requestBody).toMatchObject({
      recipient: "CO.573001234567",
      biz_opaque_callback_data: correlationToken,
    });
    expect(requestBody).not.toHaveProperty("to");
  })
);

it.effect("uses to only in explicit sandbox phone mode", () =>
  Effect.gen(function* () {
    let outboundRequest: Option.Option<OutboundHttpRequest> = Option.none();
    const service = makeService(
      {
        execute: (request) => {
          outboundRequest = Option.some(request);
          return Effect.succeed({
            status: 200,
            headers: {},
            body: new TextEncoder().encode(
              JSON.stringify({
                messaging_product: "whatsapp",
                messages: [{ id: "wamid.sandbox-outbound" }],
              })
            ),
          });
        },
      },
      "sandbox-phone"
    );

    yield* service.sendText(sendInput());

    const requestBody = yield* Schema.decodeEffect(UnknownJsonString)(
      Option.getOrThrow(outboundRequest).body
    );
    expect(requestBody).toMatchObject({ to: "573001234567" });
    expect(requestBody).not.toHaveProperty("recipient");
  })
);

it.effect("returns validated provider evidence at the local completion time", () =>
  Effect.gen(function* () {
    const completedAt = DateTime.makeUnsafe("2026-09-01T12:34:56.000Z");
    yield* TestClock.setTime(DateTime.toEpochMillis(completedAt));
    const service = makeService(
      fakeOutboundHttp(() =>
        Response.json({
          messaging_product: "whatsapp",
          messages: [{ id: "wamid.completed" }],
        })
      )
    );

    const sent = yield* service.sendText(sendInput());

    expect(sent).toEqual({
      messageEvidence: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: "wamid.completed",
      },
      sentAt: completedAt,
      responseStatus: 200,
    });
  })
);

it.effect("cancels Effect HTTP execution when delivery is interrupted", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const service = makeService({
      execute: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined))
        ),
    });
    const fiber = yield* service
      .sendText(sendInput())
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);

    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(cancelled);
    const exit = yield* Fiber.await(fiber);

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  })
);

it.effect("classifies the adapter deadline as an ambiguous timeout", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const service = makeService({
      execute: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const fiber = yield* service
      .sendText(sendInput())
      .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* TestClock.adjust("15 seconds");
    const failure = yield* Fiber.join(fiber);

    expect(failure).toEqual(
      expect.objectContaining({
        safeReason: "timeout",
        deliveryCertainty: "ambiguous",
        automaticRetry: false,
      })
    );
  })
);

it.effect("applies the adapter deadline while streaming the response body", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const outboundHttp = yield* makeRealOutboundHttp(
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
    const service = makeService(outboundHttp);
    const fiber = yield* service
      .sendText(sendInput())
      .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* TestClock.adjust("15 seconds");
    const failure = yield* Fiber.join(fiber);
    yield* Deferred.await(cancelled);

    expect(failure).toEqual(
      expect.objectContaining({
        safeReason: "timeout",
        deliveryCertainty: "ambiguous",
        automaticRetry: false,
      })
    );
  })
);

it.effect("classifies every known rejection with safe retry semantics", () =>
  Effect.gen(function* () {
    const cases = [
      {
        response: (): Response =>
          Response.json(
            { error: "Sandbox numbers do not support BSUID recipients" },
            { status: 400 }
          ),
        expected: ["sandbox_bsuid_unsupported", false] as const,
      },
      {
        response: (): Response => Response.json({ error: { code: 131026 } }, { status: 400 }),
        expected: ["invalid_recipient", false] as const,
      },
      {
        response: (): Response => Response.json({ error: { code: 131047 } }, { status: 400 }),
        expected: ["conversation_window_closed", false] as const,
      },
      {
        response: (): Response =>
          Response.json(
            { error: "Rate limit exceeded", message: "Please try again later" },
            { status: 429 }
          ),
        expected: ["rate_limited", true] as const,
      },
      {
        response: (): Response => Response.json({ error: { code: 4 } }, { status: 400 }),
        expected: ["rate_limited", true] as const,
      },
      {
        response: (): Response => Response.json({ error: "bad api key" }, { status: 401 }),
        expected: ["authentication_failed", false] as const,
      },
      {
        response: (): Response => Response.json({ error: "forbidden" }, { status: 403 }),
        expected: ["authentication_failed", false] as const,
      },
      {
        response: (): Response => Response.json({ error: { code: 190 } }, { status: 400 }),
        expected: ["authentication_failed", false] as const,
      },
      {
        response: (): Response => Response.json({ error: { code: 131016 } }, { status: 400 }),
        expected: ["provider_unavailable", true] as const,
      },
      {
        response: (): Response =>
          Response.json({ error: "another provider rejection" }, { status: 400 }),
        expected: ["invalid_response", false] as const,
      },
      {
        response: (): Response => new Response("not-json", { status: 400 }),
        expected: ["invalid_response", false] as const,
      },
      {
        response: responseWithStatusOutsideFetchRange,
        expected: ["invalid_response", false] as const,
      },
    ];

    for (const testCase of cases) {
      const service = makeService(fakeOutboundHttp(testCase.response));
      const failure = yield* service.sendText(sendInput()).pipe(Effect.flip);
      expect(failure).toEqual(
        expect.objectContaining({
          _tag: "KapsoSendFailed",
          safeReason: testCase.expected[0],
          deliveryCertainty: "rejected",
          automaticRetry: testCase.expected[1],
        })
      );
    }
  })
);

it.effect("classifies timeout and transport outcomes as ambiguous and not retryable", () =>
  Effect.gen(function* () {
    const cases = [
      {
        outboundHttp: {
          execute: (): Effect.Effect<OutboundHttpResponse, OutboundHttpFailure> =>
            Effect.fail(
              new OutboundHttpFailure({
                reason: "transport-failed",
                responseStatus: Option.none(),
                responseHeaders: {},
              })
            ),
        } satisfies OutboundHttpService,
        safeReason: "provider_unavailable",
      },
      {
        outboundHttp: fakeOutboundHttp(() => new Response("request timeout", { status: 408 })),
        safeReason: "timeout",
      },
      {
        outboundHttp: fakeOutboundHttp(
          () => new Response("malformed maintenance body", { status: 503 })
        ),
        safeReason: "provider_unavailable",
      },
    ];

    for (const testCase of cases) {
      const service = makeService(testCase.outboundHttp);
      const failure = yield* service.sendText(sendInput()).pipe(Effect.flip);
      expect(failure).toEqual(
        expect.objectContaining({
          safeReason: testCase.safeReason,
          deliveryCertainty: "ambiguous",
          automaticRetry: false,
        })
      );
    }
  })
);

it.effect("cancels a response rejected by the declared byte bound", () =>
  Effect.gen(function* () {
    let requestSignal = Option.none<AbortSignal>();
    let responseBodyCancelled = false;
    const outboundHttp = yield* makeRealOutboundHttp(
      HttpClient.make((request, _url, signal) => {
        requestSignal = Option.some(signal);
        const body = new ReadableStream<Uint8Array>({
          start: (controller): void => controller.enqueue(new Uint8Array([1])),
          cancel: (): void => {
            responseBodyCancelled = true;
          },
        });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              status: 200,
              headers: { "content-length": String(64 * 1_024 + 1) },
            })
          )
        );
      })
    );
    const service = makeService(outboundHttp);

    const failure = yield* service.sendText(sendInput()).pipe(Effect.flip);

    expect(failure).toEqual(
      expect.objectContaining({
        safeReason: "invalid_response",
        deliveryCertainty: "ambiguous",
        automaticRetry: false,
      })
    );
    expect(Option.isSome(requestSignal) && requestSignal.value.aborted).toBe(true);
    expect(responseBodyCancelled).toBe(true);
  })
);

it.effect("fails unknown, malformed, oversized, and incomplete responses closed", () =>
  Effect.gen(function* () {
    const cases = [
      {
        response: (): Response => Response.json({ error: { code: 999_999 } }, { status: 418 }),
        certainty: "rejected",
      },
      {
        response: (): Response => new Response("not-json", { status: 200 }),
        certainty: "ambiguous",
      },
      {
        response: (): Response =>
          new Response("x", {
            status: 200,
            headers: { "content-length": String(64 * 1_024 + 1) },
          }),
        certainty: "ambiguous",
      },
      {
        response: (): Response =>
          new Response("x", {
            status: 400,
            headers: { "content-length": String(64 * 1_024 + 1) },
          }),
        certainty: "rejected",
      },
      {
        response: (): Response =>
          new Response(null, {
            status: 200,
            headers: { "content-length": String(64 * 1_024 + 1) },
          }),
        certainty: "ambiguous",
      },
      {
        response: (): Response => new Response(new Uint8Array(64 * 1_024 + 1), { status: 200 }),
        certainty: "ambiguous",
      },
      {
        response: (): Response =>
          new Response(new Uint8Array(64 * 1_024 + 1), {
            status: 200,
            headers: { "content-length": "1" },
          }),
        certainty: "ambiguous",
      },
      {
        response: (): Response => new Response(new Uint8Array(64 * 1_024 + 1), { status: 400 }),
        certainty: "rejected",
      },
      {
        response: (): Response => new Response(null, { status: 204 }),
        certainty: "ambiguous",
      },
      {
        response: (): Response => Response.json({ messaging_product: "whatsapp", messages: [] }),
        certainty: "ambiguous",
      },
    ];

    for (const testCase of cases) {
      const service = makeService(fakeOutboundHttp(testCase.response));
      const failure = yield* service.sendText(sendInput()).pipe(Effect.flip);
      expect(failure).toEqual(
        expect.objectContaining({
          safeReason: "invalid_response",
          deliveryCertainty: testCase.certainty,
          automaticRetry: false,
        })
      );
    }
  })
);

it.effect("keeps provider bodies and send inputs out of typed failures", () =>
  Effect.gen(function* () {
    const sensitive = {
      credential: "secret-api-key",
      text: "mi saldo privado",
      phone: "+573009998877",
      bsuid: "CO.privatebsuid",
      response: "remote-private-body",
    };
    const service = makeKapsoClientService({
      deliveryMode: "bsuid",
      outboundHttp: fakeOutboundHttp(() =>
        Response.json(
          {
            error: {
              code: 999_999,
              message: sensitive.response,
              error_data: { details: sensitive.phone },
            },
          },
          { status: 400 }
        )
      ),
    });

    const failure = yield* service
      .sendText(
        sendInput({
          destination: {
            recipient: WhatsAppBusinessScopedUserId.make(sensitive.bsuid),
            sandboxPhone: Option.some(E164PhoneNumber.make(sensitive.phone)),
          },
          text: TranscriptText.make(sensitive.text),
        })
      )
      .pipe(Effect.flip);
    const ordinaryOutput = yield* Schema.encodeEffect(UnknownJsonString)(failure);

    expect(ordinaryOutput).toBe(
      '{"safeReason":"invalid_response","deliveryCertainty":"rejected","automaticRetry":false,"responseStatus":{"_id":"Option","_tag":"Some","value":400},"_tag":"KapsoSendFailed"}'
    );
    for (const secret of Object.values(sensitive)) expect(ordinaryOutput).not.toContain(secret);
  })
);

it.effect("rejects sandbox delivery locally when authenticated phone evidence is absent", () =>
  Effect.gen(function* () {
    const service = makeService(
      fakeOutboundHttp(() => Response.json({})),
      "sandbox-phone"
    );

    const failure = yield* service
      .sendText(
        sendInput({
          destination: {
            recipient: WhatsAppBusinessScopedUserId.make("CO.573001234567"),
            sandboxPhone: Option.none(),
          },
        })
      )
      .pipe(Effect.flip);

    expect(failure).toEqual(
      expect.objectContaining({
        safeReason: "invalid_recipient",
        deliveryCertainty: "rejected",
        automaticRetry: false,
      })
    );
  })
);
