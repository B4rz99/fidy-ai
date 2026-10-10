import type { OperationalSignal } from "../runtime/operational-health/contract";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  activateWeeklySummary,
  seedWeeklySummaryActivity,
  weeklySummaryDatabaseAt,
  weeklySummaryOtherUser,
  weeklySummaryTestDatabases,
  weeklySummaryTestNow,
  weeklySummaryTestUser,
} from "../weekly-summary.test-fixture";
import {
  decideOperationalAlerts,
  observeOperationalHealth,
} from "../runtime/operational-health/operations";
import { materializeWeeklySummary, observeProactivityWork } from "./operations";
import { prepareProactivityWorkObservation } from "./internal/operational-observation";
import { proactivityWorkflowId } from "./internal/proactivity-workflow";
import {
  ProactivityDeliveryWork,
  ProactivityWorkObservations,
  ProactivityWorkflowId,
} from "./contract";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const userId = weeklySummaryTestUser;
const questionId = "90000000-0000-4000-8000-000000000001";
const deliveryId = "90000000-0000-4000-8000-000000000002";
afterAll(() => weeklySummaryTestDatabases.dispose());
afterEach(() => vi.restoreAllMocks());

it.each(["weekly-summary", "weekly-question", "proactivity-delivery"] as const)(
  "constructs and validates %s locators from the same owner-declared grammar",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const work = yield* Schema.decodeEffect(ProactivityDeliveryWork)({
          kind,
          version: 1,
          userId,
          id: deliveryId,
          insightEventId: deliveryId,
        });
        const id = yield* proactivityWorkflowId(work);
        expect(id).toBe(`weekly-${userId}-${kind}-${deliveryId}`);
        expect(Schema.is(ProactivityWorkflowId)(id)).toBe(true);
        for (const invalid of [
          `other-${userId}-${kind}-${deliveryId}`,
          `weekly-${userId}-unknown-${deliveryId}`,
          `weekly-${"-".repeat(36)}-${kind}-${deliveryId}`,
          `weekly-${userId}-${kind}-${"f".repeat(36)}`,
          `${id}-extra`,
        ]) {
          expect(Schema.is(ProactivityWorkflowId)(invalid)).toBe(false);
        }
      })
    )
);

it("observes only enabled Proactivity work and its real Workflow identities without exposing content", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      const schedule = yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
      yield* seedWeeklySummaryActivity({ db, at: "2026-08-04T12:00:00.000Z" });
      const generated = yield* materializeWeeklySummary({
        db,
        userId,
        id: schedule.id,
        now: schedule.nextScheduledAt,
      });
      expect(generated._tag).toBe("Created");
      if (generated._tag !== "Created") throw new Error("Expected pending summary");
      const now = schedule.nextScheduledAt.epochMilliseconds + 900_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO weekly_question_intents(id,user_id,origin,created_at_ms) VALUES (?,?,'requested',?)"
            )
            .bind(questionId, weeklySummaryOtherUser, now - 600_000),
          db
            .prepare(
              "INSERT INTO proactivity_reports(delivery_id,user_id,role,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES (?,?,'budget-offer',?,'private-financial-sentinel',?,?,'UTC',?)"
            )
            .bind(deliveryId, userId, deliveryId, now - 300_000, now - 1, now - 300_000),
          db
            .prepare(
              "INSERT INTO proactivity_outbox(user_id,delivery_id,created_at_ms,state) VALUES (?,?,?,'started')"
            )
            .bind(userId, deliveryId, now - 300_000),
        ])
      );
      const inspected: string[] = [];
      const metrics = vi.fn(() => Promise.resolve({ backlogCount: 150, backlogBytes: 3000 }));
      const observe = (
        weeklyEnabled: boolean,
        proactivityEnabled: boolean
      ): Effect.Effect<ReadonlyArray<OperationalSignal>> =>
        observeOperationalHealth({
          DB: db,
          proactivity: { weeklyEnabled, proactivityEnabled },
          workflows: {
            proactivity: {
              get: (id) => {
                inspected.push(id);
                return Promise.resolve({
                  status: () =>
                    Promise.resolve({
                      status: "errored",
                      error: "private-workflow-error-sentinel",
                    }),
                });
              },
            },
          },
          workQueues: { proactivityQueue: { metrics } },
          deadLetters: Option.none(),
        });
      const signals = yield* observe(true, true);
      expect(inspected).toEqual([
        `weekly-${userId}-weekly-summary-${generated.id}`,
        `weekly-${weeklySummaryOtherUser}-weekly-question-${questionId}`,
        `weekly-${userId}-proactivity-delivery-${deliveryId}`,
      ]);
      const observed = yield* observeProactivityWork({
        db,
        weeklyEnabled: true,
        proactivityEnabled: true,
      });
      expect(Schema.is(ProactivityWorkObservations)(observed)).toBe(true);
      expect(observed.map((row) => row.id)).toEqual(inspected);
      expect(
        observed.every((row) => Object.keys(row).sort().join(",") === "created,deadline,id")
      ).toBe(true);
      expect(signals.find((signal) => signal.operation === "proactivity")).toMatchObject({
        state: "attention",
        sampledPending: 3,
        failedWorkflows: 3,
        expiredUndelivered: 1,
      });
      expect(decideOperationalAlerts(signals)).toContainEqual({
        kind: "workflow_failure",
        owner: "proactivity",
        severity: "critical",
      });
      expect(decideOperationalAlerts(signals)).toContainEqual({
        kind: "queue_backlog",
        owner: "proactivityQueue",
        severity: "warning",
      });
      const exported = encode(signals);
      for (const value of [
        userId,
        weeklySummaryOtherUser,
        questionId,
        deliveryId,
        "private-financial-sentinel",
        "private-workflow-error-sentinel",
      ]) {
        expect(exported).not.toContain(value);
      }
      expect(
        (yield* observe(true, false)).find((signal) => signal.operation === "proactivity")
      ).toMatchObject({ sampledPending: 2 });
      expect(
        (yield* observe(false, true)).find((signal) => signal.operation === "proactivity")
      ).toMatchObject({ sampledPending: 1 });
      inspected.length = 0;
      metrics.mockClear();
      expect(
        (yield* observe(false, false)).some(
          (signal) => signal.operation === "proactivity" || signal.operation === "proactivityQueue"
        )
      ).toBe(false);
      expect(inspected).toEqual([]);
      expect(metrics).not.toHaveBeenCalled();
    })
  ));

it("caps the oldest pending sample and indexed reads independently of terminal delivery history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2020)
      INSERT INTO proactivity_reports(delivery_id,user_id,role,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms)
      SELECT printf('90000000-0000-4000-8000-%012d', i),?,'budget-offer','offer','private-report',0,?,'UTC',i FROM n`)
            .bind(userId, now + 600_000),
          db.prepare(`INSERT INTO proactivity_outbox(user_id,delivery_id,created_at_ms,state)
      SELECT user_id,delivery_id,created_at_ms,CASE WHEN created_at_ms<=2000 THEN 'settled' ELSE 'ready' END FROM proactivity_reports`),
        ])
      );
      const result = yield* Effect.tryPromise(() =>
        prepareProactivityWorkObservation({
          db,
          weeklyEnabled: true,
          proactivityEnabled: true,
        }).all()
      );
      expect(result.results).toHaveLength(8);
      expect(result.results.map((row) => row.created)).toEqual([
        2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008,
      ]);
      expect(result.meta.rows_read).toBeLessThan(100);
      const signals = yield* observeOperationalHealth({
        DB: db,
        proactivity: { weeklyEnabled: false, proactivityEnabled: true },
        workflows: {},
        workQueues: {},
        deadLetters: Option.none(),
      });
      expect(signals.find((signal) => signal.operation === "proactivity")).toMatchObject({
        sampledPending: 8,
        sampleLimited: true,
        unavailableWorkflows: 8,
      });
      expect(signals.find((signal) => signal.operation === "proactivityQueue")).toEqual({
        component: "async-health",
        operation: "proactivityQueue",
        state: "unavailable",
      });
    })
  ));

it("reports a stalled Proactivity Workflow as unavailable while preserving independent Queue measurements", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      const now = DateTime.makeUnsafe("2026-10-01T00:00:00Z").epochMilliseconds;
      vi.spyOn(Date, "now").mockReturnValue(now);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO weekly_question_intents(id,user_id,origin,created_at_ms) VALUES (?,?,'requested',?)"
          )
          .bind(questionId, userId, now - 600_000)
          .run()
      );
      const signals = yield* observeOperationalHealth({
        DB: db,
        proactivity: { weeklyEnabled: true, proactivityEnabled: false },
        workflows: { proactivity: { get: () => Promise.withResolvers<never>().promise } },
        workQueues: {
          proactivityQueue: {
            metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
          },
        },
        deadLetters: Option.none(),
      });
      expect(signals.find((signal) => signal.operation === "proactivity")).toMatchObject({
        sampledPending: 1,
        unavailableWorkflows: 1,
      });
      expect(signals.find((signal) => signal.operation === "proactivityQueue")).toMatchObject({
        state: "healthy",
        backlogCount: 0,
      });
    })
  ));

it("rejects malformed stored Work identities before Workflow inspection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO weekly_question_intents(id,user_id,origin,created_at_ms) VALUES (?,?,'requested',?)"
          )
          .bind("-".repeat(36), userId, now - 600_000)
          .run()
      );
      const get = vi.fn(() =>
        Promise.resolve({ status: () => Promise.resolve({ status: "errored" }) })
      );
      const signals = yield* observeOperationalHealth({
        DB: db,
        proactivity: { weeklyEnabled: true, proactivityEnabled: false },
        workflows: { proactivity: { get } },
        workQueues: {},
        deadLetters: Option.none(),
      });
      expect(signals.find((signal) => signal.operation === "proactivity")).toEqual({
        component: "async-health",
        operation: "proactivity",
        state: "unavailable",
      });
      expect(get).not.toHaveBeenCalled();
    })
  ));
