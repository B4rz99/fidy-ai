import { TranscriptText } from "~/core/agent/contract";
import { WhatsAppImage, WhatsAppMediaId } from "~/shell/channels/whatsapp/contract";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Redacted } from "effect";
import { authenticateWhatsAppInbound } from "~/shell/channels/whatsapp/operations";

const fixture = await Bun.file(
  new URL(
    "../../../../src/shell/channels/whatsapp/internal/fixtures/kapso-bsuid-image-v2.json",
    import.meta.url
  )
).text();

const secret = "kapso-image-webhook-secret-32-characters";

const receivedAt = DateTime.makeUnsafe("2026-04-03T12:10:00.000Z");

const decode = (
  body = fixture,
  signature?: string
): ReturnType<typeof authenticateWhatsAppInbound> => {
  const rawBody = new TextEncoder().encode(body);

  return authenticateWhatsAppInbound({
    rawBody,
    secret: Redacted.make(secret),
    signature: signature ?? new Bun.CryptoHasher("sha256", secret).update(rawBody).digest("hex"),
    deliveryKey: "image-delivery-001",
    businessPortfolioId: "123456789",
    receivedAt,
  });
};

it.effect(
  "projects authenticated image identity and caption without trusting provider media helpers",
  () =>
    Effect.gen(function* () {
      const receipt = yield* decode();
      expect(receipt.events).toHaveLength(1);
      const event = receipt.events[0];
      expect(event.content).toEqual(
        WhatsAppImage.make({
          mediaId: WhatsAppMediaId.make("media_image_123"),
          caption: Option.some(TranscriptText.make("Recibo del mercado")),
        })
      );
      expect(event.caller.businessScopedUserId).toBe("CO.13491208655302741918");
      expect(event.caller.phoneNumber).toEqual(Option.none());
      expect(event.messageEvidence.providerMessageId).toBe("wamid.bsuid-image-001");
    })
);

it.effect("keeps caption absence distinct from provider-generated media content", () =>
  Effect.forEach(
    [
      fixture.replace(',\n      "caption": "Recibo del mercado"', ""),
      fixture.replace('"caption": "Recibo del mercado"', '"caption": null'),
    ],
    (body) =>
      Effect.gen(function* () {
        const receipt = yield* decode(body);
        expect(receipt.events[0].content).toEqual(
          WhatsAppImage.make({
            mediaId: WhatsAppMediaId.make("media_image_123"),
            caption: Option.none(),
          })
        );
      }),
    { discard: true }
  )
);

it.effect(
  "rejects forged image proof, conflicting BSUIDs and malformed media fields before projection",
  () =>
    Effect.gen(function* () {
      const forged = yield* decode(fixture, "00".repeat(32)).pipe(Effect.flip);
      expect(forged._tag).toBe("InvalidWhatsAppSignature");

      const invalid = [
        fixture.replace('"media_image_123"', '""'),
        fixture.replace('"media_image_123"', '"   "'),
        fixture.replace('"caption": "Recibo del mercado"', '"caption": 123'),
        fixture.replace(
          '"from_user_id": "CO.13491208655302741918"',
          '"from_user_id": "CO.99999999999999999999"'
        ),
      ];

      yield* Effect.forEach(
        invalid,
        (body) =>
          Effect.gen(function* () {
            expect((yield* decode(body).pipe(Effect.flip))._tag).toBe("InvalidWhatsAppPayload");
          }),
        { discard: true }
      );
    })
);
