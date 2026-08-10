import { expect, layer } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Context,
  type Crypto,
  DateTime,
  Deferred,
  Effect,
  Array as EffectArray,
  Fiber,
  Layer,
  Logger,
  Option,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import {
  HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientResponse,
} from "effect/unstable/http";
import { SqlClient, type SqlConnection, SqlSchema, type Statement } from "effect/unstable/sql";
import { ConsentRecord, ConsentRecordId } from "~/core/consent/model";
import { E164PhoneNumber, UserId, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import { AgentBearerToken } from "~/core/tokens/model";
import { AgentReply, AgentService, OnboardingConsentRequired } from "~/shell/agent/agent-service";
import { makeOpenAiFunctionCallResponse } from "~/shell/agent/fixtures/openai";
import { OpenAiLanguageModelLive } from "~/shell/agent/openai";
import { admitAgentConversationTurn } from "~/shell/agent/conversation";
import { MigrationSqlClient } from "~/shell/db/client";
import {
  defaultUserId,
  defaultWhatsAppPhone,
  seedConsentedAgentIdentity,
  seedDevelopmentIdentity,
} from "~/shell/db/development-seed";
import {
  ApiHarness,
  ApiHarnessClient,
  ApiHarnessKapsoControl,
  ApiTelemetryHarness,
} from "~/shell/testing/api-harness";
import { makeLanguageModelFinishPart } from "~/shell/testing/language-model-fixtures";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { DisabledTelemetryResource, TelemetryDisabled } from "~/shell/observability/disabled";
import { EnvelopeRecorder } from "~/shell/observability/envelope-recorder";
import { ProjectedTransaction } from "~/shell/observability/projectors";
import { Telemetry, makeTelemetryService } from "~/shell/observability/telemetry";
import {
  claimConsentDisclosureDelivery,
  claimNextConsentDisclosureRetry,
  findConsentDisclosureDeliveryState,
  releaseConsentDisclosureDelivery,
} from "./disclosure-store";
import {
  DisclosureDeliveryCorrelationToken,
  applyConsentDisclosureLifecycle,
  processDueConsentDisclosureDelivery,
} from "./disclosure-delivery";
import {
  DurableTraceContext,
  TelemetryAttempt,
  TelemetryHttpStatus,
} from "~/shell/observability/protocol";
import {
  appendConsentRecord,
  findPendingConsentExchange,
  observeConsentRecords,
} from "~/shell/consent/repo";
import { associateWhatsAppIdentity, resolveWhatsAppCaller } from "~/shell/identity/repo";
import { removeWhatsAppIdentityForTesting } from "~/shell/identity/testing";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";
import { transactionPayload } from "~/shell/transactions/fixtures";
import { listTranscriptEntries } from "~/shell/transcript/repo";
import { TranscriptText } from "~/core/transcript/model";
import { categoryIds } from "~/core/categories/taxonomy";
import { KapsoClient, type KapsoClientService, KapsoSendFailed } from "./kapso-client";
import { decodeKapsoWebhook } from "./kapso-webhook";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppDeliveryKey,
  type WhatsAppInboundEvent,
  WhatsAppProviderMessageId,
} from "./model";
import { deliverWhatsAppConsentOutcome, sendKapsoFreeForm } from "./outbound";
import { truncateWhatsAppChannel } from "./fixtures";
import {
  claimWhatsAppReceipt,
  claimWhatsAppTurn,
  consumeWhatsAppIngressBudget,
  enqueueWhatsAppTurn,
  getWhatsAppWindowState,
  markWhatsAppReceiptOutboundStarted,
  releaseWhatsAppReceipt,
  startWhatsAppTurn,
} from "./repo";
import { processNextWhatsAppTurn, runSupervisedWhatsAppLoop, runWhatsAppRetention } from "./worker";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";

const deliveryKey = WhatsAppDeliveryKey.make("delivery-worker-fixture");
const enqueueTurn = (
  input: Omit<Parameters<typeof enqueueWhatsAppTurn>[0], "propagation">
): ReturnType<typeof enqueueWhatsAppTurn> =>
  enqueueWhatsAppTurn({ ...input, propagation: Option.none() });
const sendFreeFormFixture = (
  userId: UserId,
  reply: AgentReply,
  now: DateTime.Utc
): ReturnType<typeof sendKapsoFreeForm> =>
  sendKapsoFreeForm({ userId, reply, now, attempt: TelemetryAttempt.make(1) });
const fixtureBytes = (
  name: "kapso-text-v2.json" | "kapso-voice-v2.json"
): Effect.Effect<Uint8Array<ArrayBuffer>> =>
  Effect.promise(() => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).bytes());
const postSignedTextFixture = Effect.fn("WhatsApp.postSignedTextFixture")(function* (
  input: Readonly<{ providerMessageId: string }> &
    Partial<
      Readonly<{
        phoneNumber: E164PhoneNumber;
        text: string;
        occurredAt: DateTime.Utc;
        headers: Readonly<Record<string, string>>;
      }>
    >
) {
  const phoneNumber = input.phoneNumber ?? E164PhoneNumber.make("+573001234567");
  const text = input.text ?? "almuerzo 25 mil";
  const occurredAt = input.occurredAt ?? DateTime.makeUnsafe("2026-04-03T12:00:00.000Z");
  const template = new TextDecoder().decode(yield* fixtureBytes("kapso-text-v2.json"));
  const body = new TextEncoder().encode(
    template
      .replace("wamid.text-001", input.providerMessageId)
      .replaceAll("573001234567", phoneNumber.slice(1))
      .replace("almuerzo 25 mil", text)
      .replace(
        '"timestamp": "1775217600"',
        `"timestamp": "${Math.floor(DateTime.toEpochMillis(occurredAt) / 1_000)}"`
      )
  );
  const signature = new Bun.CryptoHasher("sha256", "test-webhook-secret-32-characters")
    .update(body)
    .digest("hex");
  return yield* HttpClient.post("/webhooks/kapso", {
    headers: {
      "x-webhook-signature": signature,
      "x-idempotency-key": input.providerMessageId,
      ...input.headers,
    },
    body: HttpBody.uint8Array(body, "application/json"),
  });
});
const recordedTransactions = Effect.fn("WhatsApp.recordedTransactions")(function* () {
  const recorder = yield* EnvelopeRecorder;
  const envelopes = yield* recorder.serializedEnvelopes;
  return envelopes.flatMap((bytes) => {
    const lines = new TextDecoder().decode(bytes).split("\n");
    const payloads: Array<ProjectedTransaction> = [];
    for (let index = 2; index < lines.length; index += 2) {
      const payload = Schema.decodeUnknownOption(ProjectedTransaction)(
        Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(lines[index] ?? "null")
      );
      if (Option.isSome(payload)) payloads.push(payload.value);
    }
    return payloads;
  });
});
const requiredTransaction = (
  transactions: ReadonlyArray<ProjectedTransaction>,
  operation: ProjectedTransaction["transaction"]
): ProjectedTransaction =>
  Option.getOrThrow(
    Option.fromNullishOr(transactions.find((transaction) => transaction.transaction === operation))
  );
const expectAuthenticatedTrace = (
  transactions: ReadonlyArray<ProjectedTransaction>,
  forgedTraceId: string
): void => {
  const ingress = requiredTransaction(transactions, "POST /webhooks/kapso");
  const publication = requiredTransaction(transactions, "whatsapp.publishTurn");
  const processing = requiredTransaction(transactions, "whatsapp.processTurn");
  const hostedTurn = requiredTransaction(transactions, "agent.hostedTurn");
  const modelRound = requiredTransaction(transactions, "agent.modelRound");
  const provider = requiredTransaction(transactions, "whatsapp.sendText");
  expect(ingress.contexts.trace.parent_span_id).toBeUndefined();
  expect(ingress.contexts.trace.trace_id).not.toBe(forgedTraceId);
  expect(ingress.contexts.trace.data["fidy.operation"]).toBe("http.kapsoWebhook");
  expect(publication.contexts.trace).toMatchObject({
    trace_id: ingress.contexts.trace.trace_id,
    parent_span_id: ingress.contexts.trace.span_id,
    op: "queue.publish",
  });
  expect(processing.contexts.trace).toMatchObject({
    trace_id: ingress.contexts.trace.trace_id,
    parent_span_id: publication.contexts.trace.span_id,
    op: "queue.process",
    data: { "fidy.attempt": 1, "fidy.input_count": 1 },
  });
  expect(processing.contexts.trace.data["fidy.delay_milliseconds"]).toBeGreaterThanOrEqual(2_500);
  expect(processing.contexts.trace.data["fidy.delay_milliseconds"]).toBeLessThanOrEqual(3_000);
  expect(hostedTurn.contexts.trace).toMatchObject({
    trace_id: ingress.contexts.trace.trace_id,
    parent_span_id: processing.contexts.trace.span_id,
    op: "agent.turn",
  });
  expect(modelRound.contexts.trace).toMatchObject({
    trace_id: ingress.contexts.trace.trace_id,
    parent_span_id: hostedTurn.contexts.trace.span_id,
    op: "agent.model",
  });
  expect(provider.contexts.trace).toMatchObject({
    trace_id: ingress.contexts.trace.trace_id,
    parent_span_id: processing.contexts.trace.span_id,
    op: "http.client",
    data: {
      "fidy.provider": "kapso",
      "fidy.attempt": 1,
      "http.response.status_code": 200,
    },
  });
};
const durableContextFixture = (
  traceId: string,
  parentSpanId: string,
  capturedAt: DateTime.Utc
): Effect.Effect<DurableTraceContext, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(DurableTraceContext)({
    version: 1,
    traceId,
    parentSpanId,
    sampled: true,
    capturedAtUnixMilliseconds: DateTime.toEpochMillis(capturedAt),
  });

const enqueueTraceFixture = Effect.fn("WhatsApp.enqueueTraceFixture")(function* (
  index: number,
  eventTime: DateTime.Utc
) {
  const suffix = String(index + 1);
  const userId = UserId.make(`f1d1a000-0000-4000-8000-${String(index + 930).padStart(12, "0")}`);
  yield* seedConsentedAgentIdentity({
    userId,
    bearer: AgentBearerToken.make(
      `fin_trace${suffix.padStart(3, "0")}_abcdefghijklmnopqrstuvwxyz0123456789ABCD`
    ),
  });
  const caller = testWhatsAppCaller(
    E164PhoneNumber.make(`+5730012300${String(index).padStart(2, "0")}`)
  );
  yield* associateWhatsAppIdentity(userId, { ...caller, verifiedAt: eventTime });
  const event = {
    ...makeKapsoTextEvent(`wamid.concurrent-trace-${suffix}`, "taxi", eventTime),
    caller,
  };
  const context = yield* durableContextFixture(suffix.repeat(32), suffix.repeat(16), eventTime);
  yield* enqueueWhatsAppTurn({
    admission: {
      _tag: "AuthorizedTurn",
      userId,
      inboundMessage: { text: TranscriptText.make("taxi") },
    },
    event,
    deliveryKey,
    propagation: Option.some(context),
  });
  return { userId, context } as const;
});
const recordedEvents = Effect.fn("WhatsApp.recordedEvents")(function* (receivedAt: DateTime.Utc) {
  const text = yield* decodeKapsoWebhook({
    rawBody: yield* fixtureBytes("kapso-text-v2.json"),
    secret: "test-webhook-secret-32-characters",
    signature: "6c2d8ade595be0115c9ba1286d8f015c380008cd250ed5bfffd676c4845d4571",
    deliveryKey,
    businessPortfolioId: "portfolio-test",
    receivedAt,
  });
  const voice = yield* decodeKapsoWebhook({
    rawBody: yield* fixtureBytes("kapso-voice-v2.json"),
    secret: "test-webhook-secret-32-characters",
    signature: "c60d4e3e3daacd2911a21d7dbe4dfb488880893e5c8dbb12b8fe3479d17f8130",
    deliveryKey,
    businessPortfolioId: "portfolio-test",
    receivedAt: DateTime.add(receivedAt, { milliseconds: 100 }),
  });
  return [text.events[0], voice.events[0]] as const;
});
const businessPhoneNumberId = WhatsAppBusinessPhoneNumberId.make("123456789012345");
const ScriptedWhatsAppModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: ({ prompt }) => {
      const serialized = Schema.encodeSync(Schema.UnknownFromJsonString)(prompt.content);
      const completed = (callId: string): boolean => {
        const callIndex = serialized.lastIndexOf(callId);
        return callIndex >= 0 && serialized.lastIndexOf("tool-result") > callIndex;
      };
      const voice =
        serialized.lastIndexOf("taxi 18 mil") > serialized.lastIndexOf("almuerzo 25 mil");
      const callId = voice ? "whatsapp-voice-quick-log" : "whatsapp-text-quick-log";
      if (completed(callId)) {
        return Effect.succeed([
          { type: "text" as const, text: "Registré el movimiento." },
          makeLanguageModelFinishPart("stop"),
        ]);
      }
      const occurredAt = Option.fromNullishOr(
        /El turno comenzó en ([0-9T:.+-]+Z)/u.exec(serialized)
      ).pipe(Option.flatMap((match) => Option.fromNullishOr(match[1])));
      if (Option.isNone(occurredAt)) return Effect.die("missing scripted turn timestamp");
      return Effect.succeed([
        {
          type: "tool-call" as const,
          id: callId,
          name: "transactions__createTransaction",
          params: {
            payload: voice
              ? {
                  money: { amount: "18000", currency: "COP" },
                  counterparty: "WhatsAppTaxi",
                  direction: "outflow",
                  categoryId: categoryIds.transporte,
                  occurredAt: occurredAt.value,
                }
              : {
                  money: { amount: "25000", currency: "COP" },
                  counterparty: "WhatsAppAlmuerzo",
                  direction: "outflow",
                  categoryId: categoryIds.restaurantes,
                  occurredAt: occurredAt.value,
                },
          },
        },
        makeLanguageModelFinishPart("tool-calls"),
      ]);
    },
    streamText: () =>
      Stream.die(new Error("The WhatsApp agent test uses non-streaming generation")),
  })
);
const modelFailure = AiError.AiError.make({
  module: "WhatsAppChannelTest",
  method: "generateText",
  reason: AiError.InternalProviderError.make({ description: "scripted provider failure" }),
});
const FailingWhatsAppModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.fail(modelFailure),
    streamText: () => Stream.fail(modelFailure),
  })
);
const FailingAgentService = AgentService.layer.pipe(
  Layer.provide(FailingWhatsAppModel),
  Layer.provide(TelemetryDisabled)
);
const OpenAiRequest = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ parameters: Schema.Unknown })),
});
const openAiCategoryToolResponse = makeOpenAiFunctionCallResponse({
  name: "categories__listCategories",
  argumentsJson: "{}",
});
const openAiTransactionToolResponse = makeOpenAiFunctionCallResponse({
  name: "transactions__createTransaction",
  argumentsJson: JSON.stringify({
    payload: {
      money: { amount: "10000", currency: "COP" },
      counterparty: "OpenAiBreakfast",
      direction: "outflow",
      categoryId: categoryIds.restaurantes,
      notes: null,
      occurredAt: "2026-04-03T12:01:02.000Z",
    },
  }),
});
const OpenAiHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.body._tag !== "Uint8Array") {
        return yield* Effect.die("Expected an encoded OpenAI request body");
      }
      const requestText = new TextDecoder().decode(request.body.body);
      const json = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
        requestText
      ).pipe(Effect.orDie);
      const body = yield* Schema.decodeUnknownEffect(OpenAiRequest)(json).pipe(Effect.orDie);
      if (
        body.tools.some(
          ({ parameters }) =>
            typeof parameters === "object" && parameters !== null && "anyOf" in parameters
        )
      ) {
        return yield* Effect.die("OpenAI rejected a union parameter schema");
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          requestText.includes("10000 desayuno")
            ? openAiTransactionToolResponse
            : openAiCategoryToolResponse,
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );
    })
  )
);
const OpenAiWhatsAppModel = OpenAiLanguageModelLive.pipe(
  Layer.provide(OpenAiHttpClient),
  Layer.provide(
    ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENAI_API_KEY: "test-only-secret" }))
  )
);
const OpenAiAgentService = AgentService.layer.pipe(
  Layer.provide(OpenAiWhatsAppModel),
  Layer.provide(TelemetryDisabled)
);
const WhatsAppHarness = AgentService.layer.pipe(
  Layer.provideMerge(ScriptedWhatsAppModel),
  Layer.provideMerge(ApiHarness),
  Layer.provide(TelemetryDisabled)
);
const WhatsAppTraceHarness = AgentService.layer.pipe(
  Layer.provideMerge(ScriptedWhatsAppModel),
  Layer.provideMerge(ApiTelemetryHarness)
);
const makeKapsoTextEvent = (
  providerMessageId: string,
  text: string,
  receivedAt: DateTime.Utc
): WhatsAppInboundEvent => ({
  messageEvidence: {
    channel: "whatsapp",
    provider: "kapso",
    providerMessageId: WhatsAppProviderMessageId.make(providerMessageId),
  },
  caller: testWhatsAppCaller(defaultWhatsAppPhone),
  businessPhoneNumberId,
  occurredAt: receivedAt,
  receivedAt,
  content: { _tag: "Text", text: TranscriptText.make(text) },
});
const authorizedTurn = (
  event: WhatsAppInboundEvent,
  userId: UserId = defaultUserId
): {
  _tag: "AuthorizedTurn";
  userId: UserId;
  inboundMessage: { text: TranscriptText };
} => ({
  _tag: "AuthorizedTurn" as const,
  userId,
  inboundMessage: { text: event.content.text },
});
const agentReplyFixture = (text: string, overrides: Partial<AgentReply> = {}): AgentReply =>
  AgentReply.make({
    text: TranscriptText.make(text),
    attachments: Option.none(),
    choices: Option.none(),
    ...overrides,
  });
type AgentServiceFixture = Parameters<typeof AgentService.of>[0];
const agentServiceFixture = (overrides: Partial<AgentServiceFixture> = {}): AgentServiceFixture =>
  AgentService.of({
    handleTurn: () =>
      Effect.succeed({
        reply: agentReplyFixture("Respuesta entregada."),
        assistantEntry: Option.none(),
      }),
    handleSynchronousTurn: () => Effect.succeed(agentReplyFixture("Respuesta entregada.")),
    recordDeliveredReply: () => Effect.void,
    ...overrides,
  });
const kapsoClientFixture = (
  providerMessageId: string,
  sentAt: DateTime.Utc,
  beforeSend: Effect.Effect<void> = Effect.void
): KapsoClientService => ({
  sendText: (): Effect.Effect<{
    messageEvidence: {
      channel: "whatsapp";
      provider: string;
      providerMessageId: WhatsAppProviderMessageId;
    };
    sentAt: DateTime.Utc;
    responseStatus: TelemetryHttpStatus;
  }> =>
    beforeSend.pipe(
      Effect.as({
        messageEvidence: {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: WhatsAppProviderMessageId.make(providerMessageId),
        },
        sentAt,
        responseStatus: TelemetryHttpStatus.make(200),
      })
    ),
});
const deliverLatestDisclosure = Effect.fn("Test.deliverLatestDisclosure")(function* (
  phoneNumber: E164PhoneNumber,
  occurredAt: DateTime.Utc
) {
  const exchange = yield* Effect.fromOption(
    yield* findPendingConsentExchange(testWhatsAppCaller(phoneNumber))
  ).pipe(Effect.orDie);
  const attempt = yield* Effect.fromOption(
    yield* findConsentDisclosureDeliveryState(exchange.id)
  ).pipe(Effect.orDie);
  return yield* applyConsentDisclosureLifecycle({
    outcome: "accepted",
    correlationToken: DisclosureDeliveryCorrelationToken.make(attempt.attemptId),
    messageEvidence: {
      channel: "whatsapp",
      provider: "kapso",
      providerMessageId: WhatsAppProviderMessageId.make("wamid.test-outbound"),
    },
    occurredAt,
  });
});

const processTurnWith = (
  claimTime: DateTime.Utc,
  agent: AgentServiceFixture,
  kapso: KapsoClientService
): Effect.Effect<boolean, never, Crypto.Crypto | HttpClient.HttpClient | SqlClient.SqlClient> =>
  processNextWhatsAppTurn(claimTime).pipe(
    Effect.provideService(AgentService, agent),
    Effect.provideService(KapsoClient, kapso)
  );
layer(WhatsAppHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "WhatsApp durable turn boundary",
  (it) => {
    it.effect(
      "resolves identity, deduplicates redelivery, and collapses a text/voice burst once",
      () =>
        Effect.gen(function* () {
          yield* seedDevelopmentIdentity(defaultAgentBearer);
          yield* truncateWhatsAppChannel;
          const eventTime = DateTime.makeUnsafe("2026-04-03T12:00:02.000Z");
          const [first, second] = yield* recordedEvents(eventTime);

          const firstAdmission = yield* admitAgentConversationTurn({
            caller: first.caller,
            content: { _tag: "Text", text: first.content.text },
            message: first.messageEvidence,
            receivedAt: first.receivedAt,
          });
          const secondAdmission = yield* admitAgentConversationTurn({
            caller: second.caller,
            content: { _tag: "Text", text: second.content.text },
            message: second.messageEvidence,
            receivedAt: second.receivedAt,
          });
          expect(firstAdmission).toMatchObject({ _tag: "AuthorizedTurn", userId: defaultUserId });
          expect(secondAdmission).toMatchObject({ _tag: "AuthorizedTurn", userId: defaultUserId });
          if (
            firstAdmission._tag !== "AuthorizedTurn" ||
            secondAdmission._tag !== "AuthorizedTurn"
          ) {
            return yield* Effect.die("expected authorized fixture turns");
          }
          expect(
            (yield* enqueueTurn({
              admission: firstAdmission,
              event: first,
              deliveryKey,
            })).inserted
          ).toBe(true);
          expect(
            (yield* enqueueTurn({
              admission: secondAdmission,
              event: second,
              deliveryKey,
            })).inserted
          ).toBe(true);
          const sql = yield* SqlClient.SqlClient;
          yield* withUserTransaction(
            defaultUserId,
            sql`UPDATE whatsapp_conversation_windows
                SET window_open_until = ${DateTime.add(yield* DateTime.now, { hours: 1 })}
                WHERE user_id = ${defaultUserId}`
          );

          const sendCalls = yield* Ref.make(0);
          const kapsoService = kapsoClientFixture(
            "wamid.worker-reply",
            eventTime,
            Ref.update(sendCalls, (count) => count + 1)
          );
          expect(
            yield* processNextWhatsAppTurn(DateTime.add(eventTime, { seconds: 1 })).pipe(
              Effect.provideService(KapsoClient, kapsoService)
            )
          ).toBe(false);
          expect(
            yield* processNextWhatsAppTurn(DateTime.add(eventTime, { seconds: 3 })).pipe(
              Effect.provideService(KapsoClient, kapsoService)
            )
          ).toBe(true);
          expect(yield* Ref.get(sendCalls)).toBe(1);
          const transactions = yield* withUserTransaction(
            defaultUserId,
            sql`SELECT counterparty FROM transactions
                WHERE user_id = ${defaultUserId}
                  AND counterparty IN ('WhatsAppAlmuerzo', 'WhatsAppTaxi')
                ORDER BY counterparty`
          );
          expect(transactions).toEqual([{ counterparty: "WhatsAppTaxi" }]);

          expect(
            (yield* enqueueTurn({
              admission: firstAdmission,
              event: first,
              deliveryKey,
            })).inserted
          ).toBe(false);
        })
    );

    it.effect("quick-logs a text-only turn through the real AgentService", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = DateTime.makeUnsafe("2026-04-03T12:01:02.000Z");
        const inbound = makeKapsoTextEvent("wamid.text-only", "almuerzo 25 mil", eventTime);
        const admission = yield* admitAgentConversationTurn({
          caller: inbound.caller,
          content: { _tag: "Text", text: inbound.content.text },
          message: inbound.messageEvidence,
          receivedAt: inbound.receivedAt,
        });
        if (admission._tag !== "AuthorizedTurn") {
          return yield* Effect.die("expected authorized text turn");
        }
        yield* enqueueTurn({
          admission,
          event: inbound,
          deliveryKey,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* withUserTransaction(
          defaultUserId,
          sql`UPDATE whatsapp_conversation_windows
              SET window_open_until = ${DateTime.add(yield* DateTime.now, { hours: 1 })}
              WHERE user_id = ${defaultUserId}`
        );
        const kapsoService = kapsoClientFixture("wamid.text-only-reply", eventTime);
        expect(
          yield* processNextWhatsAppTurn(DateTime.add(eventTime, { seconds: 3 })).pipe(
            Effect.provideService(KapsoClient, kapsoService)
          )
        ).toBe(true);
        expect(
          yield* withUserTransaction(
            defaultUserId,
            sql`SELECT counterparty FROM transactions
                WHERE user_id = ${defaultUserId} AND counterparty = 'WhatsAppAlmuerzo'`
          )
        ).toEqual([{ counterparty: "WhatsAppAlmuerzo" }]);
      })
    );

    it.effect("keeps concurrent background turns bound to their originating Users", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const secondUserId = UserId.make("f1d1a000-0000-4000-8000-000000000920");
        const secondPhone = E164PhoneNumber.make("+573008889920");
        yield* seedConsentedAgentIdentity({
          userId: secondUserId,
          bearer: AgentBearerToken.make("fin_whatsiso_abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
        });
        const sql = yield* SqlClient.SqlClient;
        const countTransactions = (
          userId: UserId,
          counterparty: string
        ): Effect.Effect<
          number,
          Cause.NoSuchElementError | Schema.SchemaError,
          SqlClient.SqlClient
        > =>
          Effect.gen(function* () {
            const row = yield* withUserTransaction(
              userId,
              SqlSchema.findOne({
                Request: Schema.Struct({ userId: UserId, counterparty: Schema.String }),
                Result: Schema.Struct({ count: Schema.Int }),
                execute: (request) => sql`SELECT count(*)::int AS count FROM transactions
                  WHERE user_id = ${request.userId} AND counterparty = ${request.counterparty}`,
              })({ userId, counterparty }).pipe(Effect.orDie)
            );
            return row.count;
          });
        const [firstCountBefore, secondCountBefore] = yield* Effect.all([
          countTransactions(defaultUserId, "WhatsAppAlmuerzo"),
          countTransactions(secondUserId, "WhatsAppTaxi"),
        ]);
        const eventTime = yield* DateTime.now;
        yield* associateWhatsAppIdentity(secondUserId, {
          ...testWhatsAppCaller(secondPhone),
          verifiedAt: eventTime,
        });
        const first = makeKapsoTextEvent("wamid.isolation-a", "almuerzo 25 mil", eventTime);
        const second = {
          ...makeKapsoTextEvent("wamid.isolation-b", "taxi 18 mil", eventTime),
          caller: testWhatsAppCaller(secondPhone),
        };
        yield* Effect.all(
          [
            enqueueTurn({
              admission: authorizedTurn(first),
              event: first,
              deliveryKey,
            }),
            enqueueTurn({
              admission: authorizedTurn(second, secondUserId),
              event: second,
              deliveryKey,
            }),
          ],
          { concurrency: "unbounded" }
        );

        const recipients = yield* Ref.make<ReadonlyArray<string>>([]);
        const kapsoService: KapsoClientService = {
          sendText: (input) =>
            Ref.updateAndGet(recipients, (current) => [
              ...current,
              input.destination.recipient,
            ]).pipe(
              Effect.map((current) => ({
                messageEvidence: {
                  channel: "whatsapp" as const,
                  provider: "kapso",
                  providerMessageId: WhatsAppProviderMessageId.make(
                    `wamid.isolation-reply-${current.length}`
                  ),
                },
                sentAt: eventTime,
                responseStatus: TelemetryHttpStatus.make(200),
              }))
            ),
        };
        const claimTime = DateTime.add(eventTime, { seconds: 3 });
        yield* Effect.all(
          [processNextWhatsAppTurn(claimTime), processNextWhatsAppTurn(claimTime)],
          { concurrency: "unbounded" }
        ).pipe(Effect.provideService(KapsoClient, kapsoService));
        yield* processNextWhatsAppTurn(claimTime).pipe(
          Effect.provideService(KapsoClient, kapsoService)
        );

        expect((yield* Ref.get(recipients)).toSorted()).toEqual(
          [
            testWhatsAppCaller(defaultWhatsAppPhone).businessScopedUserId,
            testWhatsAppCaller(secondPhone).businessScopedUserId,
          ].toSorted()
        );
        const [firstCountAfter, secondCountAfter] = yield* Effect.all([
          countTransactions(defaultUserId, "WhatsAppAlmuerzo"),
          countTransactions(secondUserId, "WhatsAppTaxi"),
        ]);
        expect(firstCountAfter).toBe(firstCountBefore + 1);
        expect(secondCountAfter).toBe(secondCountBefore + 1);
        expect(
          yield* withUserTransaction(
            defaultUserId,
            sql`SELECT counterparty FROM transactions WHERE user_id = ${secondUserId}`
          )
        ).toEqual([]);
      })
    );

    it.effect("keeps claimed content behind User RLS and exposes only pre-subject identity", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = DateTime.makeUnsafe("2026-04-03T12:00:02.000Z");
        const inbound = makeKapsoTextEvent("wamid.gateway-boundary", "pan 5 mil", eventTime);
        yield* enqueueTurn({
          admission: authorizedTurn(inbound),
          event: inbound,
          deliveryKey,
        });

        const claim = yield* claimWhatsAppTurn(DateTime.add(eventTime, { seconds: 3 }));
        expect(Option.isSome(claim)).toBe(true);
        if (Option.isNone(claim)) return yield* Effect.die("expected gateway claim");
        expect(Object.keys(claim.value).sort()).toEqual(["action", "claimId", "userId"]);
        const wrongUserClaim = {
          ...claim.value,
          userId: UserId.make("f1d1a000-0000-4000-8000-000000000921"),
        };
        expect(
          (yield* startWhatsAppTurn(wrongUserClaim, DateTime.add(eventTime, { seconds: 3 })).pipe(
            Effect.flip
          ))._tag
        ).toBe("WhatsAppClaimInvalid");

        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT content FROM whatsapp_inbound_jobs`).toEqual([]);
        expect(
          yield* withUserTransaction(
            defaultUserId,
            sql`SELECT claim.status, job.content
                FROM whatsapp_turn_claims AS claim
                JOIN whatsapp_inbound_jobs AS job ON job.claim_id = claim.id
                WHERE claim.id = ${claim.value.claimId}`
          )
        ).toEqual([{ status: "claimed", content: "pan 5 mil" }]);

        const claimTime = DateTime.add(eventTime, { seconds: 3 });
        yield* startWhatsAppTurn(claim.value, claimTime);
        expect(
          yield* withUserTransaction(
            defaultUserId,
            sql`SELECT started_at = ${claimTime} AS "startedAtClaimTime",
                       claim_expires_at = ${DateTime.add(claimTime, { minutes: 10 })}
                         AS "expiresFromClaimTime"
                FROM whatsapp_turn_claims
                WHERE id = ${claim.value.claimId}`
          )
        ).toEqual([{ startedAtClaimTime: true, expiresFromClaimTime: true }]);
      })
    );

    it.effect("terminally retires stale started work without replaying its content", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = yield* DateTime.now;
        const inbound = makeKapsoTextEvent("wamid.ambiguous-crash", "mercado 20 mil", eventTime);
        yield* enqueueTurn({
          admission: authorizedTurn(inbound),
          event: inbound,
          deliveryKey,
        });
        const claim = yield* claimWhatsAppTurn(DateTime.add(eventTime, { seconds: 3 }));
        if (Option.isNone(claim)) return yield* Effect.die("expected crash fixture claim");
        yield* startWhatsAppTurn(claim.value, DateTime.add(eventTime, { seconds: 3 }));
        const sql = yield* SqlClient.SqlClient;
        yield* withUserTransaction(
          defaultUserId,
          sql`UPDATE whatsapp_turn_claims SET claim_expires_at = ${eventTime}
              WHERE id = ${claim.value.claimId}`
        );
        expect(
          yield* processNextWhatsAppTurn(DateTime.add(eventTime, { minutes: 11 })).pipe(
            Effect.provideService(KapsoClient, {
              sendText: () => Effect.die("retired claim reached Kapso"),
            })
          )
        ).toBe(true);
        expect(
          yield* withUserTransaction(
            defaultUserId,
            sql`SELECT claim.safe_reason AS "safeReason",
                  (SELECT content FROM whatsapp_inbound_jobs
                   WHERE user_id = ${defaultUserId}
                   AND message_evidence_id = (
                     SELECT id FROM whatsapp_message_evidence
                     WHERE provider_message_id = 'wamid.ambiguous-crash'
                   )) AS content
                FROM whatsapp_turn_claims AS claim
                WHERE claim.id = ${claim.value.claimId}`
          )
        ).toMatchObject([{ safeReason: "ambiguous_crash", content: null }]);
      })
    );

    it.effect("enforces a durable cross-instance hourly ingress budget", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const receivedAt = yield* DateTime.now;
        const scope = {
          _tag: "Caller" as const,
          caller: testWhatsAppCaller(E164PhoneNumber.make("+573001234567")),
        };
        yield* Effect.forEach(
          EffectArray.range(1, 60),
          (index) =>
            consumeWhatsAppIngressBudget(
              scope,
              WhatsAppProviderMessageId.make(`wamid.phone-budget-${index}`),
              receivedAt
            ),
          { concurrency: "unbounded" }
        );
        const failure = yield* consumeWhatsAppIngressBudget(
          scope,
          WhatsAppProviderMessageId.make("wamid.phone-budget-overflow"),
          receivedAt
        ).pipe(Effect.flip);
        expect(failure._tag).toBe("WhatsAppRateLimitExceeded");
        yield* consumeWhatsAppIngressBudget(
          scope,
          WhatsAppProviderMessageId.make("wamid.phone-budget-next-window"),
          DateTime.add(receivedAt, { hours: 1 })
        );
      })
    );

    it.effect("prunes expired operational identifiers without later inbound traffic", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = yield* DateTime.now;
        const inbound = makeKapsoTextEvent("wamid.retention", "x", eventTime);
        yield* enqueueTurn({
          admission: authorizedTurn(inbound),
          event: inbound,
          deliveryKey,
        });
        yield* consumeWhatsAppIngressBudget(
          { _tag: "Caller", caller: inbound.caller },
          inbound.messageEvidence.providerMessageId,
          eventTime
        );

        const admin = yield* MigrationSqlClient;
        yield* admin`UPDATE whatsapp_ingress_budgets
                     SET window_started_at = now() - interval '3 hours'`;
        yield* consumeWhatsAppIngressBudget(
          { _tag: "User", userId: defaultUserId },
          WhatsAppProviderMessageId.make("wamid.retention-user-budget"),
          eventTime
        );
        yield* withUserTransaction(
          defaultUserId,
          (yield* SqlClient.SqlClient)`UPDATE whatsapp_conversation_windows
                                       SET window_open_until = now() - interval '1 second'`
        );
        yield* runWhatsAppRetention.pipe(
          Effect.provideService(Telemetry, makeTelemetryService(DisabledTelemetryResource.adapter))
        );

        expect(
          yield* admin`SELECT budget_key AS "budgetKey" FROM whatsapp_ingress_budgets`
        ).toEqual([{ budgetKey: `user:${defaultUserId}` }]);
        expect(yield* admin`SELECT user_id FROM whatsapp_conversation_windows`).toEqual([]);
      })
    );

    it.effect("refuses bounded-capacity overflow without consuming provider evidence", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = yield* DateTime.now;
        const concurrentAdmissions = yield* Effect.forEach(
          Array.from({ length: 32 }, (_, index) => index),
          (index) => {
            const inbound = makeKapsoTextEvent(`wamid.capacity-${index}`, "x", eventTime);
            return enqueueTurn({
              admission: authorizedTurn(inbound),
              event: inbound,
              deliveryKey,
            });
          },
          { concurrency: "unbounded" }
        );
        expect(concurrentAdmissions.every(({ inserted }) => inserted)).toBe(true);
        const overflowBody = yield* fixtureBytes("kapso-text-v2.json");
        const response = yield* HttpClient.post("/webhooks/kapso", {
          headers: {
            "x-webhook-signature":
              "6c2d8ade595be0115c9ba1286d8f015c380008cd250ed5bfffd676c4845d4571",
            "x-idempotency-key": "capacity-overflow-delivery",
          },
          body: HttpBody.uint8Array(overflowBody, "application/json"),
        });
        expect(response.status).toBe(503);

        const sql = yield* SqlClient.SqlClient;
        const evidence = yield* withUserTransaction(
          defaultUserId,
          sql`SELECT provider_message_id FROM whatsapp_message_evidence
              WHERE provider_message_id = 'wamid.text-001'`
        );
        expect(evidence).toEqual([]);
        const admin = yield* MigrationSqlClient;
        expect(
          yield* admin`SELECT provider_message_id FROM whatsapp_inbound_receipts
                       WHERE provider_message_id = 'wamid.text-001'`
        ).toEqual([]);
      })
    );

    it.effect("counts newline separators inside the 16,000-character burst limit", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = yield* DateTime.now;
        const first = makeKapsoTextEvent("wamid.boundary-first", "a".repeat(8_000), eventTime);
        const second = makeKapsoTextEvent("wamid.boundary-second", "b".repeat(7_999), eventTime);
        expect(
          (yield* enqueueTurn({
            admission: authorizedTurn(first),
            event: first,
            deliveryKey,
          })).inserted
        ).toBe(true);
        expect(
          (yield* enqueueTurn({
            admission: authorizedTurn(second),
            event: second,
            deliveryKey,
          })).inserted
        ).toBe(true);

        const overflow = makeKapsoTextEvent("wamid.boundary-overflow", "c", eventTime);
        const failure = yield* enqueueTurn({
          admission: authorizedTurn(overflow),
          event: overflow,
          deliveryKey,
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("WhatsAppInboundCapacityExceeded");

        const claim = yield* claimWhatsAppTurn(DateTime.add(eventTime, { seconds: 3 }));
        if (Option.isNone(claim) || claim.value.action !== "process") {
          return yield* Effect.die("missing boundary claim");
        }
        const started = yield* startWhatsAppTurn(
          claim.value,
          DateTime.add(eventTime, { seconds: 3 })
        );
        expect(started.inboundMessage.text).toBe(`${"a".repeat(8_000)}\n${"b".repeat(7_999)}`);
        expect(started.inboundMessage.text).toHaveLength(16_000);
      })
    );

    it.effect("terminally fails a claimed burst when the agent cannot answer", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = DateTime.makeUnsafe("2026-04-03T12:00:02.000Z");
        const inbound = makeKapsoTextEvent("wamid.agent-failure", "mercado 20 mil", eventTime);
        yield* enqueueTurn({
          admission: authorizedTurn(inbound),
          event: inbound,
          deliveryKey,
        });

        const failingAgent = yield* Layer.build(FailingAgentService).pipe(
          Effect.map(Context.get(AgentService))
        );
        const processed = yield* processNextWhatsAppTurn(
          DateTime.add(eventTime, { seconds: 3 })
        ).pipe(
          Effect.provideService(AgentService, failingAgent),
          Effect.provideService(KapsoClient, {
            sendText: () => Effect.die("failed agent turn reached Kapso"),
          })
        );
        expect(processed).toBe(true);
        expect(
          yield* processNextWhatsAppTurn(DateTime.add(eventTime, { seconds: 4 })).pipe(
            Effect.provideService(AgentService, failingAgent),
            Effect.provideService(KapsoClient, {
              sendText: () => Effect.die("terminal turn reached Kapso"),
            })
          )
        ).toBe(false);
      })
    );

    it.effect("reports a worker defect and runs the next loop iteration", () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const capturedLogs: Array<unknown> = [];
        const logger = Logger.make((options) => capturedLogs.push(options.message));
        const sentinel = "secret-webhook-body-sentinel";
        const captures = yield* Ref.make(0);
        const capturedCause = yield* Ref.make<Option.Option<unknown>>(Option.none());
        const resumed = yield* Deferred.make<void>();
        const telemetry = Telemetry.of({
          span: (_descriptor, work) => work,
          rootSpan: (_descriptor, work) => work,
          continueSpan: (_savedContext, _descriptor, work) => work,
          recordOutcome: () => Effect.void,
          recordResponseStatus: () => Effect.void,
          captureFailure: (failure) =>
            Ref.update(captures, (count) => count + 1).pipe(
              Effect.andThen(
                failure._tag === "Defect"
                  ? Ref.set(capturedCause, Option.some(failure.cause))
                  : Effect.void
              )
            ),
          addBreadcrumb: () => Effect.void,
          recordModelUsage: () => Effect.void,
          captureDurableContext: Effect.succeed(Option.none()),
          isActiveSpan: () => Effect.succeed(false),
        });
        const iteration = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) => {
            if (attempt === 1) {
              return Effect.fail({ _tag: "ScriptedWorkerFailure", body: sentinel });
            }
            if (attempt === 2) {
              return Effect.die(Object.assign(new Error(sentinel), { body: sentinel }));
            }
            return Deferred.succeed(resumed, undefined).pipe(Effect.andThen(Effect.never));
          })
        );
        const fiber = yield* runSupervisedWhatsAppLoop(iteration, "whatsapp.processWork").pipe(
          Effect.provideService(Telemetry, telemetry),
          Effect.withLogger(logger),
          Effect.forkScoped
        );

        yield* Deferred.await(resumed);
        yield* Fiber.interrupt(fiber);
        expect(yield* Ref.get(attempts)).toBe(3);
        expect(yield* Ref.get(captures)).toBe(2);
        const cause = yield* Ref.get(capturedCause);
        expect(
          Option.isSome(cause) && Cause.isCause(cause.value) && Cause.hasDies(cause.value)
        ).toBe(true);
        const encodedLogs = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(capturedLogs);
        expect(encodedLogs).not.toContain(sentinel);
        expect(encodedLogs).toContain("whatsapp-channel.test.ts");
      })
    );

    it.effect(
      "completes delivery when consent is revoked before recording and processes the next turn",
      () =>
        Effect.gen(function* () {
          yield* seedDevelopmentIdentity(defaultAgentBearer);
          yield* truncateWhatsAppChannel;
          const eventTime = yield* DateTime.now;
          const recordings = yield* Ref.make(0);
          const agent = agentServiceFixture({
            recordDeliveredReply: () =>
              Ref.updateAndGet(recordings, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Effect.fail(new OnboardingConsentRequired({ userId: defaultUserId }))
                    : Effect.void
                )
              ),
          });
          const sends = yield* Ref.make(0);
          const kapsoService = kapsoClientFixture(
            "wamid.consent-revoked-reply",
            eventTime,
            Ref.update(sends, (count) => count + 1)
          );
          const first = makeKapsoTextEvent("wamid.consent-revoked-first", "primero", eventTime);
          yield* enqueueTurn({
            admission: authorizedTurn(first),
            event: first,
            deliveryKey,
          });
          expect(
            yield* processTurnWith(DateTime.add(eventTime, { seconds: 3 }), agent, kapsoService)
          ).toBe(true);

          const secondTime = DateTime.add(eventTime, { seconds: 4 });
          const second = makeKapsoTextEvent("wamid.consent-revoked-second", "segundo", secondTime);
          yield* enqueueTurn({
            admission: authorizedTurn(second),
            event: second,
            deliveryKey,
          });
          expect(
            yield* processTurnWith(DateTime.add(secondTime, { seconds: 3 }), agent, kapsoService)
          ).toBe(true);
          expect(yield* Ref.get(sends)).toBe(2);
        })
    );

    it.effect("retries rejected transient sends but does not retry ambiguous sends", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = yield* DateTime.now;
        const agent = agentServiceFixture();
        const attempts = yield* Ref.make(0);
        const transientKapso: KapsoClientService = {
          sendText: () =>
            Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(
                      new KapsoSendFailed({
                        safeReason: "rate_limited",
                        deliveryCertainty: "rejected",
                        automaticRetry: true,
                        responseStatus: Option.some(TelemetryHttpStatus.make(429)),
                      })
                    )
                  : Effect.succeed({
                      messageEvidence: {
                        channel: "whatsapp",
                        provider: "kapso",
                        providerMessageId: WhatsAppProviderMessageId.make(
                          "wamid.transient-retry-reply"
                        ),
                      },
                      sentAt: eventTime,
                      responseStatus: TelemetryHttpStatus.make(200),
                    })
              )
            ),
        };
        const transient = makeKapsoTextEvent("wamid.transient-retry", "primero", eventTime);
        yield* enqueueTurn({
          admission: authorizedTurn(transient),
          event: transient,
          deliveryKey,
        });
        expect(
          yield* processTurnWith(DateTime.add(eventTime, { seconds: 3 }), agent, transientKapso)
        ).toBe(true);
        expect(yield* Ref.get(attempts)).toBe(1);
        expect(
          yield* processTurnWith(DateTime.add(eventTime, { seconds: 5 }), agent, transientKapso)
        ).toBe(true);
        expect(yield* Ref.get(attempts)).toBe(2);

        const ambiguousTime = DateTime.add(eventTime, { seconds: 6 });
        const ambiguous = makeKapsoTextEvent("wamid.ambiguous-no-retry", "segundo", ambiguousTime);
        yield* enqueueTurn({
          admission: authorizedTurn(ambiguous),
          event: ambiguous,
          deliveryKey,
        });
        const ambiguousAttempts = yield* Ref.make(0);
        const ambiguousKapso: KapsoClientService = {
          sendText: () =>
            Ref.update(ambiguousAttempts, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.fail(
                  new KapsoSendFailed({
                    safeReason: "timeout",
                    deliveryCertainty: "ambiguous",
                    automaticRetry: false,
                    responseStatus: Option.none(),
                  })
                )
              )
            ),
        };
        expect(
          yield* processTurnWith(DateTime.add(ambiguousTime, { seconds: 3 }), agent, ambiguousKapso)
        ).toBe(true);
        expect(yield* Ref.get(ambiguousAttempts)).toBe(1);
      })
    );

    it.effect("processes an authorized turn through OpenAI with strict toolkit schemas", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = DateTime.makeUnsafe("2026-04-03T12:01:02.000Z");
        const inbound = makeKapsoTextEvent("wamid.openai-toolkit", "mercado 20 mil", eventTime);
        yield* enqueueTurn({
          admission: authorizedTurn(inbound),
          event: inbound,
          deliveryKey,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* withUserTransaction(
          defaultUserId,
          sql`UPDATE whatsapp_conversation_windows
              SET window_open_until = ${DateTime.add(yield* DateTime.now, { hours: 1 })}
              WHERE user_id = ${defaultUserId}`
        );
        const sent = yield* Ref.make(0);
        const agent = yield* Layer.build(Layer.fresh(OpenAiAgentService)).pipe(
          Effect.map(Context.get(AgentService))
        );

        const processed = yield* processNextWhatsAppTurn(
          DateTime.add(eventTime, { seconds: 3 })
        ).pipe(
          Effect.provideService(AgentService, agent),
          Effect.provideService(
            KapsoClient,
            kapsoClientFixture(
              "wamid.openai-toolkit-reply",
              eventTime,
              Ref.update(sent, (count) => count + 1)
            )
          )
        );

        expect(processed).toBe(true);
        expect(yield* Ref.get(sent)).toBe(1);
        const admin = yield* MigrationSqlClient;
        const trace = yield* admin`
          SELECT entry ->> '_tag' AS "tag", entry ->> 'operation' AS "operation"
          FROM transcript_entries
          WHERE user_id = ${defaultUserId}
          ORDER BY sequence
        `;
        expect(trace).toContainEqual({
          tag: "CanonicalToolCallEntry",
          operation: "categories.listCategories",
        });
        const results = yield* admin`
          SELECT entry ->> '_tag' AS "tag", entry ->> 'operation' AS "operation"
          FROM transcript_entries
          WHERE user_id = ${defaultUserId} AND entry ->> '_tag' = 'CanonicalToolResultEntry'
        `;
        expect(results).toContainEqual({
          tag: "CanonicalToolResultEntry",
          operation: "categories.listCategories",
        });
      })
    );

    it.effect("accepts OpenAI's encoded money input through the canonical transaction seam", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = DateTime.makeUnsafe("2026-04-03T12:01:02.000Z");
        const inbound = makeKapsoTextEvent("wamid.openai-transaction", "10000 desayuno", eventTime);
        yield* enqueueTurn({
          admission: authorizedTurn(inbound),
          event: inbound,
          deliveryKey,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* withUserTransaction(
          defaultUserId,
          sql`UPDATE whatsapp_conversation_windows
              SET window_open_until = ${DateTime.add(yield* DateTime.now, { hours: 1 })}
              WHERE user_id = ${defaultUserId}`
        );
        const sent = yield* Ref.make(0);
        const agent = yield* Layer.build(Layer.fresh(OpenAiAgentService)).pipe(
          Effect.map(Context.get(AgentService))
        );

        const processed = yield* processNextWhatsAppTurn(
          DateTime.add(eventTime, { seconds: 3 })
        ).pipe(
          Effect.provideService(AgentService, agent),
          Effect.provideService(
            KapsoClient,
            kapsoClientFixture(
              "wamid.openai-transaction-reply",
              eventTime,
              Ref.update(sent, (count) => count + 1)
            )
          )
        );

        expect(processed).toBe(true);
        expect(yield* Ref.get(sent)).toBe(1);
        const admin = yield* MigrationSqlClient;
        const trace = yield* admin`
          SELECT entry ->> '_tag' AS "tag", entry ->> 'operation' AS "operation"
          FROM transcript_entries
          WHERE user_id = ${defaultUserId}
          ORDER BY sequence
        `;
        expect(trace).toContainEqual({
          tag: "CanonicalToolCallEntry",
          operation: "transactions.createTransaction",
        });
        expect(
          yield* admin`
            SELECT counterparty, amount::text AS amount
            FROM transactions
            WHERE user_id = ${defaultUserId} AND counterparty = 'OpenAiBreakfast'
          `
        ).toEqual([{ counterparty: "OpenAiBreakfast", amount: "10000" }]);
      })
    );

    it.effect("fails a sent turn terminally when Kapso reuses existing evidence identity", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = DateTime.makeUnsafe("2026-04-03T12:02:02.000Z");
        const inbound = makeKapsoTextEvent(
          "wamid.evidence-collision",
          "almuerzo 25 mil",
          eventTime
        );
        yield* enqueueTurn({
          admission: authorizedTurn(inbound),
          event: inbound,
          deliveryKey,
        });
        const assistantCountBefore = (yield* listTranscriptEntries(defaultUserId)).filter(
          (entry) => entry._tag === "AssistantTranscriptEntry"
        ).length;

        expect(
          yield* processNextWhatsAppTurn(DateTime.add(eventTime, { seconds: 3 })).pipe(
            Effect.provideService(
              KapsoClient,
              kapsoClientFixture("wamid.evidence-collision", eventTime)
            )
          )
        ).toBe(true);
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* withUserTransaction(
            defaultUserId,
            sql`SELECT claim.status, claim.safe_reason AS "safeReason",
                  (SELECT content FROM whatsapp_inbound_jobs
                   WHERE user_id = ${defaultUserId}
                   AND message_evidence_id = (
                     SELECT id FROM whatsapp_message_evidence
                     WHERE provider_message_id = 'wamid.evidence-collision'
                   )) AS content
                FROM whatsapp_turn_claims AS claim
                WHERE claim.user_id = ${defaultUserId}`
          )
        ).toEqual([{ status: "failed", safeReason: "send_failed", content: null }]);
        expect(
          yield* withUserTransaction(
            defaultUserId,
            sql`SELECT direction FROM whatsapp_message_evidence
                WHERE provider_message_id = 'wamid.evidence-collision'`
          )
        ).toEqual([{ direction: "inbound" }]);
        expect(
          (yield* listTranscriptEntries(defaultUserId)).filter(
            (entry) => entry._tag === "AssistantTranscriptEntry"
          )
        ).toHaveLength(assistantCountBefore);
      })
    );

    it.effect("authenticates and durably deduplicates the public webhook route", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const body = yield* fixtureBytes("kapso-text-v2.json");
        const request = (): Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError,
          HttpClient.HttpClient
        > =>
          HttpClient.post("/webhooks/kapso", {
            headers: {
              "x-webhook-signature":
                "6c2d8ade595be0115c9ba1286d8f015c380008cd250ed5bfffd676c4845d4571",
              "x-idempotency-key": "recorded-route-delivery",
            },
            body: HttpBody.uint8Array(body, "application/json"),
          });

        const accepted = yield* request();
        expect(accepted.status).toBe(200);
        expect(yield* accepted.json).toEqual({
          decoded: 1,
          consentTurns: 0,
          enqueued: 1,
          duplicates: 0,
        });

        const duplicate = yield* request();
        expect(duplicate.status).toBe(200);
        expect(yield* duplicate.json).toEqual({
          decoded: 1,
          consentTurns: 0,
          enqueued: 0,
          duplicates: 1,
        });
      })
    );

    it.effect("keeps an in-flight receipt retryable until its owner releases the claim", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const now = yield* DateTime.now;
        const event = (yield* recordedEvents(now))[0];
        const claim = yield* claimWhatsAppReceipt(
          event.messageEvidence.providerMessageId,
          deliveryKey,
          now
        );
        if (Option.isNone(claim)) return yield* Effect.die("missing receipt claim");
        const body = yield* fixtureBytes("kapso-text-v2.json");
        const request = (): Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError,
          HttpClient.HttpClient
        > =>
          HttpClient.post("/webhooks/kapso", {
            headers: {
              "x-webhook-signature":
                "6c2d8ade595be0115c9ba1286d8f015c380008cd250ed5bfffd676c4845d4571",
              "x-idempotency-key": "in-flight-redelivery",
            },
            body: HttpBody.uint8Array(body, "application/json"),
          });
        expect((yield* request()).status).toBe(503);
        yield* releaseWhatsAppReceipt(claim.value);
        expect((yield* request()).status).toBe(200);
      })
    );

    it.effect("charges a repeatedly failing provider message to the global budget only once", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const now = yield* DateTime.now;
        const exhaustedPhone = E164PhoneNumber.make("+573007770096");
        yield* Effect.forEach(
          EffectArray.range(1, 60),
          (index) =>
            consumeWhatsAppIngressBudget(
              { _tag: "Caller", caller: testWhatsAppCaller(exhaustedPhone) },
              WhatsAppProviderMessageId.make(`wamid.exhausted-phone-${index}`),
              now
            ),
          { concurrency: 16, discard: true }
        );
        const request = (): Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError,
          HttpClient.HttpClient
        > =>
          postSignedTextFixture({
            phoneNumber: exhaustedPhone,
            providerMessageId: "wamid.retried-after-phone-limit",
            occurredAt: now,
          });
        expect((yield* request()).status).toBe(429);
        expect((yield* request()).status).toBe(429);
        expect((yield* request()).status).toBe(429);

        const admin = yield* MigrationSqlClient;
        expect(
          yield* admin`SELECT accepted_count AS count FROM whatsapp_ingress_budgets
                       WHERE budget_key = 'global:authenticated'`
        ).toEqual([{ count: 1 }]);
        expect(
          (yield* postSignedTextFixture({
            phoneNumber: E164PhoneNumber.make("+573007770095"),
            providerMessageId: "wamid.other-phone-after-retries",
            occurredAt: now,
          })).status
        ).toBe(200);
      })
    );

    it.effect("bounds aggregate pre-subject cost across distinct phone numbers", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const now = yield* DateTime.now;
        yield* Effect.forEach(
          EffectArray.range(1, 600),
          (index) =>
            consumeWhatsAppIngressBudget(
              { _tag: "Global" },
              WhatsAppProviderMessageId.make(`wamid.global-budget-${index}`),
              now
            ),
          { concurrency: 32, discard: true }
        );
        const phoneNumber = E164PhoneNumber.make("+573007770099");
        const response = yield* postSignedTextFixture({
          phoneNumber,
          providerMessageId: "wamid.aggregate-budget",
          text: "hola",
          occurredAt: now,
        });
        expect(response.status).toBe(429);
        expect(
          Option.isNone(yield* findPendingConsentExchange(testWhatsAppCaller(phoneNumber)))
        ).toBe(true);
        yield* truncateWhatsAppChannel;
      })
    );

    it.effect(
      "keeps the public route retryable while another disclosure delivery owns the claim",
      () =>
        Effect.gen(function* () {
          yield* truncateWhatsAppChannel;
          const now = yield* DateTime.now;
          const phoneNumber = E164PhoneNumber.make("+573007770097");
          const initialEvent = {
            ...makeKapsoTextEvent("wamid.public-disclosure-initial", "hola", now),
            caller: testWhatsAppCaller(phoneNumber),
          };
          const admission = yield* admitAgentConversationTurn({
            caller: initialEvent.caller,
            content: { _tag: "Text", text: initialEvent.content.text },
            message: initialEvent.messageEvidence,
            receivedAt: initialEvent.occurredAt,
          });
          if (admission._tag !== "SendDisclosure") {
            return yield* Effect.die("missing public-route disclosure admission");
          }
          const claim = yield* claimConsentDisclosureDelivery(admission.exchangeId, now);
          if (Option.isNone(claim)) return yield* Effect.die("missing disclosure delivery claim");

          const request = (): Effect.Effect<
            HttpClientResponse.HttpClientResponse,
            HttpClientError.HttpClientError,
            HttpClient.HttpClient
          > =>
            postSignedTextFixture({
              phoneNumber,
              providerMessageId: "wamid.public-disclosure-retry",
              text: "hola de nuevo",
              occurredAt: now,
            });
          expect((yield* request()).status).toBe(503);
          yield* releaseConsentDisclosureDelivery({
            exchangeId: admission.exchangeId,
            attemptId: claim.value.attemptId,
          });
          expect((yield* request()).status).toBe(200);
        })
    );

    it.effect("serializes concurrent disclosure sends for one pending exchange", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const phoneNumber = E164PhoneNumber.make("+573007770098");
        const event = {
          ...makeKapsoTextEvent("wamid.concurrent-disclosure", "hola", now),
          caller: testWhatsAppCaller(phoneNumber),
        };
        const admission = yield* admitAgentConversationTurn({
          caller: event.caller,
          content: { _tag: "Text", text: event.content.text },
          message: event.messageEvidence,
          receivedAt: event.occurredAt,
        });
        if (admission._tag !== "SendDisclosure") {
          return yield* Effect.die("missing disclosure admission");
        }
        const sendStarted = yield* Deferred.make<void>();
        const allowSend = yield* Deferred.make<void>();
        const sends = yield* Ref.make(0);
        const kapsoService = kapsoClientFixture(
          "wamid.concurrent-disclosure-reply",
          now,
          Ref.update(sends, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(sendStarted, undefined)),
            Effect.andThen(Deferred.await(allowSend))
          )
        );
        const first = yield* deliverWhatsAppConsentOutcome(event, admission).pipe(
          Effect.provideService(KapsoClient, kapsoService),
          Effect.forkChild
        );
        yield* Deferred.await(sendStarted);
        const secondFailure = yield* deliverWhatsAppConsentOutcome(event, admission).pipe(
          Effect.provideService(KapsoClient, kapsoService),
          Effect.flip
        );
        expect(secondFailure._tag).toBe("ConsentDisclosureDeliveryUnavailable");
        expect(yield* Ref.get(sends)).toBe(1);
        yield* Deferred.succeed(allowSend, undefined);
        yield* Fiber.join(first);
        expect(
          (yield* findPendingConsentExchange(testWhatsAppCaller(phoneNumber))).pipe(Option.isSome)
        ).toBe(true);
      })
    );

    it.effect("does not replay an ambiguous disclosure through the public webhook", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const provider = yield* ApiHarnessKapsoControl;
        yield* provider.reset;
        yield* provider.failNextAfterAcceptance;
        const now = yield* DateTime.now;
        const input = {
          phoneNumber: E164PhoneNumber.make("+573007770093"),
          providerMessageId: "wamid.public-ambiguous-disclosure",
          text: "hola",
          occurredAt: now,
        };

        expect((yield* postSignedTextFixture(input)).status).toBe(500);
        expect(yield* provider.callCount).toBe(1);
        expect((yield* postSignedTextFixture(input)).status).toBe(200);
        expect(yield* provider.callCount).toBe(1);

        const admin = yield* MigrationSqlClient;
        expect(
          yield* admin`SELECT status FROM whatsapp_inbound_receipts
            WHERE provider_message_id = 'wamid.public-ambiguous-disclosure'`
        ).toEqual([{ status: "outbound_started" }]);
      })
    );

    it.effect("does not replay a disclosure after its provider call becomes ambiguous", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const phoneNumber = E164PhoneNumber.make("+573007770094");
        const event = {
          ...makeKapsoTextEvent("wamid.ambiguous-disclosure", "hola", now),
          caller: testWhatsAppCaller(phoneNumber),
        };
        const admission = yield* admitAgentConversationTurn({
          caller: event.caller,
          content: { _tag: "Text", text: event.content.text },
          message: event.messageEvidence,
          receivedAt: event.occurredAt,
        });
        if (admission._tag !== "SendDisclosure") {
          return yield* Effect.die("missing ambiguous disclosure admission");
        }
        const receipt = yield* claimWhatsAppReceipt(
          event.messageEvidence.providerMessageId,
          deliveryKey,
          now
        );
        if (Option.isNone(receipt)) return yield* Effect.die("missing ambiguous receipt claim");
        const sends = yield* Ref.make(0);
        yield* Effect.exit(
          deliverWhatsAppConsentOutcome(
            event,
            admission,
            markWhatsAppReceiptOutboundStarted(receipt.value)
          ).pipe(
            Effect.provideService(KapsoClient, {
              sendText: () =>
                Ref.update(sends, (count) => count + 1).pipe(
                  Effect.andThen(Effect.die("provider result lost"))
                ),
            })
          )
        );

        expect(
          Option.isNone(
            yield* claimWhatsAppReceipt(event.messageEvidence.providerMessageId, deliveryKey, now)
          )
        ).toBe(true);
        expect(
          Option.isNone(
            yield* claimConsentDisclosureDelivery(
              admission.exchangeId,
              DateTime.add(now, { minutes: 1 })
            )
          )
        ).toBe(true);
        expect(yield* Ref.get(sends)).toBe(1);

        const state = yield* findConsentDisclosureDeliveryState(admission.exchangeId);
        const attempt = yield* Effect.fromOption(state).pipe(Effect.orDie);
        const correlationToken = DisclosureDeliveryCorrelationToken.make(attempt.attemptId);
        expect(
          yield* applyConsentDisclosureLifecycle({
            outcome: "sent",
            correlationToken,
            messageEvidence: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: WhatsAppProviderMessageId.make("wamid.sent-only"),
            },
            occurredAt: now,
          })
        ).toBe("applied");
        expect(
          yield* applyConsentDisclosureLifecycle({
            outcome: "failed",
            correlationToken,
            reason: "provider_unavailable",
            automaticRetry: true,
            messageEvidence: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: WhatsAppProviderMessageId.make("wamid.sent-only"),
            },
            occurredAt: DateTime.subtract(now, { seconds: 1 }),
          })
        ).toBe("ignored");
        expect(
          yield* applyConsentDisclosureLifecycle({
            outcome: "accepted",
            correlationToken: DisclosureDeliveryCorrelationToken.make(
              "11111111-1111-4111-8111-111111111111"
            ),
            messageEvidence: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: WhatsAppProviderMessageId.make("wamid.uncorrelated"),
            },
            occurredAt: now,
          })
        ).toBe("ignored");

        expect(
          yield* applyConsentDisclosureLifecycle({
            outcome: "sent",
            correlationToken,
            messageEvidence: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: WhatsAppProviderMessageId.make("wamid.conflicting"),
            },
            occurredAt: DateTime.add(now, { seconds: 1 }),
          })
        ).toBe("ignored");
        expect(
          yield* applyConsentDisclosureLifecycle({
            outcome: "accepted",
            correlationToken,
            messageEvidence: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: WhatsAppProviderMessageId.make("wamid.conflicting"),
            },
            occurredAt: DateTime.add(now, { seconds: 1 }),
          })
        ).toBe("ignored");
        expect(
          yield* processDueConsentDisclosureDelivery(DateTime.add(now, { hours: 2 })).pipe(
            Effect.provideService(KapsoClient, {
              sendText: () => Effect.die("ambiguous disclosure was replayed"),
            })
          )
        ).toBe(false);
        expect(
          yield* applyConsentDisclosureLifecycle({
            outcome: "accepted",
            correlationToken,
            messageEvidence: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: WhatsAppProviderMessageId.make("wamid.sent-only"),
            },
            occurredAt: DateTime.add(now, { hours: 2 }),
          })
        ).toBe("applied");
      })
    );

    it.effect("retries only a definitively rejected disclosure attempt", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const now = yield* DateTime.now;
        const phoneNumber = E164PhoneNumber.make(
          `+57${String(DateTime.toEpochMillis(now)).slice(-10)}`
        );
        const event = {
          ...makeKapsoTextEvent("wamid.rejected-disclosure", "hola", now),
          caller: testWhatsAppCaller(phoneNumber),
        };
        const admission = yield* admitAgentConversationTurn({
          caller: event.caller,
          content: { _tag: "Text", text: event.content.text },
          message: event.messageEvidence,
          receivedAt: now,
        });
        if (admission._tag !== "SendDisclosure") {
          return yield* Effect.die("missing rejected disclosure admission");
        }
        yield* Effect.exit(
          deliverWhatsAppConsentOutcome(event, admission).pipe(
            Effect.provideService(KapsoClient, {
              sendText: () =>
                Effect.fail(
                  new KapsoSendFailed({
                    safeReason: "timeout",
                    deliveryCertainty: "ambiguous",
                    automaticRetry: false,
                    responseStatus: Option.none(),
                  })
                ),
            })
          )
        );

        const rejectedState = yield* findConsentDisclosureDeliveryState(admission.exchangeId);
        const rejectedAttempt = yield* Effect.fromOption(rejectedState).pipe(Effect.orDie);
        const rejectedCorrelation = DisclosureDeliveryCorrelationToken.make(
          rejectedAttempt.attemptId
        );
        const lifecycleFailure = {
          outcome: "failed" as const,
          correlationToken: rejectedCorrelation,
          reason: "provider_unavailable" as const,
          automaticRetry: true,
          messageEvidence: {
            channel: "whatsapp" as const,
            provider: "kapso",
            providerMessageId: WhatsAppProviderMessageId.make("wamid.lifecycle-rejection"),
          },
          occurredAt: DateTime.add(now, { seconds: 1 }),
        };
        expect(
          yield* applyConsentDisclosureLifecycle({
            ...lifecycleFailure,
            occurredAt: DateTime.subtract(now, { seconds: 1 }),
          })
        ).toBe("ignored");
        expect(yield* applyConsentDisclosureLifecycle(lifecycleFailure)).toBe("applied");
        expect(yield* applyConsentDisclosureLifecycle(lifecycleFailure)).toBe("ignored");

        const retries = yield* Ref.make(0);
        const retryingKapso: KapsoClientService = {
          sendText: () =>
            Ref.update(retries, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.fail(
                  new KapsoSendFailed({
                    safeReason: "rate_limited",
                    deliveryCertainty: "rejected",
                    automaticRetry: true,
                    responseStatus: Option.none(),
                  })
                )
              )
            ),
        };
        for (const dueAt of [5, 15, 30]) {
          expect(
            yield* processDueConsentDisclosureDelivery(DateTime.add(now, { seconds: dueAt })).pipe(
              Effect.provideService(KapsoClient, retryingKapso)
            )
          ).toBe(true);
        }
        expect(yield* Ref.get(retries)).toBe(3);
        expect(
          yield* processDueConsentDisclosureDelivery(DateTime.add(now, { minutes: 1 })).pipe(
            Effect.provideService(KapsoClient, kapsoClientFixture("wamid.never-used", now))
          )
        ).toBe(false);
      })
    );

    it.effect("cancels a claimed retry when newer authenticated delivery arrives", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const now = yield* DateTime.now;
        const phoneNumber = E164PhoneNumber.make(
          `+57${String(DateTime.toEpochMillis(now) + 1).slice(-10)}`
        );
        const event = {
          ...makeKapsoTextEvent("wamid.reordered-disclosure", "hola", now),
          caller: testWhatsAppCaller(phoneNumber),
        };
        const admission = yield* admitAgentConversationTurn({
          caller: event.caller,
          content: { _tag: "Text", text: event.content.text },
          message: event.messageEvidence,
          receivedAt: now,
        });
        if (admission._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
        yield* Effect.exit(
          deliverWhatsAppConsentOutcome(event, admission).pipe(
            Effect.provideService(KapsoClient, {
              sendText: () =>
                Effect.fail(
                  new KapsoSendFailed({
                    safeReason: "timeout",
                    deliveryCertainty: "ambiguous",
                    automaticRetry: false,
                    responseStatus: Option.none(),
                  })
                ),
            })
          )
        );
        const state = yield* findConsentDisclosureDeliveryState(admission.exchangeId);
        const attempt = yield* Effect.fromOption(state).pipe(Effect.orDie);
        const correlationToken = DisclosureDeliveryCorrelationToken.make(attempt.attemptId);
        expect(
          yield* applyConsentDisclosureLifecycle({
            outcome: "failed",
            correlationToken,
            reason: "provider_unavailable",
            automaticRetry: true,
            messageEvidence: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: WhatsAppProviderMessageId.make("wamid.reordered-failed"),
            },
            occurredAt: DateTime.add(now, { seconds: 1 }),
          })
        ).toBe("applied");
        expect(
          yield* applyConsentDisclosureLifecycle({
            outcome: "accepted",
            correlationToken,
            messageEvidence: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: WhatsAppProviderMessageId.make("wamid.stale-delivered"),
            },
            occurredAt: now,
          })
        ).toBe("ignored");
        expect(
          Option.isSome(yield* claimNextConsentDisclosureRetry(DateTime.add(now, { minutes: 1 })))
        ).toBe(true);
        expect(
          yield* applyConsentDisclosureLifecycle({
            outcome: "accepted",
            correlationToken,
            messageEvidence: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: WhatsAppProviderMessageId.make("wamid.reordered-delivered"),
            },
            occurredAt: DateTime.add(now, { seconds: 2 }),
          })
        ).toBe("applied");
        expect(
          yield* processDueConsentDisclosureDelivery(DateTime.add(now, { minutes: 1 })).pipe(
            Effect.provideService(KapsoClient, kapsoClientFixture("wamid.never-used", now))
          )
        ).toBe(false);
        const delivered = yield* Effect.fromOption(
          yield* findConsentDisclosureDeliveryState(admission.exchangeId)
        ).pipe(Effect.orDie);
        expect(delivered.state).toBe("delivered");
      })
    );

    it.effect("rolls back delivered attempt evidence when Consent cannot advance", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const now = yield* DateTime.now;
        const event = {
          ...makeKapsoTextEvent("wamid.atomic-disclosure", "hola", now),
          caller: testWhatsAppCaller(
            E164PhoneNumber.make(`+57${String(DateTime.toEpochMillis(now) + 2).slice(-10)}`)
          ),
        };
        const admission = yield* admitAgentConversationTurn({
          caller: event.caller,
          content: { _tag: "Text", text: event.content.text },
          message: event.messageEvidence,
          receivedAt: now,
        });
        if (admission._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
        yield* deliverWhatsAppConsentOutcome(event, admission).pipe(
          Effect.provideService(KapsoClient, kapsoClientFixture("wamid.atomic-send", now))
        );
        const attempt = yield* Effect.fromOption(
          yield* findConsentDisclosureDeliveryState(admission.exchangeId)
        ).pipe(Effect.orDie);
        const admin = yield* MigrationSqlClient;
        yield* admin`
          UPDATE pending_consent_exchanges
          SET lifecycle = 'awaiting-decision', disclosure_channel = 'test',
            disclosure_provider = 'test', disclosure_provider_message_id = 'test',
            disclosed_at = ${now}
          WHERE id = ${admission.exchangeId}
        `;
        const failure = yield* applyConsentDisclosureLifecycle({
          outcome: "accepted",
          correlationToken: DisclosureDeliveryCorrelationToken.make(attempt.attemptId),
          messageEvidence: {
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: WhatsAppProviderMessageId.make("wamid.atomic-send"),
          },
          occurredAt: DateTime.add(now, { seconds: 1 }),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("ConsentDisclosureDeliveryUnavailable");
        const retained = yield* Effect.fromOption(
          yield* findConsentDisclosureDeliveryState(admission.exchangeId)
        ).pipe(Effect.orDie);
        expect(retained.state).toBe("reconciliation-required");
      })
    );

    it.effect("propagates a definitive terminal disclosure rejection without scheduling work", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const now = yield* DateTime.now;
        const phoneNumber = E164PhoneNumber.make(
          `+58${String(DateTime.toEpochMillis(now)).slice(-10)}`
        );
        const event = {
          ...makeKapsoTextEvent("wamid.terminal-disclosure", "hola", now),
          caller: testWhatsAppCaller(phoneNumber),
        };
        const admission = yield* admitAgentConversationTurn({
          caller: event.caller,
          content: { _tag: "Text", text: event.content.text },
          message: event.messageEvidence,
          receivedAt: now,
        });
        if (admission._tag !== "SendDisclosure") {
          return yield* Effect.die("missing terminal disclosure admission");
        }
        const failure = yield* deliverWhatsAppConsentOutcome(event, admission).pipe(
          Effect.provideService(KapsoClient, {
            sendText: () =>
              Effect.fail(
                new KapsoSendFailed({
                  safeReason: "invalid_recipient",
                  deliveryCertainty: "rejected",
                  automaticRetry: false,
                  responseStatus: Option.none(),
                })
              ),
          }),
          Effect.flip
        );
        expect(failure._tag).toBe("KapsoSendFailed");
        if (failure._tag !== "KapsoSendFailed") return yield* Effect.die("wrong failure");
        expect(failure.safeReason).toBe("invalid_recipient");
        expect(
          yield* processDueConsentDisclosureDelivery(DateTime.add(now, { minutes: 1 })).pipe(
            Effect.provideService(KapsoClient, kapsoClientFixture("wamid.never-used", now))
          )
        ).toBe(false);
      })
    );

    it.effect("uses provider occurrence time to reject a delayed pre-disclosure decision", () =>
      Effect.gen(function* () {
        const phoneNumber = E164PhoneNumber.make("+573007776655");
        const postEvent = (
          providerMessageId: string,
          text: string,
          occurredAt: DateTime.Utc
        ): Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError,
          HttpClient.HttpClient
        > => postSignedTextFixture({ phoneNumber, providerMessageId, text, occurredAt });
        const receivedAt = yield* DateTime.now;
        expect((yield* postEvent("wamid.disclosure-trigger", "hola", receivedAt)).status).toBe(200);
        expect(yield* deliverLatestDisclosure(phoneNumber, receivedAt)).toBe("applied");
        expect(
          (yield* postEvent(
            "wamid.predates-disclosure",
            "Acepto",
            DateTime.subtract(receivedAt, { minutes: 1 })
          )).status
        ).toBe(200);
        expect(yield* resolveWhatsAppCaller(testWhatsAppCaller(phoneNumber))).toEqual(
          Option.none()
        );
      })
    );

    it.effect("keeps a pre-consent financial message inert when its signed body is replayed", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const phoneNumber = E164PhoneNumber.make("+573006665544");
        const postEvent = (
          providerMessageId: string,
          text: string,
          occurredAt: DateTime.Utc
        ): Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError,
          HttpClient.HttpClient
        > => postSignedTextFixture({ phoneNumber, providerMessageId, text, occurredAt });
        const receivedAt = yield* DateTime.now;
        const original = (): Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError,
          HttpClient.HttpClient
        > => postEvent("wamid.pre-consent-financial", "almuerzo 25 mil", receivedAt);
        expect((yield* original()).status).toBe(200);
        expect(yield* deliverLatestDisclosure(phoneNumber, receivedAt)).toBe("applied");
        // A minute, not a second: the fixture truncates the provider timestamp to whole seconds
        // while the harness stamps `disclosedAt` from the real clock, so any margin shorter than
        // the disclosure round trip lands the decision before it and only clarifies.
        expect(
          (yield* postEvent(
            "wamid.fresh-consent",
            "Acepto",
            DateTime.add(receivedAt, { minutes: 1 })
          )).status
        ).toBe(200);
        expect(Option.isSome(yield* resolveWhatsAppCaller(testWhatsAppCaller(phoneNumber)))).toBe(
          true
        );

        const replay = yield* original();
        expect(replay.status).toBe(200);
        expect(yield* replay.json).toEqual({
          decoded: 1,
          consentTurns: 0,
          enqueued: 0,
          duplicates: 1,
        });
        const admin = yield* MigrationSqlClient;
        expect(
          yield* admin`SELECT count(*)::int AS count FROM whatsapp_inbound_jobs
                       WHERE content = 'almuerzo 25 mil'`
        ).toEqual([{ count: 0 }]);
      })
    );

    it.effect("does not authorize messages predating consent or the current association", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const now = yield* DateTime.now;
        const preConsent = yield* postSignedTextFixture({
          phoneNumber: defaultWhatsAppPhone,
          providerMessageId: "wamid.predates-consent",
          text: "almuerzo 25 mil",
          occurredAt: DateTime.makeUnsafe("2025-12-31T23:59:00Z"),
        });
        expect(preConsent.status).toBe(200);
        expect(yield* preConsent.json).toMatchObject({ enqueued: 0, duplicates: 1 });

        yield* associateWhatsAppIdentity(defaultUserId, {
          ...testWhatsAppCaller(defaultWhatsAppPhone),
          businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.new573001234567"),
          verifiedAt: now,
        });
        const preAssociation = yield* postSignedTextFixture({
          phoneNumber: defaultWhatsAppPhone,
          providerMessageId: "wamid.predates-association",
          text: "taxi 18 mil",
          occurredAt: DateTime.subtract(now, { minutes: 1 }),
        });
        expect(preAssociation.status).toBe(200);
        expect(yield* preAssociation.json).toMatchObject({
          consentTurns: 1,
          enqueued: 0,
          duplicates: 0,
        });

        const admin = yield* MigrationSqlClient;
        expect(
          yield* admin`SELECT count(*)::int AS count FROM whatsapp_inbound_jobs
                       WHERE content IN ('almuerzo 25 mil', 'taxi 18 mil')`
        ).toEqual([{ count: 0 }]);
        expect(yield* admin`SELECT user_id FROM whatsapp_conversation_windows`).toEqual([]);
      })
    );

    it.effect("bounds concurrent unauthenticated webhook body readers", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const admin = yield* MigrationSqlClient;
        const observeEffects = (): Statement.Statement<SqlConnection.Row> =>
          admin`SELECT
            (SELECT count(*)::int FROM whatsapp_message_evidence) AS evidence,
            (SELECT count(*)::int FROM whatsapp_inbound_jobs) AS jobs,
            (SELECT count(*)::int FROM whatsapp_conversation_windows) AS windows,
            (SELECT count(*)::int FROM whatsapp_ingress_budgets) AS budgets,
            (SELECT count(*)::int FROM whatsapp_inbound_receipts) AS receipts`;
        const before = yield* observeEffects();
        const slowBody = HttpBody.stream(
          Stream.concat(Stream.make(new Uint8Array([123])), Stream.never)
        );
        const readers = yield* Effect.forEach(
          Array.from({ length: 32 }),
          () =>
            HttpClient.post("/webhooks/kapso", {
              headers: {
                "x-webhook-signature": "0".repeat(64),
                "x-idempotency-key": "slow-reader",
              },
              body: slowBody,
            }).pipe(Effect.forkScoped),
          { concurrency: "unbounded" }
        );
        const refused = yield* HttpClient.post("/webhooks/kapso", {
          headers: {
            "x-webhook-signature": "0".repeat(64),
            "x-idempotency-key": "reader-overflow",
          },
          body: HttpBody.uint8Array(new Uint8Array([123]), "application/json"),
        }).pipe(
          Effect.filterOrFail(
            (response) => response.status === 429,
            () => "reader budget not exhausted"
          ),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 60 })
        );
        expect(refused.status).toBe(429);
        expect(yield* observeEffects()).toEqual(before);
        yield* Fiber.interruptAll(readers);
      })
    );

    it.effect("maps authenticated route boundary failures without persisting", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const admin = yield* MigrationSqlClient;
        const observeEffects = (): Statement.Statement<SqlConnection.Row> =>
          admin`SELECT
            (SELECT count(*)::int FROM users) AS users,
            (SELECT count(*)::int FROM pending_consent_exchanges) AS consent,
            (SELECT count(*)::int FROM transactions) AS transactions,
            (SELECT count(*)::int FROM whatsapp_message_evidence) AS evidence,
            (SELECT count(*)::int FROM whatsapp_inbound_jobs) AS jobs,
            (SELECT count(*)::int FROM whatsapp_conversation_windows) AS windows,
            (SELECT count(*)::int FROM whatsapp_ingress_budgets) AS budgets,
            (SELECT count(*)::int FROM whatsapp_inbound_receipts) AS receipts`;
        const before = yield* observeEffects();
        const post = (
          body: Uint8Array,
          signature: string
        ): Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError,
          HttpClient.HttpClient
        > =>
          HttpClient.post("/webhooks/kapso", {
            headers: {
              "x-webhook-signature": signature,
              "x-idempotency-key": "rejected-route-delivery",
            },
            body: HttpBody.uint8Array(body, "application/json"),
          });
        const invalidSignature = yield* post(new TextEncoder().encode("not json"), "not-authentic");
        expect(invalidSignature.status).toBe(401);
        const altered = yield* fixtureBytes("kapso-text-v2.json");
        altered[altered.length - 2] = altered[altered.length - 2] === 32 ? 33 : 32;
        expect(
          (yield* post(altered, "6c2d8ade595be0115c9ba1286d8f015c380008cd250ed5bfffd676c4845d4571"))
            .status
        ).toBe(401);

        const malformed = new TextEncoder().encode("not json");
        const malformedSignature = new Bun.CryptoHasher(
          "sha256",
          "test-webhook-secret-32-characters"
        )
          .update(malformed)
          .digest("hex");
        expect((yield* post(malformed, malformedSignature)).status).toBe(400);

        const invalidTimestamp = new TextEncoder().encode(
          new TextDecoder()
            .decode(yield* fixtureBytes("kapso-text-v2.json"))
            .replace('"timestamp": "1775217600"', '"timestamp": "9007199254740991"')
        );
        const invalidTimestampSignature = new Bun.CryptoHasher(
          "sha256",
          "test-webhook-secret-32-characters"
        )
          .update(invalidTimestamp)
          .digest("hex");
        expect((yield* post(invalidTimestamp, invalidTimestampSignature)).status).toBe(400);

        const oversized = new Uint8Array(1_048_577);
        const oversizedSignature = new Bun.CryptoHasher(
          "sha256",
          "test-webhook-secret-32-characters"
        )
          .update(oversized)
          .digest("hex");
        expect((yield* post(oversized, oversizedSignature)).status).toBe(413);
        expect(yield* observeEffects()).toEqual(before);
      })
    );

    it.effect("suppresses stale consent replies and sends current terminal guidance", () =>
      Effect.gen(function* () {
        const eventTime = yield* DateTime.now;
        const event = makeKapsoTextEvent("wamid.consent-guidance", "hola", eventTime);
        const sends = yield* Ref.make(0);
        const kapsoService = kapsoClientFixture(
          "wamid.consent-guidance-reply",
          eventTime,
          Ref.update(sends, (count) => count + 1)
        );
        yield* deliverWhatsAppConsentOutcome(
          { ...event, occurredAt: DateTime.subtract(eventTime, { hours: 25 }) },
          { _tag: "ClarifyDecision", text: "Aclara tu decisión." }
        ).pipe(Effect.provideService(KapsoClient, kapsoService));
        expect(yield* Ref.get(sends)).toBe(0);
        yield* deliverWhatsAppConsentOutcome(event, {
          _tag: "Declined",
          text: "No se creó una cuenta.",
        }).pipe(Effect.provideService(KapsoClient, kapsoService));
        expect(yield* Ref.get(sends)).toBe(1);
      })
    );

    it.effect("renders standard Markdown bold for WhatsApp free-form replies", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = DateTime.makeUnsafe("2026-04-03T12:00:02.000Z");
        const event = makeKapsoTextEvent("wamid.markdown-bold", "hola", eventTime);
        const admission = yield* admitAgentConversationTurn({
          caller: event.caller,
          content: { _tag: "Text", text: event.content.text },
          message: event.messageEvidence,
          receivedAt: event.receivedAt,
        });
        if (admission._tag !== "AuthorizedTurn") {
          return yield* Effect.die("expected authorized formatting fixture");
        }
        yield* enqueueTurn({ admission, event, deliveryKey });
        const sql = yield* SqlClient.SqlClient;
        yield* withUserTransaction(
          defaultUserId,
          sql`UPDATE whatsapp_conversation_windows
              SET window_open_until = ${DateTime.add(eventTime, { hours: 1 })}
              WHERE user_id = ${defaultUserId}`
        );
        const sentText = yield* Ref.make(Option.none<TranscriptText>());
        const destination = yield* Ref.make<
          Option.Option<{ readonly recipient: WhatsAppBusinessScopedUserId }>
        >(Option.none());
        yield* sendFreeFormFixture(
          defaultUserId,
          agentReplyFixture("**Registré** el movimiento."),
          DateTime.add(eventTime, { seconds: 1 })
        ).pipe(
          Effect.provideService(KapsoClient, {
            sendText: (input) =>
              Ref.set(sentText, Option.some(input.text)).pipe(
                Effect.andThen(Ref.set(destination, Option.some(input.destination))),
                Effect.as({
                  messageEvidence: {
                    channel: "whatsapp" as const,
                    provider: "kapso" as const,
                    providerMessageId: WhatsAppProviderMessageId.make("wamid.markdown-bold-reply"),
                  },
                  sentAt: eventTime,
                  responseStatus: TelemetryHttpStatus.make(200),
                })
              ),
          })
        );
        expect(yield* Ref.get(sentText)).toEqual(
          Option.some(TranscriptText.make("*Registré* el movimiento."))
        );
        expect(yield* Ref.get(destination)).toEqual(
          Option.some({
            recipient: event.caller.businessScopedUserId,
            sandboxPhone: event.caller.phoneNumber,
          })
        );
      })
    );

    it.effect("refuses channel-unsupported semantic reply shapes before authorization", () =>
      Effect.gen(function* () {
        const unreachableKapso: KapsoClientService = {
          sendText: () => Effect.die("unsupported reply reached Kapso"),
        };
        const attachmentFailure = yield* sendFreeFormFixture(
          defaultUserId,
          agentReplyFixture("Adjunto", {
            attachments: Option.some([
              { mediaType: "image/png", url: new URL("https://example.com/image.png") },
            ]),
          }),
          yield* DateTime.now
        ).pipe(Effect.provideService(KapsoClient, unreachableKapso), Effect.flip);
        expect(attachmentFailure._tag).toBe("AgentReplyNotRenderable");

        const choiceFailure = yield* sendFreeFormFixture(
          defaultUserId,
          agentReplyFixture("Elige", {
            choices: Option.some([{ label: "Sí", message: TranscriptText.make("Sí") }]),
          }),
          yield* DateTime.now
        ).pipe(Effect.provideService(KapsoClient, unreachableKapso), Effect.flip);
        expect(choiceFailure._tag).toBe("AgentReplyNotRenderable");
      })
    );

    it.effect("refuses free-form send after onboarding consent is revoked", () =>
      Effect.gen(function* () {
        const userId = UserId.make("f1d1a000-0000-4000-8000-000000000910");
        const bearer = AgentBearerToken.make(
          "fin_whatsrvk_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
        );
        const eventTime = DateTime.makeUnsafe("2026-04-03T12:00:02.000Z");
        yield* seedConsentedAgentIdentity({ userId, bearer, scopes: ["read", "write"] });
        yield* associateWhatsAppIdentity(userId, {
          ...testWhatsAppCaller(E164PhoneNumber.make("+573008887766")),
          verifiedAt: eventTime,
        });
        const event = {
          ...makeKapsoTextEvent("wamid.revoked-window", "pan 5 mil", eventTime),
          caller: testWhatsAppCaller(E164PhoneNumber.make("+573008887766")),
        };
        yield* enqueueTurn({
          admission: {
            _tag: "AuthorizedTurn",
            userId,
            inboundMessage: { text: event.content.text },
          },
          event,
          deliveryKey,
        });
        const sql = yield* SqlClient.SqlClient;
        const outboundBefore = yield* withUserTransaction(
          userId,
          sql`SELECT count(*)::int AS count FROM whatsapp_message_evidence
              WHERE user_id = ${userId} AND direction = 'outbound'`
        );
        const grant = EffectArray.head(yield* observeConsentRecords(userId));
        if (Option.isNone(grant)) return yield* Effect.die("missing onboarding grant");
        yield* appendConsentRecord(
          ConsentRecord.make({
            ...grant.value,
            id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000911"),
            event: { _tag: "Revoked", grantId: grant.value.id },
            occurredAt: DateTime.add(eventTime, { minutes: 1 }),
            decisionMessage: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: "wamid.revoked-decision",
            },
          })
        );
        const sends = yield* Ref.make(0);
        const kapsoNeverCalled: KapsoClientService = {
          sendText: () =>
            Ref.update(sends, (count) => count + 1).pipe(Effect.andThen(Effect.die("called"))),
        };
        const failure = yield* sendFreeFormFixture(
          userId,
          agentReplyFixture("No debe salir después de revocar."),
          DateTime.add(eventTime, { minutes: 2 })
        ).pipe(Effect.provideService(KapsoClient, kapsoNeverCalled), Effect.flip);
        expect(failure._tag).toBe("OnboardingConsentRequired");
        expect(yield* Ref.get(sends)).toBe(0);
        expect(
          yield* withUserTransaction(
            userId,
            sql`SELECT count(*)::int AS count FROM whatsapp_message_evidence
                WHERE user_id = ${userId} AND direction = 'outbound'`
          )
        ).toEqual(outboundBefore);
      })
    );

    it.effect("refuses an out-of-window free-form send before calling Kapso", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = DateTime.makeUnsafe("2026-04-03T12:00:02.000Z");
        const sql = yield* SqlClient.SqlClient;
        const sends = yield* Ref.make(0);
        const kapsoNeverCalled: KapsoClientService = {
          sendText: () =>
            Ref.update(sends, (count) => count + 1).pipe(Effect.andThen(Effect.die("called"))),
        };
        const missingWindow = yield* sendFreeFormFixture(
          defaultUserId,
          agentReplyFixture("Todavía no debe salir."),
          eventTime
        ).pipe(Effect.provideService(KapsoClient, kapsoNeverCalled), Effect.flip);
        expect(missingWindow._tag).toBe("WhatsAppWindowClosed");

        yield* removeWhatsAppIdentityForTesting(defaultUserId);
        const missingIdentity = yield* sendFreeFormFixture(
          defaultUserId,
          agentReplyFixture("No hay destinatario."),
          eventTime
        ).pipe(Effect.provideService(KapsoClient, kapsoNeverCalled), Effect.flip);
        expect(missingIdentity._tag).toBe("WhatsAppIdentityMissing");
        yield* seedDevelopmentIdentity(defaultAgentBearer);

        const [inbound] = yield* recordedEvents(eventTime);
        const admission = yield* admitAgentConversationTurn({
          caller: inbound.caller,
          content: { _tag: "Text", text: inbound.content.text },
          message: inbound.messageEvidence,
          receivedAt: inbound.receivedAt,
        });
        if (admission._tag !== "AuthorizedTurn") {
          return yield* Effect.die("expected authorized fixture turn");
        }
        yield* enqueueTurn({
          admission,
          event: inbound,
          deliveryKey,
        });
        const client = yield* ApiHarnessClient;
        yield* client.transactions.createTransaction({
          payload: transactionPayload({ counterparty: "ReassociationHistory" }),
        });
        const reassociatedPhone = E164PhoneNumber.make("+573009999999");
        yield* associateWhatsAppIdentity(defaultUserId, {
          ...testWhatsAppCaller(reassociatedPhone),
          verifiedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        });
        expect(yield* resolveWhatsAppCaller(testWhatsAppCaller(reassociatedPhone))).toEqual(
          Option.some(defaultUserId)
        );
        expect(
          yield* withUserTransaction(
            defaultUserId,
            sql`SELECT counterparty FROM transactions
                WHERE user_id = ${defaultUserId} AND counterparty = 'ReassociationHistory'`
          )
        ).toEqual([{ counterparty: "ReassociationHistory" }]);
        const reassociated = yield* sendFreeFormFixture(
          defaultUserId,
          agentReplyFixture("La ventana anterior no se transfiere."),
          eventTime
        ).pipe(Effect.provideService(KapsoClient, kapsoNeverCalled), Effect.flip);
        expect(reassociated._tag).toBe("WhatsAppWindowClosed");
        expect(yield* getWhatsAppWindowState(defaultUserId, eventTime)).toEqual({
          _tag: "Closed",
          lastWindowOpenUntil: Option.none(),
        });

        const failure = yield* sendFreeFormFixture(
          defaultUserId,
          agentReplyFixture("No debe salir."),
          DateTime.add(eventTime, { hours: 25 })
        ).pipe(Effect.provideService(KapsoClient, kapsoNeverCalled), Effect.flip);
        expect(failure._tag).toBe("WhatsAppWindowClosed");
        expect(yield* Ref.get(sends)).toBe(0);
      })
    );
  }
);

layer(WhatsAppTraceHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "WhatsApp causal tracing",
  (it) => {
    it.effect("continues an authenticated webhook trace through durable delivery", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const recorder = yield* EnvelopeRecorder;
        yield* recorder.clear;
        const receivedAt = yield* DateTime.now;
        const forgedTraceId = "a".repeat(32);
        const bodySentinel = "trace-private-message-sentinel";

        const response = yield* postSignedTextFixture({
          providerMessageId: "wamid.trace-causality",
          text: bodySentinel,
          occurredAt: receivedAt,
          headers: {
            "sentry-trace": `${forgedTraceId}-${"b".repeat(16)}-1`,
            baggage: "private-baggage-sentinel",
            traceparent: `00-${forgedTraceId}-${"c".repeat(16)}-01`,
            b3: `${forgedTraceId}-${"d".repeat(16)}-1`,
          },
        });
        expect(response.status).toBe(200);

        const sql = yield* SqlClient.SqlClient;
        const stored = yield* withUserTransaction(
          defaultUserId,
          sql`SELECT trace_version AS "traceVersion", trace_id AS "traceId",
            parent_span_id AS "parentSpanId", trace_sampled AS "sampled",
            trace_captured_at AS "capturedAt", processing_attempt AS "processingAttempt"
          FROM whatsapp_inbound_jobs WHERE user_id = ${defaultUserId}`
        );
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ traceVersion: 1, sampled: true, processingAttempt: 0 });
        expect(stored[0]?.traceId).not.toBe(forgedTraceId);
        const serializedStored = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(stored);
        expect(serializedStored).not.toContain(defaultUserId);
        expect(serializedStored).not.toContain("wamid.trace-causality");
        expect(serializedStored).not.toContain(bodySentinel);

        expect(yield* processNextWhatsAppTurn(DateTime.add(receivedAt, { seconds: 3 }))).toBe(true);
        const transactions = yield* recordedTransactions();
        expectAuthenticatedTrace(transactions, forgedTraceId);
        const serialized = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(transactions);
        for (const sentinel of [
          bodySentinel,
          "private-baggage-sentinel",
          defaultUserId,
          defaultWhatsAppPhone,
          "wamid.trace-causality",
          "wamid.test-outbound",
          "Respuesta entregada.",
          "test-api-key",
        ]) {
          expect(serialized).not.toContain(sentinel);
        }
      })
    );

    it.effect("parents a debounced burst from only its newest durable context", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const recorder = yield* EnvelopeRecorder;
        yield* recorder.clear;
        const firstAt = yield* DateTime.now;
        const secondAt = DateTime.add(firstAt, { seconds: 1 });
        const olderContext = yield* durableContextFixture("3".repeat(32), "4".repeat(16), firstAt);
        const newestContext = yield* durableContextFixture("5".repeat(32), "6".repeat(16), firstAt);
        const first = makeKapsoTextEvent("wamid.trace-burst-older", "almuerzo", firstAt);
        const second = {
          ...makeKapsoTextEvent(
            "wamid.trace-burst-newest",
            "taxi",
            DateTime.subtract(firstAt, { seconds: 1 })
          ),
          receivedAt: secondAt,
        };
        yield* enqueueWhatsAppTurn({
          admission: authorizedTurn(first),
          event: first,
          deliveryKey,
          propagation: Option.some(olderContext),
        });
        yield* enqueueWhatsAppTurn({
          admission: authorizedTurn(second),
          event: second,
          deliveryKey,
          propagation: Option.some(newestContext),
        });

        expect(
          yield* processNextWhatsAppTurn(DateTime.add(secondAt, { seconds: 3 })).pipe(
            Effect.provideService(AgentService, agentServiceFixture()),
            Effect.provideService(
              KapsoClient,
              kapsoClientFixture("wamid.trace-burst-reply", secondAt)
            )
          )
        ).toBe(true);
        const processing = (yield* recordedTransactions()).find(
          (transaction) => transaction.transaction === "whatsapp.processTurn"
        );
        expect(processing?.contexts.trace).toMatchObject({
          trace_id: newestContext.traceId,
          parent_span_id: newestContext.parentSpanId,
          data: { "fidy.input_count": 2 },
        });
        expect(processing?.contexts.trace.trace_id).not.toBe(olderContext.traceId);
      })
    );

    it.effect(
      "rejects widened storage and discards stale durable context without losing the turn",
      () =>
        Effect.gen(function* () {
          yield* seedDevelopmentIdentity(defaultAgentBearer);
          yield* truncateWhatsAppChannel;
          const recorder = yield* EnvelopeRecorder;
          yield* recorder.clear;
          const eventTime = yield* DateTime.now;
          const event = makeKapsoTextEvent("wamid.stale-propagation", "almuerzo 25 mil", eventTime);
          const staleTraceId = "1".repeat(32);
          const stalePropagation = yield* Schema.decodeUnknownEffect(DurableTraceContext)({
            version: 1,
            traceId: staleTraceId,
            parentSpanId: "2".repeat(16),
            sampled: true,
            capturedAtUnixMilliseconds: 0,
          });
          yield* enqueueWhatsAppTurn({
            admission: authorizedTurn(event),
            event,
            deliveryKey,
            propagation: Option.some(stalePropagation),
          });

          const admin = yield* MigrationSqlClient;
          const partial = yield* Effect.exit(
            admin`UPDATE whatsapp_inbound_jobs SET parent_span_id = NULL
            WHERE trace_id = ${staleTraceId}`
          );
          const oversized = yield* Effect.exit(
            admin`UPDATE whatsapp_inbound_jobs SET trace_id = ${"f".repeat(2_048)}
            WHERE trace_id = ${staleTraceId}`
          );
          expect(partial._tag).toBe("Failure");
          expect(oversized._tag).toBe("Failure");

          const secondUserId = UserId.make("f1d1a000-0000-4000-8000-000000000921");
          yield* seedConsentedAgentIdentity({
            userId: secondUserId,
            bearer: AgentBearerToken.make("fin_traceiso_abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
          });
          const sql = yield* SqlClient.SqlClient;
          expect(
            yield* withUserTransaction(
              secondUserId,
              sql`SELECT trace_id FROM whatsapp_inbound_jobs WHERE trace_id = ${staleTraceId}`
            )
          ).toEqual([]);

          expect(
            yield* processNextWhatsAppTurn(DateTime.add(eventTime, { seconds: 3 })).pipe(
              Effect.provideService(
                KapsoClient,
                kapsoClientFixture("wamid.stale-propagation-reply", eventTime)
              )
            )
          ).toBe(true);
          const processing = (yield* recordedTransactions()).find(
            (transaction) => transaction.transaction === "whatsapp.processTurn"
          );
          expect(processing?.contexts.trace.parent_span_id).toBeUndefined();
          expect(processing?.contexts.trace.trace_id).not.toBe(staleTraceId);
        })
    );

    it.effect("discards unsupported stored context without losing the turn", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const recorder = yield* EnvelopeRecorder;
        yield* recorder.clear;
        const eventTime = yield* DateTime.now;
        const traceId = "7".repeat(32);
        const event = makeKapsoTextEvent("wamid.unsupported-propagation", "taxi", eventTime);
        yield* enqueueWhatsAppTurn({
          admission: authorizedTurn(event),
          event,
          deliveryKey,
          propagation: Option.some(
            yield* durableContextFixture(traceId, "8".repeat(16), eventTime)
          ),
        });
        const admin = yield* MigrationSqlClient;
        const processed = yield* Effect.acquireUseRelease(
          admin`ALTER TABLE whatsapp_inbound_jobs
            DROP CONSTRAINT whatsapp_inbound_jobs_trace_complete_or_absent`,
          () =>
            admin`UPDATE whatsapp_inbound_jobs SET trace_version = 2
              WHERE trace_id = ${traceId}`.pipe(
              Effect.andThen(
                processNextWhatsAppTurn(DateTime.add(eventTime, { seconds: 3 })).pipe(
                  Effect.provideService(
                    KapsoClient,
                    kapsoClientFixture("wamid.unsupported-propagation-reply", eventTime)
                  )
                )
              )
            ),
          () =>
            admin`UPDATE whatsapp_inbound_jobs
              SET trace_version = NULL, trace_id = NULL, parent_span_id = NULL,
                trace_sampled = NULL, trace_captured_at = NULL
              WHERE trace_version <> 1`.pipe(
              Effect.andThen(admin`ALTER TABLE whatsapp_inbound_jobs
                ADD CONSTRAINT whatsapp_inbound_jobs_trace_complete_or_absent CHECK (
                  (trace_version IS NULL AND trace_id IS NULL AND parent_span_id IS NULL
                    AND trace_sampled IS NULL AND trace_captured_at IS NULL)
                  OR
                  (trace_version IS NOT NULL AND trace_id IS NOT NULL
                    AND parent_span_id IS NOT NULL AND trace_sampled IS NOT NULL
                    AND trace_captured_at IS NOT NULL AND trace_version = 1
                    AND trace_id ~ '^[0-9a-f]{32}$'
                    AND parent_span_id ~ '^[0-9a-f]{16}$'
                    AND trace_captured_at >= 0
                    AND trace_captured_at <= 8640000000000000)
                )`),
              Effect.orDie
            )
        );
        expect(processed).toBe(true);
        const processing = requiredTransaction(
          yield* recordedTransactions(),
          "whatsapp.processTurn"
        );
        expect(processing.contexts.trace.parent_span_id).toBeUndefined();
        expect(processing.contexts.trace.trace_id).not.toBe(traceId);
      })
    );

    it.effect("preserves context and bounded provider metadata across a retry", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const recorder = yield* EnvelopeRecorder;
        yield* recorder.clear;
        const eventTime = yield* DateTime.now;
        const context = yield* durableContextFixture("9".repeat(32), "a".repeat(16), eventTime);
        const event = makeKapsoTextEvent("wamid.trace-retry", "mercado", eventTime);
        yield* enqueueWhatsAppTurn({
          admission: authorizedTurn(event),
          event,
          deliveryKey,
          propagation: Option.some(context),
        });
        const attempts = yield* Ref.make(0);
        const kapso: KapsoClientService = {
          sendText: () =>
            Ref.updateAndGet(attempts, (attempt) => attempt + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(
                      new KapsoSendFailed({
                        safeReason: "rate_limited",
                        deliveryCertainty: "rejected",
                        automaticRetry: true,
                        responseStatus: Option.some(TelemetryHttpStatus.make(429)),
                      })
                    )
                  : Effect.succeed({
                      messageEvidence: {
                        channel: "whatsapp",
                        provider: "kapso",
                        providerMessageId:
                          WhatsAppProviderMessageId.make("wamid.trace-retry-reply"),
                      },
                      sentAt: eventTime,
                      responseStatus: TelemetryHttpStatus.make(200),
                    })
              )
            ),
        };
        expect(
          yield* processTurnWith(
            DateTime.add(eventTime, { seconds: 3 }),
            agentServiceFixture(),
            kapso
          )
        ).toBe(true);
        expect(
          yield* processTurnWith(
            DateTime.add(eventTime, { seconds: 5 }),
            agentServiceFixture(),
            kapso
          )
        ).toBe(true);
        const transactions = yield* recordedTransactions();
        const processingAttempts = transactions.filter(
          (transaction) => transaction.transaction === "whatsapp.processTurn"
        );
        const providerAttempts = transactions.filter(
          (transaction) => transaction.transaction === "whatsapp.sendText"
        );
        expect(processingAttempts).toHaveLength(2);
        expect(providerAttempts).toHaveLength(2);
        expect(processingAttempts.map((transaction) => transaction.contexts.trace.data)).toEqual([
          expect.objectContaining({ "fidy.attempt": 1 }),
          expect.objectContaining({ "fidy.attempt": 2 }),
        ]);
        expect(providerAttempts.map((transaction) => transaction.contexts.trace.data)).toEqual([
          expect.objectContaining({ "fidy.attempt": 1, "http.response.status_code": 429 }),
          expect.objectContaining({ "fidy.attempt": 2, "http.response.status_code": 200 }),
        ]);
        for (const [index, processing] of processingAttempts.entries()) {
          expect(processing.contexts.trace).toMatchObject({
            trace_id: context.traceId,
            parent_span_id: context.parentSpanId,
          });
          expect(providerAttempts[index]?.contexts.trace).toMatchObject({
            trace_id: context.traceId,
            parent_span_id: processing.contexts.trace.span_id,
          });
        }
        expect(processingAttempts[0]?.contexts.trace.span_id).not.toBe(
          processingAttempts[1]?.contexts.trace.span_id
        );
      })
    );

    it.effect("isolates trace metadata across eight concurrent worker loops", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const recorder = yield* EnvelopeRecorder;
        yield* recorder.clear;
        const eventTime = yield* DateTime.now;
        const fixtures = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => index),
          (index) => enqueueTraceFixture(index, eventTime)
        );
        const sends = yield* Ref.make(0);
        const kapso: KapsoClientService = {
          sendText: () =>
            Ref.updateAndGet(sends, (count) => count + 1).pipe(
              Effect.map((count) => ({
                messageEvidence: {
                  channel: "whatsapp" as const,
                  provider: "kapso" as const,
                  providerMessageId: WhatsAppProviderMessageId.make(
                    `wamid.concurrent-trace-reply-${count}`
                  ),
                },
                sentAt: eventTime,
                responseStatus: TelemetryHttpStatus.make(200),
              }))
            ),
        };
        const workerLoop = Effect.gen(function* () {
          let processed = 0;
          while (
            yield* processTurnWith(
              DateTime.add(eventTime, { seconds: 3 }),
              agentServiceFixture(),
              kapso
            )
          ) {
            processed += 1;
          }
          return processed;
        });
        const processedByLoop = yield* Effect.all(
          fixtures.map(() => workerLoop),
          {
            concurrency: "unbounded",
          }
        );
        expect(processedByLoop.reduce((total, count) => total + count, 0)).toBe(8);
        const transactions = yield* recordedTransactions();
        const processing = transactions.filter(
          (transaction) => transaction.transaction === "whatsapp.processTurn"
        );
        expect(processing).toHaveLength(8);
        expect(
          new Set(processing.map((transaction) => transaction.contexts.trace.trace_id))
        ).toEqual(new Set(fixtures.map(({ context }) => context.traceId)));
        for (const transaction of processing) {
          expect(transaction.contexts.trace.data).toMatchObject({
            "fidy.attempt": 1,
            "fidy.input_count": 1,
          });
        }
        const serialized = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(transactions);
        for (const { userId } of fixtures) expect(serialized).not.toContain(userId);
      })
    );
  }
);
