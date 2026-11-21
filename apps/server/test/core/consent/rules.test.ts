import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import {
  ConsentInboundContent,
  ConsentReplyDecision,
  DisclosureSnapshot,
  PendingConsentExchangeId,
} from "~/core/consent/contract";
import {
  decideConsentReply,
  hasPendingConsentExpired,
  makePendingConsentDraft,
} from "~/core/consent/operations";

const Content = ConsentInboundContent.pipe(Schema.toTaggedUnion("_tag")).cases;

const makeDisclosure = (): DisclosureSnapshot =>
  Schema.decodeSync(DisclosureSnapshot)({
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
      expect(yield* decideConsentReply(Content.Choice.make({ choice: "accept" }))).toEqual(
        ConsentReplyDecision.Accepted()
      );
      expect(yield* decideConsentReply(Content.Text.make({ text: "Acepto" }))).toEqual(
        ConsentReplyDecision.Accepted()
      );
      expect(yield* decideConsentReply(Content.Text.make({ text: "Sí, acepto" }))).toEqual(
        ConsentReplyDecision.Accepted()
      );
    })
  );

  it.effect("normalizes surrounding whitespace, repeated spaces, and trailing punctuation", () =>
    Effect.gen(function* () {
      expect(yield* decideConsentReply(Content.Text.make({ text: "  SÍ,   ACEPTO!!  " }))).toEqual(
        ConsentReplyDecision.Accepted()
      );
    })
  );

  it.effect("does not erase punctuation from inside a reply", () =>
    Effect.gen(function* () {
      expect(yield* decideConsentReply(Content.Text.make({ text: "A.cepto" }))).toEqual(
        ConsentReplyDecision.Clarify()
      );
    })
  );

  it.effect("does not treat bare agreement or a finance request as legal acceptance", () =>
    Effect.gen(function* () {
      expect(yield* decideConsentReply(Content.Text.make({ text: "sí" }))).toEqual(
        ConsentReplyDecision.Clarify()
      );
      expect(yield* decideConsentReply(Content.Text.make({ text: "almuerzo 25 mil" }))).toEqual(
        ConsentReplyDecision.Clarify()
      );
    })
  );

  it.effect("recognizes an explicit decline without confusing it with acceptance", () =>
    Effect.gen(function* () {
      expect(yield* decideConsentReply(Content.Choice.make({ choice: "decline" }))).toEqual(
        ConsentReplyDecision.Declined()
      );
      expect(yield* decideConsentReply(Content.Text.make({ text: "No acepto" }))).toEqual(
        ConsentReplyDecision.Declined()
      );
      expect(yield* decideConsentReply(Content.Text.make({ text: "No autorizo" }))).toEqual(
        ConsentReplyDecision.Declined()
      );
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

    expect(pending.disclosure.purposes).toEqual(["Registrar y organizar tus finanzas personales"]);
    expect(pending.disclosure.dataCategories).toEqual(["Datos financieros"]);
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
