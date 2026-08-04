import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { decodeKapsoWebhook } from "./kapso-webhook";

const fixtureBytes = (name: "kapso-text-v2.json" | "kapso-voice-v2.json") =>
  Effect.promise(() => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).bytes());
const receivedAt = DateTime.makeUnsafe("2026-04-03T12:00:02.000Z");
const secret = "test-webhook-secret-32-characters";
const signedInput = (rawBody: Uint8Array, deliveryKey = "delivery-signed") => ({
  rawBody,
  secret,
  signature: new Bun.CryptoHasher("sha256", secret).update(rawBody).digest("hex"),
  deliveryKey,
  receivedAt,
});

it.effect("rejects an invalid Kapso signature before decoding provider content", () =>
  Effect.gen(function* () {
    const rawBody = yield* fixtureBytes("kapso-text-v2.json");
    const failure = yield* decodeKapsoWebhook({
      rawBody,
      secret: "test-webhook-secret-32-characters",
      signature: "0".repeat(64),
      deliveryKey: "delivery-invalid",
      receivedAt,
    }).pipe(Effect.flip);

    expect(failure._tag).toBe("InvalidKapsoSignature");
  })
);

it.effect("bounds and validates authenticated webhook envelopes", () =>
  Effect.gen(function* () {
    const fixture = yield* fixtureBytes("kapso-text-v2.json");
    const tooLarge = yield* decodeKapsoWebhook({
      ...signedInput(new Uint8Array(1_048_577)),
    }).pipe(Effect.flip);
    expect(tooLarge._tag).toBe("KapsoPayloadTooLarge");

    const shortSecret = yield* decodeKapsoWebhook({
      ...signedInput(fixture),
      secret: "too-short",
    }).pipe(Effect.flip);
    expect(shortSecret._tag).toBe("InvalidKapsoSignature");

    const malformed = new TextEncoder().encode("not json");
    const invalidJson = yield* decodeKapsoWebhook(signedInput(malformed)).pipe(Effect.flip);
    expect(invalidJson._tag).toBe("InvalidKapsoPayload");

    const invalidDelivery = yield* decodeKapsoWebhook(signedInput(fixture, "")).pipe(Effect.flip);
    expect(invalidDelivery._tag).toBe("InvalidKapsoPayload");

    const eventJson = new TextDecoder().decode(fixture);
    const oversizedBatch = new TextEncoder().encode(
      `{"batch":true,"data":[${Array.from({ length: 101 }, () => eventJson).join(",")}]}`
    );
    const tooMany = yield* decodeKapsoWebhook(signedInput(oversizedBatch)).pipe(Effect.flip);
    expect(tooMany._tag).toBe("KapsoBatchTooLarge");
  })
);

it.effect("normalizes prefixed senders and rejects unsafe projected event fields", () =>
  Effect.gen(function* () {
    const fixture = new TextDecoder().decode(yield* fixtureBytes("kapso-text-v2.json"));
    const prefixed = new TextEncoder().encode(fixture.replace('"from": "573', '"from": "+573'));
    const decoded = yield* decodeKapsoWebhook(signedInput(prefixed));
    expect(decoded.events[0].phoneNumber).toBe("+573001234567");

    const unsafeTimestamp = new TextEncoder().encode(
      fixture.replace('"timestamp": "1775217600"', '"timestamp": "9999999999999999"')
    );
    expect((yield* decodeKapsoWebhook(signedInput(unsafeTimestamp)).pipe(Effect.flip))._tag).toBe(
      "InvalidKapsoPayload"
    );

    const future = new TextEncoder().encode(
      fixture.replace('"timestamp": "1775217600"', '"timestamp": "1775221200"')
    );
    expect((yield* decodeKapsoWebhook(signedInput(future)).pipe(Effect.flip))._tag).toBe(
      "InvalidKapsoPayload"
    );

    const invalidPhone = new TextEncoder().encode(
      fixture.replace('"from": "573001234567"', '"from": "not-a-phone"')
    );
    expect((yield* decodeKapsoWebhook(signedInput(invalidPhone)).pipe(Effect.flip))._tag).toBe(
      "InvalidKapsoPayload"
    );
  })
);

it.effect("decodes recorded Kapso text and voice payloads into bounded WhatsApp evidence", () =>
  Effect.gen(function* () {
    const text = yield* decodeKapsoWebhook({
      rawBody: yield* fixtureBytes("kapso-text-v2.json"),
      secret: "test-webhook-secret-32-characters",
      signature: "2c9e6d0ce2b1d348e540f8e3ed623cd633aa39e09c2b96f1c782008186e0352f",
      deliveryKey: "delivery-text",
      receivedAt,
    });
    const voice = yield* decodeKapsoWebhook({
      rawBody: yield* fixtureBytes("kapso-voice-v2.json"),
      secret: "test-webhook-secret-32-characters",
      signature: "181344306f695b38d012453d4a3d12cd97917c5aa3d5db1e598ad5cd2d7f77ad",
      deliveryKey: "delivery-voice",
      receivedAt,
    });

    expect(text.events).toMatchObject([
      {
        messageEvidence: {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: "wamid.text-001",
        },
        phoneNumber: "+573001234567",
        businessPhoneNumberId: "123456789012345",
        content: { _tag: "Text", text: "almuerzo 25 mil" },
      },
    ]);
    expect(voice.events).toMatchObject([
      {
        messageEvidence: { providerMessageId: "wamid.voice-001" },
        content: {
          _tag: "VoiceTranscript",
          text: "taxi 18 mil",
          mediaId: "media-001",
        },
      },
    ]);
  })
);
