import assert from "node:assert/strict";
import { afterAll, expect, it } from "vitest";
import { type Cause, DateTime, Effect, Exit, Option } from "effect";
import {
  activateTestReminder,
  proactivityDatabase,
  proactivityTestCallers,
  proactivityTestDatabases,
  proactivityTestNow,
  proactivityTestUsers,
  withdrawTestProcessingConsent,
} from "../proactivity.test-fixture";
import {
  createProactivityConsentOffer,
  findProactivityConsentGrant,
  readConsentStatus,
  recordProactivityConsentDisclosure,
} from "../consent/operations";
import { ReminderRevisionConflict } from "./contract";
import {
  findInsight,
  findReminderSchedule,
  materializeReminder,
  prepareReminderRevision,
  recordProactivityDecision,
} from "./operations";

afterAll(() => proactivityTestDatabases.dispose());

const reminderPersistence = (
  db: D1Database
): Effect.Effect<Option.Option<Readonly<Record<string, unknown>>>, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db
      .prepare(`
  SELECT s.*,
    (SELECT count(*) FROM insight_events WHERE user_id=s.user_id) AS events,
    (SELECT count(*) FROM insight_events WHERE kind='manual-entry-reminder' AND reminder_grant_id IS NOT NULL AND user_id=s.user_id) AS reports,
    (SELECT count(*) FROM (SELECT rowid,user_id,kind,id AS delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM proactive_messages WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='proactivity-delivery' AND user_id=s.user_id) AS outbox,
    (SELECT count(*) FROM (SELECT rowid,kind,user_id,schedule_id,version AS schedule_version,scheduled_at,outcome FROM schedule_history WHERE record_type='execution') WHERE kind='reminder' AND user_id=s.user_id) AS executions,
    (SELECT count(*) FROM (SELECT rowid,kind,user_id,schedule_id,version,snapshot_json FROM schedule_history WHERE record_type='revision') WHERE kind='reminder' AND user_id=s.user_id) AS revisions,
    (SELECT standing_json FROM reminder_proactivity_state AS reminder_governors WHERE user_id=s.user_id) AS standing_json
  FROM schedules s WHERE kind='reminder' AND user_id=?`)
      .bind(proactivityTestUsers[0])
      .first()
  ).pipe(Effect.map(Option.fromNullOr));

it("refuses due reminder materialization after processing withdrawal without disabling or advancing the enabled schedule", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      yield* activateTestReminder(db);
      const before = yield* reminderPersistence(db);
      expect(Option.getOrThrow(before)).toMatchObject({
        enabled: 1,
        version: 1,
        events: 0,
        reports: 0,
        outbox: 0,
        executions: 0,
        revisions: 1,
      });
      yield* withdrawTestProcessingConsent(db);
      expect(yield* readConsentStatus({ db, userId: proactivityTestUsers[0] })).toBe("Revoked");
      expect(
        (yield* materializeReminder({
          db,
          userId: proactivityTestUsers[0],
          now: DateTime.makeUnsafe("2026-10-06T23:00:00Z"),
        }))._tag
      ).toBe("NoWork");
      expect(yield* reminderPersistence(db)).toEqual(before);
    })
  ));

it("rolls back a prepared reminder revision when processing Consent is withdrawn before its atomic commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const before = yield* reminderPersistence(db);
      const revision = yield* prepareReminderRevision({
        db,
        userId: proactivityTestUsers[0],
        now: proactivityTestNow,
        input: {
          expectedVersion: schedule.version,
          cadence: { kind: "weekdays" },
          timing: { hour: 9, minute: 0 },
          timeZone: schedule.timeZone,
        },
      });
      yield* withdrawTestProcessingConsent(db);
      expect(yield* readConsentStatus({ db, userId: proactivityTestUsers[0] })).toBe("Revoked");
      expect((yield* Effect.exit(Effect.tryPromise(() => db.batch([...revision]))))._tag).toBe(
        "Failure"
      );
      expect(yield* reminderPersistence(db)).toEqual(before);
    })
  ));

it.each(["budget-threshold", "manual-entry-reminder"] as const)(
  "refuses %s acceptance exactly at and after expiry without receipts, authority or reminder activation",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        const input = {
          db,
          userId: proactivityTestUsers[0],
          caller: proactivityTestCallers[0],
          kind,
          now: proactivityTestNow,
        };
        const offer = Option.getOrThrow(yield* createProactivityConsentOffer(input));
        expect(
          yield* recordProactivityConsentDisclosure({
            ...input,
            offerId: offer.id,
            disclosureMessageId: "expiry-disclosure",
          })
        ).toBe(true);
        for (const elapsedMs of [600000, 600001]) {
          expect(
            yield* recordProactivityDecision({
              ...input,
              now: DateTime.makeUnsafe(proactivityTestNow.epochMilliseconds + elapsedMs),
              choice: offer.acceptChoice,
              decisionMessageId: `expired-${elapsedMs}`,
            })
          ).toBe(false);
          expect(Option.isNone(yield* findProactivityConsentGrant(input))).toBe(true);
          expect(Option.isNone(yield* findReminderSchedule(input))).toBe(true);
        }
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                `SELECT decision_message_id,decision FROM (SELECT rowid,* FROM consent_offers WHERE kind<>'weekly-summary') AS proactivity_consent_offers WHERE id=?`
              )
              .bind(offer.id)
              .first()
          )
        ).toEqual({ decision_message_id: null, decision: null });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(`SELECT
    (SELECT count(*) FROM (SELECT * FROM consent_history WHERE record_type='proactivity_grant') AS proactivity_consent_records WHERE user_id=u.id) AS consent_records,
    (SELECT count(*) FROM schedules WHERE kind='reminder' AND user_id=u.id) AS schedules,
    (SELECT count(*) FROM reminder_proactivity_state AS reminder_governors WHERE user_id=u.id) AS governors,
    (SELECT count(*) FROM insight_events WHERE user_id=u.id) AS events,
    (SELECT count(*) FROM (SELECT rowid,user_id,kind,id AS delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM proactive_messages WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='proactivity-delivery' AND user_id=u.id) AS outbox
    FROM users u WHERE id=?`)
              .bind(input.userId)
              .first()
          )
        ).toEqual({ consent_records: 0, schedules: 0, governors: 0, events: 0, outbox: 0 });
      })
    )
);

it("activates the disclosed daily 18:00 Bogotá reminder atomically with legal evidence and recovers only the latest occurrence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = {
        db,
        userId: proactivityTestUsers[0],
        caller: proactivityTestCallers[0],
        kind: "manual-entry-reminder" as const,
        now: proactivityTestNow,
      };
      const schedule = yield* activateTestReminder(db);
      expect(schedule.cadence).toEqual({ kind: "daily" });
      expect(schedule.timing).toEqual({ hour: 18, minute: 0 });
      expect(schedule.timeZone).toBe("America/Bogota");
      expect(DateTime.formatIso(schedule.nextScheduledAt)).toBe("2026-10-06T23:00:00.000Z");
      expect(
        Option.isNone(yield* findReminderSchedule({ ...context, userId: proactivityTestUsers[1] }))
      ).toBe(true);
      const now = DateTime.makeUnsafe("2026-10-10T23:30:00Z");
      const generated = yield* materializeReminder({
        db,
        userId: context.userId,
        now,
      });
      expect(generated._tag).toBe("Created");
      if (generated._tag !== "Created") return;
      const event = Option.getOrThrow(
        yield* findInsight({ db, userId: context.userId, id: generated.id })
      );
      expect(event.kind).toBe("manual-entry-reminder");
      expect(DateTime.formatIso(event.scheduledAt)).toBe("2026-10-10T23:00:00.000Z");
      expect(event.scheduleVersion).toBe(schedule.version);
      expect((yield* materializeReminder({ db, userId: context.userId, now }))._tag).toBe("NoWork");
      expect((yield* materializeReminder({ db, userId: proactivityTestUsers[1], now }))._tag).toBe(
        "NoWork"
      );
      const next = Option.getOrThrow(yield* findReminderSchedule(context));
      expect(next.version).toBe(schedule.version);
      expect(DateTime.formatIso(next.nextScheduledAt)).toBe("2026-10-11T23:00:00.000Z");
      const revision = yield* prepareReminderRevision({
        db,
        userId: context.userId,
        now,
        input: {
          expectedVersion: schedule.version,
          cadence: { kind: "weekdays" },
          timing: { hour: 10, minute: 0 },
          timeZone: schedule.timeZone,
        },
      });
      yield* Effect.tryPromise(() => db.batch([...revision]));
      const edited = Option.getOrThrow(yield* findReminderSchedule(context));
      expect(edited.version).toBe(2);
      expect(edited.timing).toEqual({ hour: 10, minute: 0 });
      const original = Option.getOrThrow(
        yield* findInsight({ db, userId: context.userId, id: generated.id })
      );
      expect(original.scheduleVersion).toBe(1);
      expect(DateTime.formatIso(original.scheduledAt)).toBe("2026-10-10T23:00:00.000Z");
      assert.deepStrictEqual(
        yield* Effect.exit(
          prepareReminderRevision({
            db,
            userId: context.userId,
            now,
            input: {
              expectedVersion: schedule.version,
              cadence: { kind: "daily" },
              timing: schedule.timing,
              timeZone: schedule.timeZone,
            },
          })
        ),
        Exit.fail(new ReminderRevisionConflict())
      );
    })
  ));

it("rolls back reminder occurrence, outbox and execution advancement together when durable publication fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const input = {
        db,
        userId: proactivityTestUsers[0],
        id: schedule.id,
        now: DateTime.makeUnsafe("2026-10-06T23:00:00Z"),
      };
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER reject_proactivity_outbox BEFORE INSERT ON proactive_messages WHEN NEW.dispatch_state IS NOT NULL BEGIN SELECT RAISE(ABORT,'test_outbox_refusal'); END"
          )
          .run()
      );
      expect((yield* Effect.exit(materializeReminder(input)))._tag).toBe("Failure");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM insight_events WHERE user_id=?")
            .bind(input.userId)
            .first()
        )
      ).toEqual({ count: 0 });
      const after = Option.getOrThrow(yield* findReminderSchedule(input));
      expect(DateTime.formatIso(after.nextScheduledAt)).toBe(
        DateTime.formatIso(schedule.nextScheduledAt)
      );
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER reject_proactivity_outbox").run());
      expect((yield* materializeReminder(input))._tag).toBe("Created");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT rowid,user_id,kind,id AS delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM proactive_messages WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='proactivity-delivery' AND user_id=?"
            )
            .bind(input.userId)
            .first()
        )
      ).toEqual({ count: 1 });
    })
  ));

it("atomically disables reminders when their category grant is revoked and refuses foreign revision work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const input = {
        db,
        userId: proactivityTestUsers[0],
        caller: proactivityTestCallers[0],
        kind: "manual-entry-reminder" as const,
        now: proactivityTestNow,
      };
      const edit = {
        expectedVersion: schedule.version,
        cadence: { kind: "daily" as const },
        timing: { hour: 9, minute: 0 },
        timeZone: schedule.timeZone,
      };
      expect(
        (yield* Effect.exit(
          prepareReminderRevision({ ...input, userId: proactivityTestUsers[1], input: edit })
        ))._tag
      ).toBe("Failure");
      const offer = Option.getOrThrow(yield* createProactivityConsentOffer(input));
      yield* recordProactivityConsentDisclosure({
        ...input,
        offerId: offer.id,
        disclosureMessageId: "stop-disclosed",
      });
      expect(
        yield* recordProactivityDecision({
          ...input,
          choice: offer.revokeChoice,
          decisionMessageId: "stop-reminders",
        })
      ).toBe(true);
      const disabled = Option.getOrThrow(yield* findReminderSchedule(input));
      expect(disabled.enabled).toBe(false);
      expect(disabled.timing).toEqual(schedule.timing);
      expect(
        (yield* materializeReminder({
          ...input,
          now: DateTime.makeUnsafe("2026-10-06T23:00:00Z"),
        }))._tag
      ).toBe("NoWork");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM insight_events WHERE user_id=?")
            .bind(input.userId)
            .first()
        )
      ).toEqual({ count: 0 });
    })
  ));

it("evaluates current instructions from a User wake after revision and retains one occurrence with its original deadline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const userId = proactivityTestUsers[0];
      const wake = { db, userId };
      const revision = yield* prepareReminderRevision({
        ...wake,
        now: proactivityTestNow,
        input: {
          expectedVersion: schedule.version,
          cadence: { kind: "weekdays" },
          timing: { hour: 9, minute: 0 },
          timeZone: schedule.timeZone,
        },
      });
      yield* Effect.tryPromise(() => db.batch([...revision]));
      const now = DateTime.makeUnsafe("2026-10-09T15:00:00Z");
      const generated = yield* materializeReminder({ ...wake, now });
      expect(generated._tag).toBe("Created");
      if (generated._tag !== "Created") return;
      const event = Option.getOrThrow(yield* findInsight({ ...wake, id: generated.id }));
      expect(event.scheduleVersion).toBe(2);
      expect(DateTime.formatIso(event.scheduledAt)).toBe("2026-10-09T14:00:00.000Z");
      expect(yield* materializeReminder({ ...wake, now })).toEqual({ _tag: "NoWork" });
      expect(Option.getOrThrow(yield* reminderPersistence(db))).toMatchObject({
        events: 1,
        reports: 1,
        outbox: 1,
        executions: 1,
        revisions: 2,
        next_scheduled_at: "2026-10-12T14:00:00.000Z",
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT scheduled_at_ms,expires_at_ms,dispatch_state FROM proactive_messages WHERE user_id=? AND id=?"
            )
            .bind(userId, generated.id)
            .first()
        )
      ).toEqual({
        scheduled_at_ms: Date.parse("2026-10-09T14:00:00Z"),
        expires_at_ms: Date.parse("2026-10-10T14:00:00Z"),
        dispatch_state: "ready",
      });
    })
  ));

it("rejects a revision committed after due reading without partially admitting the stale occurrence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const userId = proactivityTestUsers[0];
      const now = DateTime.makeUnsafe("2026-10-06T23:00:00Z");
      const revision = yield* prepareReminderRevision({
        db,
        userId,
        now: proactivityTestNow,
        input: {
          expectedVersion: schedule.version,
          cadence: schedule.cadence,
          timing: { hour: 9, minute: 0 },
          timeZone: schedule.timeZone,
        },
      });
      const nativeBatch = db.batch.bind(db);
      const racingDb = new Proxy(db, {
        get(target, property): unknown {
          if (property === "batch") {
            return <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
              nativeBatch([...revision]).then(() => nativeBatch<Row>(statements));
          }
          return Reflect.get(target, property);
        },
      });
      expect((yield* Effect.exit(materializeReminder({ db: racingDb, userId, now })))._tag).toBe(
        "Failure"
      );
      expect(Option.getOrThrow(yield* reminderPersistence(db))).toMatchObject({
        version: 2,
        events: 0,
        reports: 0,
        outbox: 0,
        executions: 0,
        revisions: 2,
        next_scheduled_at: "2026-10-06T14:00:00.000Z",
      });
      expect((yield* materializeReminder({ db, userId, now }))._tag).toBe("Created");
      expect(Option.getOrThrow(yield* reminderPersistence(db))).toMatchObject({
        version: 2,
        events: 1,
        reports: 1,
        outbox: 1,
        executions: 1,
        revisions: 2,
      });
    })
  ));

it("keeps an uncertain committed admission without replaying or extending its deadline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      yield* activateTestReminder(db);
      const input = {
        db,
        userId: proactivityTestUsers[0],
        now: DateTime.makeUnsafe("2026-10-06T23:30:00Z"),
      };
      const nativeBatch = db.batch.bind(db);
      const uncertainDb = new Proxy(db, {
        get(target, property): unknown {
          if (property === "batch") {
            return (statements: D1PreparedStatement[]): Promise<never> =>
              nativeBatch(statements).then(() =>
                Promise.reject(new Error("Native commit response lost"))
              );
          }
          return Reflect.get(target, property);
        },
      });
      expect((yield* Effect.exit(materializeReminder({ ...input, db: uncertainDb })))._tag).toBe(
        "Failure"
      );
      const committed = yield* reminderPersistence(db);
      expect(Option.getOrThrow(committed)).toMatchObject({
        events: 1,
        reports: 1,
        outbox: 1,
        executions: 1,
      });
      expect(
        yield* materializeReminder({ ...input, now: DateTime.makeUnsafe("2026-10-07T00:30:00Z") })
      ).toEqual({ _tag: "NoWork" });
      expect(yield* reminderPersistence(db)).toEqual(committed);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT scheduled_at_ms,expires_at_ms FROM proactive_messages WHERE user_id=? AND role='manual-entry-reminder'"
            )
            .bind(input.userId)
            .first()
        )
      ).toEqual({
        scheduled_at_ms: Date.parse("2026-10-06T23:00:00Z"),
        expires_at_ms: Date.parse("2026-10-07T23:00:00Z"),
      });
    })
  ));

it("resets standing with the same enabled grant without minting an instruction revision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const context = {
        db,
        userId: proactivityTestUsers[0],
        caller: proactivityTestCallers[0],
        kind: "manual-entry-reminder" as const,
        now: proactivityTestNow,
      };
      const grant = yield* findProactivityConsentGrant(context);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE reminder_proactivity_state SET standing_json=? WHERE user_id=?")
          .bind('{"_tag":"Paused","unanswered":3}', context.userId)
          .run()
      );
      const offer = Option.getOrThrow(yield* createProactivityConsentOffer(context));
      yield* recordProactivityConsentDisclosure({
        ...context,
        offerId: offer.id,
        disclosureMessageId: "continue-disclosed",
      });
      expect(
        yield* recordProactivityDecision({
          ...context,
          choice: offer.acceptChoice,
          decisionMessageId: "continue-accepted",
        })
      ).toBe(true);
      expect(yield* findProactivityConsentGrant(context)).toEqual(grant);
      expect(Option.getOrThrow(yield* findReminderSchedule(context))).toEqual(schedule);
      expect(Option.getOrThrow(yield* reminderPersistence(db))).toMatchObject({
        version: 1,
        revisions: 1,
        events: 0,
        executions: 0,
        outbox: 0,
        standing_json: '{"_tag":"Attentive","unanswered":0}',
      });
    })
  ));
