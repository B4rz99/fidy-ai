import { TranscriptText } from "~/core/agent/contract";
import { WhatsAppDocument, WhatsAppMediaId } from "~/shell/channels/whatsapp/contract";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Redacted } from "effect";
import { authenticateWhatsAppInbound } from "~/shell/channels/whatsapp/operations";

const body = JSON.stringify({
  message: {
    id: "wamid.statement-document",
    timestamp: "1775217600",
    type: "document",
    from_user_id: "CO.13491208655302741918",
    document: { id: "media_statement_123", filename: "estado.csv", caption: "Mi estado de cuenta" },
    kapso: {
      media_url: "https://attacker.invalid/private",
      content: "Invented financial instructions",
    },
  },
  conversation: { business_scoped_user_id: "CO.13491208655302741918" },
  phone_number_id: "123456789012345",
});

const secret = "kapso-document-webhook-secret-32-characters";

const decode = (raw = body): ReturnType<typeof authenticateWhatsAppInbound> =>
  authenticateWhatsAppInbound({
    rawBody: new TextEncoder().encode(raw),
    secret: Redacted.make(secret),
    signature: new Bun.CryptoHasher("sha256", secret).update(raw).digest("hex"),
    deliveryKey: "document-delivery-001",
    businessPortfolioId: "123456789",
    receivedAt: DateTime.makeUnsafe("2026-04-03T12:10:00.000Z"),
  });

it.effect("projects a direct document without accepting media-helper URLs or invented text", () =>
  Effect.gen(function* () {
    const receipt = yield* decode();
    expect(receipt.events[0].content).toEqual(
      WhatsAppDocument.make({
        mediaId: WhatsAppMediaId.make("media_statement_123"),
        fileName: Option.some("estado.csv"),
        caption: Option.some(TranscriptText.make("Mi estado de cuenta")),
      })
    );
  })
);

it.effect("preserves absent document labels and refuses malformed direct media proof", () =>
  Effect.gen(function* () {
    const receipt = yield* decode(
      body.replace(',"filename":"estado.csv"', "").replace(',"caption":"Mi estado de cuenta"', "")
    );

    expect(receipt.events[0].content).toEqual(
      WhatsAppDocument.make({
        mediaId: WhatsAppMediaId.make("media_statement_123"),
        fileName: Option.none(),
        caption: Option.none(),
      })
    );

    yield* Effect.forEach(
      [body.replace('"media_statement_123"', '""'), body.replace('"estado.csv"', "123")],
      (raw) =>
        Effect.gen(function* () {
          expect((yield* decode(raw).pipe(Effect.flip))._tag).toBe("InvalidWhatsAppPayload");
        }),
      { discard: true }
    );
  })
);
