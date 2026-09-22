import assert from "node:assert/strict";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { expect, it } from "@effect/vitest";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { E164PhoneNumber, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import {
  OutboundHttpFailure,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
} from "~/shell/outbound-http/contract";
import type { OutboundHttpService } from "~/shell/outbound-http/operations";
import { TelemetryHttpStatus } from "~/shell/observability/contract";
import { type KapsoClientService, KapsoSendFailed, makeKapsoClientService } from "./kapso-client";
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
    if (request._tag !== "KapsoMessages") return yield* Effect.die("unexpected destination");
    expect(request).toMatchObject({
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

    const request = Option.getOrThrow(outboundRequest);
    if (request._tag !== "KapsoMessages") return yield* Effect.die("unexpected destination");
    const requestBody = yield* Schema.decodeEffect(UnknownJsonString)(request.body);
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

it.effect("maps redirect responses to closed definitive failures", () =>
  Effect.gen(function* () {
    for (const status of [302, 307, 308]) {
      const service = makeService({
        execute: () =>
          Effect.succeed({
            status,
            headers: {},
            body: new TextEncoder().encode("private redirect body"),
          }),
      });

      const exit = yield* service.sendText(sendInput()).pipe(Effect.exit);
      const unannotatedExit = Exit.isFailure(exit)
        ? Exit.fail(Option.getOrThrow(Cause.findErrorOption(exit.cause)))
        : exit;

      assert.deepStrictEqual(
        unannotatedExit,
        Exit.fail(
          new KapsoSendFailed({
            safeReason: "invalid_response",
            deliveryCertainty: "rejected",
            automaticRetry: false,
            responseStatus: Option.some(TelemetryHttpStatus.make(status)),
          })
        )
      );
      expect(String(exit)).not.toContain("private redirect body");
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
