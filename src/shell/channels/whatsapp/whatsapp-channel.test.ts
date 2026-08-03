import { expect, layer } from "@effect/vitest";
import {
  Array as EffectArray,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ConsentRecord, ConsentRecordId } from "~/core/consent/model";
import { E164PhoneNumber, UserId } from "~/core/identity/reference";
import { AgentBearerToken } from "~/core/tokens/model";
import { AgentReply, AgentService, AgentServiceLive } from "~/shell/agent/agent-service";
import { admitAgentConversationTurn } from "~/shell/agent/conversation";
import { MigrationSqlClient } from "~/shell/db/client";
import {
  defaultUserId,
  defaultWhatsAppPhone,
  seedConsentedAgentIdentity,
  seedDevelopmentIdentity,
} from "~/shell/db/development-seed";
import { ApiHarness, ApiHarnessClient, ApiHarnessKapsoControl } from "~/shell/testing/api-harness";
import { withUserTransaction } from "~/shell/db/user-transaction";
import {
  appendConsentRecord,
  claimConsentDisclosureDelivery,
  findPendingConsentExchange,
  observeConsentRecords,
  releaseConsentDisclosureDelivery,
} from "~/shell/consent/repo";
import { associateWhatsAppIdentity, resolveWhatsAppCaller } from "~/shell/identity/repo";
import { removeWhatsAppIdentityForTesting } from "~/shell/identity/testing";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";
import { transactionPayload } from "~/shell/transactions/fixtures";
import { listTranscriptEntries } from "~/shell/transcript/repo";
import { TranscriptText } from "~/core/transcript/model";
import { categoryIds } from "~/core/categories/taxonomy";
import { KapsoClient, type KapsoClientService } from "./kapso-client";
import { decodeKapsoWebhook } from "./kapso-webhook";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppDeliveryKey,
  WhatsAppProviderMessageId,
  type WhatsAppInboundEvent,
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
  pruneWhatsAppOperationalData,
  releaseWhatsAppReceipt,
  startWhatsAppTurn,
} from "./repo";
import { processNextWhatsAppTurn } from "./worker";

const deliveryKey = WhatsAppDeliveryKey.make("delivery-worker-fixture");
const fixtureBytes = (name: "kapso-text-v2.json" | "kapso-voice-v2.json") =>
  Effect.promise(() => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).bytes());
const postSignedTextFixture = Effect.fn("WhatsApp.postSignedTextFixture")(function* (input: {
  readonly providerMessageId: string;
  readonly phoneNumber?: E164PhoneNumber;
  readonly text?: string;
  readonly occurredAt?: DateTime.Utc;
}) {
  const phoneNumber = input.phoneNumber ?? E164PhoneNumber.make("+573001234567");
  const text = input.text ?? "almuerzo 25 mil";
  const occurredAt = input.occurredAt ?? DateTime.makeUnsafe("2026-04-03T12:00:00.000Z");
  const template = new TextDecoder().decode(yield* fixtureBytes("kapso-text-v2.json"));
  const body = new TextEncoder().encode(
    template
      .replace("wamid.text-001", input.providerMessageId)
      .replace("573001234567", phoneNumber.slice(1))
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
    headers: { "x-webhook-signature": signature, "x-idempotency-key": input.providerMessageId },
    body: HttpBody.uint8Array(body, "application/json"),
  });
});
const recordedEvents = Effect.fn("WhatsApp.recordedEvents")(function* (receivedAt: DateTime.Utc) {
  const text = yield* decodeKapsoWebhook({
    rawBody: yield* fixtureBytes("kapso-text-v2.json"),
    secret: "test-webhook-secret-32-characters",
    signature: "2c9e6d0ce2b1d348e540f8e3ed623cd633aa39e09c2b96f1c782008186e0352f",
    deliveryKey,
    receivedAt,
  });
  const voice = yield* decodeKapsoWebhook({
    rawBody: yield* fixtureBytes("kapso-voice-v2.json"),
    secret: "test-webhook-secret-32-characters",
    signature: "181344306f695b38d012453d4a3d12cd97917c5aa3d5db1e598ad5cd2d7f77ad",
    deliveryKey,
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
      const completed = (callId: string) => {
        const callIndex = serialized.lastIndexOf(callId);
        return callIndex >= 0 && serialized.lastIndexOf("tool-result") > callIndex;
      };
      const voice =
        serialized.lastIndexOf("taxi 18 mil") > serialized.lastIndexOf("almuerzo 25 mil");
      const callId = voice ? "whatsapp-voice-quick-log" : "whatsapp-text-quick-log";
      if (completed(callId)) {
        return Effect.succeed([{ type: "text" as const, text: "Registré el movimiento." }]);
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
                  merchant: "WhatsAppTaxi",
                  direction: "outflow",
                  categoryId: categoryIds.transporte,
                  occurredAt: occurredAt.value,
                }
              : {
                  money: { amount: "25000", currency: "COP" },
                  merchant: "WhatsAppAlmuerzo",
                  direction: "outflow",
                  categoryId: categoryIds.restaurantes,
                  occurredAt: occurredAt.value,
                },
          },
        },
      ]);
    },
    streamText: () => {
      throw new Error("The WhatsApp agent test uses non-streaming generation");
    },
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
const FailingAgentService = AgentServiceLive.pipe(Layer.provide(FailingWhatsAppModel));
const WhatsAppHarness = AgentServiceLive.pipe(
  Layer.provideMerge(ScriptedWhatsAppModel),
  Layer.provideMerge(ApiHarness)
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
  phoneNumber: defaultWhatsAppPhone,
  businessPhoneNumberId,
  occurredAt: receivedAt,
  receivedAt,
  content: { _tag: "Text", text: TranscriptText.make(text) },
});
const authorizedTurn = (event: WhatsAppInboundEvent, userId: UserId = defaultUserId) => ({
  _tag: "AuthorizedTurn" as const,
  userId,
  inboundMessage: { text: event.content.text },
});
const agentReplyFixture = (text: string, overrides: Partial<AgentReply> = {}) =>
  AgentReply.make({
    text: TranscriptText.make(text),
    attachments: Option.none(),
    choices: Option.none(),
    ...overrides,
  });
const kapsoClientFixture = (
  providerMessageId: string,
  sentAt: DateTime.Utc,
  beforeSend: Effect.Effect<void> = Effect.void
): KapsoClientService => ({
  sendText: () =>
    beforeSend.pipe(
      Effect.as({
        messageEvidence: {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: WhatsAppProviderMessageId.make(providerMessageId),
        },
        sentAt,
      })
    ),
});
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
            phoneNumber: first.phoneNumber,
            content: { _tag: "Text", text: first.content.text },
            message: first.messageEvidence,
            receivedAt: first.receivedAt,
          });
          const secondAdmission = yield* admitAgentConversationTurn({
            phoneNumber: second.phoneNumber,
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
            (yield* enqueueWhatsAppTurn({
              admission: firstAdmission,
              event: first,
              deliveryKey,
            })).inserted
          ).toBe(true);
          expect(
            (yield* enqueueWhatsAppTurn({
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
            sql`SELECT merchant FROM transactions
                WHERE user_id = ${defaultUserId}
                  AND merchant IN ('WhatsAppAlmuerzo', 'WhatsAppTaxi')
                ORDER BY merchant`
          );
          expect(transactions).toEqual([{ merchant: "WhatsAppTaxi" }]);

          expect(
            (yield* enqueueWhatsAppTurn({
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
          phoneNumber: inbound.phoneNumber,
          content: { _tag: "Text", text: inbound.content.text },
          message: inbound.messageEvidence,
          receivedAt: inbound.receivedAt,
        });
        if (admission._tag !== "AuthorizedTurn") {
          return yield* Effect.die("expected authorized text turn");
        }
        yield* enqueueWhatsAppTurn({
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
            sql`SELECT merchant FROM transactions
                WHERE user_id = ${defaultUserId} AND merchant = 'WhatsAppAlmuerzo'`
          )
        ).toEqual([{ merchant: "WhatsAppAlmuerzo" }]);
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
        const countTransactions = (userId: UserId, merchant: string) =>
          Effect.gen(function* () {
            const row = yield* withUserTransaction(
              userId,
              SqlSchema.findOne({
                Request: Schema.Struct({ userId: UserId, merchant: Schema.String }),
                Result: Schema.Struct({ count: Schema.Int }),
                execute: (request) => sql`SELECT count(*)::int AS count FROM transactions
                  WHERE user_id = ${request.userId} AND merchant = ${request.merchant}`,
              })({ userId, merchant })
            );
            return row.count;
          });
        const [firstCountBefore, secondCountBefore] = yield* Effect.all([
          countTransactions(defaultUserId, "WhatsAppAlmuerzo"),
          countTransactions(secondUserId, "WhatsAppTaxi"),
        ]);
        const eventTime = yield* DateTime.now;
        yield* associateWhatsAppIdentity(secondUserId, {
          phoneNumber: secondPhone,
          verifiedAt: eventTime,
        });
        const first = makeKapsoTextEvent("wamid.isolation-a", "almuerzo 25 mil", eventTime);
        const second = {
          ...makeKapsoTextEvent("wamid.isolation-b", "taxi 18 mil", eventTime),
          phoneNumber: secondPhone,
        };
        yield* Effect.all(
          [
            enqueueWhatsAppTurn({
              admission: authorizedTurn(first),
              event: first,
              deliveryKey,
            }),
            enqueueWhatsAppTurn({
              admission: authorizedTurn(second, secondUserId),
              event: second,
              deliveryKey,
            }),
          ],
          { concurrency: "unbounded" }
        );

        const recipients = yield* Ref.make<ReadonlyArray<E164PhoneNumber>>([]);
        const kapsoService: KapsoClientService = {
          sendText: (input) =>
            Ref.updateAndGet(recipients, (current) => [...current, input.to]).pipe(
              Effect.map((current) => ({
                messageEvidence: {
                  channel: "whatsapp" as const,
                  provider: "kapso",
                  providerMessageId: WhatsAppProviderMessageId.make(
                    `wamid.isolation-reply-${current.length}`
                  ),
                },
                sentAt: eventTime,
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
          [defaultWhatsAppPhone, secondPhone].toSorted()
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
            sql`SELECT merchant FROM transactions WHERE user_id = ${secondUserId}`
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
        yield* enqueueWhatsAppTurn({
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
        expect((yield* startWhatsAppTurn(wrongUserClaim).pipe(Effect.flip))._tag).toBe(
          "WhatsAppClaimInvalid"
        );

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
      })
    );

    it.effect("terminally retires stale started work without replaying its content", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateWhatsAppChannel;
        const eventTime = yield* DateTime.now;
        const inbound = makeKapsoTextEvent("wamid.ambiguous-crash", "mercado 20 mil", eventTime);
        yield* enqueueWhatsAppTurn({
          admission: authorizedTurn(inbound),
          event: inbound,
          deliveryKey,
        });
        const claim = yield* claimWhatsAppTurn(DateTime.add(eventTime, { seconds: 3 }));
        if (Option.isNone(claim)) return yield* Effect.die("expected crash fixture claim");
        yield* startWhatsAppTurn(claim.value);
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
          _tag: "Phone" as const,
          phoneNumber: E164PhoneNumber.make("+573001234567"),
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
        yield* enqueueWhatsAppTurn({
          admission: authorizedTurn(inbound),
          event: inbound,
          deliveryKey,
        });
        yield* consumeWhatsAppIngressBudget(
          { _tag: "Phone", phoneNumber: inbound.phoneNumber },
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
        yield* pruneWhatsAppOperationalData();

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
            return enqueueWhatsAppTurn({
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
              "2c9e6d0ce2b1d348e540f8e3ed623cd633aa39e09c2b96f1c782008186e0352f",
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
          (yield* enqueueWhatsAppTurn({
            admission: authorizedTurn(first),
            event: first,
            deliveryKey,
          })).inserted
        ).toBe(true);
        expect(
          (yield* enqueueWhatsAppTurn({
            admission: authorizedTurn(second),
            event: second,
            deliveryKey,
          })).inserted
        ).toBe(true);

        const overflow = makeKapsoTextEvent("wamid.boundary-overflow", "c", eventTime);
        const failure = yield* enqueueWhatsAppTurn({
          admission: authorizedTurn(overflow),
          event: overflow,
          deliveryKey,
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("WhatsAppInboundCapacityExceeded");

        const claim = yield* claimWhatsAppTurn(DateTime.add(eventTime, { seconds: 3 }));
        if (Option.isNone(claim) || claim.value.action !== "process") {
          return yield* Effect.die("missing boundary claim");
        }
        const started = yield* startWhatsAppTurn(claim.value);
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
        yield* enqueueWhatsAppTurn({
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
        yield* enqueueWhatsAppTurn({
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
        const request = () =>
          HttpClient.post("/webhooks/kapso", {
            headers: {
              "x-webhook-signature":
                "2c9e6d0ce2b1d348e540f8e3ed623cd633aa39e09c2b96f1c782008186e0352f",
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
        const request = () =>
          HttpClient.post("/webhooks/kapso", {
            headers: {
              "x-webhook-signature":
                "2c9e6d0ce2b1d348e540f8e3ed623cd633aa39e09c2b96f1c782008186e0352f",
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
              { _tag: "Phone", phoneNumber: exhaustedPhone },
              WhatsAppProviderMessageId.make(`wamid.exhausted-phone-${index}`),
              now
            ),
          { concurrency: 16, discard: true }
        );
        const request = () =>
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
        expect(Option.isNone(yield* findPendingConsentExchange(phoneNumber))).toBe(true);
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
            phoneNumber,
          };
          const admission = yield* admitAgentConversationTurn({
            phoneNumber,
            content: { _tag: "Text", text: initialEvent.content.text },
            message: initialEvent.messageEvidence,
            receivedAt: initialEvent.occurredAt,
          });
          if (admission._tag !== "SendDisclosure") {
            return yield* Effect.die("missing public-route disclosure admission");
          }
          const claim = yield* claimConsentDisclosureDelivery(admission.exchangeId, now);
          if (Option.isNone(claim)) return yield* Effect.die("missing disclosure delivery claim");

          const request = () =>
            postSignedTextFixture({
              phoneNumber,
              providerMessageId: "wamid.public-disclosure-retry",
              text: "hola de nuevo",
              occurredAt: now,
            });
          expect((yield* request()).status).toBe(503);
          yield* releaseConsentDisclosureDelivery({
            exchangeId: admission.exchangeId,
            claimId: claim.value.claimId,
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
          phoneNumber,
        };
        const admission = yield* admitAgentConversationTurn({
          phoneNumber,
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
        expect((yield* findPendingConsentExchange(phoneNumber)).pipe(Option.isSome)).toBe(true);
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
          phoneNumber,
        };
        const admission = yield* admitAgentConversationTurn({
          phoneNumber,
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
      })
    );

    it.effect("uses provider occurrence time to reject a delayed pre-disclosure decision", () =>
      Effect.gen(function* () {
        const phoneNumber = E164PhoneNumber.make("+573007776655");
        const postEvent = (providerMessageId: string, text: string, occurredAt: DateTime.Utc) =>
          postSignedTextFixture({ phoneNumber, providerMessageId, text, occurredAt });
        const receivedAt = yield* DateTime.now;
        expect((yield* postEvent("wamid.disclosure-trigger", "hola", receivedAt)).status).toBe(200);
        expect(
          (yield* postEvent(
            "wamid.predates-disclosure",
            "Acepto",
            DateTime.subtract(receivedAt, { minutes: 1 })
          )).status
        ).toBe(200);
        expect(yield* resolveWhatsAppCaller(phoneNumber)).toEqual(Option.none());
      })
    );

    it.effect("keeps a pre-consent financial message inert when its signed body is replayed", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const phoneNumber = E164PhoneNumber.make("+573006665544");
        const postEvent = (providerMessageId: string, text: string, occurredAt: DateTime.Utc) =>
          postSignedTextFixture({ phoneNumber, providerMessageId, text, occurredAt });
        const receivedAt = yield* DateTime.now;
        const original = () =>
          postEvent("wamid.pre-consent-financial", "almuerzo 25 mil", receivedAt);
        expect((yield* original()).status).toBe(200);
        expect(
          (yield* postEvent(
            "wamid.fresh-consent",
            "Acepto",
            DateTime.add(receivedAt, { seconds: 1 })
          )).status
        ).toBe(200);
        expect(Option.isSome(yield* resolveWhatsAppCaller(phoneNumber))).toBe(true);

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

    it.effect("rejects first-delivered messages predating consent or the current association", () =>
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
          phoneNumber: defaultWhatsAppPhone,
          verifiedAt: now,
        });
        const preAssociation = yield* postSignedTextFixture({
          phoneNumber: defaultWhatsAppPhone,
          providerMessageId: "wamid.predates-association",
          text: "taxi 18 mil",
          occurredAt: DateTime.subtract(now, { minutes: 1 }),
        });
        expect(preAssociation.status).toBe(200);
        expect(yield* preAssociation.json).toMatchObject({ enqueued: 0, duplicates: 1 });

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
        yield* Effect.sleep("500 millis");
        const refused = yield* HttpClient.post("/webhooks/kapso", {
          headers: {
            "x-webhook-signature": "0".repeat(64),
            "x-idempotency-key": "reader-overflow",
          },
          body: HttpBody.uint8Array(new Uint8Array([123]), "application/json"),
        });
        expect(refused.status).toBe(429);
        yield* Fiber.interruptAll(readers);
      })
    );

    it.effect("maps authenticated route boundary failures without persisting", () =>
      Effect.gen(function* () {
        yield* truncateWhatsAppChannel;
        const admin = yield* MigrationSqlClient;
        const observeEffects = () =>
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
        const post = (body: Uint8Array, signature: string) =>
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
          (yield* post(altered, "2c9e6d0ce2b1d348e540f8e3ed623cd633aa39e09c2b96f1c782008186e0352f"))
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

    it.effect("refuses channel-unsupported semantic reply shapes before authorization", () =>
      Effect.gen(function* () {
        const unreachableKapso: KapsoClientService = {
          sendText: () => Effect.die("unsupported reply reached Kapso"),
        };
        const attachmentFailure = yield* sendKapsoFreeForm(
          defaultUserId,
          agentReplyFixture("Adjunto", {
            attachments: Option.some([
              { mediaType: "image/png", url: new URL("https://example.com/image.png") },
            ]),
          }),
          yield* DateTime.now
        ).pipe(Effect.provideService(KapsoClient, unreachableKapso), Effect.flip);
        expect(attachmentFailure._tag).toBe("AgentReplyNotRenderable");

        const choiceFailure = yield* sendKapsoFreeForm(
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
          phoneNumber: E164PhoneNumber.make("+573008887766"),
          verifiedAt: eventTime,
        });
        const event = {
          ...makeKapsoTextEvent("wamid.revoked-window", "pan 5 mil", eventTime),
          phoneNumber: E164PhoneNumber.make("+573008887766"),
        };
        yield* enqueueWhatsAppTurn({
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
        const failure = yield* sendKapsoFreeForm(
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
        const missingWindow = yield* sendKapsoFreeForm(
          defaultUserId,
          agentReplyFixture("Todavía no debe salir."),
          eventTime
        ).pipe(Effect.provideService(KapsoClient, kapsoNeverCalled), Effect.flip);
        expect(missingWindow._tag).toBe("WhatsAppWindowClosed");

        yield* removeWhatsAppIdentityForTesting(defaultUserId);
        const missingIdentity = yield* sendKapsoFreeForm(
          defaultUserId,
          agentReplyFixture("No hay destinatario."),
          eventTime
        ).pipe(Effect.provideService(KapsoClient, kapsoNeverCalled), Effect.flip);
        expect(missingIdentity._tag).toBe("WhatsAppIdentityMissing");
        yield* seedDevelopmentIdentity(defaultAgentBearer);

        const [inbound] = yield* recordedEvents(eventTime);
        const admission = yield* admitAgentConversationTurn({
          phoneNumber: inbound.phoneNumber,
          content: { _tag: "Text", text: inbound.content.text },
          message: inbound.messageEvidence,
          receivedAt: inbound.receivedAt,
        });
        if (admission._tag !== "AuthorizedTurn") {
          return yield* Effect.die("expected authorized fixture turn");
        }
        yield* enqueueWhatsAppTurn({
          admission,
          event: inbound,
          deliveryKey,
        });
        const client = yield* ApiHarnessClient;
        yield* client.transactions.createTransaction({
          payload: transactionPayload({ merchant: "ReassociationHistory" }),
        });
        const reassociatedPhone = E164PhoneNumber.make("+573009999999");
        yield* associateWhatsAppIdentity(defaultUserId, {
          phoneNumber: reassociatedPhone,
          verifiedAt: eventTime,
        });
        expect(yield* resolveWhatsAppCaller(reassociatedPhone)).toEqual(Option.some(defaultUserId));
        expect(
          yield* withUserTransaction(
            defaultUserId,
            sql`SELECT merchant FROM transactions
                WHERE user_id = ${defaultUserId} AND merchant = 'ReassociationHistory'`
          )
        ).toEqual([{ merchant: "ReassociationHistory" }]);
        const reassociated = yield* sendKapsoFreeForm(
          defaultUserId,
          agentReplyFixture("La ventana anterior no se transfiere."),
          eventTime
        ).pipe(Effect.provideService(KapsoClient, kapsoNeverCalled), Effect.flip);
        expect(reassociated._tag).toBe("WhatsAppWindowClosed");
        expect(yield* getWhatsAppWindowState(defaultUserId, eventTime)).toEqual({
          _tag: "Closed",
          lastWindowOpenUntil: Option.none(),
        });

        const failure = yield* sendKapsoFreeForm(
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
