import { deepStrictEqual } from "node:assert";
import { InsightUnavailable, type WeeklyScheduleSnapshot, WeeklySummaryReport } from "./contract";
import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { DateTime, Effect, Exit, Option, Schema } from "effect";
import { categoryIds } from "../../src/core/categories/contract";
import {
  createWeeklyGovernorConsentOffer,
  findWeeklyConsentGrant,
  prepareWeeklyConsentDecision,
  recordWeeklyConsentDisclosure,
} from "../consent/operations";
import {
  findWeeklySchedule,
  findWeeklySummaryReport,
  recordWeeklySummaryDecision,
  runWeeklyGeneration,
  weeklyReportDeliveryQuery,
} from "./operations";
import {
  seedWeeklySummaryActivity,
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
    const offer = Option.getOrThrow(
      yield* createWeeklyGovernorConsentOffer({
        ...context,
        request: { _tag: "ShortOffer", origin: "proactive" },
      })
    );
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

const prepareWithdrawal = (
  db: D1Database
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, object> =>
  Effect.gen(function* () {
    const context = {
      db,
      userId: weeklySummaryTestUser,
      caller: weeklySummaryTestCaller,
      now: weeklySummaryTestNow,
    };
    const offer = Option.getOrThrow(
      yield* createWeeklyGovernorConsentOffer({
        ...context,
        request: { _tag: "ShortOffer", origin: "proactive" },
      })
    );
    yield* recordWeeklyConsentDisclosure({
      ...context,
      offerId: offer.id,
      disclosureMessageId: "withdrawal-disclosed",
    });
    return Option.getOrThrow(
      yield* prepareWeeklyConsentDecision({
        ...context,
        choice: offer.revokeChoice,
        decisionMessageId: "withdrawal-accepted",
      })
    ).statements;
  });

it.live(
  "freezes complete owned facts and cutoff once with the report, outbox and schedule advancement",
  () =>
    Effect.gen(function* () {
      const db = yield* weeklySummaryTestDatabase;
      const schedule = yield* enable(db);
      const sql =
        "INSERT INTO transactions (id,user_id,amount,currency,category_id,direction,occurred_at_ms,created_at_ms,counterparty) VALUES (?,?,?,?,?,?,CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER),CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER),NULL)";
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
      const outcome = yield* runWeeklyGeneration(input);
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
      expect(yield* runWeeklyGeneration(input)).toEqual({ _tag: "NoWork" });
      const outbox = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT user_id,delivery_id AS insight_event_id,state FROM (SELECT rowid,user_id,kind,id AS delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM proactive_messages WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='weekly-summary'"
          )
          .all()
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
        .prepare("UPDATE transaction_projection_state SET readiness = 'dirty' WHERE user_id = ?")
        .bind(weeklySummaryTestUser)
        .run()
    );
    const input = {
      db,
      userId: weeklySummaryTestUser,
      id: snapshot.id,
      now: snapshot.nextScheduledAt,
    };
    deepStrictEqual(
      yield* Effect.exit(runWeeklyGeneration(input)),
      Exit.fail(new InsightUnavailable())
    );
    expect(
      DateTime.formatIso(Option.getOrThrow(yield* findWeeklySchedule(input)).nextScheduledAt)
    ).toBe(DateTime.formatIso(snapshot.nextScheduledAt));
    const outbox = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT delivery_id AS insight_event_id FROM (SELECT rowid,user_id,kind,id AS delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM proactive_messages WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='weekly-summary'"
        )
        .all()
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
      const offer = Option.getOrThrow(
        yield* createWeeklyGovernorConsentOffer({
          ...context,
          request: { _tag: "ShortOffer", origin: "proactive" },
        })
      );
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
      const revoke = Option.getOrThrow(
        yield* createWeeklyGovernorConsentOffer({
          ...context,
          request: { _tag: "ShortOffer", origin: "proactive" },
        })
      );
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

it.live("advances only the latest complete empty occurrence after a multiweek delay", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const snapshot = yield* enable(db);
    const input = {
      db,
      userId: weeklySummaryTestUser,
      id: snapshot.id,
      now: DateTime.makeUnsafe("2026-08-23T23:00:00Z"),
    };
    expect(yield* runWeeklyGeneration(input)).toEqual({ _tag: "NoActivity" });
    expect(
      DateTime.formatIso(Option.getOrThrow(yield* findWeeklySchedule(input)).nextScheduledAt)
    ).toBe("2026-08-30T23:00:00.000Z");
    expect(yield* runWeeklyGeneration(input)).toEqual({ _tag: "NoWork" });
    const history = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT scheduled_at,outcome FROM schedule_history WHERE record_type='execution' AND kind='weekly' AND user_id=?"
        )
        .bind(input.userId)
        .all()
    );
    expect(history.results).toEqual([
      { scheduled_at: "2026-08-23T23:00:00.000Z", outcome: "empty" },
    ]);
  })
);

it.live("expires at the exact original deadline without requiring financial facts", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const snapshot = yield* enable(db);
    yield* Effect.tryPromise(() =>
      db
        .prepare("UPDATE transaction_projection_state SET readiness='dirty' WHERE user_id=?")
        .bind(snapshot.userId)
        .run()
    );
    const input = {
      db,
      userId: snapshot.userId,
      id: snapshot.id,
      now: DateTime.makeUnsafe("2026-08-10T23:00:00Z"),
    };
    expect(yield* runWeeklyGeneration(input)).toEqual({ _tag: "Expired" });
    expect(
      DateTime.formatIso(Option.getOrThrow(yield* findWeeklySchedule(input)).nextScheduledAt)
    ).toBe("2026-08-16T23:00:00.000Z");
    const history = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT scheduled_at,outcome FROM schedule_history WHERE record_type='execution' AND kind='weekly'"
        )
        .all()
    );
    expect(history.results).toEqual([
      { scheduled_at: "2026-08-09T23:00:00.000Z", outcome: "expired" },
    ]);
  })
);

const assertUnpublished = (
  db: D1Database,
  snapshot: WeeklyScheduleSnapshot
): Effect.Effect<void, object> =>
  Effect.gen(function* () {
    expect(
      DateTime.formatIso(
        Option.getOrThrow(yield* findWeeklySchedule({ db, userId: snapshot.userId }))
          .nextScheduledAt
      )
    ).toBe(DateTime.formatIso(snapshot.nextScheduledAt));
    const retained = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT (SELECT count(*) FROM insight_events) AS events,(SELECT count(*) FROM insight_reports) AS reports,(SELECT count(*) FROM proactive_messages WHERE kind='weekly-summary') AS intents,(SELECT count(*) FROM schedule_history WHERE record_type='execution') AS executions"
        )
        .first()
    );
    expect(retained).toEqual({ events: 0, reports: 0, intents: 0, executions: 0 });
  });

for (const change of ["revision", "withdrawal", "schedule"] as const) {
  for (const activity of [false, true]) {
    it.live(
      `refuses ${activity ? "report" : "empty"} publication when ${change} changes after complete facts`,
      () =>
        Effect.gen(function* () {
          const db = yield* weeklySummaryTestDatabase;
          const snapshot = yield* enable(db);
          yield* seedWeeklySummaryActivity({
            db,
            at: activity ? "2026-08-04T12:00:00Z" : "2026-07-01T12:00:00Z",
          });
          const withdrawal = change === "withdrawal" ? yield* prepareWithdrawal(db) : [];
          const originalRevision = yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT fact_revision FROM transaction_projection_state WHERE user_id=?")
              .bind(snapshot.userId)
              .first("fact_revision")
          );
          let mutationSucceeded = false;
          let calls = 0;
          let interleaved = false;
          const intercepted: D1Database["batch"] = <Row>(
            statements: D1PreparedStatement[]
          ): Promise<D1Result<Row>[]> => {
            calls += 1;
            return db.batch<Row>(statements).then((result) => {
              if (calls !== 2) return result;
              interleaved = true;
              if (change === "withdrawal") {
                return db.batch([...withdrawal]).then(() => {
                  mutationSucceeded = true;
                  return result;
                });
              }
              const mutation =
                change === "revision"
                  ? db
                      .prepare(
                        "UPDATE transaction_projection_state SET fact_revision=fact_revision+1 WHERE user_id=?"
                      )
                      .bind(snapshot.userId)
                  : db
                      .prepare(
                        "UPDATE schedules SET version=version+1 WHERE kind='weekly' AND user_id=?"
                      )
                      .bind(snapshot.userId);
              return mutation.run().then((committed) => {
                mutationSucceeded = committed.success && committed.meta.changes === 1;
                return result;
              });
            });
          };
          const guardedDb = new Proxy(db, {
            get(target, key, receiver): unknown {
              return key === "batch" ? intercepted : Reflect.get(target, key, receiver);
            },
          });
          const result = yield* Effect.exit(
            runWeeklyGeneration({
              db: guardedDb,
              userId: snapshot.userId,
              id: snapshot.id,
              now: snapshot.nextScheduledAt,
            })
          );
          expect(interleaved).toBe(true);
          expect(mutationSucceeded).toBe(true);
          if (change === "revision") {
            const revision = yield* Effect.tryPromise(() =>
              db
                .prepare("SELECT fact_revision FROM transaction_projection_state WHERE user_id=?")
                .bind(snapshot.userId)
                .first("fact_revision")
            );
            const beforeRevision = yield* Schema.decodeUnknownEffect(Schema.Int)(originalRevision);
            const afterRevision = yield* Schema.decodeUnknownEffect(Schema.Int)(revision);
            expect(afterRevision).toBe(beforeRevision + 1);
          }
          deepStrictEqual(result, Exit.fail(new InsightUnavailable()));
          if (change === "schedule") {
            yield* Effect.tryPromise(() =>
              db
                .prepare("UPDATE schedules SET version=? WHERE kind='weekly' AND user_id=?")
                .bind(snapshot.version, snapshot.userId)
                .run()
            );
          }
          yield* assertUnpublished(db, snapshot);
        })
    );
  }
}

it.live("rolls back the complete occurrence when report insertion fails and freshly retries", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const snapshot = yield* enable(db);
    yield* seedWeeklySummaryActivity({ db, at: "2026-08-04T12:00:00Z" });
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "CREATE TRIGGER fail_weekly_report BEFORE INSERT ON insight_reports BEGIN SELECT RAISE(ABORT,'forced report failure'); END"
        )
        .run()
    );
    const input = { db, userId: snapshot.userId, id: snapshot.id, now: snapshot.nextScheduledAt };
    deepStrictEqual(
      yield* Effect.exit(runWeeklyGeneration(input)),
      Exit.fail(new InsightUnavailable())
    );
    yield* assertUnpublished(db, snapshot);
    yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER fail_weekly_report").run());
    expect((yield* runWeeklyGeneration(input))._tag).toBe("Created");
    expect(yield* runWeeklyGeneration(input)).toEqual({ _tag: "NoWork" });
  })
);

it.live("unavailable projection cannot masquerade as a complete empty period", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const snapshot = yield* enable(db);
    yield* Effect.tryPromise(() =>
      db
        .prepare("DELETE FROM transaction_projection_state WHERE user_id=?")
        .bind(snapshot.userId)
        .run()
    );
    deepStrictEqual(
      yield* Effect.exit(
        runWeeklyGeneration({
          db,
          userId: snapshot.userId,
          id: snapshot.id,
          now: snapshot.nextScheduledAt,
        })
      ),
      Exit.fail(new InsightUnavailable())
    );
    yield* assertUnpublished(db, snapshot);
  })
);

it.live("withdrawn category refuses generation independently of active Processing Consent", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const snapshot = yield* enable(db);
    const withdrawal = yield* prepareWithdrawal(db);
    yield* Effect.tryPromise(() => db.batch([...withdrawal]));
    expect(
      yield* runWeeklyGeneration({
        db,
        userId: snapshot.userId,
        id: snapshot.id,
        now: snapshot.nextScheduledAt,
      })
    ).toEqual({ _tag: "NoWork" });
    yield* assertUnpublished(db, snapshot);
  })
);

it.live(
  "delayed discovery freezes only the latest local-calendar report and its original deadline",
  () =>
    Effect.gen(function* () {
      const db = yield* weeklySummaryTestDatabase;
      const snapshot = yield* enable(db);
      yield* seedWeeklySummaryActivity({ db, at: "2026-08-20T12:00:00Z" });
      const input = {
        db,
        userId: snapshot.userId,
        id: snapshot.id,
        now: DateTime.makeUnsafe("2026-08-24T14:00:00Z"),
      };
      const result = yield* runWeeklyGeneration(input);
      if (result._tag !== "Created") return yield* Effect.die("Expected latest report");
      const report = Option.getOrThrow(yield* findWeeklySummaryReport({ ...input, id: result.id }));
      expect(DateTime.formatIso(report.payload.periods.current.from)).toBe(
        "2026-08-16T23:00:00.000Z"
      );
      expect(DateTime.formatIso(report.payload.periods.current.toExclusive)).toBe(
        "2026-08-23T23:00:00.000Z"
      );
      expect(DateTime.formatIso(report.expiresAt)).toBe("2026-08-24T23:00:00.000Z");
      expect(report.consentGrantId).toBe(snapshot.consentGrantId);
      expect(yield* runWeeklyGeneration(input)).toEqual({ _tag: "NoWork" });
    })
);

it.live("retains the frozen grant and deadline across a later enabled timing revision", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const snapshot = yield* enable(db);
    yield* seedWeeklySummaryActivity({ db, at: "2026-08-04T12:00:00Z" });
    const input = { db, userId: snapshot.userId, id: snapshot.id, now: snapshot.nextScheduledAt };
    const outcome = yield* runWeeklyGeneration(input);
    if (outcome._tag !== "Created") return yield* Effect.die("Expected frozen report");
    const before = Option.getOrThrow(yield* findWeeklySummaryReport({ ...input, id: outcome.id }));
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "UPDATE schedules SET version=version+1,snapshot_json=json_set(snapshot_json,'$.version',version+1,'$.timing.hour',19) WHERE kind='weekly' AND user_id=?"
        )
        .bind(input.userId)
        .run()
    );
    const query = weeklyReportDeliveryQuery({ userId: input.userId, insightEventId: outcome.id });
    const eligible = yield* Effect.tryPromise(() =>
      db
        .prepare(query.sql)
        .bind(...query.params)
        .all()
    );
    expect(eligible.results).toHaveLength(1);
    const after = Option.getOrThrow(yield* findWeeklySummaryReport({ ...input, id: outcome.id }));
    expect(after).toEqual(before);
    expect(Option.getOrThrow(yield* findWeeklySchedule(input)).version).toBe(snapshot.version + 1);
  })
);
