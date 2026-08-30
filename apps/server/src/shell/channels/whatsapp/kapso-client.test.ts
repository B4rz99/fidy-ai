import { UnknownJsonString } from "~/schema-compatibility";
import { expect, it } from "@effect/vitest";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  Stream,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { E164PhoneNumber, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
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

const fakeHttpClient = (response: () => Response): HttpClient.HttpClient =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response())));

const makeService = (
  httpClient: HttpClient.HttpClient,
  deliveryMode: "bsuid" | "sandbox-phone" = "bsuid"
): KapsoClientService =>
  makeKapsoClientService({ apiKey: "test-api-key", deliveryMode, httpClient });

const responseWithStatusOutsideFetchRange = (): Response => {
  const response = Response.json({}, { status: 599 });
  Object.defineProperties(response, {
    ok: { value: false },
    status: { value: 600 },
  });
  return response;
};

it.effect("uses recipient without forwarding trace propagation to Kapso", () =>
  Effect.gen(function* () {
    let requestBody: unknown;
    let requestHeaders = new Headers();
    const service = makeService(
      HttpClient.make((request) => {
        if (request.body._tag !== "Uint8Array") return Effect.die("missing request body");
        requestBody = Schema.decodeSync(UnknownJsonString)(
          new TextDecoder().decode(request.body.body)
        );
        requestHeaders = new Headers(request.headers);
        expect(request.method).toBe("POST");
        expect(request.url).toBe("https://api.kapso.ai/meta/whatsapp/v24.0/123456789/messages");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              messaging_product: "whatsapp",
              messages: [{ id: "wamid.bsuid-outbound" }],
            })
          )
        );
      })
    );
    const correlationToken = DisclosureDeliveryCorrelationToken.make(
      "11111111-1111-4111-8111-111111111111"
    );
    yield* service
      .sendText(
        sendInput({
          destination: {
            recipient: WhatsAppBusinessScopedUserId.make("CO.573001234567"),
            sandboxPhone: Option.some(E164PhoneNumber.make("+573001234567")),
          },
          opaqueCallbackData: Option.some(correlationToken),
        })
      )
      .pipe(
        Effect.withSpan("test active propagation"),
        Effect.provideService(Tracer.DisablePropagation, false),
        Effect.provideService(HttpClient.TracerPropagationEnabled, true)
      );
    expect(requestBody).toMatchObject({
      recipient: "CO.573001234567",
      biz_opaque_callback_data: correlationToken,
    });
    expect(requestBody).not.toHaveProperty("to");
    expect(requestHeaders.get("content-type")).toBe("application/json");
    expect(requestHeaders.get("x-api-key")).toBe("test-api-key");
    expect(Array.from(requestHeaders.keys())).not.toEqual(
      expect.arrayContaining(["b3", "baggage", "sentry-trace", "traceparent", "tracestate"])
    );
  })
);

it.effect("uses to only in explicit sandbox phone mode", () =>
  Effect.gen(function* () {
    let requestBody: unknown;
    const service = makeService(
      HttpClient.make((request) => {
        if (request.body._tag !== "Uint8Array") return Effect.die("missing request body");
        requestBody = Schema.decodeSync(UnknownJsonString)(
          new TextDecoder().decode(request.body.body)
        );
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              messaging_product: "whatsapp",
              messages: [{ id: "wamid.sandbox-outbound" }],
            })
          )
        );
      }),
      "sandbox-phone"
    );

    yield* service.sendText(sendInput());

    expect(requestBody).toMatchObject({ to: "573001234567" });
    expect(requestBody).not.toHaveProperty("recipient");
  })
);

it.effect("returns validated provider evidence at the local completion time", () =>
  Effect.gen(function* () {
    const completedAt = DateTime.makeUnsafe("2026-09-01T12:34:56.000Z");
    yield* TestClock.setTime(DateTime.toEpochMillis(completedAt));
    const service = makeService(
      fakeHttpClient(() =>
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
    const service = makeService(
      HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined))
        )
      )
    );
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
    const service = makeService(
      HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
    );
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
    const service = makeService(
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
      const service = makeService(fakeHttpClient(testCase.response));
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
        httpClient: HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            })
          )
        ),
        safeReason: "provider_unavailable",
      },
      {
        httpClient: fakeHttpClient(() => new Response("request timeout", { status: 408 })),
        safeReason: "timeout",
      },
      {
        httpClient: fakeHttpClient(
          () => new Response("malformed maintenance body", { status: 503 })
        ),
        safeReason: "provider_unavailable",
      },
    ];

    for (const testCase of cases) {
      const service = makeService(testCase.httpClient);
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
    const service = makeService(
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
      const service = makeService(fakeHttpClient(testCase.response));
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
      apiKey: sensitive.credential,
      deliveryMode: "bsuid",
      httpClient: fakeHttpClient(() =>
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
      fakeHttpClient(() => Response.json({})),
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
