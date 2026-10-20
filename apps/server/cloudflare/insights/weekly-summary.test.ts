import { applyTestMigration } from "../d1-test-fixture";
import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { type WeeklyScheduleSnapshot, WeeklySummaryReport } from "./contract";
import { categoryIds } from "../../src/core/categories/contract";
import {
  createWeeklyGovernorConsentOffer,
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
        db
          .prepare(
            "SELECT user_id,delivery_id AS insight_event_id,state FROM (SELECT rowid,user_id,kind,delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM insight_reports WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='weekly-summary'"
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
      db
        .prepare(
          "SELECT delivery_id AS insight_event_id FROM (SELECT rowid,user_id,kind,delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM insight_reports WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='weekly-summary'"
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
          .prepare(
            "SELECT scheduled_at,outcome FROM schedule_executions WHERE kind='weekly' AND user_id = ?"
          )
          .bind(context.userId)
          .all()
      );
      expect(executions.results).toEqual([
        { scheduled_at: "2026-08-23T23:00:00.000Z", outcome: "empty" },
      ]);
    })
);

it.live(
  "preserves both delivery kinds and retry progress through consolidation without mixing report ownership",
  () =>
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => weeklySummaryTestDatabases.acquire());
      const directory = new URL("../migrations/", import.meta.url);
      const names = Array.from(new Bun.Glob("*.sql").scanSync(directory.pathname))
        .filter((name) => name < "0123_")
        .sort();
      for (const name of names) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(name, directory) })
        );
      }
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO','es-CO','UTC',0)"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO','es-CO','UTC',0)"
            )
            .bind(weeklySummaryOtherUser),
        ])
      );
      const states = ["ready", "started", "settled", "expired", "refused"] as const;
      for (const [index, state] of states.entries()) {
        const id = `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) VALUES (?,?,'weekly-summary',?,1,'CO','es-CO','UTC','2026-10-18T00:00:00Z','[]')"
              )
              .bind(id, weeklySummaryTestUser, id),
            db
              .prepare(
                "INSERT INTO weekly_summary_reports VALUES (?,?,'grant','{}','{}',1000,2000)"
              )
              .bind(weeklySummaryTestUser, id),
            db
              .prepare(
                "INSERT INTO proactivity_reports(delivery_id,user_id,role,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES (?,?,'budget-offer','offer',NULL,1000,3000,'UTC',1000)"
              )
              .bind(id, weeklySummaryTestUser),
            db
              .prepare(
                "INSERT INTO weekly_summary_outbox(user_id,insight_event_id,state,created_at_ms,last_attempt_at_ms,restart_attempts) VALUES (?,?,?,1000,1500,2)"
              )
              .bind(weeklySummaryTestUser, id, state),
            db
              .prepare(
                "INSERT INTO proactivity_outbox(user_id,delivery_id,state,created_at_ms,last_attempt_at_ms,restart_attempts) VALUES (?,?,?,1100,1600,3)"
              )
              .bind(weeklySummaryTestUser, id, state),
          ])
        );
      }
      yield* Effect.tryPromise(() =>
        applyTestMigration({ db, source: new URL("0123_proactivity_delivery.sql", directory) })
      );
      const rows = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT kind,delivery_id,state,created_at_ms,last_attempt_at_ms,restart_attempts,expires_at_ms,content_available FROM proactivity_delivery_metadata ORDER BY kind,delivery_id"
          )
          .all()
      );
      expect(rows.results).toEqual([
        ...states.map((state, index) => ({
          kind: "proactivity-delivery",
          delivery_id: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          state,
          created_at_ms: 1100,
          last_attempt_at_ms: 1600,
          restart_attempts: 3,
          expires_at_ms: 3000,
          content_available: 0,
        })),
        ...states.map((state, index) => ({
          kind: "weekly-summary",
          delivery_id: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          state,
          created_at_ms: 1000,
          last_attempt_at_ms: 1500,
          restart_attempts: 2,
          expires_at_ms: 2000,
          content_available: 1,
        })),
      ]);
      for (const kind of ["weekly-summary", "proactivity-delivery"]) {
        const refused = yield* Effect.exit(
          Effect.tryPromise(() =>
            db
              .prepare(
                "INSERT INTO proactivity_delivery_outbox(user_id,kind,delivery_id,created_at_ms) VALUES (?,?,?,0)"
              )
              .bind(weeklySummaryOtherUser, kind, "90000000-0000-4000-8000-000000000000")
              .run()
          )
        );
        expect(refused._tag).toBe("Failure");
      }
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM proactivity_delivery_outbox WHERE user_id=?")
            .bind(weeklySummaryOtherUser)
            .first("count")
        )
      ).toBe(0);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
    })
);

it.live(
  "preserves overlapping schedule identities, instruction history and execution progress through consolidation",
  () =>
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => weeklySummaryTestDatabases.acquire());
      const directory = new URL("../migrations/", import.meta.url);
      const names = Array.from(new Bun.Glob("*.sql").scanSync(directory.pathname))
        .filter((name) => name < "0136_")
        .sort();
      for (const name of names) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(name, directory) })
        );
      }
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0),(?,'CO','es-CO','America/Bogota',0)"
            )
            .bind(weeklySummaryTestUser, weeklySummaryOtherUser),
          db
            .prepare(
              "INSERT INTO proactivity_consent_offers(id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms) VALUES ('offer',?,'manual-entry-reminder','portfolio','subject','{}',100,200)"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO consent_history(record_type,id,user_id,kind,offer_id,decision_message_id,record_json,occurred_at_ms) VALUES ('proactivity_grant','grant',?,'manual-entry-reminder','offer','decision','{}',100)"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO weekly_schedules(id,user_id,version,enabled,weekday,hour,minute,time_zone,service_market,locale,next_scheduled_at,consent_grant_id,last_evaluated_at_ms) VALUES ('same-id',?,7,0,2,18,30,'America/Bogota','CO','es-CO','2026-10-20T23:30:00.000Z','weekly-grant',123)"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO reminder_schedules(id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id,last_evaluated_at_ms) VALUES ('same-id',?,3,1,'{\"cadence\":{\"kind\":\"weekdays\"}}','2026-10-19T23:00:00.000Z','grant',456)"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO weekly_schedule_revisions(user_id,schedule_id,version,snapshot_json) VALUES (?,'same-id',7,'{\"frozen\":\"weekly\"}')"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO reminder_schedule_revisions(user_id,schedule_id,version,snapshot_json) VALUES (?,'same-id',3,'{\"frozen\":\"reminder\"}')"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO weekly_schedule_executions(user_id,schedule_id,schedule_version,scheduled_at,outcome) VALUES (?,'same-id',7,'2026-10-13T23:30:00.000Z','empty')"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO reminder_schedule_executions(user_id,schedule_id,schedule_version,scheduled_at,outcome) VALUES (?,'same-id',3,'2026-10-16T23:00:00.000Z','generated')"
            )
            .bind(weeklySummaryTestUser),
        ])
      );
      yield* Effect.tryPromise(() =>
        applyTestMigration({ db, source: new URL("0136_schedules.sql", directory) })
      );
      const rows = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT kind,id,version,enabled,next_scheduled_at,consent_grant_id,last_evaluated_at_ms FROM schedules ORDER BY kind"
          )
          .all()
      );
      expect(rows.results).toEqual([
        {
          kind: "reminder",
          id: "same-id",
          version: 3,
          enabled: 1,
          next_scheduled_at: "2026-10-19T23:00:00.000Z",
          consent_grant_id: "grant",
          last_evaluated_at_ms: 456,
        },
        {
          kind: "weekly",
          id: "same-id",
          version: 7,
          enabled: 0,
          next_scheduled_at: "2026-10-20T23:30:00.000Z",
          consent_grant_id: "weekly-grant",
          last_evaluated_at_ms: 123,
        },
      ]);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT json_extract(snapshot_json,'$.timing.weekday') AS weekday,json_extract(snapshot_json,'$.timing.hour') AS hour,json_extract(snapshot_json,'$.timing.minute') AS minute,json_extract(snapshot_json,'$.timeZone') AS timeZone FROM schedules WHERE kind='weekly'"
            )
            .first()
        )
      ).toEqual({ weekday: 2, hour: 18, minute: 30, timeZone: "America/Bogota" });
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT kind,version,snapshot_json FROM schedule_revisions ORDER BY kind")
            .all()
        )).results
      ).toEqual([
        { kind: "reminder", version: 3, snapshot_json: '{"frozen":"reminder"}' },
        { kind: "weekly", version: 7, snapshot_json: '{"frozen":"weekly"}' },
      ]);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT kind,schedule_version,scheduled_at,outcome FROM schedule_executions ORDER BY kind"
            )
            .all()
        )).results
      ).toEqual([
        {
          kind: "reminder",
          schedule_version: 3,
          scheduled_at: "2026-10-16T23:00:00.000Z",
          outcome: "generated",
        },
        {
          kind: "weekly",
          schedule_version: 7,
          scheduled_at: "2026-10-13T23:30:00.000Z",
          outcome: "empty",
        },
      ]);
      for (const statement of [
        db.prepare("UPDATE schedule_revisions SET snapshot_json='{}'"),
        db.prepare("DELETE FROM schedule_executions"),
        db
          .prepare(
            "INSERT INTO schedule_executions(kind,user_id,schedule_id,schedule_version,scheduled_at,outcome) VALUES ('weekly',?,'same-id',7,'2026-10-20T23:30:00.000Z','generated')"
          )
          .bind(weeklySummaryOtherUser),
        db
          .prepare(
            "INSERT INTO schedule_executions(kind,user_id,schedule_id,schedule_version,scheduled_at,outcome) VALUES ('reminder',?,'same-id',3,'2026-10-19T23:00:00.000Z','empty')"
          )
          .bind(weeklySummaryTestUser),
      ]) {
        expect((yield* Effect.exit(Effect.tryPromise(() => statement.run())))._tag).toBe("Failure");
      }
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
    })
);

it.live(
  "preserves frozen report content, independent evidence and delivery progress when report stores are combined",
  () =>
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => weeklySummaryTestDatabases.acquire());
      const directory = new URL("../migrations/", import.meta.url);
      const names = Array.from(new Bun.Glob("*.sql").scanSync(directory.pathname))
        .filter((name) => name < "0137_")
        .sort();
      for (const name of names) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(name, directory) })
        );
      }
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0),(?,'CO','es-CO','America/Bogota',0)"
            )
            .bind(weeklySummaryTestUser, weeklySummaryOtherUser),
          db
            .prepare(
              "INSERT INTO proactivity_consent_offers(id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms) VALUES ('offer',?,'manual-entry-reminder','portfolio','subject','{}',100,200)"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO consent_history(record_type,id,user_id,kind,offer_id,decision_message_id,record_json,occurred_at_ms) VALUES ('proactivity_grant','grant',?,'manual-entry-reminder','offer','decision','{}',100)"
            )
            .bind(weeklySummaryTestUser),
          ...["shared-id", "reminder", "digest", "retained-detail"].map((id) =>
            db
              .prepare(
                "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) VALUES (?,?,'weekly-summary',?,1,'CO','es-CO','America/Bogota','2026-10-18T00:00:00.000Z','[]')"
              )
              .bind(id, weeklySummaryTestUser, id)
          ),
          db
            .prepare(
              "INSERT INTO weekly_summary_reports(user_id,insight_event_id,consent_grant_id,payload_json,presentation_json,scheduled_at_ms,expires_at_ms) VALUES (?,'shared-id','weekly-grant','{\"amount\":\"12345678901234567890.12\"}','{\"text\":\"Original weekly report\"}',1000,2000)"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO proactivity_reports(delivery_id,user_id,role,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES ('shared-id',?,'budget-offer','offer','Original offer',1000,3000,'America/Bogota',900)"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO proactivity_reports(delivery_id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES ('reminder',?,'manual-entry-reminder','grant','Original reminder',1000,6000,'America/Bogota',900),('digest',?,'new-recurring-series','grant','Original digest',1000,6000,'America/Bogota',900)"
            )
            .bind(weeklySummaryTestUser, weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO reminder_occurrence_reports(user_id,insight_event_id,consent_grant_id,expires_at_ms) VALUES (?,'reminder','grant',5000)"
            )
            .bind(weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO recurring_digest_reports(user_id,insight_event_id,instruction_id,instruction_version,grant_id,local_date,day_from_ms,day_to_ms,report_json) VALUES (?,'digest','instruction',4,'original-grant','2026-10-17',10,20,'{\"text\":\"Original digest details\"}'),(?,'retained-detail','instruction',2,'retained-grant','2026-10-16',0,10,'{\"text\":\"Independently retained details\"}')"
            )
            .bind(weeklySummaryTestUser, weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO proactivity_delivery_outbox(user_id,kind,delivery_id,state,created_at_ms,last_attempt_at_ms,restart_attempts) VALUES (?,'weekly-summary','shared-id','ready',900,1100,2),(?,'proactivity-delivery','reminder','started',901,1200,1),(?,'proactivity-delivery','digest','expired',902,1300,3)"
            )
            .bind(weeklySummaryTestUser, weeklySummaryTestUser, weeklySummaryTestUser),
          db
            .prepare(
              "INSERT INTO proactivity_message_events(user_id,delivery_id,insight_event_id) VALUES (?,'reminder','reminder')"
            )
            .bind(weeklySummaryTestUser),
        ])
      );
      const deliveryBefore = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM proactivity_delivery_metadata ORDER BY kind,delivery_id").all()
      );
      yield* Effect.tryPromise(() =>
        applyTestMigration({ db, source: new URL("0137_insight_reports.sql", directory) })
      );
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM proactivity_delivery_metadata ORDER BY kind,delivery_id").all()
        )).results
      ).toEqual(deliveryBefore.results);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT payload_json,presentation_json,expires_at_ms FROM insight_reports WHERE kind='weekly-summary' AND delivery_id='shared-id'"
            )
            .first()
        )
      ).toEqual({
        payload_json: '{"amount":"12345678901234567890.12"}',
        presentation_json: '{"text":"Original weekly report"}',
        expires_at_ms: 2000,
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT text,expires_at_ms,reminder_grant_id,reminder_expires_at_ms FROM insight_reports WHERE kind='proactivity-delivery' AND delivery_id='reminder'"
            )
            .first()
        )
      ).toEqual({
        text: "Original reminder",
        expires_at_ms: 6000,
        reminder_grant_id: "grant",
        reminder_expires_at_ms: 5000,
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE insight_reports SET text=NULL WHERE delivery_id='digest' AND kind='proactivity-delivery'"
          )
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT delivery_id,report_json,grant_id,instruction_version FROM insight_reports WHERE report_json IS NOT NULL ORDER BY delivery_id"
            )
            .all()
        )).results
      ).toEqual([
        {
          delivery_id: "digest",
          report_json: '{"text":"Original digest details"}',
          grant_id: "original-grant",
          instruction_version: 4,
        },
        {
          delivery_id: "retained-detail",
          report_json: '{"text":"Independently retained details"}',
          grant_id: "retained-grant",
          instruction_version: 2,
        },
      ]);
      for (const statement of [
        db.prepare("UPDATE insight_reports SET payload_json='{}' WHERE kind='weekly-summary'"),
        db.prepare(
          "UPDATE insight_reports SET report_json='{}',text=NULL WHERE delivery_id='digest'"
        ),
        db.prepare(
          "UPDATE insight_reports SET text='Regenerated digest' WHERE delivery_id='digest'"
        ),
        db
          .prepare(
            "INSERT INTO proactivity_delivery_outbox(user_id,kind,delivery_id,created_at_ms) VALUES (?,'weekly-summary','reminder',900)"
          )
          .bind(weeklySummaryTestUser),
        db
          .prepare(
            "INSERT INTO proactivity_delivery_outbox(user_id,kind,delivery_id,created_at_ms) VALUES (?,'proactivity-delivery','shared-id',900)"
          )
          .bind(weeklySummaryOtherUser),
        db
          .prepare(
            "INSERT INTO proactivity_delivery_outbox(user_id,kind,delivery_id,created_at_ms) VALUES (?,'proactivity-delivery','retained-detail',900)"
          )
          .bind(weeklySummaryTestUser),
      ]) {
        expect((yield* Effect.exit(Effect.tryPromise(() => statement.run())))._tag).toBe("Failure");
      }
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
    })
);
