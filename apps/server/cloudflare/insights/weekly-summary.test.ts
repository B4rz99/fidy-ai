import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { type WeeklyScheduleSnapshot, WeeklySummaryReport } from "./contract";
import { categoryIds } from "../../src/core/categories/contract";
import {
  createWeeklyConsentOffer,
  findWeeklyConsentGrant,
  recordWeeklyConsentDisclosure,
} from "../consent/operations";
import {
  findWeeklySchedule,
  findWeeklySummaryReport,
  materializeWeeklySummary,
  prepareWeeklyScheduleAdvance,
  recordWeeklySummaryDecision,
} from "./operations";
import {
  weeklySummaryOtherUser,
  weeklySummaryTestCaller,
  weeklySummaryTestDatabase,
  weeklySummaryTestDatabases,
  weeklySummaryTestNow,
  weeklySummaryTestUser,
} from "../weekly-summary.test-fixture";

afterAll(() => weeklySummaryTestDatabases.dispose());

const enable = (db: D1Database): Effect.Effect<WeeklyScheduleSnapshot, object> =>
  Effect.gen(function* () {
    const context = {
      db,
      userId: weeklySummaryTestUser,
      caller: weeklySummaryTestCaller,
      now: weeklySummaryTestNow,
    };
    const offer = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
    yield* recordWeeklyConsentDisclosure({
      ...context,
      offerId: offer.id,
      disclosureMessageId: "disclosure",
    });
    yield* recordWeeklySummaryDecision({
      ...context,
      choice: offer.acceptChoice,
      decisionMessageId: "accepted",
    });
    return Option.getOrThrow(yield* findWeeklySchedule(context));
  });

it.live(
  "freezes complete owned facts and cutoff once with the report, outbox and schedule advancement",
  () =>
    Effect.gen(function* () {
      const db = yield* weeklySummaryTestDatabase;
      const schedule = yield* enable(db);
      const sql =
        "INSERT INTO transactions (id,user_id,amount,currency,category_id,direction,occurred_at,created_at,counterparty) VALUES (?,?,?,?,?,?,?,?,NULL)";
      const seedDefaults: Readonly<{
        userId: string;
        amount: string;
        currency: string;
        direction: string;
        at: string;
      }> = {
        userId: weeklySummaryTestUser,
        amount: "10.25",
        currency: "COP",
        direction: "outflow",
        at: "2026-08-04T12:00:00.000Z",
      };
      const seed = (
        suffix: string,
        override: Partial<typeof seedDefaults> = {}
      ): D1PreparedStatement => {
        const facts = { ...seedDefaults, ...override };
        return db
          .prepare(sql)
          .bind(
            `20000000-0000-4000-8000-0000000000${suffix}`,
            facts.userId,
            facts.amount,
            facts.currency,
            categoryIds.mercado,
            facts.direction,
            facts.at,
            facts.at
          );
      };
      yield* Effect.tryPromise(() =>
        db.batch([
          seed("01"),
          seed("02", { amount: "30", direction: "inflow", at: "2026-08-08T12:00:00.000Z" }),
          seed("03", { amount: "3", currency: "USD", at: "2026-08-01T12:00:00.000Z" }),
          seed("04", {
            userId: weeklySummaryOtherUser,
            amount: "999",
            at: "2026-08-05T12:00:00.000Z",
          }),
          seed("05", { amount: "100", at: "2026-08-09T23:00:00.000Z" }),
        ])
      );
      const input = {
        db,
        userId: weeklySummaryTestUser,
        id: schedule.id,
        now: DateTime.makeUnsafe("2026-08-10T14:00:00Z"),
      };
      const outcome = yield* materializeWeeklySummary(input);
      if (outcome._tag !== "Created") return yield* Effect.die("Expected created summary");
      const report = Option.getOrThrow(
        yield* findWeeklySummaryReport({ ...input, id: outcome.id })
      );
      const encoded = yield* Schema.encodeEffect(WeeklySummaryReport)(report);
      expect(encoded.payload.groups.map((group) => group.currency)).toEqual(["COP", "USD"]);
      expect(encoded.payload.groups[0].outflow.current.amount).toBe("10.25");
      expect(encoded.payload.groups[0].inflow.current.amount).toBe("30");
      expect(encoded.payload.periods.current.toExclusive).toBe("2026-08-09T23:00:00.000Z");
      expect(encoded.expiresAt).toBe("2026-08-10T23:00:00.000Z");
      expect(
        Option.isNone(
          yield* findWeeklySummaryReport({
            ...input,
            userId: weeklySummaryOtherUser,
            id: outcome.id,
          })
        )
      ).toBe(true);
      expect(yield* materializeWeeklySummary(input)).toEqual({ _tag: "NoWork" });
      const outbox = yield* Effect.tryPromise(() =>
        db.prepare("SELECT user_id,insight_event_id,state FROM weekly_summary_outbox").all()
      );
      expect(outbox.results).toEqual([
        { user_id: weeklySummaryTestUser, insight_event_id: outcome.id, state: "ready" },
      ]);
    })
);

it.live("does not convert unavailable aggregates into an empty-week advancement", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const snapshot = yield* enable(db);
    yield* Effect.tryPromise(() =>
      db
        .prepare("UPDATE dashboard_projection_state SET readiness = 'dirty' WHERE user_id = ?")
        .bind(weeklySummaryTestUser)
        .run()
    );
    const input = {
      db,
      userId: weeklySummaryTestUser,
      id: snapshot.id,
      now: snapshot.nextScheduledAt,
    };
    expect((yield* Effect.exit(materializeWeeklySummary(input)))._tag).toBe("Failure");
    expect(
      DateTime.formatIso(Option.getOrThrow(yield* findWeeklySchedule(input)).nextScheduledAt)
    ).toBe(DateTime.formatIso(snapshot.nextScheduledAt));
    const outbox = yield* Effect.tryPromise(() =>
      db.prepare("SELECT insight_event_id FROM weekly_summary_outbox").all()
    );
    expect(outbox.results).toEqual([]);
  })
);

it.live(
  "enables one weekly schedule atomically with qualified Consent and cannot substitute another User",
  () =>
    Effect.gen(function* () {
      const db = yield* weeklySummaryTestDatabase;
      const context = {
        db,
        userId: weeklySummaryTestUser,
        caller: weeklySummaryTestCaller,
        now: weeklySummaryTestNow,
      };
      const offer = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
      yield* recordWeeklyConsentDisclosure({
        ...context,
        offerId: offer.id,
        disclosureMessageId: "disclosure",
      });
      expect(
        yield* recordWeeklySummaryDecision({
          ...context,
          userId: weeklySummaryOtherUser,
          choice: offer.acceptChoice,
          decisionMessageId: "foreign",
        })
      ).toBe(false);
      expect(Option.isNone(yield* findWeeklySchedule({ db, userId: weeklySummaryOtherUser }))).toBe(
        true
      );
      expect(
        yield* recordWeeklySummaryDecision({
          ...context,
          choice: offer.acceptChoice,
          decisionMessageId: "accepted",
        })
      ).toBe(true);
      const schedule = Option.getOrThrow(yield* findWeeklySchedule(context));
      expect(schedule.enabled).toBe(true);
      expect(schedule.timing).toEqual({ weekday: 0, hour: 18, minute: 0 });
      expect(DateTime.formatIso(schedule.nextScheduledAt)).toBe("2026-08-09T23:00:00.000Z");
      const grant = Option.getOrThrow(yield* findWeeklyConsentGrant(context));
      expect(schedule.consentGrantId).toBe(grant.id);
      expect(
        yield* recordWeeklySummaryDecision({
          ...context,
          choice: offer.acceptChoice,
          decisionMessageId: "replay",
        })
      ).toBe(false);
      const revoke = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
      yield* recordWeeklyConsentDisclosure({
        ...context,
        offerId: revoke.id,
        disclosureMessageId: "revoke-disclosure",
      });
      expect(
        yield* recordWeeklySummaryDecision({
          ...context,
          choice: revoke.revokeChoice,
          decisionMessageId: "revoked",
        })
      ).toBe(true);
      expect(Option.getOrThrow(yield* findWeeklySchedule(context)).enabled).toBe(false);
      expect(Option.isNone(yield* findWeeklyConsentGrant(context))).toBe(true);
    })
);

it.live(
  "advances a genuinely empty latest occurrence once and rolls back stale or revoked schedule publication",
  () =>
    Effect.gen(function* () {
      const db = yield* weeklySummaryTestDatabase;
      const context = {
        db,
        userId: weeklySummaryTestUser,
        caller: weeklySummaryTestCaller,
        now: weeklySummaryTestNow,
      };
      const offer = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
      yield* recordWeeklyConsentDisclosure({
        ...context,
        offerId: offer.id,
        disclosureMessageId: "disclosure",
      });
      yield* recordWeeklySummaryDecision({
        ...context,
        choice: offer.acceptChoice,
        decisionMessageId: "accepted",
      });
      const snapshot = Option.getOrThrow(yield* findWeeklySchedule(context));
      const now = DateTime.makeUnsafe("2026-08-23T23:00:00Z");
      const advance = (): ReadonlyArray<D1PreparedStatement> =>
        prepareWeeklyScheduleAdvance({
          db,
          snapshot,
          now,
          materializedScheduledAt: now,
          outcome: "empty",
        });
      yield* Effect.tryPromise(() => db.batch([...advance()]));
      expect(
        DateTime.formatIso(Option.getOrThrow(yield* findWeeklySchedule(context)).nextScheduledAt)
      ).toBe("2026-08-30T23:00:00.000Z");
      expect((yield* Effect.exit(Effect.tryPromise(() => db.batch([...advance()]))))._tag).toBe(
        "Failure"
      );
      const executions = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT scheduled_at,outcome FROM weekly_schedule_executions WHERE user_id = ?")
          .bind(context.userId)
          .all()
      );
      expect(executions.results).toEqual([
        { scheduled_at: "2026-08-23T23:00:00.000Z", outcome: "empty" },
      ]);
    })
);
