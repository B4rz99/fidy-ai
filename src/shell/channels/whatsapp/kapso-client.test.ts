import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { E164PhoneNumber } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import { makeKapsoClientService } from "./kapso-client";
import { WhatsAppBusinessPhoneNumberId } from "./model";

const input = {
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
  to: E164PhoneNumber.make("+573001234567"),
  text: TranscriptText.make("hola"),
};

const fakeFetch = (response: () => Response): typeof globalThis.fetch =>
  Object.assign(() => Promise.resolve(response()), { preconnect: () => undefined });

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
      const failure = yield* service.sendText(input).pipe(Effect.flip);
      expect(failure._tag).toBe("KapsoSendFailed");
      expect(failure.safeReason).toBe("invalid_response");
    }
  })
);
