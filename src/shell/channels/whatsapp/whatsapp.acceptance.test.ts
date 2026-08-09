import { expect, layer } from "@effect/vitest";
import { Crypto, DateTime, Effect, Option, Schedule, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  E164PhoneNumber,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import { CURRENT_DISCLOSURE_TEXT } from "~/shell/consent/current-disclosure";
import { WhatsAppProviderMessageId } from "./model";
import {
  WhatsAppAcceptanceApiClient,
  WhatsAppAcceptanceCallerControl,
  type WhatsAppAcceptanceCallerProbe,
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
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 60 }),
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

        const outbound = yield* awaitKapsoRequests(3);
        const reply = yield* Schema.decodeUnknownEffect(KapsoTextRequest)(outbound[2]?.body);
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
        const plainOutbound = yield* awaitKapsoRequests(4);
        const plainReply = yield* Schema.decodeUnknownEffect(KapsoTextRequest)(
          plainOutbound[3]?.body
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
