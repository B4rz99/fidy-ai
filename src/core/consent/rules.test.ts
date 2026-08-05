import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { DisclosureSnapshot, PendingConsentExchangeId } from "./model";
import { decideConsentReply, hasPendingConsentExpired, makePendingConsentDraft } from "./rules";

const makeDisclosure = () =>
  Schema.decodeUnknownSync(DisclosureSnapshot)({
    serviceMarket: "CO",
    locale: "es-CO",
    revision: "onboarding-2026-01",
    contentSha256: "a".repeat(64),
    text: "Fidy solicita tu autorización expresa para tratar tus datos personales.",
    policy: {
      publicUrl: "https://fidyapp.com/politica",
      revision: "policy-2026-01",
      contentSha256: "b".repeat(64),
    },
    purposes: ["Registrar y organizar tus finanzas personales"],
    dataCategories: ["Datos financieros"],
    duration: "Mientras uses Fidy o hasta que revoques tu autorización.",
    revocationMethod: "Solicítala por chat.",
  });

describe("consent reply decision", () => {
  it.effect("accepts only explicit authorization replies", () =>
    Effect.gen(function* () {
      expect(yield* decideConsentReply({ _tag: "Choice", choice: "accept" })).toEqual({
        _tag: "Accepted",
      });
      expect(yield* decideConsentReply({ _tag: "Text", text: "Acepto" })).toEqual({
        _tag: "Accepted",
      });
      expect(yield* decideConsentReply({ _tag: "Text", text: "Sí, acepto" })).toEqual({
        _tag: "Accepted",
      });
    })
  );

  it.effect("does not treat bare agreement or a finance request as legal acceptance", () =>
    Effect.gen(function* () {
      expect(yield* decideConsentReply({ _tag: "Text", text: "sí" })).toEqual({
        _tag: "Clarify",
      });
      expect(yield* decideConsentReply({ _tag: "Text", text: "almuerzo 25 mil" })).toEqual({
        _tag: "Clarify",
      });
    })
  );

  it.effect("recognizes an explicit decline without confusing it with acceptance", () =>
    Effect.gen(function* () {
      expect(yield* decideConsentReply({ _tag: "Choice", choice: "decline" })).toEqual({
        _tag: "Declined",
      });
      expect(yield* decideConsentReply({ _tag: "Text", text: "No acepto" })).toEqual({
        _tag: "Declined",
      });
      expect(yield* decideConsentReply({ _tag: "Text", text: "No autorizo" })).toEqual({
        _tag: "Declined",
      });
    })
  );
});

it.effect("expires a pending disclosure exactly 24 hours after creation", () =>
  Effect.gen(function* () {
    const createdAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");
    const pending = yield* makePendingConsentDraft({
      id: PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000811"),
      disclosure: makeDisclosure(),
      initiatingMessage: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: "wamid.expiry-initiator",
      },
      createdAt,
    });

    expect(DateTime.formatIso(pending.expiresAt)).toBe("2026-08-02T12:00:00.000Z");
    expect(
      yield* hasPendingConsentExpired({
        pending,
        now: DateTime.makeUnsafe("2026-08-02T11:59:59.999Z"),
      })
    ).toBe(false);
    expect(
      yield* hasPendingConsentExpired({
        pending,
        now: DateTime.makeUnsafe("2026-08-02T12:00:00Z"),
      })
    ).toBe(true);
  })
);
