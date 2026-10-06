import { afterAll, afterEach, expect, it, vi } from "vitest";
import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import {
  activateTestReminder,
  observeTestHostedContext,
  proactivityDatabase,
  proactivityTestCallers,
  proactivityTestDatabases,
  proactivityTestUsers,
  withdrawTestProcessingConsent,
} from "../proactivity.test-fixture";
import {
  makeProactivityCoordinator,
  proactivityWorkflowHarness,
} from "../weekly-summary.test-fixture";
import {
  controlManualReminders,
  findInsight,
  findProactivityReport,
  findReminderGovernor,
  findReminderSchedule,
  materializeReminder,
  prepareReminderRevision,
  recordProactivityDecision,
  requestProactivityConsent,
} from "./operations";
import { contextualProactiveInsightQuery, prepareInsightRecipient } from "../whatsapp/operations";
import {
  HostedDeliveryCorrelationToken,
  ProactivityTemplateConfiguration,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import {
  type InsightUnavailable,
  ProactivityActivity,
  type ProactivityDeliveryWork,
  type ProactivityEnvironment,
} from "./contract";
import { WhatsAppStatusAdmission, WhatsAppTurnAdmission } from "../whatsapp/contract";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { newId } from "../secret-material/operations";
import { UserId } from "../../src/core/identity/contract";
import { findCurrentProactivityOffer, findProactivityConsentGrant } from "../consent/operations";
import { FetchHttpClient } from "effect/http";
import type { ConsentUnavailable } from "../consent/contract";
import { executeProactivityWork } from "./runtime";
import { expireDeliveryWork, recoverDeliveryWork } from "./internal/proactivity-delivery-work";
import {
  readContextualProactiveReply,
  readProactiveMessageTranscript,
  readProactiveTranscript,
} from "../agent/operations";

const configuration = (db: D1Database): ProactivityEnvironment => ({
  DB: db,
  PROACTIVITY_ENABLED: "enabled",
  KAPSO_API_KEY: "test-only",
  PROACTIVITY_TEMPLATE_JSON: Schema.encodeSync(
    Schema.fromJsonString(ProactivityTemplateConfiguration)
  )({ name: "fidy_proactivity", language: "es", approval: "approved", body: "Fidy: {{1}}" }),
});
const workRequest = (work: ProactivityActivity): Request =>
  new Request("https://coordinator/proactivity-work", {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(ProactivityActivity))(work),
  });
afterAll(() => proactivityTestDatabases.dispose());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("the installed User coordinator generates the latest reminder and frozen message without enabling weekly summaries or invoking inference", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const now = DateTime.makeUnsafe("2026-10-06T23:00:00Z");
      vi.spyOn(Date, "now").mockReturnValue(now.epochMilliseconds);
      const coordinator = makeProactivityCoordinator({
        environment: configuration(db),
        userId: proactivityTestUsers[0],
      });
      const response = yield* Effect.tryPromise(() =>
        coordinator.fetch(
          workRequest({ kind: "proactivity-generate", version: 1, userId: proactivityTestUsers[0] })
        )
      );
      expect(response.status).toBe(200);
      expect(
        Option.getOrThrow(yield* findReminderSchedule({ db, userId: proactivityTestUsers[0] }))
          .nextScheduledAt.epochMilliseconds
      ).toBeGreaterThan(now.epochMilliseconds);
      const report = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT role,text,expires_at_ms FROM proactivity_reports WHERE user_id=?")
          .bind(proactivityTestUsers[0])
          .all()
      );
      expect(report.results).toHaveLength(1);
      expect(report.results[0]).toMatchObject({
        role: "manual-entry-reminder",
        expires_at_ms: DateTime.makeUnsafe("2026-10-07T23:00:00Z").epochMilliseconds,
      });
      expect(schedule.enabled).toBe(true);
    })
  ));

it("a category send is one-shot, provider acceptance is not delivery, and verified evidence settles the exact occurrence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const now = DateTime.makeUnsafe("2026-10-06T23:00:00Z");
      vi.spyOn(Date, "now").mockReturnValue(now.epochMilliseconds);
      const generated = yield* materializeReminder({
        db,
        userId: proactivityTestUsers[0],
        id: schedule.id,
        now,
      });
      if (generated._tag !== "Created") return yield* Effect.die("Expected reminder");
      const id = generated.id;
      const revision = yield* prepareReminderRevision({
        db,
        userId: proactivityTestUsers[0],
        now,
        input: {
          expectedVersion: schedule.version,
          cadence: { kind: "weekdays" },
          timing: { hour: 10, minute: 0 },
          timeZone: IanaTimeZone.make("UTC"),
        },
      });
      yield* Effect.tryPromise(() => db.batch([...revision]));
      const caller = proactivityTestCallers[0];
      const phone = WhatsAppBusinessPhoneNumberId.make("123456789");
      yield* Effect.tryPromise(() =>
        db.batch([
          prepareInsightRecipient({
            db,
            userId: proactivityTestUsers[0],
            recipient: {
              portfolioId: caller.businessPortfolioId,
              bsuid: caller.businessScopedUserId,
              businessPhoneNumberId: phone,
            },
            receivedAtMs: now.epochMilliseconds,
          }),
        ])
      );
      const provider = vi.fn(() =>
        Promise.resolve(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "reminder-provider" }] })
        )
      );
      vi.stubGlobal("fetch", provider);
      const coordinator = makeProactivityCoordinator({
        environment: configuration(db),
        userId: proactivityTestUsers[0],
      });
      const request = (): Request =>
        workRequest({
          kind: "proactivity-delivery",
          version: 1,
          userId: proactivityTestUsers[0],
          id,
        });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER test_pause_before_send BEFORE UPDATE ON proactivity_whatsapp_claims WHEN OLD.state='staged' AND NEW.state='sending' BEGIN SELECT RAISE(ABORT,'test_claim_refusal'); END"
          )
          .run()
      );
      expect((yield* Effect.tryPromise(() => coordinator.fetch(request()))).status).toBe(503);
      const staged = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          correlation_token: HostedDeliveryCorrelationToken,
          state: Schema.Literal("staged"),
        })
      )(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT correlation_token,state FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
            )
            .bind(proactivityTestUsers[0], id)
            .first()
        )
      );
      const early = yield* Schema.encodeEffect(Schema.fromJsonString(WhatsAppStatusAdmission))({
        userId: proactivityTestUsers[0],
        correlationToken: staged.correlation_token,
        businessPhoneNumberId: phone,
        providerMessageId: WhatsAppProviderMessageId.make("reminder-provider"),
        outcome: "delivered",
        occurredAtMs: now.epochMilliseconds,
        receivedAtMs: now.epochMilliseconds,
      });
      expect(
        (yield* Effect.tryPromise(() =>
          coordinator.fetch(
            new Request("https://coordinator/hosted-turn/whatsapp/status", {
              method: "POST",
              body: early,
            })
          )
        )).status
      ).toBe(503);
      expect(provider).not.toHaveBeenCalled();
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT state FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
            )
            .bind(proactivityTestUsers[0], id)
            .first()
        )
      ).toEqual({ state: "staged" });
      expect(
        Option.getOrThrow(yield* findInsight({ db, userId: proactivityTestUsers[0], id }))
          .lifecycleState
      ).toBe("pending");
      expect(
        Option.getOrThrow(yield* findReminderGovernor({ db, userId: proactivityTestUsers[0] }))
      ).toEqual({ _tag: "Attentive", unanswered: 0 });
      expect(
        Option.isNone(
          yield* readProactiveTranscript({
            db,
            userId: proactivityTestUsers[0],
            insightEventId: id,
            now: now.epochMilliseconds,
          })
        )
      ).toBe(true);
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER test_pause_before_send").run());
      expect((yield* Effect.tryPromise(() => coordinator.fetch(request()))).status).toBe(200);
      expect((yield* Effect.tryPromise(() => coordinator.fetch(request()))).status).toBe(200);
      expect(provider).toHaveBeenCalledOnce();
      expect(
        Option.getOrThrow(yield* findInsight({ db, userId: proactivityTestUsers[0], id }))
          .lifecycleState
      ).toBe("pending");
      expect(
        Option.getOrThrow(yield* findReminderGovernor({ db, userId: proactivityTestUsers[0] }))
      ).toEqual({ _tag: "Attentive", unanswered: 0 });
      const raw = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT correlation_token FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
          )
          .bind(proactivityTestUsers[0], id)
          .first()
      );
      const claim = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ correlation_token: HostedDeliveryCorrelationToken })
      )(raw);
      const baseStatus = {
        userId: proactivityTestUsers[0],
        correlationToken: claim.correlation_token,
        businessPhoneNumberId: phone,
        providerMessageId: WhatsAppProviderMessageId.make("reminder-provider"),
        outcome: "delivered" as const,
        occurredAtMs: now.epochMilliseconds,
        receivedAtMs: now.epochMilliseconds,
      };
      const changedToken = HostedDeliveryCorrelationToken.make(
        `${claim.correlation_token.slice(0, -1)}${claim.correlation_token.endsWith("a") ? "b" : "a"}`
      );
      for (const altered of [
        { ...baseStatus, userId: proactivityTestUsers[1] },
        { ...baseStatus, correlationToken: changedToken },
        { ...baseStatus, businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("987654321") },
        { ...baseStatus, providerMessageId: WhatsAppProviderMessageId.make("foreign-provider-id") },
        { ...baseStatus, occurredAtMs: now.epochMilliseconds - 2000 },
        { ...baseStatus, occurredAtMs: now.epochMilliseconds + 600000 },
      ]) {
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(WhatsAppStatusAdmission))(
          altered
        );
        expect(
          (yield* Effect.tryPromise(() =>
            coordinator.fetch(
              new Request("https://coordinator/hosted-turn/whatsapp/status", {
                method: "POST",
                body,
              })
            )
          )).status
        ).not.toBe(200);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT state FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
              )
              .bind(proactivityTestUsers[0], id)
              .first()
          )
        ).toEqual({ state: "accepted" });
        expect(
          Option.getOrThrow(yield* findReminderGovernor({ db, userId: proactivityTestUsers[0] }))
        ).toEqual({ _tag: "Attentive", unanswered: 0 });
        expect(
          Option.isNone(
            yield* readProactiveTranscript({
              db,
              userId: proactivityTestUsers[0],
              insightEventId: id,
              now: now.epochMilliseconds,
            })
          )
        ).toBe(true);
      }
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT (SELECT count(*) FROM insight_delivery_attempts WHERE user_id=?) AS attempts,(SELECT count(*) FROM proactive_transcript_event_links WHERE user_id=?) AS transcript_links,(SELECT count(*) FROM proactive_message_transcript_entries WHERE user_id=?) AS control_transcripts"
            )
            .bind(proactivityTestUsers[0], proactivityTestUsers[0], proactivityTestUsers[0])
            .first()
        )
      ).toEqual({ attempts: 0, transcript_links: 0, control_transcripts: 0 });
      const status = (): Request =>
        new Request("https://coordinator/hosted-turn/whatsapp/status", {
          method: "POST",
          body: Schema.encodeSync(Schema.fromJsonString(WhatsAppStatusAdmission))({
            userId: proactivityTestUsers[0],
            correlationToken: claim.correlation_token,
            businessPhoneNumberId: phone,
            providerMessageId: WhatsAppProviderMessageId.make("reminder-provider"),
            outcome: "delivered",
            occurredAtMs: now.epochMilliseconds,
            receivedAtMs: now.epochMilliseconds,
          }),
        });
      yield* Effect.tryPromise(() =>
        db.exec(
          "CREATE TRIGGER test_refuse_exact_transcript BEFORE INSERT ON proactive_transcript_entries BEGIN SELECT RAISE(ABORT,'test settlement unavailable'); END;"
        )
      );
      expect((yield* Effect.tryPromise(() => coordinator.fetch(status()))).status).toBe(503);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT state FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
            )
            .bind(proactivityTestUsers[0], id)
            .first()
        )
      ).toEqual({ state: "accepted" });
      expect(
        Option.getOrThrow(yield* findReminderGovernor({ db, userId: proactivityTestUsers[0] }))
      ).toEqual({ _tag: "Attentive", unanswered: 0 });
      yield* Effect.tryPromise(() => db.exec("DROP TRIGGER test_refuse_exact_transcript"));
      expect((yield* Effect.tryPromise(() => coordinator.fetch(status()))).status).toBe(200);
      expect((yield* Effect.tryPromise(() => coordinator.fetch(status()))).status).toBe(200);
      expect(
        Option.getOrThrow(yield* findInsight({ db, userId: proactivityTestUsers[0], id }))
          .lifecycleState
      ).toBe("delivered");
      expect(
        Option.getOrThrow(yield* findReminderGovernor({ db, userId: proactivityTestUsers[0] }))
      ).toEqual({ _tag: "Attentive", unanswered: 1 });
      const transcript = Option.getOrThrow(
        yield* readProactiveTranscript({
          db,
          userId: proactivityTestUsers[0],
          insightEventId: id,
          now: now.epochMilliseconds,
        })
      );
      expect(transcript.text).toBe("Fidy: Recuerda registrar tus movimientos manuales en Fidy.");
      expect(DateTime.isUtc(transcript.occurredAt)).toBe(true);
      expect(
        Option.isNone(
          yield* readProactiveTranscript({
            db,
            userId: proactivityTestUsers[1],
            insightEventId: id,
            now: now.epochMilliseconds,
          })
        )
      ).toBe(true);
      expect(provider).toHaveBeenCalledOnce();
      const prompt = yield* observeTestHostedContext({
        db,
        proof: yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
          userId: proactivityTestUsers[0],
          portfolioId: caller.businessPortfolioId,
          bsuid: caller.businessScopedUserId,
          businessPhoneNumberId: phone,
          messageId: "hosted-reminder-context",
          text: "¿Cómo cambio la hora?",
          occurredAtMs: now.epochMilliseconds,
          receivedAtMs: now.epochMilliseconds,
          replyToMessageId: "reminder-provider",
        }),
      });
      expect(prompt).toContain("ProactiveInsightTranscriptEntry");
      expect(prompt).toContain("Fidy: Recuerda registrar tus movimientos manuales en Fidy.");
      expect(
        Option.getOrThrow(yield* findReminderGovernor({ db, userId: proactivityTestUsers[0] }))
      ).toEqual({ _tag: "Attentive", unanswered: 0 });
    })
  ));

it("refuses approved-template drift between a deferred staging and the irreversible claim", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const now = DateTime.makeUnsafe("2026-10-06T23:00:00Z");
      const created = yield* materializeReminder({
        db,
        userId: proactivityTestUsers[0],
        id: schedule.id,
        now,
      });
      if (created._tag !== "Created") return yield* Effect.die("Expected reminder");
      const caller = proactivityTestCallers[0];
      yield* Effect.tryPromise(() =>
        db.batch([
          prepareInsightRecipient({
            db,
            userId: proactivityTestUsers[0],
            recipient: {
              portfolioId: caller.businessPortfolioId,
              bsuid: caller.businessScopedUserId,
              businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
            },
            receivedAtMs: now.epochMilliseconds,
          }),
        ])
      );
      const first = makeProactivityCoordinator({
        environment: configuration(db),
        userId: proactivityTestUsers[0],
      });
      const work: ProactivityActivity = {
        kind: "proactivity-delivery",
        version: 1,
        userId: proactivityTestUsers[0],
        id: created.id,
      };
      vi.spyOn(Date, "now").mockReturnValue(
        DateTime.makeUnsafe("2026-10-06T18:00:00Z").epochMilliseconds
      );
      expect((yield* Effect.tryPromise(() => first.fetch(workRequest(work)))).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(now.epochMilliseconds);
      const changed = makeProactivityCoordinator({
        environment: {
          ...configuration(db),
          PROACTIVITY_TEMPLATE_JSON:
            '{"name":"changed_template","language":"es","body":"Fidy: {{1}}","approval":"approved"}',
        },
        userId: proactivityTestUsers[0],
      });
      expect((yield* Effect.tryPromise(() => changed.fetch(workRequest(work)))).status).toBe(503);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT state,send_started_at_ms FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
            )
            .bind(proactivityTestUsers[0], created.id)
            .first()
        )
      ).toEqual({ state: "staged", send_started_at_ms: null });
    })
  ));

type RefusalCase = Readonly<{
  name: string;
  withdraw: boolean;
  reassociate: boolean;
  at: Option.Option<number>;
  environment: Partial<ProactivityEnvironment>;
  coordinatorUser: (typeof proactivityTestUsers)[number];
  workUser: (typeof proactivityTestUsers)[number];
  expectedStatus: 200 | 503;
  expectedState: "ready" | "expired";
}>;
const refused = {
  withdraw: false,
  reassociate: false,
  at: Option.none<number>(),
  environment: {},
  coordinatorUser: proactivityTestUsers[0],
  workUser: proactivityTestUsers[0],
  expectedStatus: 503,
  expectedState: "ready",
} as const;
const refusalCases: ReadonlyArray<RefusalCase> = [
  { ...refused, name: "foreign subject", coordinatorUser: proactivityTestUsers[1] },
  {
    ...refused,
    name: "foreign report",
    coordinatorUser: proactivityTestUsers[1],
    workUser: proactivityTestUsers[1],
  },
  { ...refused, name: "withdrawal", withdraw: true },
  { ...refused, name: "unapproved template", environment: { PROACTIVITY_TEMPLATE_JSON: "{}" } },
  { ...refused, name: "disabled channel", environment: { PROACTIVITY_ENABLED: "disabled" } },
  {
    ...refused,
    name: "expiry",
    at: Option.some(DateTime.makeUnsafe("2026-10-07T23:00:00Z").epochMilliseconds),
    expectedStatus: 200,
    expectedState: "expired",
  },
  { ...refused, name: "reassociation", reassociate: true, expectedStatus: 200 },
];
it.each(refusalCases)(
  "category delivery refuses $name without an irreversible claim or provider call",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        const schedule = yield* activateTestReminder(db);
        const now = DateTime.makeUnsafe("2026-10-06T23:00:00Z");
        const generated = yield* materializeReminder({
          db,
          userId: proactivityTestUsers[0],
          id: schedule.id,
          now,
        });
        if (generated._tag !== "Created") return yield* Effect.die("Expected reminder");
        const caller = proactivityTestCallers[0];
        yield* Effect.tryPromise(() =>
          db.batch([
            prepareInsightRecipient({
              db,
              userId: proactivityTestUsers[0],
              recipient: {
                portfolioId: caller.businessPortfolioId,
                bsuid: caller.businessScopedUserId,
                businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
              },
              receivedAtMs: now.epochMilliseconds,
            }),
          ])
        );
        if (scenario.withdraw === true) yield* withdrawTestProcessingConsent(db);
        if (scenario.reassociate === true) {
          yield* Effect.tryPromise(() =>
            db
              .prepare("UPDATE whatsapp_identities SET bsuid='CO.newuser' WHERE user_id=?")
              .bind(proactivityTestUsers[0])
              .run()
          );
        }
        vi.spyOn(Date, "now").mockReturnValue(
          Option.getOrElse(scenario.at, () => now.epochMilliseconds)
        );
        const provider = vi.fn(() =>
          Promise.resolve(
            Response.json({ messaging_product: "whatsapp", messages: [{ id: "must-not-send" }] })
          )
        );
        vi.stubGlobal("fetch", provider);
        const environment = { ...configuration(db), ...scenario.environment };
        const coordinator = makeProactivityCoordinator({
          environment,
          userId: scenario.coordinatorUser,
        });
        const response = yield* Effect.tryPromise(() =>
          coordinator.fetch(
            workRequest({
              kind: "proactivity-delivery",
              version: 1,
              userId: scenario.workUser,
              id: generated.id,
            })
          )
        );
        expect(response.status).toBe(scenario.expectedStatus);
        expect(provider).not.toHaveBeenCalled();
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT count(*) AS n FROM proactivity_whatsapp_claims WHERE send_started_at_ms IS NOT NULL"
              )
              .first()
          )
        ).toEqual({ n: 0 });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT state FROM proactivity_outbox WHERE user_id=? AND delivery_id=?")
              .bind(proactivityTestUsers[0], generated.id)
              .first()
          )
        ).toEqual({ state: scenario.expectedState });
      })
    )
);

it.each(["budget-threshold", "manual-entry-reminder"] as const)(
  "verified %s disclosures retain exact standalone Transcript without fabricated financial events",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        const userId = proactivityTestUsers[0];
        const caller = proactivityTestCallers[0];
        const now = DateTime.makeUnsafe("2026-10-06T17:00:00Z");
        vi.spyOn(Date, "now").mockReturnValue(now.epochMilliseconds);
        const phone = WhatsAppBusinessPhoneNumberId.make("123456789");
        yield* Effect.tryPromise(() =>
          db.batch([
            prepareInsightRecipient({
              db,
              userId,
              recipient: {
                portfolioId: caller.businessPortfolioId,
                bsuid: caller.businessScopedUserId,
                businessPhoneNumberId: phone,
              },
              receivedAtMs: now.epochMilliseconds,
            }),
          ])
        );
        const context = { db, userId, caller, kind, now };
        yield* requestProactivityConsent({ ...context, messageId: "request-contextual-category" });
        const environment = configuration(db);
        yield* executeProactivityWork({
          environment,
          userId,
          now,
          work: { kind: "proactivity-generate", version: 1, userId },
        });
        const offer = Option.getOrThrow(yield* findCurrentProactivityOffer(context));
        const exact = `Fidy: ${offer.disclosure.text}\n${offer.acceptChoice}\n${offer.declineChoice}`;
        const provider = vi.fn(() =>
          Promise.resolve(
            Response.json({
              messaging_product: "whatsapp",
              messages: [{ id: "contextual-provider" }],
            })
          )
        );
        vi.stubGlobal("fetch", provider);
        yield* executeProactivityWork({
          environment,
          userId,
          now,
          work: { kind: "proactivity-delivery", version: 1, userId, id: offer.id },
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
        const afterExpiry = DateTime.makeUnsafe(now.epochMilliseconds + 660000);
        vi.spyOn(Date, "now").mockReturnValue(afterExpiry.epochMilliseconds);
        yield* executeProactivityWork({
          environment,
          userId,
          now: afterExpiry,
          work: { kind: "proactivity-generate", version: 1, userId },
        });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT count(*) AS n FROM proactivity_reports WHERE user_id=? AND role IN ('budget-offer','reminder-offer')"
              )
              .bind(userId)
              .first()
          )
        ).toEqual({ n: 1 });
        vi.spyOn(Date, "now").mockReturnValue(now.epochMilliseconds);
        expect(
          Option.isNone(
            yield* readProactiveMessageTranscript({
              db,
              userId,
              id: offer.id,
              now: now.epochMilliseconds,
            })
          )
        ).toBe(true);
        const claim = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ correlation_token: HostedDeliveryCorrelationToken })
        )(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT correlation_token FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
              )
              .bind(userId, offer.id)
              .first()
          )
        );
        const coordinator = makeProactivityCoordinator({ environment, userId });
        const status = (): Request =>
          new Request("https://coordinator/hosted-turn/whatsapp/status", {
            method: "POST",
            body: Schema.encodeSync(Schema.fromJsonString(WhatsAppStatusAdmission))({
              userId,
              correlationToken: claim.correlation_token,
              businessPhoneNumberId: phone,
              providerMessageId: WhatsAppProviderMessageId.make("contextual-provider"),
              outcome: "delivered",
              occurredAtMs: now.epochMilliseconds,
              receivedAtMs: now.epochMilliseconds,
            }),
          });
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "CREATE TRIGGER reject_message_transcript BEFORE INSERT ON proactive_message_transcript_entries BEGIN SELECT RAISE(ABORT,'test_message_transcript_unavailable'); END"
            )
            .run()
        );
        expect((yield* Effect.tryPromise(() => coordinator.fetch(status()))).status).toBe(503);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT state FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
              )
              .bind(userId, offer.id)
              .first()
          )
        ).toEqual({ state: "accepted" });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT disclosure_message_id FROM proactivity_consent_offers WHERE user_id=? AND id=?"
              )
              .bind(userId, offer.id)
              .first()
          )
        ).toEqual({ disclosure_message_id: null });
        yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER reject_message_transcript").run());
        expect((yield* Effect.tryPromise(() => coordinator.fetch(status()))).status).toBe(200);
        expect((yield* Effect.tryPromise(() => coordinator.fetch(status()))).status).toBe(200);
        expect(
          Option.getOrThrow(
            yield* readProactiveMessageTranscript({
              db,
              userId,
              id: offer.id,
              now: now.epochMilliseconds,
            })
          ).text
        ).toBe(exact);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT count(*) AS n FROM insight_events WHERE user_id=?")
              .bind(userId)
              .first()
          )
        ).toEqual({ n: 0 });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT disclosure_message_id FROM proactivity_consent_offers WHERE user_id=? AND id=?"
              )
              .bind(userId, offer.id)
              .first()
          )
        ).toEqual({ disclosure_message_id: "contextual-provider" });
        expect(provider).toHaveBeenCalledOnce();
        const beforeForeign = yield* readProactiveMessageTranscript({
          db,
          userId,
          id: offer.id,
          now: now.epochMilliseconds,
        });
        const standingBefore = yield* findReminderGovernor({ db, userId });
        const reportBefore = yield* findProactivityReport({ db, userId, id: offer.id });
        const foreignUserId = proactivityTestUsers[1];
        const foreignCaller = proactivityTestCallers[1];
        const foreignReply = yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
          userId: foreignUserId,
          portfolioId: foreignCaller.businessPortfolioId,
          bsuid: foreignCaller.businessScopedUserId,
          businessPhoneNumberId: phone,
          messageId: "foreign-contextual-reply",
          text: "Quiero entender esta oferta",
          occurredAtMs: now.epochMilliseconds,
          receivedAtMs: now.epochMilliseconds,
          replyToMessageId: "contextual-provider",
        });
        const ownReply = {
          ...foreignReply,
          userId,
          portfolioId: caller.businessPortfolioId,
          bsuid: caller.businessScopedUserId,
        };
        for (const probe of [
          { userId: foreignUserId, proof: contextualProactiveInsightQuery(foreignReply) },
          { userId: foreignUserId, proof: contextualProactiveInsightQuery(ownReply) },
          { userId, proof: contextualProactiveInsightQuery(foreignReply) },
        ]) {
          expect(
            Option.isNone(
              yield* readContextualProactiveReply({ db, now: now.epochMilliseconds, ...probe })
            )
          ).toBe(true);
        }
        const foreignPrompt = yield* observeTestHostedContext({ db, proof: foreignReply });
        expect(foreignPrompt).not.toContain(offer.id);
        expect(foreignPrompt).not.toContain("ProactiveMessageTranscriptEntry");
        expect(
          yield* readProactiveMessageTranscript({
            db,
            userId,
            id: offer.id,
            now: now.epochMilliseconds,
          })
        ).toEqual(beforeForeign);
        expect(yield* findReminderGovernor({ db, userId })).toEqual(standingBefore);
        expect(yield* findProactivityReport({ db, userId, id: offer.id })).toEqual(reportBefore);
        const prompt = yield* observeTestHostedContext({
          db,
          proof: yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
            userId,
            portfolioId: caller.businessPortfolioId,
            bsuid: caller.businessScopedUserId,
            businessPhoneNumberId: phone,
            messageId: "hosted-offer-context",
            text: "Quiero entender esta oferta",
            occurredAtMs: now.epochMilliseconds,
            receivedAtMs: now.epochMilliseconds,
            replyToMessageId: "contextual-provider",
          }),
        });
        expect(prompt).toContain("ProactiveMessageTranscriptEntry");
        expect(prompt).toContain(offer.id);
        yield* withdrawTestProcessingConsent(db);
        expect(
          Option.isNone(
            yield* readProactiveMessageTranscript({
              db,
              userId,
              id: offer.id,
              now: now.epochMilliseconds,
            })
          )
        ).toBe(true);
      })
    )
);

it("sixteen unserviceable contextual offers cannot starve an eligible reminder during bounded Maintenance discovery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const now = DateTime.makeUnsafe("2026-10-06T23:00:00Z");
      vi.spyOn(Date, "now").mockReturnValue(now.epochMilliseconds);
      const others = Array.from({ length: 16 }, () => UserId.make(newId()));
      yield* Effect.tryPromise(() =>
        db.batch(
          others.flatMap((userId) => [
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
              )
              .bind(userId, now.epochMilliseconds),
            db
              .prepare(
                "INSERT INTO proactivity_offer_requests(id,user_id,kind,request_message_id,created_at_ms) VALUES(?,?,'manual-entry-reminder','request-offer',?)"
              )
              .bind(newId(), userId, now.epochMilliseconds),
          ])
        )
      );
      const harness = proactivityWorkflowHarness({
        environment: { DB: db, PROACTIVITY_ENABLED: "enabled" },
        userId: proactivityTestUsers[0],
        otherUserIds: others,
        unavailableUserIds: others,
      });
      yield* Effect.exit(harness.sweep());
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS n FROM insight_events WHERE user_id=? AND schedule_id=? AND kind='manual-entry-reminder'"
            )
            .bind(proactivityTestUsers[0], schedule.id)
            .first()
        )
      ).toEqual({ n: 1 });
    })
  ));

it("a crash after question acceptance cannot authorize an expiry replacement or invalidate its qualified controls", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const userId = proactivityTestUsers[0];
      const caller = proactivityTestCallers[0];
      const phone = WhatsAppBusinessPhoneNumberId.make("123456789");
      const environment = configuration(db);
      const coordinator = makeProactivityCoordinator({ environment, userId });
      yield* Effect.tryPromise(() =>
        db.batch([
          prepareInsightRecipient({
            db,
            userId,
            recipient: {
              portfolioId: caller.businessPortfolioId,
              bsuid: caller.businessScopedUserId,
              businessPhoneNumberId: phone,
            },
            receivedAtMs: DateTime.makeUnsafe("2026-10-06T23:00:00Z").epochMilliseconds,
          }),
        ])
      );
      let sent = 0;
      const provider = vi.fn(() =>
        Promise.resolve(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: `crash-${++sent}` }] })
        )
      );
      vi.stubGlobal("fetch", provider);
      const send = (id: string, now: DateTime.Utc): ReturnType<typeof executeProactivityWork> =>
        executeProactivityWork({
          environment,
          userId,
          now,
          work: { kind: "proactivity-delivery", version: 1, userId, id },
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
      const verify = (
        id: string,
        now: DateTime.Utc
      ): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
        Effect.gen(function* () {
          const claim = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ correlation_token: HostedDeliveryCorrelationToken })
          )(
            yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT correlation_token FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
                )
                .bind(userId, id)
                .first()
            )
          );
          const body = yield* Schema.encodeEffect(Schema.fromJsonString(WhatsAppStatusAdmission))({
            userId,
            correlationToken: claim.correlation_token,
            businessPhoneNumberId: phone,
            providerMessageId: WhatsAppProviderMessageId.make(`crash-${sent}`),
            outcome: "delivered",
            occurredAtMs: now.epochMilliseconds,
            receivedAtMs: now.epochMilliseconds,
          });
          expect(
            (yield* Effect.tryPromise(() =>
              coordinator.fetch(
                new Request("https://coordinator/hosted-turn/whatsapp/status", {
                  method: "POST",
                  body,
                })
              )
            )).status
          ).toBe(200);
        });
      for (const day of [6, 7, 8]) {
        const now = DateTime.makeUnsafe(`2026-10-${String(day).padStart(2, "0")}T23:00:00Z`);
        vi.spyOn(Date, "now").mockReturnValue(now.epochMilliseconds);
        const occurrence = yield* materializeReminder({ db, userId, id: schedule.id, now });
        if (occurrence._tag !== "Created") return yield* Effect.die("Expected reminder");
        yield* send(occurrence.id, now);
        yield* verify(occurrence.id, now);
      }
      const now = DateTime.makeUnsafe("2026-10-08T23:00:00Z");
      yield* executeProactivityWork({
        environment,
        userId,
        now,
        work: { kind: "proactivity-generate", version: 1, userId },
      });
      const question = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ delivery_id: Schema.String.check(Schema.isUUID()) })
      )(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT delivery_id FROM proactivity_reports WHERE user_id=? AND role='reminder-question'"
            )
            .bind(userId)
            .first()
        )
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER crash_after_question_acceptance BEFORE UPDATE ON proactivity_outbox WHEN NEW.state='started' BEGIN SELECT RAISE(ABORT,'test_crash'); END"
          )
          .run()
      );
      expect((yield* Effect.exit(send(question.delivery_id, now)))._tag).toBe("Failure");
      expect(sent).toBe(4);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT state FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
            )
            .bind(userId, question.delivery_id)
            .first()
        )
      ).toEqual({ state: "accepted" });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state FROM proactivity_outbox WHERE user_id=? AND delivery_id=?")
            .bind(userId, question.delivery_id)
            .first()
        )
      ).toEqual({ state: "ready" });
      yield* Effect.tryPromise(() =>
        db.prepare("DROP TRIGGER crash_after_question_acceptance").run()
      );
      const later = DateTime.makeUnsafe("2026-10-10T14:00:00Z");
      vi.spyOn(Date, "now").mockReturnValue(later.epochMilliseconds);
      yield* expireDeliveryWork({ db, now: later.epochMilliseconds });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state FROM proactivity_outbox WHERE user_id=? AND delivery_id=?")
            .bind(userId, question.delivery_id)
            .first()
        )
      ).toEqual({ state: "started" });
      const published: Array<ProactivityDeliveryWork> = [];
      const unexpected = (): Promise<never> =>
        Promise.reject(new Error("No Workflow creation expected during Maintenance"));
      const harness = proactivityWorkflowHarness({
        environment: {
          ...environment,
          WEEKLY_DELIVERY_QUEUE: {
            send: (message: ProactivityDeliveryWork): Promise<QueueSendResponse> => {
              published.push(message);
              return Promise.resolve({
                metadata: { metrics: { backlogCount: published.length, backlogBytes: 0 } },
              });
            },
          },
          WEEKLY_DELIVERY_WORKFLOW: {
            create: unexpected,
            get: unexpected,
            createBatch: unexpected,
            deleteBatch: unexpected,
          },
        },
        userId,
        otherUserIds: [],
        unavailableUserIds: [],
      });
      for (const attempt of [0, 1, 2, 3]) {
        vi.spyOn(Date, "now").mockReturnValue(later.epochMilliseconds + attempt * 60000);
        yield* harness.sweep();
      }
      expect(
        published.some(
          (work) => work.kind === "proactivity-delivery" && work.id === question.delivery_id
        )
      ).toBe(false);
      vi.spyOn(Date, "now").mockReturnValue(later.epochMilliseconds);
      expect(
        yield* recoverDeliveryWork({
          db,
          userId,
          now: later.epochMilliseconds,
          work: { kind: "proactivity-delivery", version: 1, userId, id: question.delivery_id },
        })
      ).toBe(true);
      yield* executeProactivityWork({
        environment,
        userId,
        now: later,
        work: { kind: "proactivity-generate", version: 1, userId },
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS n FROM proactivity_reports WHERE user_id=? AND role='reminder-question'"
            )
            .bind(userId)
            .first()
        )
      ).toEqual({ n: 1 });
      yield* send(question.delivery_id, later);
      expect(sent).toBe(4);
      yield* verify(question.delivery_id, later);
      expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))).toEqual({
        _tag: "QuestionDelivered",
        unanswered: 3,
      });
      const proof = yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
        userId,
        portfolioId: caller.businessPortfolioId,
        bsuid: caller.businessScopedUserId,
        businessPhoneNumberId: phone,
        messageId: "stop-crashed-question",
        occurredAtMs: later.epochMilliseconds,
        receivedAtMs: later.epochMilliseconds,
        text: `reminder:${question.delivery_id}:stop`,
      });
      expect(yield* controlManualReminders({ db, proof, now: later.epochMilliseconds })).toBe(true);
      expect(Option.getOrThrow(yield* findReminderSchedule({ db, userId })).enabled).toBe(false);
    })
  ));

it.each(["paused", "stopped"] as const)(
  "verified reminder attention can reactivate from %s without revoking its live grant",
  (reactivationState) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        const schedule = yield* activateTestReminder(db);
        const userId = proactivityTestUsers[0];
        const caller = proactivityTestCallers[0];
        yield* Effect.tryPromise(() =>
          db.batch([
            prepareInsightRecipient({
              db,
              userId,
              recipient: {
                portfolioId: caller.businessPortfolioId,
                bsuid: caller.businessScopedUserId,
                businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
              },
              receivedAtMs: DateTime.makeUnsafe("2026-10-06T23:00:00Z").epochMilliseconds,
            }),
          ])
        );
        const environment = configuration(db);
        let sent = 0;
        vi.stubGlobal(
          "fetch",
          vi.fn(() =>
            Promise.resolve(
              Response.json({
                messaging_product: "whatsapp",
                messages: [{ id: `attention-${++sent}` }],
              })
            )
          )
        );
        const coordinator = makeProactivityCoordinator({ environment, userId });
        const deliver = (
          id: string,
          now: DateTime.Utc,
          outcome: "delivered" | "failed" = "delivered"
        ): Effect.Effect<void, InsightUnavailable | Schema.SchemaError | Cause.UnknownError> =>
          Effect.gen(function* () {
            yield* executeProactivityWork({
              environment,
              userId,
              now,
              work: { kind: "proactivity-delivery", version: 1, userId, id },
            }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
            const raw = yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT correlation_token FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
                )
                .bind(userId, id)
                .first()
            );
            const claim = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ correlation_token: HostedDeliveryCorrelationToken })
            )(raw);
            if (outcome === "failed") {
              yield* executeProactivityWork({
                environment,
                userId,
                now,
                work: { kind: "proactivity-generate", version: 1, userId },
              });
              expect(
                yield* Effect.tryPromise(() =>
                  db
                    .prepare(
                      "SELECT count(*) AS n FROM proactivity_reports WHERE user_id=? AND role='reminder-question'"
                    )
                    .bind(userId)
                    .first()
                )
              ).toEqual({ n: 1 });
            }
            const status = yield* Schema.encodeEffect(
              Schema.fromJsonString(WhatsAppStatusAdmission)
            )({
              userId,
              correlationToken: claim.correlation_token,
              businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
              providerMessageId: WhatsAppProviderMessageId.make(`attention-${sent}`),
              outcome,
              occurredAtMs: now.epochMilliseconds,
              receivedAtMs: now.epochMilliseconds,
            });
            expect(
              (yield* Effect.tryPromise(() =>
                coordinator.fetch(
                  new Request("https://coordinator/hosted-turn/whatsapp/status", {
                    method: "POST",
                    body: status,
                  })
                )
              )).status,
              `verified message ${sent}`
            ).toBe(200);
          });
        for (const day of [6, 7, 8, 9, 10, 11]) {
          const now = DateTime.makeUnsafe(`2026-10-${String(day).padStart(2, "0")}T23:00:00Z`);
          vi.spyOn(Date, "now").mockReturnValue(now.epochMilliseconds);
          const occurrence = yield* materializeReminder({ db, userId, id: schedule.id, now });
          if (occurrence._tag !== "Created") return yield* Effect.die("Expected latest reminder");
          yield* deliver(occurrence.id, now);
          if (day === 8 || day === 9) {
            expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))).toEqual({
              _tag: "QuestionPending",
              unanswered: 3,
            });
            if (day === 8) continue;
            yield* executeProactivityWork({
              environment,
              userId,
              now,
              work: { kind: "proactivity-generate", version: 1, userId },
            });
            const raw = yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT delivery_id FROM proactivity_reports WHERE user_id=? AND role='reminder-question'"
                )
                .bind(userId)
                .first()
            );
            const question = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ delivery_id: Schema.String.check(Schema.isUUID()) })
            )(raw);
            const rejectedControl = yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
              userId,
              portfolioId: proactivityTestCallers[0].businessPortfolioId,
              bsuid: proactivityTestCallers[0].businessScopedUserId,
              businessPhoneNumberId: "123456789",
              messageId: "control-before-delivery",
              occurredAtMs: now.epochMilliseconds,
              receivedAtMs: now.epochMilliseconds,
              text: `reminder:${question.delivery_id}:stop`,
            });
            expect(
              yield* controlManualReminders({
                db,
                proof: rejectedControl,
                now: now.epochMilliseconds,
              })
            ).toBe(false);
            const rejectedBody = yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.toCodecJson(WhatsAppTurnAdmission))
            )(rejectedControl);
            expect(
              (yield* Effect.tryPromise(() =>
                coordinator.fetch(
                  new Request("https://coordinator/hosted-turn/whatsapp", {
                    method: "POST",
                    body: rejectedBody,
                  })
                )
              )).status
            ).toBe(422);
            yield* deliver(question.delivery_id, now, "failed");
            expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))).toEqual({
              _tag: "QuestionPending",
              unanswered: 3,
            });
            yield* executeProactivityWork({
              environment,
              userId,
              now,
              work: { kind: "proactivity-generate", version: 1, userId },
            });
            const replacementRaw = yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT delivery_id FROM proactivity_reports WHERE user_id=? AND role='reminder-question' AND delivery_id<>?"
                )
                .bind(userId, question.delivery_id)
                .first()
            );
            const replacement = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ delivery_id: Schema.String.check(Schema.isUUID()) })
            )(replacementRaw);
            yield* deliver(replacement.delivery_id, now);
            const rawControl = yield* Schema.encodeEffect(WhatsAppTurnAdmission)(rejectedControl);
            for (const [index, altered] of [
              { ...rawControl, text: `reminder:${question.delivery_id}:stop` },
              { ...rawControl, text: `reminder:${newId()}:continue` },
              {
                ...rawControl,
                text: `reminder:${replacement.delivery_id}:stop`,
                userId: proactivityTestUsers[1],
                portfolioId: proactivityTestCallers[1].businessPortfolioId,
                bsuid: proactivityTestCallers[1].businessScopedUserId,
              },
              {
                ...rawControl,
                text: `reminder:${replacement.delivery_id}:continue`,
                businessPhoneNumberId: "987654321",
              },
              {
                ...rawControl,
                text: `reminder:${replacement.delivery_id}:stop`,
                occurredAtMs: now.epochMilliseconds - 2000,
              },
            ].entries()) {
              const proof = yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
                ...altered,
                messageId: `refused-control-${index}`,
              });
              const beforeSend = sent;
              expect(yield* controlManualReminders({ db, proof, now: now.epochMilliseconds })).toBe(
                false
              );
              const body = yield* Schema.encodeEffect(
                Schema.fromJsonString(Schema.toCodecJson(WhatsAppTurnAdmission))
              )(proof);
              expect(
                (yield* Effect.tryPromise(() =>
                  coordinator.fetch(
                    new Request("https://coordinator/hosted-turn/whatsapp", {
                      method: "POST",
                      body,
                    })
                  )
                )).status
              ).toBe(proof.userId === userId ? 422 : 503);
              expect(sent).toBe(beforeSend);
              expect(
                yield* Effect.tryPromise(() =>
                  db
                    .prepare("SELECT count(*) AS n FROM reminder_control_receipts WHERE user_id=?")
                    .bind(userId)
                    .first()
                )
              ).toEqual({ n: 0 });
              expect(
                yield* Effect.tryPromise(() =>
                  db
                    .prepare(
                      "SELECT count(*) AS n FROM proactivity_consent_records WHERE user_id=?"
                    )
                    .bind(userId)
                    .first()
                )
              ).toEqual({ n: 1 });
              expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))).toEqual({
                _tag: "QuestionDelivered",
                unanswered: 3,
              });
              expect(Option.getOrThrow(yield* findReminderSchedule({ db, userId })).enabled).toBe(
                true
              );
            }
            const ordinaryReply = yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
              ...rawControl,
              text: "¿Cómo cambio la hora?",
              messageId: "ordinary-question-reply",
              replyToMessageId: `attention-${sent}`,
            });
            const contextual = yield* readContextualProactiveReply({
              db,
              userId,
              now: now.epochMilliseconds,
              proof: contextualProactiveInsightQuery(ordinaryReply),
            });
            const contextualEntry = Option.getOrThrow(contextual).entry;
            expect(contextualEntry).toMatchObject({
              _tag: "ProactiveMessageTranscriptEntry",
              deliveryId: replacement.delivery_id,
              role: "reminder-question",
            });
            expect(
              Option.isNone(
                yield* readProactiveMessageTranscript({
                  db,
                  userId: proactivityTestUsers[1],
                  id: replacement.delivery_id,
                  now: now.epochMilliseconds,
                })
              )
            ).toBe(true);
            expect(
              Option.isNone(
                yield* readProactiveMessageTranscript({
                  db,
                  userId,
                  id: replacement.delivery_id,
                  now: now.epochMilliseconds + 2592000000,
                })
              )
            ).toBe(true);
            expect(
              yield* Effect.tryPromise(() =>
                db
                  .prepare(
                    "SELECT text FROM proactive_message_transcript_entries WHERE user_id=? AND delivery_id=?"
                  )
                  .bind(userId, replacement.delivery_id)
                  .first()
              )
            ).toEqual({
              text: `Fidy: Has recibido tres recordatorios sin responder. ¿Quieres continuar?\nreminder:${replacement.delivery_id}:continue\nreminder:${replacement.delivery_id}:stop`,
            });
            expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))).toEqual({
              _tag: "QuestionDelivered",
              unanswered: 3,
            });
          }
        }
        expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))._tag).toBe("Paused");
        const afterTime = DateTime.makeUnsafe("2026-10-12T23:00:00Z");
        vi.spyOn(Date, "now").mockReturnValue(afterTime.epochMilliseconds);
        const after = yield* materializeReminder({
          db,
          userId,
          id: schedule.id,
          now: afterTime,
        });
        expect(after._tag).toBe("NoWork");
        const raw = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT question_id FROM reminder_governors WHERE user_id=?")
            .bind(userId)
            .first()
        );
        const question = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ question_id: Schema.String.check(Schema.isUUID()) })
        )(raw);
        const proof = yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
          userId,
          portfolioId: caller.businessPortfolioId,
          bsuid: caller.businessScopedUserId,
          businessPhoneNumberId: "123456789",
          messageId: "stop-reminders",
          occurredAtMs: afterTime.epochMilliseconds,
          receivedAtMs: afterTime.epochMilliseconds,
          text: `reminder:${question.question_id}:stop`,
        });
        const reactivate = (): Effect.Effect<
          void,
          Cause.UnknownError | Schema.SchemaError | InsightUnavailable | ConsentUnavailable
        > =>
          Effect.gen(function* () {
            if (reactivationState === "stopped") {
              expect(
                yield* controlManualReminders({ db, proof, now: afterTime.epochMilliseconds })
              ).toBe(true);
              expect(
                yield* controlManualReminders({ db, proof, now: afterTime.epochMilliseconds })
              ).toBe(true);
              expect(Option.getOrThrow(yield* findReminderSchedule({ db, userId })).enabled).toBe(
                false
              );
            }
            const context = {
              db,
              userId,
              caller,
              kind: "manual-entry-reminder" as const,
              now: afterTime,
            };
            const grantBefore = Option.getOrThrow(yield* findProactivityConsentGrant(context));
            yield* requestProactivityConsent({
              ...context,
              messageId: "reactivate-operational-reminders",
            });
            yield* executeProactivityWork({
              environment,
              userId,
              now: afterTime,
              work: { kind: "proactivity-generate", version: 1, userId },
            });
            const offer = Option.getOrThrow(yield* findCurrentProactivityOffer(context));
            const report = Option.getOrThrow(
              yield* findProactivityReport({ db, userId, id: offer.id })
            );
            expect(Option.getOrThrow(report.text)).toContain(offer.acceptChoice);
            expect(Option.getOrThrow(report.text)).toContain(offer.revokeChoice);
            yield* deliver(offer.id, afterTime);
            const choice = {
              ...context,
              choice: offer.acceptChoice,
              decisionMessageId: "continue-operational-reminders",
            };
            expect(yield* recordProactivityDecision(choice)).toBe(true);
            expect(Option.getOrThrow(yield* findProactivityConsentGrant(context)).id).toBe(
              grantBefore.id
            );
            expect(
              yield* Effect.tryPromise(() =>
                db
                  .prepare("SELECT count(*) AS n FROM proactivity_consent_records WHERE user_id=?")
                  .bind(userId)
                  .first()
              )
            ).toEqual({ n: 1 });
            expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))).toEqual({
              _tag: "Attentive",
              unanswered: 0,
            });
            expect(Option.getOrThrow(yield* findReminderSchedule({ db, userId })).enabled).toBe(
              true
            );
            const resumedAt = DateTime.makeUnsafe("2026-10-13T23:00:00Z");
            vi.spyOn(Date, "now").mockReturnValue(resumedAt.epochMilliseconds);
            expect(
              (yield* materializeReminder({ db, userId, id: schedule.id, now: resumedAt }))._tag
            ).toBe("Created");
          });
        yield* reactivate();
      })
    )
);
