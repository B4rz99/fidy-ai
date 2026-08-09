import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
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

const fakeFetch = (response: () => Response): typeof globalThis.fetch =>
  Object.assign(() => Promise.resolve(response()), { preconnect: () => undefined });

const responseWithStatusOutsideFetchRange = (): Response => {
  const response = new Response(null, { status: 599 });
  Object.defineProperties(response, {
    ok: { value: false },
    status: { value: 600 },
  });
  return response;
};

it.effect("uses recipient, never to, for a BSUID destination", () =>
  Effect.gen(function* () {
    let requestBody: unknown;
    const service = makeKapsoClientService({
      apiKey: "test-api-key",
      deliveryMode: "bsuid",
      nativeFetch: Object.assign(
        (_resource: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          requestBody = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(init?.body);
          return Promise.resolve(
            Response.json({
              messaging_product: "whatsapp",
              messages: [{ id: "wamid.bsuid-outbound" }],
            })
          );
        },
        { preconnect: () => undefined }
      ),
    });
    const correlationToken = DisclosureDeliveryCorrelationToken.make(
      "11111111-1111-4111-8111-111111111111"
    );
    yield* service.sendText(
      sendInput({
        destination: {
          recipient: WhatsAppBusinessScopedUserId.make("CO.573001234567"),
          sandboxPhone: Option.some(E164PhoneNumber.make("+573001234567")),
        },
        opaqueCallbackData: Option.some(correlationToken),
      })
    );
    expect(requestBody).toMatchObject({
      recipient: "CO.573001234567",
      biz_opaque_callback_data: correlationToken,
    });
    expect(requestBody).not.toHaveProperty("to");
  })
);

it.effect("uses to only in explicit sandbox phone mode", () =>
  Effect.gen(function* () {
    let requestBody: unknown;
    const service = makeKapsoClientService({
      apiKey: "test-api-key",
      deliveryMode: "sandbox-phone",
      nativeFetch: Object.assign(
        (_resource: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          requestBody = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(init?.body);
          return Promise.resolve(
            Response.json({
              messaging_product: "whatsapp",
              messages: [{ id: "wamid.sandbox-outbound" }],
            })
          );
        },
        { preconnect: () => undefined }
      ),
    });

    yield* service.sendText(sendInput());

    expect(requestBody).toMatchObject({ to: "573001234567" });
    expect(requestBody).not.toHaveProperty("recipient");
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
      const service = makeKapsoClientService({
        apiKey: "test-api-key",
        deliveryMode: "bsuid",
        nativeFetch: fakeFetch(testCase.response),
      });
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
        nativeFetch: Object.assign(
          () => Promise.reject(new DOMException("request timed out", "TimeoutError")),
          { preconnect: () => undefined }
        ),
        safeReason: "timeout",
      },
      {
        nativeFetch: Object.assign(
          () => Promise.reject(new DOMException("request aborted", "AbortError")),
          { preconnect: () => undefined }
        ),
        safeReason: "timeout",
      },
      {
        nativeFetch: Object.assign(() => Promise.reject(new Error("connection reset")), {
          preconnect: () => undefined,
        }),
        safeReason: "provider_unavailable",
      },
      {
        nativeFetch: fakeFetch(() => new Response("request timeout", { status: 408 })),
        safeReason: "timeout",
      },
      {
        nativeFetch: fakeFetch(() => new Response("malformed maintenance body", { status: 503 })),
        safeReason: "provider_unavailable",
      },
      {
        nativeFetch: fakeFetch(() => new Response("outside Fetch status range", { status: 600 })),
        safeReason: "invalid_response",
      },
    ];

    for (const testCase of cases) {
      const service = makeKapsoClientService({
        apiKey: "test-api-key",
        deliveryMode: "bsuid",
        nativeFetch: testCase.nativeFetch,
      });
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
      const service = makeKapsoClientService({
        apiKey: "test-api-key",
        deliveryMode: "bsuid",
        nativeFetch: fakeFetch(testCase.response),
      });
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
      nativeFetch: fakeFetch(() =>
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
    const ordinaryOutput = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(failure);

    expect(ordinaryOutput).toBe(
      '{"safeReason":"invalid_response","deliveryCertainty":"rejected","automaticRetry":false,"_tag":"KapsoSendFailed"}'
    );
    for (const secret of Object.values(sensitive)) expect(ordinaryOutput).not.toContain(secret);
  })
);

it.effect("rejects sandbox delivery locally when authenticated phone evidence is absent", () =>
  Effect.gen(function* () {
    const service = makeKapsoClientService({
      apiKey: "test-api-key",
      deliveryMode: "sandbox-phone",
      nativeFetch: fakeFetch(() => Response.json({})),
    });

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
