import { afterAll, afterEach, expect, it, vi } from "vitest";
import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import {
  activateTestReminder,
  proactivityDatabase,
  proactivityTestCallers,
  proactivityTestDatabases,
  proactivityTestUsers,
  withdrawTestProcessingConsent,
} from "../proactivity.test-fixture";
import { makeWeeklySummaryCoordinator } from "../weekly-summary.test-fixture";
import {
  controlManualReminders,
  findInsight,
  findReminderGovernor,
  findReminderSchedule,
  materializeReminder,
  prepareReminderRevision,
} from "./operations";
import { prepareInsightRecipient } from "../whatsapp/operations";
import {
  HostedDeliveryCorrelationToken,
  ProactivityTemplateConfiguration,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { type InsightUnavailable, WeeklyActivity, type WeeklyEnvironment } from "./contract";
import { WhatsAppStatusAdmission, WhatsAppTurnAdmission } from "../whatsapp/contract";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { FetchHttpClient } from "effect/http";
import { executeWeeklyWork } from "./runtime";
import { readProactiveTranscript } from "../agent/operations";

const configuration = (db: D1Database): WeeklyEnvironment => ({
  DB: db,
  PROACTIVITY_ENABLED: "enabled",
  KAPSO_API_KEY: "test-only",
  PROACTIVITY_TEMPLATE_JSON: Schema.encodeSync(
    Schema.fromJsonString(ProactivityTemplateConfiguration)
  )({ name: "fidy_proactivity", language: "es", approval: "approved", body: "Fidy: {{1}}" }),
});
const workRequest = (work: WeeklyActivity): Request =>
  new Request("https://coordinator/weekly-work", {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(WeeklyActivity))(work),
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
      const coordinator = makeWeeklySummaryCoordinator({
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
      const coordinator = makeWeeklySummaryCoordinator({
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
      const first = makeWeeklySummaryCoordinator({
        environment: configuration(db),
        userId: proactivityTestUsers[0],
      });
      const work: WeeklyActivity = {
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
      const changed = makeWeeklySummaryCoordinator({
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
  environment: Partial<WeeklyEnvironment>;
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
        const coordinator = makeWeeklySummaryCoordinator({
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

it("three verified ignored reminders ask once; only the verified question opens the two-additional pause counter", () =>
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
      const coordinator = makeWeeklySummaryCoordinator({ environment, userId });
      const deliver = (
        id: string,
        now: DateTime.Utc
      ): Effect.Effect<void, InsightUnavailable | Schema.SchemaError | Cause.UnknownError> =>
        Effect.gen(function* () {
          yield* executeWeeklyWork({
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
          const status = yield* Schema.encodeEffect(Schema.fromJsonString(WhatsAppStatusAdmission))(
            {
              userId,
              correlationToken: claim.correlation_token,
              businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
              providerMessageId: WhatsAppProviderMessageId.make(`attention-${sent}`),
              outcome: "delivered",
              occurredAtMs: now.epochMilliseconds,
              receivedAtMs: now.epochMilliseconds,
            }
          );
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
      for (const day of [6, 7, 8, 9, 10]) {
        const now = DateTime.makeUnsafe(`2026-10-${String(day).padStart(2, "0")}T23:00:00Z`);
        vi.spyOn(Date, "now").mockReturnValue(now.epochMilliseconds);
        const occurrence = yield* materializeReminder({ db, userId, id: schedule.id, now });
        if (occurrence._tag !== "Created") return yield* Effect.die("Expected latest reminder");
        yield* deliver(occurrence.id, now);
        if (day === 8) {
          expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))).toEqual({
            _tag: "QuestionPending",
            unanswered: 3,
          });
          yield* executeWeeklyWork({
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
          yield* deliver(question.delivery_id, now);
          expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))).toEqual({
            _tag: "QuestionDelivered",
            unanswered: 3,
          });
        }
      }
      expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))._tag).toBe("Paused");
      const afterTime = DateTime.makeUnsafe("2026-10-11T23:00:00Z");
      const after = yield* materializeReminder({
        db,
        userId,
        id: schedule.id,
        now: DateTime.makeUnsafe("2026-10-11T23:00:00Z"),
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
      expect(yield* controlManualReminders({ db, proof, now: afterTime.epochMilliseconds })).toBe(
        true
      );
      expect(yield* controlManualReminders({ db, proof, now: afterTime.epochMilliseconds })).toBe(
        true
      );
      expect(Option.getOrThrow(yield* findReminderSchedule({ db, userId })).enabled).toBe(false);
    })
  ));
