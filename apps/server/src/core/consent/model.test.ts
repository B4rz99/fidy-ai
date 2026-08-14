import { expect, it } from "@effect/vitest";
import { Option, Result, Schema } from "effect";
import {
  E164PhoneNumber,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
import {
  ConsentInboundContent,
  ConsentRecord,
  DisclosureRevision,
  DisclosureSnapshot,
  PendingConsentExchange,
  PolicyRevision,
  PolicyUrl,
  Sha256Digest,
} from "./model";

type DisclosureInput = typeof DisclosureSnapshot.Encoded;

const makeDisclosure = (overrides: Partial<DisclosureInput> = {}): DisclosureInput => ({
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
  dataCategories: ["Datos de identidad y contacto", "Datos financieros"],
  duration: "Mientras uses Fidy o hasta que revoques tu autorización.",
  revocationMethod: "Solicítala por chat o mediante el canal indicado en la política.",
  ...overrides,
});

const makeEvidence = (
  providerMessageId: string
): { channel: string; provider: string; providerMessageId: string } => ({
  channel: "whatsapp",
  provider: "kapso",
  providerMessageId,
});

it("requires policy revisions to match their complete lexical grammar", () => {
  for (const revision of ["@policy-2026-01", "policy-2026-01@"]) {
    expect(Result.isFailure(Schema.decodeUnknownResult(PolicyRevision)(revision))).toBe(true);
  }
});

it("requires disclosure revisions to match their complete lexical grammar", () => {
  for (const revision of ["@onboarding-2026-01", "onboarding-2026-01@"]) {
    expect(Result.isFailure(Schema.decodeUnknownResult(DisclosureRevision)(revision))).toBe(true);
  }
});

it("requires a SHA-256 digest to occupy the complete input", () => {
  const digest = "a".repeat(64);

  expect(Result.isFailure(Schema.decodeUnknownResult(Sha256Digest)(`!${digest}`))).toBe(true);
  expect(Result.isFailure(Schema.decodeUnknownResult(Sha256Digest)(`${digest}!`))).toBe(true);
});

it("requires a policy URL to be HTTPS without ignored prefixes or suffixes", () => {
  expect(
    Result.isFailure(Schema.decodeUnknownResult(PolicyUrl)("xhttps://fidyapp.com/politica"))
  ).toBe(true);
  expect(
    Result.isFailure(Schema.decodeUnknownResult(PolicyUrl)("https://fidyapp.com/politica trailing"))
  ).toBe(true);
});

it("decodes text and every supported explicit consent choice", () => {
  for (const content of [
    { _tag: "Text", text: "Acepto" },
    { _tag: "Choice", choice: "accept" },
    { _tag: "Choice", choice: "decline" },
  ]) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(ConsentInboundContent)(content))).toBe(true);
  }

  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(ConsentInboundContent)({ _tag: "Choice", choice: "maybe" })
    )
  ).toBe(true);
});

it("decodes complete immutable onboarding consent evidence", () => {
  const record = Schema.decodeUnknownSync(ConsentRecord)({
    id: "f1d1a000-0000-4000-8000-000000000801",
    subjectUserId: "f1d1a000-0000-4000-8000-000000000802",
    event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
    disclosure: makeDisclosure(),
    occurredAt: "2026-08-01T12:00:00Z",
    disclosureMessage: makeEvidence("wamid.disclosure-801"),
    decisionMessage: makeEvidence("wamid.acceptance-801"),
  });

  expect(record.event).toEqual({ _tag: "Granted", grant: { _tag: "Onboarding" } });
  expect(record.decisionMessage.provider).toBe("kapso");
});

it("supports the explicitly reusable grant and revocation shapes", () => {
  const common = {
    id: "f1d1a000-0000-4000-8000-000000000801",
    subjectUserId: "f1d1a000-0000-4000-8000-000000000802",
    disclosure: makeDisclosure(),
    occurredAt: "2026-08-01T12:00:00Z",
    disclosureMessage: makeEvidence("wamid.disclosure-801"),
    decisionMessage: makeEvidence("wamid.acceptance-801"),
  };
  const events = [
    {
      _tag: "Granted",
      grant: {
        _tag: "PAT",
        tokenId: "f1d1a000-0000-4000-8000-000000000803",
      },
    },
    {
      _tag: "Granted",
      grant: { _tag: "InsightDelivery", insightKind: "weekly-summary" },
    },
    {
      _tag: "Revoked",
      grantId: "f1d1a000-0000-4000-8000-000000000804",
    },
  ];

  for (const event of events) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(ConsentRecord)({ ...common, event }))).toBe(
      true
    );
  }
});

it("requires outbound evidence only after disclosure delivery", () => {
  const awaitingDelivery = {
    _tag: "AwaitingDisclosureDelivery",
    id: "f1d1a000-0000-4000-8000-000000000811",
    caller: {
      businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio-test"),
      businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.573001112233"),
      parentBusinessScopedUserId: Option.none(),
      username: Option.none(),
      phoneNumber: Option.some(E164PhoneNumber.make("+573001112233")),
    },
    disclosure: makeDisclosure(),
    initiatingMessage: makeEvidence("wamid.initiating-811"),
    createdAt: "2026-08-01T12:00:00Z",
    expiresAt: "2026-08-02T12:00:00Z",
  };
  const awaitingDecision = {
    ...awaitingDelivery,
    _tag: "AwaitingDecision",
    disclosureMessage: makeEvidence("wamid.disclosure-811"),
    disclosedAt: "2026-08-01T12:00:01Z",
  };

  expect(
    Result.isSuccess(Schema.decodeUnknownResult(PendingConsentExchange)(awaitingDelivery))
  ).toBe(true);
  expect(
    Result.isSuccess(Schema.decodeUnknownResult(PendingConsentExchange)(awaitingDecision))
  ).toBe(true);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(PendingConsentExchange)({
        ...awaitingDecision,
        disclosureMessage: undefined,
      })
    )
  ).toBe(true);
});

it("rejects duplicate legal-purpose facts and malformed digests", () => {
  const purpose = "Registrar y organizar tus finanzas personales";
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(DisclosureSnapshot)(
        makeDisclosure({ purposes: [purpose, purpose] })
      )
    )
  ).toBe(true);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(DisclosureSnapshot)(
        makeDisclosure({ contentSha256: "not-a-hash" })
      )
    )
  ).toBe(true);
});
