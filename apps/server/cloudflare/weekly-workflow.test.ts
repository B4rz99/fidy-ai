import { type WorkflowStep } from "cloudflare:workers";
import { DateTime, Effect, Option, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  type ProactivityDeliveryWork,
  type ProactivityEnvironment,
  type WeeklyScheduleSnapshot,
} from "./insights/contract";
import { UserId, WhatsAppCallerReference } from "../src/core/identity/contract";
import { materializeWeeklySummary } from "./insights/operations";
import {
  activateWeeklySummary,
  activateWeeklySummaryForUser,
  makeExecutingWeeklyFixtureStep,
  proactivityWorkflowHarness,
  seedWeeklySummaryActivity,
  weeklySummaryDatabaseAt,
  weeklySummaryOtherUser,
  weeklySummaryTestCaller,
  weeklySummaryTestDatabases,
  weeklySummaryTestNow,
  weeklySummaryTestUser,
  withdrawWeeklyFixtureConsent,
} from "./weekly-summary.test-fixture";

const userId = weeklySummaryTestUser;
const promise = <Value>(run: () => Promise<Value>): Effect.Effect<Value> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const unexpected = (): Promise<never> =>
  Promise.reject(new Error("Unexpected infrastructure authority"));
const workflowInstance: WorkflowInstance = {
  id: "fixture",
  pause: unexpected,
  resume: unexpected,
  terminate: unexpected,
  restart: unexpected,
  delete: unexpected,
  sendEvent: unexpected,
  subscribe: unexpected,
  status: (): ReturnType<WorkflowInstance["status"]> => Promise.resolve({ status: "running" }),
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const configuration = (DB: D1Database): ProactivityEnvironment => ({
  DB,
  WEEKLY_SUMMARY_ENABLED: "enabled",
  KAPSO_API_KEY: "test",
  WEEKLY_SUMMARY_TEMPLATE_JSON: encode({
    name: "fidy_weekly_summary",
    language: "es",
    approval: "approved",
    body: "Tu resumen semanal: {{1}} Consulta tus movimientos en Fidy.",
  }),
  WEEKLY_QUESTION_TEMPLATE_JSON: encode({
    name: "fidy_weekly_question",
    language: "es",
    approval: "approved",
    body: "Fidy: {{1}}",
  }),
  PROACTIVITY_ASK_AFTER: "4",
  PROACTIVITY_PAUSE_AFTER: "2",
});
const questionId = "90000000-0000-4000-8000-000000000001";
const otherCaller = Schema.decodeSync(WhatsAppCallerReference)({
  businessPortfolioId: "portfolio",
  businessScopedUserId: "CO.other",
});
const seedOtherSchedule = (db: D1Database): Effect.Effect<WeeklyScheduleSnapshot> =>
  Effect.gen(function* () {
    yield* promise(() =>
      db
        .prepare(
          "INSERT INTO whatsapp_identities(user_id,portfolio_id,bsuid,verified_at_ms) VALUES (?,?,?,?)"
        )
        .bind(
          weeklySummaryOtherUser,
          otherCaller.businessPortfolioId,
          otherCaller.businessScopedUserId,
          weeklySummaryTestNow.epochMilliseconds
        )
        .run()
    );
    return yield* activateWeeklySummaryForUser({
      db,
      now: weeklySummaryTestNow,
      userId: weeklySummaryOtherUser,
      caller: otherCaller,
    });
  });
const workflowBinding: Workflow<ProactivityDeliveryWork> = {
  create: unexpected,
  get: unexpected,
  createBatch: unexpected,
  deleteBatch: unexpected,
};
const snapshot = (db: D1Database): Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>> =>
  Effect.forEach(
    [
      "weekly_summary_outbox",
      "weekly_question_intents",
      "weekly_governor_questions",
      "insight_whatsapp_claims",
      "weekly_consent_offers",
      "weekly_consent_revocation_records",
      "weekly_governors",
      "proactive_transcript_entries",
      "insight_events",
    ],
    (table) =>
      promise(() => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).pipe(
        Effect.map((result) => result.results)
      )
  );
const seedQuestion = (
  input: Readonly<{ db: D1Database; created: number; expires: number }>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* promise(() =>
      input.db
        .prepare(
          "INSERT INTO weekly_question_intents(id,user_id,origin,created_at_ms) VALUES (?,?,'requested',?)"
        )
        .bind(questionId, userId, input.created)
        .run()
    );
    yield* promise(() =>
      input.db
        .prepare(
          "INSERT INTO weekly_governor_questions(id,user_id,offer_id,created_at_ms,expires_at_ms,correlation_token,portfolio_id,bsuid,business_phone_number_id,text,time_zone) SELECT ?,user_id,id,?,?,'question-correlation','portfolio','CO.abcdef','phone','retained question disclosure','America/Bogota' FROM weekly_consent_offers WHERE user_id=? LIMIT 1"
        )
        .bind(questionId, input.created, input.expires, userId)
        .run()
    );
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => weeklySummaryTestDatabases.dispose());
it("Maintenance publishes identity-only work and Queue acknowledgment follows durable Workflow handoff", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      const schedule = yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
      yield* seedWeeklySummaryActivity({ db, at: "2026-08-04T12:00:00.000Z" });
      vi.spyOn(Date, "now").mockReturnValue(schedule.nextScheduledAt.epochMilliseconds);
      const work: Array<ProactivityDeliveryWork> = [];
      const create = vi
        .fn<Workflow<ProactivityDeliveryWork>["create"]>()
        .mockResolvedValue(workflowInstance);
      const get = vi
        .fn<Workflow<ProactivityDeliveryWork>["get"]>()
        .mockRejectedValue(new Error("No durable instance"));
      const binding: Workflow<ProactivityDeliveryWork> = {
        create,
        get,
        createBatch: unexpected,
        deleteBatch: unexpected,
      };
      const send = (message: ProactivityDeliveryWork): Promise<QueueSendResponse> => {
        work.push(message);
        return Promise.resolve({
          metadata: { metrics: { backlogCount: work.length, backlogBytes: 0 } },
        });
      };
      const environment = {
        DB: db,
        WEEKLY_SUMMARY_ENABLED: "enabled",
        KAPSO_API_KEY: "test",
        WEEKLY_SUMMARY_TEMPLATE_JSON: encode({
          name: "fidy_weekly_summary",
          language: "es",
          approval: "approved",
          body: "Tu resumen semanal: {{1}} Consulta tus movimientos en Fidy.",
        }),
        WEEKLY_QUESTION_TEMPLATE_JSON: encode({
          name: "fidy_weekly_question",
          language: "es",
          approval: "approved",
          body: "Fidy: {{1}}",
        }),
        PROACTIVITY_ASK_AFTER: "4",
        PROACTIVITY_PAUSE_AFTER: "2",
        WEEKLY_DELIVERY_QUEUE: { send },
        WEEKLY_DELIVERY_WORKFLOW: binding,
      };
      const harness = proactivityWorkflowHarness({
        environment,
        userId,
        otherUserIds: [],
        unavailableUserIds: [],
      });
      yield* harness.sweep();
      expect(work).toHaveLength(1);
      const hint = work[0];
      if (hint?.kind !== "weekly-summary") {
        return yield* Effect.die("Expected summary hint");
      }
      expect(Object.keys(hint).sort()).toEqual(["insightEventId", "kind", "userId", "version"]);
      const message = {
        body: { ...hint, text: "untrusted extra content", recipient: "untrusted route" },
        ack: vi.fn(),
        retry: vi.fn(),
      };
      yield* harness.receive({ messages: [message], workflow: Option.some(binding) });
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith({
        id: `weekly-${userId}-weekly-summary-${hint.insightEventId}`,
        params: hint,
      });
      create.mockRejectedValue(new Error("Workflow unavailable"));
      message.ack.mockClear();
      yield* harness.receive({ messages: [message], workflow: Option.some(binding) });
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
      get.mockResolvedValueOnce(workflowInstance);
      yield* harness.receive({ messages: [message], workflow: Option.some(binding) });
      expect(message.ack).toHaveBeenCalledOnce();
    })
  ));

it("native Workflow persists only eligibility results and stops after four deferred wakeups", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      const harness = proactivityWorkflowHarness({
        environment: { DB: db },
        userId,
        otherUserIds: [],
        unavailableUserIds: [],
      });
      const instant = DateTime.toEpochMillis(weeklySummaryTestNow);
      const deferred = { _tag: "Deferred", nextEligibleAtMs: instant };
      const sleepUntil = vi.fn<WorkflowStep["sleepUntil"]>().mockResolvedValue(undefined);
      const step: WorkflowStep = {
        do: unexpected,
        sleepUntil,
        sleep: unexpected,
        waitForEvent: unexpected,
      };
      const execute = vi.spyOn(step, "do").mockResolvedValue(deferred);
      const work: ProactivityDeliveryWork = {
        kind: "weekly-question",
        version: 1,
        userId,
        id: "90000000-0000-4000-8000-000000000001",
      };
      const result = yield* Effect.exit(promise(() => harness.execute({ work, step })));
      expect(result._tag).toBe("Failure");
      expect(execute.mock.calls.map(([name]) => name)).toEqual([
        "weekly-delivery-0",
        "weekly-delivery-1",
        "weekly-delivery-2",
        "weekly-delivery-3",
      ]);
      expect(sleepUntil.mock.calls.map(([, at]) => at)).toEqual([
        instant,
        instant,
        instant,
        instant,
      ]);
      execute.mockClear();
      sleepUntil.mockClear();
      execute.mockResolvedValueOnce(deferred).mockResolvedValueOnce({ _tag: "Done" });
      yield* promise(() => harness.execute({ work, step }));
      expect(execute).toHaveBeenCalledTimes(2);
      expect(sleepUntil).toHaveBeenCalledOnce();
    })
  ));

it.each(["weekly-summary", "weekly-question"] as const)(
  "Queue-to-Workflow rejects a foreign %s identity without partial effects",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
        const schedule = yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
        yield* seedOtherSchedule(db);
        yield* seedWeeklySummaryActivity({ db, at: "2026-08-04T12:00:00.000Z" });
        vi.spyOn(Date, "now").mockReturnValue(schedule.nextScheduledAt.epochMilliseconds);
        const generated = yield* materializeWeeklySummary({
          db,
          userId,
          id: schedule.id,
          now: schedule.nextScheduledAt,
        });
        if (generated._tag !== "Created") return yield* Effect.die("Expected generated summary");
        const now = schedule.nextScheduledAt.epochMilliseconds;
        yield* seedQuestion({
          db,
          created: now,
          expires: DateTime.add(schedule.nextScheduledAt, { days: 1 }).epochMilliseconds,
        });
        const before = yield* snapshot(db);
        const provider = vi
          .fn<typeof globalThis.fetch>()
          .mockRejectedValue(new Error("Forbidden provider IO"));
        vi.stubGlobal("fetch", provider);
        const create = vi
          .fn<Workflow<ProactivityDeliveryWork>["create"]>()
          .mockResolvedValue(workflowInstance);
        const binding: Workflow<ProactivityDeliveryWork> = {
          create,
          get: unexpected,
          createBatch: unexpected,
          deleteBatch: unexpected,
        };
        const harness = proactivityWorkflowHarness({
          environment: configuration(db),
          userId,
          otherUserIds: [weeklySummaryOtherUser],
          unavailableUserIds: [],
        });
        const work: ProactivityDeliveryWork =
          kind === "weekly-summary"
            ? {
                kind,
                version: 1,
                userId: weeklySummaryOtherUser,
                insightEventId: generated.id,
              }
            : { kind, version: 1, userId: weeklySummaryOtherUser, id: questionId };
        const message = { body: work, ack: vi.fn(), retry: vi.fn() };
        yield* harness.receive({ messages: [message], workflow: Option.some(binding) });
        expect(message.ack).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledWith({
          id: `weekly-${work.userId}-${kind}-${kind === "weekly-summary" ? generated.id : questionId}`,
          params: work,
        });
        const step: WorkflowStep = {
          do: makeExecutingWeeklyFixtureStep(),
          sleep: unexpected,
          sleepUntil: unexpected,
          waitForEvent: unexpected,
        };
        yield* Effect.exit(Effect.tryPromise(() => harness.execute({ work, step })));
        expect(provider).not.toHaveBeenCalled();
        expect(yield* snapshot(db)).toEqual(before);
      })
    )
);

it.each(["retention", "generation"])(
  "a failed %s activity does not skip question retention or another User's publication",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
        const schedule = yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
        yield* seedOtherSchedule(db);
        yield* seedWeeklySummaryActivity({ db, at: "2026-08-04T12:00:00.000Z" });
        const now = schedule.nextScheduledAt.epochMilliseconds;
        vi.spyOn(Date, "now").mockReturnValue(now);
        yield* materializeWeeklySummary({
          db,
          userId,
          id: schedule.id,
          now: schedule.nextScheduledAt,
        });
        yield* promise(() =>
          db
            .prepare(
              "UPDATE weekly_schedules SET next_scheduled_at=?,last_evaluated_at_ms=0 WHERE user_id=?"
            )
            .bind(DateTime.formatIso(schedule.nextScheduledAt), weeklySummaryOtherUser)
            .run()
        );
        yield* seedQuestion({
          db,
          created: DateTime.subtract(schedule.nextScheduledAt, { days: 2 }).epochMilliseconds,
          expires: DateTime.subtract(schedule.nextScheduledAt, { days: 1 }).epochMilliseconds,
        });
        if (failure === "retention") {
          yield* promise(() => db.prepare("DROP TABLE insight_whatsapp_claims").run());
        }
        const work: Array<ProactivityDeliveryWork> = [];
        const send = (message: ProactivityDeliveryWork): Promise<QueueSendResponse> => {
          work.push(message);
          return Promise.resolve({
            metadata: { metrics: { backlogCount: work.length, backlogBytes: 0 } },
          });
        };
        const harness = proactivityWorkflowHarness({
          environment: {
            ...configuration(db),
            WEEKLY_DELIVERY_QUEUE: { send },
            WEEKLY_DELIVERY_WORKFLOW: workflowBinding,
          },
          userId,
          otherUserIds: [weeklySummaryOtherUser],
          unavailableUserIds: failure === "generation" ? [weeklySummaryOtherUser] : [],
        });
        expect((yield* Effect.exit(harness.sweep()))._tag).toBe("Failure");
        expect(work.some((item) => item.userId === userId && item.kind === "weekly-summary")).toBe(
          true
        );
        expect(
          yield* promise(() =>
            db
              .prepare("SELECT text FROM weekly_governor_questions WHERE id=?")
              .bind(questionId)
              .first("text")
          )
        ).toBeNull();
      })
    )
);

it.each(["errored", "terminated", "complete"] as const)(
  "redelivery recovers an exhausted %s Workflow only after a durable restart",
  (status) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
        const harness = proactivityWorkflowHarness({
          environment: { DB: db },
          userId,
          otherUserIds: [],
          unavailableUserIds: [],
        });
        yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
        vi.spyOn(Date, "now").mockReturnValue(weeklySummaryTestNow.epochMilliseconds);
        yield* seedQuestion({
          db,
          created: weeklySummaryTestNow.epochMilliseconds,
          expires: DateTime.add(weeklySummaryTestNow, { days: 1 }).epochMilliseconds,
        });
        const restart = vi
          .fn<WorkflowInstance["restart"]>()
          .mockRejectedValueOnce(new Error("Restart unavailable"))
          .mockResolvedValue(undefined);
        const instance: WorkflowInstance = {
          id: "fixture",
          pause: unexpected,
          resume: unexpected,
          terminate: unexpected,
          delete: unexpected,
          sendEvent: unexpected,
          subscribe: unexpected,
          restart,
          status: () => Promise.resolve({ status }),
        };
        const binding: Workflow<ProactivityDeliveryWork> = {
          createBatch: unexpected,
          deleteBatch: unexpected,
          create: () => Promise.reject(new Error("Existing Workflow")),
          get: () => Promise.resolve(instance),
        };
        const work: ProactivityDeliveryWork = {
          kind: "weekly-question",
          version: 1,
          userId,
          id: questionId,
        };
        const message = { body: work, ack: vi.fn(), retry: vi.fn() };
        yield* harness.receive({ messages: [message], workflow: Option.some(binding) });
        expect(message.ack).not.toHaveBeenCalled();
        expect(message.retry).toHaveBeenCalledOnce();
        yield* harness.receive({ messages: [message], workflow: Option.some(binding) });
        expect(restart).toHaveBeenCalledTimes(2);
        expect(message.ack).toHaveBeenCalledOnce();
      })
    )
);

it("cumulative Workflow restarts terminalize ready work and stop future Maintenance publication", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
      vi.spyOn(Date, "now").mockReturnValue(weeklySummaryTestNow.epochMilliseconds);
      yield* seedQuestion({
        db,
        created: weeklySummaryTestNow.epochMilliseconds,
        expires: DateTime.add(weeklySummaryTestNow, { days: 1 }).epochMilliseconds,
      });
      const restart = vi.fn<WorkflowInstance["restart"]>().mockResolvedValue(undefined);
      const instance: WorkflowInstance = {
        id: "fixture",
        pause: unexpected,
        resume: unexpected,
        terminate: unexpected,
        delete: unexpected,
        sendEvent: unexpected,
        subscribe: unexpected,
        restart,
        status: () => Promise.resolve({ status: "errored" }),
      };
      const binding: Workflow<ProactivityDeliveryWork> = {
        create: unexpected,
        get: () => Promise.resolve(instance),
        createBatch: unexpected,
        deleteBatch: unexpected,
      };
      const send = vi
        .fn<Queue<ProactivityDeliveryWork>["send"]>()
        .mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
      const harness = proactivityWorkflowHarness({
        environment: {
          ...configuration(db),
          WEEKLY_DELIVERY_QUEUE: { send },
          WEEKLY_DELIVERY_WORKFLOW: binding,
        },
        userId,
        otherUserIds: [],
        unavailableUserIds: [],
      });
      const message = {
        body: { kind: "weekly-question", version: 1, userId, id: questionId },
        ack: vi.fn(),
        retry: vi.fn(),
      };
      const repeatedHints = 5;
      for (let attempt = 0; attempt < repeatedHints; attempt++) {
        yield* harness.receive({ messages: [message], workflow: Option.some(binding) });
      }
      expect(restart).toHaveBeenCalledTimes(3);
      expect(
        yield* promise(() =>
          db
            .prepare("SELECT state FROM weekly_question_intents WHERE id=?")
            .bind(questionId)
            .first("state")
        )
      ).toBe("refused");
      yield* harness.sweep();
      expect(send).not.toHaveBeenCalled();
    })
  ));

it("withdrawn expired question purposes terminate without content reads or further Workflow restart", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
      const now = weeklySummaryTestNow.epochMilliseconds;
      yield* seedQuestion({
        db,
        created: now,
        expires: DateTime.add(weeklySummaryTestNow, { days: 1 }).epochMilliseconds,
      });
      yield* withdrawWeeklyFixtureConsent({ db, userId, now });
      vi.spyOn(Date, "now").mockReturnValue(
        DateTime.add(weeklySummaryTestNow, { days: 2 }).epochMilliseconds
      );
      const send = vi
        .fn<Queue<ProactivityDeliveryWork>["send"]>()
        .mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
      const harness = proactivityWorkflowHarness({
        environment: {
          ...configuration(db),
          WEEKLY_DELIVERY_QUEUE: { send },
          WEEKLY_DELIVERY_WORKFLOW: workflowBinding,
        },
        userId,
        otherUserIds: [],
        unavailableUserIds: [],
      });
      const provider = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error("Forbidden IO"));
      vi.stubGlobal("fetch", provider);
      yield* Effect.exit(harness.sweep());
      yield* Effect.exit(harness.sweep());
      expect(
        yield* promise(() =>
          db
            .prepare("SELECT state FROM weekly_question_intents WHERE id=?")
            .bind(questionId)
            .first("state")
        )
      ).toBe("expired");
      expect(send).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(
        yield* promise(() =>
          db
            .prepare("SELECT text FROM weekly_governor_questions WHERE id=?")
            .bind(questionId)
            .first("text")
        )
      ).toBeNull();
    })
  ));

it("four unavailable due Users do not starve a healthy fifth User's generation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      const extraIds = [
        "10000000-0000-4000-8000-000000000053",
        "10000000-0000-4000-8000-000000000054",
        "10000000-0000-4000-8000-000000000055",
      ].map((id) => UserId.make(id));
      const users = [userId, weeklySummaryOtherUser, ...extraIds];
      let at = weeklySummaryTestNow;
      for (const [index, id] of users.entries()) {
        if (index > 1) {
          yield* promise(() =>
            db.batch([
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) SELECT ?,service_market,locale,time_zone,created_at_ms FROM users WHERE id=?"
                )
                .bind(id, userId),
              db
                .prepare(
                  "INSERT INTO onboarding_consent_records(id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) SELECT ?,?,disclosure_json,?, ?,0,0 FROM onboarding_consent_records WHERE user_id=? LIMIT 1"
                )
                .bind(id, id, `disclosed-${id}`, `accepted-${id}`, userId),
            ])
          );
        }
        const caller =
          index === 0
            ? weeklySummaryTestCaller
            : yield* Schema.decodeEffect(WhatsAppCallerReference)({
                businessPortfolioId: "portfolio",
                businessScopedUserId: `CO.user${index}`,
              }).pipe(Effect.orDie);
        if (index > 0) {
          yield* promise(() =>
            db
              .prepare(
                "INSERT INTO whatsapp_identities(user_id,portfolio_id,bsuid,verified_at_ms) VALUES (?,?,?,?)"
              )
              .bind(
                id,
                caller.businessPortfolioId,
                caller.businessScopedUserId,
                weeklySummaryTestNow.epochMilliseconds
              )
              .run()
          );
        }
        const schedule = yield* activateWeeklySummaryForUser({
          db,
          userId: id,
          caller,
          now: weeklySummaryTestNow,
        });
        at = schedule.nextScheduledAt;
        yield* promise(() =>
          db
            .prepare("UPDATE weekly_schedules SET last_evaluated_at_ms=? WHERE user_id=?")
            .bind(index, id)
            .run()
        );
      }
      const healthy = Option.getOrThrow(Option.fromUndefinedOr(users.at(-1)));
      yield* seedWeeklySummaryActivity({ db, at: "2026-08-04T12:00:00.000Z" });
      yield* promise(() =>
        db
          .prepare(
            "INSERT INTO transactions(id,user_id,amount,currency,category_id,direction,occurred_at,created_at,counterparty) SELECT '20000000-0000-4000-8000-000000000005',?,amount,currency,category_id,direction,occurred_at,created_at,counterparty FROM transactions WHERE user_id=? LIMIT 1"
          )
          .bind(healthy, userId)
          .run()
      );
      const clock = vi.spyOn(Date, "now").mockReturnValue(at.epochMilliseconds);
      const work: Array<ProactivityDeliveryWork> = [];
      const send = (message: ProactivityDeliveryWork): Promise<QueueSendResponse> => {
        work.push(message);
        return Promise.resolve({
          metadata: { metrics: { backlogCount: work.length, backlogBytes: 0 } },
        });
      };
      const harness = proactivityWorkflowHarness({
        environment: {
          ...configuration(db),
          WEEKLY_DELIVERY_QUEUE: { send },
          WEEKLY_DELIVERY_WORKFLOW: workflowBinding,
        },
        userId: healthy,
        otherUserIds: users.slice(0, -1),
        unavailableUserIds: users.slice(0, -1),
      });
      expect((yield* Effect.exit(harness.sweep()))._tag).toBe("Failure");
      expect(work).toHaveLength(0);
      clock.mockReturnValue(DateTime.add(at, { minutes: 1 }).epochMilliseconds);
      expect((yield* Effect.exit(harness.sweep()))._tag).toBe("Failure");
      expect(work.some((item) => item.userId === healthy && item.kind === "weekly-summary")).toBe(
        true
      );
    })
  ));

it("an exhausted Proactivity Workflow step records one metadata-only failure and preserves rejection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      const harness = proactivityWorkflowHarness({
        environment: { DB: db },
        userId,
        otherUserIds: [],
        unavailableUserIds: [],
      });
      const original = new Error("private-financial-failure-sentinel");
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const step: WorkflowStep = {
        do: () => Promise.reject(original),
        sleep: unexpected,
        sleepUntil: unexpected,
        waitForEvent: unexpected,
      };
      const outcome = yield* Effect.tryPromise(() =>
        harness
          .execute({
            work: { kind: "weekly-question", version: 1, userId, id: questionId },
            step,
          })
          .then(
            () => undefined,
            (error: unknown) => error
          )
      );
      // The native step error stays in the existing Effect rejection; observation cannot replace it.
      expect(outcome).toHaveProperty("cause", original);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT kind,count FROM operational_event_buckets").all()
        )
      ).toMatchObject({
        results: [{ kind: "workflow_failure", count: 1 }],
      });
      const exported = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        logs.mock.calls
      );
      expect(exported).toContain("workflow.proactivityDelivery");
      expect(exported).toContain("failed");
      expect(exported).not.toContain(original.message);
      expect(exported).not.toContain(userId);
      expect(exported).not.toContain(questionId);
    })
  ));
