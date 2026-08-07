import { expect, layer } from "@effect/vitest";
import { Crypto, DateTime, Effect, Option, Schedule, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { E164PhoneNumber, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import {
  WhatsAppAcceptanceApiClient,
  WhatsAppAcceptanceHarness,
  WhatsAppAcceptanceKapsoControl,
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
    providerMessageId: `wamid.acceptance-${scenarioId}-${nonce}`,
    businessScopedUserId: WhatsAppBusinessScopedUserId.make(`CO.${nonce}`),
  };
});

const postSignedWebhook = Effect.fn("Acceptance.postSignedWhatsAppWebhook")(function* (input: {
  readonly providerMessageId: string;
  readonly businessScopedUserId: WhatsAppBusinessScopedUserId;
  readonly phoneNumber: Option.Option<E164PhoneNumber>;
  readonly text: TranscriptText;
}) {
  const occurredAt = yield* DateTime.now;
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
  return yield* HttpClient.post("/webhooks/kapso", {
    headers: {
      "x-webhook-signature": signature,
      "x-idempotency-key": input.providerMessageId,
    },
    body: HttpBody.uint8Array(body, "application/json"),
  });
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
