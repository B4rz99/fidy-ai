import { assert, expect, it } from "@effect/vitest";
import { DateTime, Option, Result, Schema } from "effect";
import {
  E164PhoneNumber,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/contract";
import {
  ConsentDecisionEvidence,
  ConsentEvent,
  ConsentGrant,
  ConsentInboundContent,
  ConsentRecord,
  DisclosureRevision,
  DisclosureSnapshot,
  PendingConsentExchange,
  PendingConsentExchangeId,
  PolicyRevision,
  PolicyUrl,
  ProviderQualifiedMessages,
  Sha256Digest,
  WebOnboardingConsentGrantId,
} from "~/core/consent/contract";

const Content = ConsentInboundContent.pipe(Schema.toTaggedUnion("_tag")).cases;

const Evidence = ConsentDecisionEvidence.pipe(Schema.toTaggedUnion("_tag")).cases;

const Event = ConsentEvent.pipe(Schema.toTaggedUnion("_tag")).cases;

const Grant = ConsentGrant.pipe(Schema.toTaggedUnion("_tag")).cases;

const Pending = PendingConsentExchange.pipe(Schema.toTaggedUnion("_tag")).cases;

const MessageEvidence = ProviderQualifiedMessages.fields.disclosureMessage;

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

const makeEvidence = (providerMessageId: string): typeof MessageEvidence.Encoded => ({
  channel: "whatsapp",
  provider: "kapso",
  providerMessageId,
});

const decodeEvidence = (providerMessageId: string): typeof MessageEvidence.Type =>
  Schema.decodeSync(MessageEvidence)(makeEvidence(providerMessageId));

const qualifiedMessages = Schema.encodeSync(ConsentDecisionEvidence)(
  ProviderQualifiedMessages.make({
    disclosureMessage: decodeEvidence("wamid.disclosure-801"),
    decisionMessage: decodeEvidence("wamid.acceptance-801"),
  })
);

const webSessionId = Schema.decodeSync(Evidence.AuthenticatedWeb.fields.webSessionId)(
  "f1d1a000-0000-4000-8000-000000000806"
);

const encodeEvent = Schema.encodeSync(ConsentEvent);

const patGrant = Event.Granted.make({
  grant: Grant.PAT.make({
    tokenId: Schema.decodeSync(Grant.PAT.fields.tokenId)("f1d1a000-0000-4000-8000-000000000803"),
  }),
});

it("requires policy and disclosure revisions to match their complete lexical grammars", () => {
  const assertInvalid = <A, E>(
    decode: (value: string) => Result.Result<A, E>,
    revisions: ReadonlyArray<string>
  ): void => {
    for (const revision of revisions) {
      expect(Result.isFailure(decode(revision))).toBe(true);
    }
  };

  assertInvalid(Schema.decodeUnknownResult(PolicyRevision), ["@policy-2026-01", "policy-2026-01@"]);
  assertInvalid(Schema.decodeUnknownResult(DisclosureRevision), [
    "@onboarding-2026-01",
    "onboarding-2026-01@",
  ]);
});

it("requires a SHA-256 digest to occupy the complete input", () => {
  const digest = "a".repeat(64);

  expect(Result.isFailure(Schema.decodeResult(Sha256Digest)(`!${digest}`))).toBe(true);
  expect(Result.isFailure(Schema.decodeResult(Sha256Digest)(`${digest}!`))).toBe(true);
});

it("requires a policy URL to be HTTPS without ignored prefixes or suffixes", () => {
  expect(Result.isFailure(Schema.decodeResult(PolicyUrl)("xhttps://fidyapp.com/politica"))).toBe(
    true
  );
  expect(
    Result.isFailure(Schema.decodeResult(PolicyUrl)("https://fidyapp.com/politica trailing"))
  ).toBe(true);
});

it("decodes text and every supported explicit consent choice", () => {
  const encode = Schema.encodeSync(ConsentInboundContent);

  for (const content of [
    Content.Text.make({ text: "Acepto" }),
    Content.Choice.make({ choice: "accept" }),
    Content.Choice.make({ choice: "decline" }),
  ]) {
    expect(Result.isSuccess(Schema.decodeResult(ConsentInboundContent)(encode(content)))).toBe(
      true
    );
  }

  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(ConsentInboundContent)({
        ...encode(Content.Choice.make({ choice: "accept" })),
        choice: "maybe",
      })
    )
  ).toBe(true);
});

it("accepts both automatic expiry policies and rejects an unknown policy", () => {
  const encode = Schema.encodeSync(ConsentDecisionEvidence);

  for (const policy of ["pat-approved-unclaimed-expiry", "pat-fixed-lifetime-expiry"] as const) {
    expect(
      Result.isSuccess(
        Schema.decodeResult(ConsentDecisionEvidence)(
          encode(Evidence.AutomaticPolicy.make({ policy }))
        )
      )
    ).toBe(true);
  }

  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(ConsentDecisionEvidence)({
        ...encode(Evidence.AutomaticPolicy.make({ policy: "pat-fixed-lifetime-expiry" })),
        policy: "unknown-policy",
      })
    )
  ).toBe(true);
});

it("decodes complete immutable onboarding consent evidence", () => {
  const onboarding = Event.Granted.make({ grant: Grant.Onboarding.make({}) });

  const record = Schema.decodeSync(ConsentRecord)({
    id: "f1d1a000-0000-4000-8000-000000000801",
    subjectUserId: "f1d1a000-0000-4000-8000-000000000802",
    event: encodeEvent(onboarding),
    disclosure: makeDisclosure(),
    occurredAt: "2026-08-01T12:00:00Z",
    evidence: qualifiedMessages,
  });

  expect(record.event).toEqual(onboarding);
  assert(Schema.is(ProviderQualifiedMessages)(record.evidence));
  expect(record.evidence.decisionMessage.provider).toBe("kapso");
});

it("records an authenticated WebSession as honest PAT decision evidence", () => {
  const record = Schema.decodeSync(ConsentRecord)({
    id: "f1d1a000-0000-4000-8000-000000000805",
    subjectUserId: "f1d1a000-0000-4000-8000-000000000802",
    event: encodeEvent(patGrant),
    disclosure: makeDisclosure({ revision: "pat-grant-2026-08" }),
    occurredAt: "2026-08-01T12:00:00Z",
    evidence: Schema.encodeSync(ConsentDecisionEvidence)(
      Evidence.AuthenticatedWeb.make({ webSessionId })
    ),
  });

  expect(record.evidence).toEqual(Evidence.AuthenticatedWeb.make({ webSessionId }));
});

it("supports the explicitly reusable grant and revocation shapes", () => {
  const common = {
    id: "f1d1a000-0000-4000-8000-000000000801",
    subjectUserId: "f1d1a000-0000-4000-8000-000000000802",
    disclosure: makeDisclosure(),
    occurredAt: "2026-08-01T12:00:00Z",
    evidence: qualifiedMessages,
  };

  const events = [
    patGrant,
    Event.Granted.make({ grant: Grant.InsightDelivery.make({ insightKind: "weekly-summary" }) }),
    Event.Revoked.make({
      grantId: Schema.decodeSync(Event.Revoked.fields.grantId)(
        "f1d1a000-0000-4000-8000-000000000804"
      ),
    }),
  ].map((event) => encodeEvent(event));

  for (const event of events) {
    expect(Result.isSuccess(Schema.decodeResult(ConsentRecord)({ ...common, event }))).toBe(true);
  }
});

it("requires outbound evidence only after disclosure delivery", () => {
  const pendingBase = {
    id: PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000811"),
    caller: {
      businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio-test"),
      businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.573001112233"),
      parentBusinessScopedUserId: Option.none(),
      username: Option.none(),
      phoneNumber: Option.some(E164PhoneNumber.make("+573001112233")),
    },
    disclosure: Schema.decodeSync(DisclosureSnapshot)(makeDisclosure()),
    initiatingMessage: decodeEvidence("wamid.initiating-811"),
    createdAt: DateTime.makeUnsafe("2026-08-01T12:00:00Z"),
    expiresAt: DateTime.makeUnsafe("2026-08-02T12:00:00Z"),
  };

  const encodePending = Schema.encodeSync(PendingConsentExchange);

  const awaitingDelivery = encodePending(Pending.AwaitingDisclosureDelivery.make(pendingBase));

  const awaitingDecision = encodePending(
    Pending.AwaitingDecision.make({
      ...pendingBase,
      disclosureMessage: decodeEvidence("wamid.disclosure-811"),
      disclosedAt: DateTime.makeUnsafe("2026-08-01T12:00:01Z"),
    })
  );

  expect(Result.isSuccess(Schema.decodeResult(PendingConsentExchange)(awaitingDelivery))).toBe(
    true
  );
  expect(Result.isSuccess(Schema.decodeResult(PendingConsentExchange)(awaitingDecision))).toBe(
    true
  );
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
      Schema.decodeResult(DisclosureSnapshot)(makeDisclosure({ purposes: [purpose, purpose] }))
    )
  ).toBe(true);
  expect(
    Result.isFailure(
      Schema.decodeResult(DisclosureSnapshot)(makeDisclosure({ contentSha256: "not-a-hash" }))
    )
  ).toBe(true);
});

it("bounds native web onboarding grant references independently of the legal grant they identify", () => {
  const decode = Schema.decodeUnknownResult(WebOnboardingConsentGrantId);
  const value = `${"Az09_-".repeat(7)}A`;
  expect(Result.isSuccess(decode(value))).toBe(true);

  for (const invalid of [value.slice(1), `${value}A`, `!${value}`, `${value}!`, "!".repeat(43)]) {
    expect(Result.isFailure(decode(invalid))).toBe(true);
  }
});
