import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { makeKapsoIdentityChangeBody } from "~/shell/testing/kapso-identity-change";
import { decodeKapsoIdentityWebhook, decodeKapsoWebhook } from "./kapso-webhook";

const fixtureBytes = (
  name: "kapso-text-v2.json" | "kapso-voice-v2.json" | "kapso-bsuid-text-v2.json"
): Effect.Effect<Uint8Array<ArrayBuffer>> =>
  Effect.promise(() => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).bytes());
const encodeJsonBody = (value: unknown): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(Schema.encodeSync(Schema.UnknownFromJsonString)(value));
const receivedAt = DateTime.makeUnsafe("2026-04-03T12:00:02.000Z");
const secret = "test-webhook-secret-32-characters";
const signedInput = (
  rawBody: Uint8Array,
  deliveryKey = "delivery-signed"
): {
  rawBody: Uint8Array;
  secret: string;
  signature: string;
  deliveryKey: string;
  businessPortfolioId: string;
  receivedAt: DateTime.Utc;
} => ({
  rawBody,
  secret,
  signature: new Bun.CryptoHasher("sha256", secret).update(rawBody).digest("hex"),
  deliveryKey,
  businessPortfolioId: "portfolio-test",
  receivedAt,
});

it.effect("projects a provider-authenticated BSUID identity change", () =>
  Effect.gen(function* () {
    const rawBody = makeKapsoIdentityChangeBody();

    const changes = yield* decodeKapsoIdentityWebhook(signedInput(rawBody));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      previousCaller: {
        businessPortfolioId: "portfolio-test",
        businessScopedUserId: "CO.573001234567",
      },
      replacement: {
        businessScopedUserId: "CO.573009876543",
        phoneNumber: Option.some("+573009876543"),
      },
    });
  })
);

it.effect("rejects forged or internally inconsistent identity changes", () =>
  Effect.gen(function* () {
    const rawBody = makeKapsoIdentityChangeBody();
    const forged = yield* decodeKapsoIdentityWebhook({
      ...signedInput(rawBody),
      signature: "0".repeat(64),
    }).pipe(Effect.flip);
    expect(forged._tag).toBe("InvalidKapsoSignature");

    const inconsistentBody = makeKapsoIdentityChangeBody({
      systemUserId: "CO.different456",
    });
    const inconsistent = yield* decodeKapsoIdentityWebhook(signedInput(inconsistentBody)).pipe(
      Effect.flip
    );
    expect(inconsistent._tag).toBe("InvalidKapsoPayload");
  })
);

it.effect("bounds, filters, and validates authenticated identity envelopes", () =>
  Effect.gen(function* () {
    const oversized = new Uint8Array(1_048_577);
    expect((yield* decodeKapsoIdentityWebhook(signedInput(oversized)).pipe(Effect.flip))._tag).toBe(
      "KapsoPayloadTooLarge"
    );

    const validBody = makeKapsoIdentityChangeBody();
    expect(
      (yield* decodeKapsoIdentityWebhook({
        ...signedInput(validBody),
        secret: "too-short",
      }).pipe(Effect.flip))._tag
    ).toBe("InvalidKapsoSignature");

    const malformedBody = makeKapsoIdentityChangeBody({ systemBody: "not a transition" });
    expect(
      (yield* decodeKapsoIdentityWebhook(signedInput(malformedBody)).pipe(Effect.flip))._tag
    ).toBe("InvalidKapsoPayload");

    const unrelatedBody = encodeJsonBody({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { messages: [{ type: "text" }] } }] }],
    });
    expect(yield* decodeKapsoIdentityWebhook(signedInput(unrelatedBody))).toEqual([]);

    const noMessagesBody = encodeJsonBody({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: {} }] }],
    });
    expect(yield* decodeKapsoIdentityWebhook(signedInput(noMessagesBody))).toEqual([]);

    const message = {
      id: "wamid.identity-change-batch",
      timestamp: "1775217600",
      type: "system",
      system: {
        body: "User Ada changed from CO.573001234567 to CO.573009876543",
        user_id: "CO.573009876543",
        type: "user_changed_user_id",
      },
    };
    const oversizedBatch = encodeJsonBody({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [{ value: { messages: Array.from({ length: 101 }, () => message) } }],
        },
      ],
    });
    expect(
      (yield* decodeKapsoIdentityWebhook(signedInput(oversizedBatch)).pipe(Effect.flip))._tag
    ).toBe("KapsoBatchTooLarge");
  })
);

it.effect("rejects an invalid Kapso signature before decoding provider content", () =>
  Effect.gen(function* () {
    const rawBody = yield* fixtureBytes("kapso-text-v2.json");
    const failure = yield* decodeKapsoWebhook({
      rawBody,
      secret: "test-webhook-secret-32-characters",
      signature: "0".repeat(64),
      deliveryKey: "delivery-invalid",
      businessPortfolioId: "portfolio-test",
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
    expect(invalidJson.cause).toBeInstanceOf(Error);
    expect(invalidJson.message.length).toBeGreaterThan(0);

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
    expect(Option.getOrThrow(decoded.events[0].caller.phoneNumber)).toBe("+573001234567");

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

it.effect("accepts null for optional Kapso message identity evidence", () =>
  Effect.gen(function* () {
    const fixture = new TextDecoder().decode(yield* fixtureBytes("kapso-text-v2.json"));
    const rawBody = new TextEncoder().encode(
      fixture.replace(
        '"from_user_id": "CO.573001234567",',
        '"from_user_id": "CO.573001234567",\n    "from_parent_user_id": null,'
      )
    );

    const decoded = yield* decodeKapsoWebhook(signedInput(rawBody, "delivery-null-parent"));

    expect(decoded.events[0].caller.parentBusinessScopedUserId).toEqual(Option.none());
  })
);

it.effect("decodes recorded Kapso text and voice payloads into bounded WhatsApp evidence", () =>
  Effect.gen(function* () {
    const textBytes = yield* fixtureBytes("kapso-text-v2.json");
    const voiceBytes = yield* fixtureBytes("kapso-voice-v2.json");
    const text = yield* decodeKapsoWebhook(signedInput(textBytes, "delivery-text"));
    const voice = yield* decodeKapsoWebhook(signedInput(voiceBytes, "delivery-voice"));

    expect(text.events).toMatchObject([
      {
        messageEvidence: {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: "wamid.text-001",
        },
        caller: {
          businessPortfolioId: "portfolio-test",
          businessScopedUserId: "CO.573001234567",
          phoneNumber: { _tag: "Some", value: "+573001234567" },
        },
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

it.effect("accepts a BSUID-only sender without inventing a phone number", () =>
  Effect.gen(function* () {
    const rawBody = yield* fixtureBytes("kapso-bsuid-text-v2.json");
    const decoded = yield* decodeKapsoWebhook(signedInput(rawBody, "delivery-bsuid"));

    expect(decoded.events[0]).toMatchObject({
      caller: {
        businessPortfolioId: "portfolio-test",
        businessScopedUserId: "CO.13491208655302741918",
        phoneNumber: { _tag: "None" },
        username: { _tag: "Some", value: "@sheena" },
      },
      content: { _tag: "Text", text: "mercado 40 mil" },
    });
  })
);
