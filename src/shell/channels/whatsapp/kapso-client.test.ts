import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import { type KapsoClientService, makeKapsoClientService } from "./kapso-client";
import { WhatsAppBusinessPhoneNumberId } from "./model";

const sendInput = (
  overrides: Partial<Parameters<KapsoClientService["sendText"]>[0]> = {}
): Parameters<KapsoClientService["sendText"]>[0] => ({
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
  destination: { recipient: WhatsAppBusinessScopedUserId.make("CO.573001234567") },
  text: TranscriptText.make("hola"),
  ...overrides,
});

const fakeFetch = (response: () => Response): typeof globalThis.fetch =>
  Object.assign(() => Promise.resolve(response()), { preconnect: () => undefined });

it.effect("uses recipient, never to, for a BSUID destination", () =>
  Effect.gen(function* () {
    let requestBody: unknown;
    const service = makeKapsoClientService({
      apiKey: "test-api-key",
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
    yield* service.sendText(
      sendInput({
        destination: {
          recipient: WhatsAppBusinessScopedUserId.make("CO.573001234567"),
        },
      })
    );
    expect(requestBody).toMatchObject({ recipient: "CO.573001234567" });
    expect(requestBody).not.toHaveProperty("to");
  })
);

it.effect("rejects malformed, incomplete, and oversized Kapso responses", () =>
  Effect.gen(function* () {
    const responses = [
      () => new Response("not-json", { status: 200 }),
      () => Response.json({ messaging_product: "whatsapp", messages: [] }),
      () =>
        new Response("x", {
          status: 200,
          headers: { "content-length": String(64 * 1_024 + 1) },
        }),
    ];
    for (const response of responses) {
      const service = makeKapsoClientService({
        apiKey: "test-api-key",
        nativeFetch: fakeFetch(response),
      });
      const failure = yield* service.sendText(sendInput()).pipe(Effect.flip);
      expect(failure._tag).toBe("KapsoSendFailed");
      expect(failure.safeReason).toBe("invalid_response");
    }
  })
);
