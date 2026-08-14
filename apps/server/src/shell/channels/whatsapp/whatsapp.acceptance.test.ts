import { expect, layer } from "@effect/vitest";
import { Crypto, DateTime, Effect, Option, Schedule, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { decideEffectiveAccess } from "~/core/identity/rules";
import {
  E164PhoneNumber,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import { CURRENT_DISCLOSURE_TEXT } from "~/shell/consent/current-disclosure";
import { DisclosureDeliveryCorrelationToken } from "./disclosure-model";
import { WhatsAppProviderMessageId } from "./model";
import {
  WhatsAppAcceptanceApiClient,
  WhatsAppAcceptanceCallerControl,
  type WhatsAppAcceptanceCallerProbe,
  WhatsAppAcceptanceDisclosureControl,
  WhatsAppAcceptanceHarness,
  WhatsAppAcceptanceKapsoControl,
  WhatsAppAcceptanceModelControl,
  type WhatsAppAcceptanceObserverId,
} from "~/shell/testing/whatsapp-acceptance-harness";
import {
  type ImplementedWhatsAppAcceptanceScenarioId,
  whatsappAcceptanceTestName,
} from "~/shell/testing/whatsapp-acceptance-scenarios";

const webhookSecret = "test-webhook-secret-32-characters";
const WebhookSummary = Schema.Struct({
  decoded: Schema.Int,
  consentTurns: Schema.Int,
  enqueued: Schema.Int,
  duplicates: Schema.Int,
});
const DisclosureKapsoRequest = Schema.Struct({
  biz_opaque_callback_data: Schema.String,
});
const KapsoTextRequest = Schema.Union([
  Schema.Struct({
    recipient: Schema.String,
    to: Schema.optional(Schema.Never),
    type: Schema.Literal("text"),
    text: Schema.Struct({ body: Schema.String }),
  }),
  Schema.Struct({
    recipient: Schema.optional(Schema.Never),
    to: Schema.String,
    type: Schema.Literal("text"),
    text: Schema.Struct({ body: Schema.String }),
  }),
]);

const makeScenarioIdentity = Effect.fn("Acceptance.makeWhatsAppScenarioIdentity")(function* (
  scenarioId: ImplementedWhatsAppAcceptanceScenarioId
) {
  const crypto = yield* Crypto.Crypto;
  const nonce = (yield* crypto.randomUUIDv7.pipe(Effect.orDie)).replaceAll("-", "");
  return {
    providerMessageId: WhatsAppProviderMessageId.make(`wamid.acceptance-${scenarioId}-${nonce}`),
    businessScopedUserId: WhatsAppBusinessScopedUserId.make(`CO.${nonce}`),
  };
});

type KapsoWebhookInput = Readonly<{
  readonly providerMessageId: WhatsAppProviderMessageId;
  readonly businessScopedUserId: WhatsAppBusinessScopedUserId;
  readonly phoneNumber: Option.Option<E164PhoneNumber>;
  readonly text: TranscriptText;
}>;

type SignedKapsoWebhook = Readonly<{
  readonly providerMessageId: WhatsAppProviderMessageId;
  readonly body: Uint8Array;
  readonly headers: Readonly<{
    readonly "x-webhook-signature": string;
    readonly "x-idempotency-key": WhatsAppProviderMessageId;
  }>;
}>;

const makeSignedWebhookAt = Effect.fn("Acceptance.makeSignedWhatsAppWebhookAt")(function* (
  input: KapsoWebhookInput,
  occurredAt: DateTime.Utc
) {
  const phoneFields = Option.match(input.phoneNumber, {
    onNone: () => ({}),
    onSome: (phoneNumber) => ({ from: phoneNumber.slice(1) }),
  });
  const conversationPhone = Option.match(input.phoneNumber, {
    onNone: () => ({}),
    onSome: (phoneNumber) => ({ phone_number: phoneNumber.slice(1) }),
  });
  const encodedBody = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
    message: {
      id: input.providerMessageId,
      timestamp: `${Math.floor(DateTime.toEpochMillis(occurredAt) / 1_000)}`,
      type: "text",
      ...phoneFields,
      from_user_id: input.businessScopedUserId,
      text: { body: input.text },
      kapso: { direction: "inbound", has_media: false },
    },
    conversation: {
      ...conversationPhone,
      business_scoped_user_id: input.businessScopedUserId,
    },
    is_new_conversation: false,
    phone_number_id: "123456789012345",
  });
  const body = new TextEncoder().encode(encodedBody);
  const signature = new Bun.CryptoHasher("sha256", webhookSecret).update(body).digest("hex");
  return {
    providerMessageId: input.providerMessageId,
    body,
    headers: {
      "x-webhook-signature": signature,
      "x-idempotency-key": input.providerMessageId,
    },
  } satisfies SignedKapsoWebhook;
});

const makeSignedWebhook = Effect.fn("Acceptance.makeSignedWhatsAppWebhook")(function* (
  input: KapsoWebhookInput
) {
  return yield* makeSignedWebhookAt(input, yield* DateTime.now);
});

const postSignedDelivery = Effect.fn("Acceptance.postSignedWhatsAppDelivery")(
  (delivery: SignedKapsoWebhook) =>
    HttpClient.post("/webhooks/kapso", {
      headers: delivery.headers,
      body: HttpBody.uint8Array(delivery.body, "application/json"),
    })
);

const postSignedWebhook = Effect.fn("Acceptance.postSignedWhatsAppWebhook")(
  (input: KapsoWebhookInput) => makeSignedWebhook(input).pipe(Effect.flatMap(postSignedDelivery))
);

const acceptanceRetryableFailureCode = 131_016;
const acceptanceTerminalFailureCode = 131_026;
const postSignedLifecycleEvidence = Effect.fn("Acceptance.postSignedDisclosureLifecycleEvidence")(
  function* (input: {
    readonly eventName:
      | "whatsapp.message.delivered"
      | "whatsapp.message.failed"
      | "whatsapp.message.sent";
    readonly correlationToken: string;
    readonly providerMessageId: WhatsAppProviderMessageId;
    readonly failureDisposition: "retryable" | "terminal";
    readonly previousStatus: Option.Option<"delivered" | "failed" | "sent">;
    readonly additionalStatus: Option.Option<"delivered" | "failed" | "sent">;
    readonly signature: Option.Option<string>;
  }) {
    const occurredAt = yield* DateTime.now;
    const status = input.eventName.replace("whatsapp.message.", "");
    const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
      message: {
        id: input.providerMessageId,
        kapso: {
          statuses: [
            ...Option.match(input.previousStatus, {
              onNone: () => [],
              onSome: (previousStatus) => [
                {
                  id: input.providerMessageId,
                  status: previousStatus,
                  timestamp: `${Math.floor(DateTime.toEpochMillis(occurredAt) / 1_000) - 1}`,
                  biz_opaque_callback_data: input.correlationToken,
                },
              ],
            }),
            {
              id: input.providerMessageId,
              status,
              timestamp: `${Math.floor(DateTime.toEpochMillis(occurredAt) / 1_000)}`,
              biz_opaque_callback_data: input.correlationToken,
              ...(status === "failed"
                ? {
                    errors: [
                      {
                        code:
                          input.failureDisposition === "retryable"
                            ? acceptanceRetryableFailureCode
                            : acceptanceTerminalFailureCode,
                      },
                    ],
                  }
                : {}),
            },
            ...Option.match(input.additionalStatus, {
              onNone: () => [],
              onSome: (additionalStatus) => [
                {
                  id: input.providerMessageId,
                  status: additionalStatus,
                  timestamp: `${Math.floor(DateTime.toEpochMillis(occurredAt) / 1_000) + 1}`,
                  biz_opaque_callback_data: input.correlationToken,
                },
              ],
            }),
          ],
        },
      },
      phone_number_id: "123456789012345",
    });
    const body = new TextEncoder().encode(encoded);
    const validSignature = new Bun.CryptoHasher("sha256", webhookSecret).update(body).digest("hex");
    return yield* HttpClient.post("/webhooks/kapso", {
      headers: {
        "x-webhook-signature": Option.getOrElse(input.signature, () => validSignature),
        "x-webhook-event": input.eventName,
      },
      body: HttpBody.uint8Array(body, "application/json"),
    });
  }
);

const acceptanceCaller = (
  businessScopedUserId: WhatsAppBusinessScopedUserId
): Readonly<{
  businessPortfolioId: WhatsAppBusinessPortfolioId;
  businessScopedUserId: WhatsAppBusinessScopedUserId;
}> => ({
  businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio-test"),
  businessScopedUserId,
});

const establishCaller = Effect.fn("Acceptance.establishWhatsAppCaller")(function* (input: {
  readonly scenarioId: WhatsAppAcceptanceObserverId;
  readonly phoneNumber: E164PhoneNumber;
}) {
  const identity = yield* makeScenarioIdentity(input.scenarioId);
  const startedAt = yield* DateTime.now;
  const disclosureDelivery = yield* makeSignedWebhookAt(
    {
      ...identity,
      phoneNumber: Option.some(input.phoneNumber),
      text: TranscriptText.make("Quiero empezar"),
    },
    startedAt
  );
  const disclosureResponse = yield* postSignedDelivery(disclosureDelivery);
  const disclosures = yield* WhatsAppAcceptanceDisclosureControl;
  const requests = yield* awaitKapsoRequests(1);
  const request = yield* Effect.fromOption(Option.fromUndefinedOr(requests[0])).pipe(Effect.orDie);
  const observed = yield* disclosures.find(acceptanceCaller(identity.businessScopedUserId));
  const attempt = yield* Effect.fromOption(observed).pipe(
    Effect.flatMap((value) => Effect.fromOption(value.state)),
    Effect.orDie
  );
  const lifecycleResponse = yield* postSignedLifecycleEvidence({
    eventName: "whatsapp.message.delivered",
    correlationToken: attempt.correlationToken,
    providerMessageId: request.outcome.providerMessageId,
    failureDisposition: "terminal",
    previousStatus: Option.some("sent"),
    additionalStatus: Option.none(),
    signature: Option.none(),
  });
  if (lifecycleResponse.status !== 200) return yield* Effect.die("delivery evidence was rejected");

  const decisionIdentity = yield* makeScenarioIdentity(input.scenarioId);
  const decisionDelivery = yield* makeSignedWebhookAt(
    {
      providerMessageId: decisionIdentity.providerMessageId,
      businessScopedUserId: identity.businessScopedUserId,
      phoneNumber: Option.some(input.phoneNumber),
      text: TranscriptText.make("Acepto"),
    },
    DateTime.add(startedAt, { seconds: 2 })
  );
  const decisionResponse = yield* postSignedDelivery(decisionDelivery);
  return {
    identity,
    startedAt,
    disclosureDelivery,
    disclosureResponse,
    decisionDelivery,
    decisionResponse,
  };
});

const authorizeCallerProbe = Effect.fn("Acceptance.authorizeWhatsAppCallerProbe")(function* (
  observerId: WhatsAppAcceptanceObserverId,
  businessScopedUserId: WhatsAppBusinessScopedUserId
) {
  const callers = yield* WhatsAppAcceptanceCallerControl;
  return yield* callers
    .authorizeProbe(observerId, {
      businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio-test"),
      businessScopedUserId,
    })
    .pipe(
      Effect.flatMap(Effect.fromOption(() => new Error("accepted caller was not established"))),
      Effect.orDie
    );
});

const submitAcceptedFinancialTurn = Effect.fn("Acceptance.submitAcceptedFinancialTurn")(
  function* (input: {
    readonly scenarioId: WhatsAppAcceptanceObserverId;
    readonly phoneNumber: E164PhoneNumber;
  }) {
    const onboarding = yield* establishCaller(input);
    const probe = yield* authorizeCallerProbe(
      input.scenarioId,
      onboarding.identity.businessScopedUserId
    );
    const financialIdentity = yield* makeScenarioIdentity(input.scenarioId);
    const financialDelivery = yield* makeSignedWebhookAt(
      {
        providerMessageId: financialIdentity.providerMessageId,
        businessScopedUserId: onboarding.identity.businessScopedUserId,
        phoneNumber: Option.some(input.phoneNumber),
        text: TranscriptText.make("Registra una compra por 25000"),
      },
      DateTime.add(onboarding.startedAt, { seconds: 4 })
    );
    const financialResponse = yield* postSignedDelivery(financialDelivery);
    return { onboarding, probe, financialDelivery, financialResponse };
  }
);

const awaitKapsoRequests = Effect.fn("Acceptance.awaitWhatsAppKapsoRequests")(function* (
  count: number
) {
  const kapso = yield* WhatsAppAcceptanceKapsoControl;
  return yield* kapso.requests.pipe(
    Effect.filterOrFail((requests) => requests.length === count),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
    Effect.orDie
  );
});

const awaitAcceptanceTransaction = Effect.fn("Acceptance.awaitWhatsAppTransaction")(function* (
  probe: WhatsAppAcceptanceCallerProbe
) {
  return yield* probe.api.transactions.listTransactions({ query: {} }).pipe(
    Effect.filterOrFail(
      (response) =>
        response.data.length === 1 &&
        response.data.every(
          (transaction) =>
            Option.getOrUndefined(transaction.counterparty) === "Acceptance authority"
        )
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 60 }),
    Effect.orDie
  );
});

layer(WhatsAppAcceptanceHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "WhatsApp acceptance",
  (it) => {
    it.effect(whatsappAcceptanceTestName("WA-A01"), () =>
      Effect.gen(function* () {
        const kapso = yield* WhatsAppAcceptanceKapsoControl;
        yield* kapso.reset;
        yield* kapso.setDeliveryMode("sandbox-phone");

        const identity = yield* makeScenarioIdentity("WA-A01");
        const response = yield* postSignedWebhook({
          ...identity,
          phoneNumber: Option.some(E164PhoneNumber.make("+573001111111")),
          text: TranscriptText.make("Quiero empezar"),
        });

        expect(response.status).toBe(200);
        expect(yield* HttpClientResponse.schemaBodyJson(WebhookSummary)(response)).toEqual({
          decoded: 1,
          consentTurns: 1,
          enqueued: 0,
          duplicates: 0,
        });
        const requests = yield* kapso.requests;
        expect(requests).toHaveLength(1);
        const sent = yield* Schema.decodeUnknownEffect(KapsoTextRequest)(requests[0]?.body);
        expect(sent).toMatchObject({ to: "573001111111", type: "text" });
        expect(sent.text.body).toContain("Antes de crear tu cuenta");
        expect(sent).not.toHaveProperty("recipient");
      })
    );

    it.effect(whatsappAcceptanceTestName("WA-A02"), () =>
      Effect.gen(function* () {
        const api = yield* WhatsAppAcceptanceApiClient;
        const upgrade = yield* api.subscription.getUpgradeUrl();
        expect(upgrade.data.url).toEqual(new URL("https://fidyapp.com/upgrade"));
        const currentUser = yield* api.identity.getCurrentUser();
        expect(currentUser.data).toMatchObject({
          paidTier: "pro",
          trialPeriod: {
            startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
            endsAt: DateTime.makeUnsafe("2026-01-08T00:00:00Z"),
          },
        });
        expect(yield* decideEffectiveAccess(currentUser.data, yield* DateTime.now)).toBe("pro");

        const kapso = yield* WhatsAppAcceptanceKapsoControl;
        yield* kapso.reset;
        yield* kapso.setDeliveryMode("sandbox-phone");

        const authorized = yield* postSignedWebhook({
          providerMessageId: (yield* makeScenarioIdentity("WA-A02")).providerMessageId,
          businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.573001234567"),
          phoneNumber: Option.some(E164PhoneNumber.make("+573009876543")),
          text: TranscriptText.make("Registra una compra por 25000"),
        });
        expect(authorized.status).toBe(200);
        expect(yield* HttpClientResponse.schemaBodyJson(WebhookSummary)(authorized)).toEqual({
          decoded: 1,
          consentTurns: 0,
          enqueued: 1,
          duplicates: 0,
        });

        const authorizedRequests = yield* kapso.requests.pipe(
          Effect.filterOrFail((requests) => requests.length === 1),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 60 }),
          Effect.orDie
        );
        const authorizedSend = yield* Schema.decodeUnknownEffect(KapsoTextRequest)(
          authorizedRequests[0]?.body
        );
        expect(authorizedSend).toMatchObject({ to: "573009876543" });
        expect(authorizedSend.text.body).toContain("Gasto guardado");
        expect(authorizedSend.text.body).not.toContain("ACCEPTANCE_TRANSIENT_CONTEXT");
        const history = yield* api.transactions.listTransactions({ query: {} });
        expect(
          history.data.some(
            (transaction) =>
              Option.getOrUndefined(transaction.counterparty) === "Acceptance authority"
          )
        ).toBe(true);

        const collidingPhoneIdentity = yield* makeScenarioIdentity("WA-A02");
        const unrecognized = yield* postSignedWebhook({
          ...collidingPhoneIdentity,
          phoneNumber: Option.some(E164PhoneNumber.make("+573001234567")),
          text: TranscriptText.make("Registra otra compra por 25000"),
        });
        expect(unrecognized.status).toBe(200);
        expect(yield* HttpClientResponse.schemaBodyJson(WebhookSummary)(unrecognized)).toEqual({
          decoded: 1,
          consentTurns: 1,
          enqueued: 0,
          duplicates: 0,
        });
        const requests = yield* kapso.requests;
        expect(requests).toHaveLength(2);
        const disclosure = yield* Schema.decodeUnknownEffect(KapsoTextRequest)(requests[1]?.body);
        expect(disclosure).toMatchObject({ to: "573001234567" });
        expect(disclosure.text.body).toContain("Antes de crear tu cuenta");
      })
    );

    it.effect(whatsappAcceptanceTestName("WA-A03"), () =>
      Effect.gen(function* () {
        const kapso = yield* WhatsAppAcceptanceKapsoControl;
        yield* kapso.reset;
        yield* kapso.setDeliveryMode("sandbox-phone");

        const identity = yield* makeScenarioIdentity("WA-A03");
        const response = yield* postSignedWebhook({
          ...identity,
          phoneNumber: Option.none(),
          text: TranscriptText.make("Quiero empezar sin teléfono"),
        });

        expect(response.status).toBe(500);
        expect(yield* kapso.requests).toEqual([]);
      })
    );

    it.effect(whatsappAcceptanceTestName("WA-A04"), () =>
      Effect.gen(function* () {
        const kapso = yield* WhatsAppAcceptanceKapsoControl;
        yield* kapso.reset;
        yield* kapso.setDeliveryMode("sandbox-phone");

        const onboarding = yield* establishCaller({
          scenarioId: "WA-A04",
          phoneNumber: E164PhoneNumber.make("+573004040404"),
        });
        expect(onboarding.disclosureResponse.status).toBe(200);
        expect(onboarding.decisionResponse.status).toBe(200);

        const outbound = yield* kapso.requests;
        expect(outbound).toHaveLength(2);
        const disclosure = yield* Schema.decodeUnknownEffect(KapsoTextRequest)(outbound[0]?.body);
        expect(disclosure).toEqual({
          to: "573004040404",
          type: "text",
          text: { body: CURRENT_DISCLOSURE_TEXT },
        });
        const probe = yield* authorizeCallerProbe(
          "WA-A04",
          onboarding.identity.businessScopedUserId
        );
        const current = yield* probe.api.identity.getCurrentUser({});
        expect(current.data.id).toBe(probe.userId);
        const records = yield* probe.consentRecords;
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
          disclosureMessage: {
            providerMessageId: outbound[0]?.outcome.providerMessageId,
          },
          decisionMessage: {
            providerMessageId: onboarding.decisionDelivery.providerMessageId,
          },
        });
      })
    );

    it.effect(whatsappAcceptanceTestName("WA-A05"), () =>
      Effect.gen(function* () {
        const kapso = yield* WhatsAppAcceptanceKapsoControl;
        const model = yield* WhatsAppAcceptanceModelControl;
        yield* kapso.reset;
        yield* model.reset;
        yield* kapso.setDeliveryMode("sandbox-phone");
        yield* kapso.setOutcomes(["accepted", "accepted", "rejected", "accepted"]);

        const { onboarding, probe, financialResponse } = yield* submitAcceptedFinancialTurn({
          scenarioId: "WA-A05",
          phoneNumber: E164PhoneNumber.make("+573005050505"),
        });
        expect(onboarding.disclosureResponse.status).toBe(200);
        expect(onboarding.decisionResponse.status).toBe(200);
        expect(financialResponse.status).toBe(200);
        expect(yield* HttpClientResponse.schemaBodyJson(WebhookSummary)(financialResponse)).toEqual(
          {
            decoded: 1,
            consentTurns: 0,
            enqueued: 1,
            duplicates: 0,
          }
        );

        const history = yield* awaitAcceptanceTransaction(probe);
        expect(history.data).toHaveLength(1);

        const outbound = yield* awaitKapsoRequests(4);
        expect(outbound[3]?.body).toEqual(outbound[2]?.body);
        const reply = yield* Schema.decodeUnknownEffect(KapsoTextRequest)(outbound[3]?.body);
        expect(reply).toHaveProperty("to", "573005050505");
        expect(reply).not.toHaveProperty("recipient");
        expect(reply.text.body).toContain("Gasto guardado");
        expect(reply.text.body).not.toContain("ACCEPTANCE_TRANSIENT_CONTEXT");

        const plainIdentity = yield* makeScenarioIdentity("WA-A05");
        const plainResponse = yield* postSignedDelivery(
          yield* makeSignedWebhookAt(
            {
              providerMessageId: plainIdentity.providerMessageId,
              businessScopedUserId: onboarding.identity.businessScopedUserId,
              phoneNumber: Option.some(E164PhoneNumber.make("+573005050505")),
              text: TranscriptText.make("Hola ACCEPTANCE_PLAIN_REPLY"),
            },
            DateTime.add(onboarding.startedAt, { seconds: 8 })
          )
        );
        expect(plainResponse.status).toBe(200);
        const plainOutbound = yield* awaitKapsoRequests(5);
        const plainReply = yield* Schema.decodeUnknownEffect(KapsoTextRequest)(
          plainOutbound[4]?.body
        );
        expect(plainReply.text.body).toBe("Todo listo.");
        expect((yield* model.calls).length).toBeGreaterThan(0);
      })
    );

    it.effect(whatsappAcceptanceTestName("WA-A06"), () =>
      Effect.gen(function* () {
        const kapso = yield* WhatsAppAcceptanceKapsoControl;
        const model = yield* WhatsAppAcceptanceModelControl;
        yield* kapso.reset;
        yield* model.reset;
        yield* kapso.setDeliveryMode("sandbox-phone");

        const { onboarding, probe, financialDelivery, financialResponse } =
          yield* submitAcceptedFinancialTurn({
            scenarioId: "WA-A06",
            phoneNumber: E164PhoneNumber.make("+573006060606"),
          });
        expect(onboarding.disclosureResponse.status).toBe(200);
        expect(onboarding.decisionResponse.status).toBe(200);
        expect(financialResponse.status).toBe(200);
        expect(yield* HttpClientResponse.schemaBodyJson(WebhookSummary)(financialResponse)).toEqual(
          {
            decoded: 1,
            consentTurns: 0,
            enqueued: 1,
            duplicates: 0,
          }
        );

        const outboundBeforeReplay = yield* awaitKapsoRequests(3);
        const reply = yield* Schema.decodeUnknownEffect(KapsoTextRequest)(
          outboundBeforeReplay[2]?.body
        );
        expect(reply.text.body).toContain("Gasto guardado");
        const historyBeforeReplay = yield* awaitAcceptanceTransaction(probe);
        const consentBeforeReplay = yield* probe.consentRecords;
        const modelCallsBeforeReplay = yield* model.calls;
        expect(consentBeforeReplay).toHaveLength(1);
        expect(modelCallsBeforeReplay.length).toBeGreaterThan(0);

        const decisionReplay = yield* postSignedDelivery(onboarding.decisionDelivery);
        expect(yield* HttpClientResponse.schemaBodyJson(WebhookSummary)(decisionReplay)).toEqual({
          decoded: 1,
          consentTurns: 0,
          enqueued: 0,
          duplicates: 1,
        });
        const financialReplay = yield* postSignedDelivery(financialDelivery);
        expect(yield* HttpClientResponse.schemaBodyJson(WebhookSummary)(financialReplay)).toEqual({
          decoded: 1,
          consentTurns: 0,
          enqueued: 0,
          duplicates: 1,
        });

        expect(yield* probe.consentRecords).toEqual(consentBeforeReplay);
        expect(yield* kapso.requests).toEqual(outboundBeforeReplay);
        expect(yield* model.calls).toEqual(modelCallsBeforeReplay);
        const historyAfterReplay = yield* probe.api.transactions.listTransactions({ query: {} });
        expect(historyAfterReplay.data).toEqual(historyBeforeReplay.data);
      })
    );

    it.effect(whatsappAcceptanceTestName("WA-A07"), () =>
      Effect.gen(function* () {
        const kapso = yield* WhatsAppAcceptanceKapsoControl;
        const disclosures = yield* WhatsAppAcceptanceDisclosureControl;
        yield* kapso.reset;
        yield* kapso.setDeliveryMode("bsuid");
        yield* kapso.setOutcomes(["rejected", "accepted"]);

        const identity = yield* makeScenarioIdentity("WA-A07");
        const delivery = yield* makeSignedWebhook({
          ...identity,
          phoneNumber: Option.none(),
          text: TranscriptText.make("Quiero empezar"),
        });
        expect((yield* postSignedDelivery(delivery)).status).toBe(200);
        const requests = yield* awaitKapsoRequests(2);
        const first = yield* Schema.decodeUnknownEffect(DisclosureKapsoRequest)(requests[0]?.body);
        const secondRequest = yield* Effect.fromOption(Option.fromUndefinedOr(requests[1])).pipe(
          Effect.orDie
        );
        const second = yield* Schema.decodeUnknownEffect(DisclosureKapsoRequest)(
          secondRequest.body
        );
        expect(first.biz_opaque_callback_data).not.toBe(second.biz_opaque_callback_data);
        const rejectedAttempt = yield* disclosures.findAttemptByCorrelation(
          DisclosureDeliveryCorrelationToken.make(first.biz_opaque_callback_data)
        );
        const rejectedAttemptValue = yield* Effect.fromOption(rejectedAttempt).pipe(Effect.orDie);
        expect(yield* disclosures.failureMetadata(rejectedAttemptValue.attemptId)).toEqual(
          Option.some({
            reason: "rate_limited",
            certainty: "rejected",
          })
        );

        expect((yield* postSignedDelivery(delivery)).status).toBe(200);
        yield* Effect.sleep("500 millis");
        expect(yield* kapso.requests).toHaveLength(2);
        const observed = yield* disclosures.find(acceptanceCaller(identity.businessScopedUserId));
        const retryAttempt = yield* Effect.fromOption(observed).pipe(
          Effect.flatMap((value) => Effect.fromOption(value.state)),
          Effect.orDie
        );
        expect(retryAttempt.state).toBe("reconciliation-required");
        const prematureDecision = yield* makeScenarioIdentity("WA-A07");
        expect(
          (yield* postSignedWebhook({
            providerMessageId: prematureDecision.providerMessageId,
            businessScopedUserId: identity.businessScopedUserId,
            phoneNumber: Option.none(),
            text: TranscriptText.make("Acepto"),
          })).status
        ).toBe(503);
        expect(
          (yield* disclosures.find(acceptanceCaller(identity.businessScopedUserId))).pipe(
            Option.map((value) => value.lifecycle),
            Option.getOrUndefined
          )
        ).toBe("AwaitingDisclosureDelivery");
        expect(yield* kapso.requests).toHaveLength(2);
        expect(
          (yield* postSignedLifecycleEvidence({
            eventName: "whatsapp.message.delivered",
            correlationToken: retryAttempt.correlationToken,
            providerMessageId: secondRequest.outcome.providerMessageId,
            failureDisposition: "terminal",
            previousStatus: Option.some("sent"),
            additionalStatus: Option.none(),
            signature: Option.none(),
          })).status
        ).toBe(200);
        expect(
          (yield* disclosures.find(acceptanceCaller(identity.businessScopedUserId))).pipe(
            Option.flatMap((value) => value.state),
            Option.map((state) => state.state),
            Option.getOrUndefined
          )
        ).toBe("delivered");

        yield* kapso.setOutcomes(["non-retryable-rejection"]);
        const terminalIdentity = yield* makeScenarioIdentity("WA-A07");
        const terminalDelivery = yield* makeSignedWebhook({
          ...terminalIdentity,
          phoneNumber: Option.none(),
          text: TranscriptText.make("Inicio con rechazo terminal"),
        });
        expect((yield* postSignedDelivery(terminalDelivery)).status).toBe(500);
        expect((yield* postSignedDelivery(terminalDelivery)).status).toBe(200);
        yield* Effect.sleep("500 millis");
        expect(yield* kapso.requests).toHaveLength(3);
        const terminalObserved = yield* disclosures.find(
          acceptanceCaller(terminalIdentity.businessScopedUserId)
        );
        expect(
          Option.getOrUndefined(terminalObserved)?.state.pipe(Option.getOrUndefined)
        ).toMatchObject({ state: "definitively-failed", reason: Option.some("invalid_response") });
      })
    );

    it.effect(whatsappAcceptanceTestName("WA-A08"), () =>
      Effect.gen(function* () {
        const kapso = yield* WhatsAppAcceptanceKapsoControl;
        const disclosures = yield* WhatsAppAcceptanceDisclosureControl;
        yield* kapso.reset;
        yield* kapso.setDeliveryMode("bsuid");
        yield* kapso.setOutcomes(["ambiguous"]);

        const identity = yield* makeScenarioIdentity("WA-A08");
        const delivery = yield* makeSignedWebhook({
          ...identity,
          phoneNumber: Option.none(),
          text: TranscriptText.make("Quiero empezar"),
        });
        expect((yield* postSignedDelivery(delivery)).status).toBe(500);
        expect((yield* postSignedDelivery(delivery)).status).toBe(200);
        yield* Effect.sleep("500 millis");
        expect(yield* kapso.requests).toHaveLength(1);

        const observed = yield* disclosures.find(acceptanceCaller(identity.businessScopedUserId));
        const observedValue = yield* Effect.fromOption(observed).pipe(Effect.orDie);
        const attempt = yield* Effect.fromOption(observedValue.state).pipe(Effect.orDie);
        expect(attempt.state).toBe("reconciliation-required");
        const invalidResponse = yield* postSignedLifecycleEvidence({
          eventName: "whatsapp.message.delivered",
          correlationToken: attempt.correlationToken,
          providerMessageId: WhatsAppProviderMessageId.make("wamid.acceptance-forged-delivery-a08"),
          failureDisposition: "terminal",
          previousStatus: Option.none(),
          additionalStatus: Option.none(),
          signature: Option.some("0".repeat(64)),
        });
        expect(invalidResponse.status).toBe(401);
        const mismatchedResponse = yield* postSignedLifecycleEvidence({
          eventName: "whatsapp.message.delivered",
          correlationToken: attempt.correlationToken,
          providerMessageId: WhatsAppProviderMessageId.make("wamid.acceptance-mismatch-a08"),
          failureDisposition: "terminal",
          previousStatus: Option.none(),
          additionalStatus: Option.some("failed"),
          signature: Option.none(),
        });
        expect(mismatchedResponse.status).toBe(400);
        expect(yield* kapso.requests).toHaveLength(1);
        expect(
          (yield* disclosures.find(acceptanceCaller(identity.businessScopedUserId))).pipe(
            Option.flatMap((value) => value.state),
            Option.map((state) => state.state),
            Option.getOrUndefined
          )
        ).toBe("reconciliation-required");
        const response = yield* postSignedLifecycleEvidence({
          eventName: "whatsapp.message.delivered",
          correlationToken: attempt.correlationToken,
          providerMessageId: WhatsAppProviderMessageId.make("wamid.acceptance-reconciled-a08"),
          failureDisposition: "terminal",
          previousStatus: Option.some("sent"),
          additionalStatus: Option.none(),
          signature: Option.none(),
        });
        expect(response.status).toBe(200);
        expect(yield* kapso.requests).toHaveLength(1);

        yield* kapso.setOutcomes(["ambiguous"]);
        const failedIdentity = yield* makeScenarioIdentity("WA-A08");
        expect(
          (yield* postSignedWebhook({
            ...failedIdentity,
            phoneNumber: Option.none(),
            text: TranscriptText.make("Inicio con fallo confirmado"),
          })).status
        ).toBe(500);
        const failedObserved = yield* disclosures.find(
          acceptanceCaller(failedIdentity.businessScopedUserId)
        );
        const failedObservedValue = yield* Effect.fromOption(failedObserved).pipe(Effect.orDie);
        const failedAttempt = yield* Effect.fromOption(failedObservedValue.state).pipe(
          Effect.orDie
        );
        expect(
          (yield* postSignedLifecycleEvidence({
            eventName: "whatsapp.message.failed",
            correlationToken: failedAttempt.correlationToken,
            providerMessageId: WhatsAppProviderMessageId.make(
              "wamid.acceptance-failed-evidence-a08"
            ),
            failureDisposition: "retryable",
            previousStatus: Option.none(),
            additionalStatus: Option.none(),
            signature: Option.none(),
          })).status
        ).toBe(200);
        expect(yield* awaitKapsoRequests(3)).toHaveLength(3);

        yield* kapso.setOutcomes(["ambiguous"]);
        const terminalIdentity = yield* makeScenarioIdentity("WA-A08");
        expect(
          (yield* postSignedWebhook({
            ...terminalIdentity,
            phoneNumber: Option.none(),
            text: TranscriptText.make("Inicio con fallo permanente"),
          })).status
        ).toBe(500);
        const terminalObserved = yield* disclosures.find(
          acceptanceCaller(terminalIdentity.businessScopedUserId)
        );
        const terminalObservedValue = yield* Effect.fromOption(terminalObserved).pipe(Effect.orDie);
        const terminalAttempt = yield* Effect.fromOption(terminalObservedValue.state).pipe(
          Effect.orDie
        );
        expect(
          (yield* postSignedLifecycleEvidence({
            eventName: "whatsapp.message.sent",
            correlationToken: terminalAttempt.correlationToken,
            providerMessageId: WhatsAppProviderMessageId.make("wamid.acceptance-sent-evidence-a08"),
            failureDisposition: "terminal",
            previousStatus: Option.none(),
            additionalStatus: Option.none(),
            signature: Option.none(),
          })).status
        ).toBe(200);
        const sentObserved = yield* disclosures.find(
          acceptanceCaller(terminalIdentity.businessScopedUserId)
        );
        expect(
          sentObserved.pipe(
            Option.flatMap((value) => value.state),
            Option.map((state) => state.state),
            Option.getOrUndefined
          )
        ).toBe("reconciliation-required");
        expect(
          sentObserved.pipe(
            Option.map((value) => value.lifecycle),
            Option.getOrUndefined
          )
        ).toBe("AwaitingDisclosureDelivery");
        expect(
          (yield* postSignedLifecycleEvidence({
            eventName: "whatsapp.message.failed",
            correlationToken: terminalAttempt.correlationToken,
            providerMessageId: WhatsAppProviderMessageId.make(
              "wamid.acceptance-terminal-evidence-a08"
            ),
            failureDisposition: "terminal",
            previousStatus: Option.none(),
            additionalStatus: Option.none(),
            signature: Option.none(),
          })).status
        ).toBe(200);
        yield* Effect.sleep("500 millis");
        expect(yield* kapso.requests).toHaveLength(4);
        expect(
          (yield* disclosures.find(acceptanceCaller(terminalIdentity.businessScopedUserId))).pipe(
            Option.flatMap((value) => value.state),
            Option.map((state) => state.state),
            Option.getOrUndefined
          )
        ).toBe("definitively-failed");
      })
    );

    it.effect(whatsappAcceptanceTestName("WA-A09"), () =>
      Effect.gen(function* () {
        const kapso = yield* WhatsAppAcceptanceKapsoControl;
        const disclosures = yield* WhatsAppAcceptanceDisclosureControl;
        yield* kapso.reset;
        yield* kapso.setDeliveryMode("bsuid");
        yield* kapso.setOutcomes(["ambiguous"]);

        const identity = yield* makeScenarioIdentity("WA-A09");
        expect(
          (yield* postSignedWebhook({
            ...identity,
            phoneNumber: Option.none(),
            text: TranscriptText.make("Quiero empezar"),
          })).status
        ).toBe(500);
        const observed = yield* disclosures.find(acceptanceCaller(identity.businessScopedUserId));
        const attempt = yield* Effect.fromOption(
          Option.getOrUndefined(observed)?.state ?? Option.none()
        ).pipe(Effect.orDie);

        expect(yield* disclosures.processDue(DateTime.add(yield* DateTime.now, { days: 1 }))).toBe(
          false
        );
        const unresolved = yield* disclosures.find(acceptanceCaller(identity.businessScopedUserId));
        expect(
          unresolved.pipe(
            Option.flatMap((value) => value.state),
            Option.map((state) => state.state),
            Option.getOrUndefined
          )
        ).toBe("reconciliation-required");
        expect(attempt.attemptNumber).toBe(1);
        expect(yield* kapso.requests).toHaveLength(1);
      })
    );

    it.effect(whatsappAcceptanceTestName("WA-A10"), () =>
      Effect.gen(function* () {
        const kapso = yield* WhatsAppAcceptanceKapsoControl;
        yield* kapso.reset;

        yield* kapso.setDeliveryMode("sandbox-phone");
        const sandboxIdentity = yield* makeScenarioIdentity("WA-A10");
        const sandboxResponse = yield* postSignedWebhook({
          ...sandboxIdentity,
          phoneNumber: Option.some(E164PhoneNumber.make("+573001010101")),
          text: TranscriptText.make("Inicio sandbox"),
        });
        expect(sandboxResponse.status).toBe(200);

        yield* kapso.setDeliveryMode("bsuid");
        const bsuidIdentity = yield* makeScenarioIdentity("WA-A10");
        const bsuidResponse = yield* postSignedWebhook({
          ...bsuidIdentity,
          phoneNumber: Option.some(E164PhoneNumber.make("+573001020202")),
          text: TranscriptText.make("Inicio BSUID"),
        });
        expect(bsuidResponse.status).toBe(200);

        const requests = yield* kapso.requests;
        expect(requests).toHaveLength(2);
        expect(requests[0]?.body).toMatchObject({ to: "573001010101" });
        expect(requests[0]?.body).not.toHaveProperty("recipient");
        expect(requests[1]?.body).toMatchObject({
          recipient: bsuidIdentity.businessScopedUserId,
        });
        expect(requests[1]?.body).not.toHaveProperty("to");
      })
    );
  }
);
