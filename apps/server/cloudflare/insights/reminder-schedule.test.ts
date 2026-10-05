import assert from "node:assert/strict";
import { afterAll, expect, it } from "vitest";
import { DateTime, Effect, Exit, Option } from "effect";
import {
  activateTestReminder,
  proactivityDatabase,
  proactivityTestCallers,
  proactivityTestDatabases,
  proactivityTestNow,
  proactivityTestUsers,
} from "../proactivity.test-fixture";
import {
  createProactivityConsentOffer,
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
        id: schedule.id,
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
      expect(
        (yield* materializeReminder({ db, userId: context.userId, id: schedule.id, now }))._tag
      ).toBe("NoWork");
      expect(
        (yield* materializeReminder({ db, userId: proactivityTestUsers[1], id: schedule.id, now }))
          ._tag
      ).toBe("NoWork");
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
            "CREATE TRIGGER reject_reminder_outbox BEFORE INSERT ON reminder_outbox BEGIN SELECT RAISE(ABORT,'test_outbox_refusal'); END"
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
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER reject_reminder_outbox").run());
      expect((yield* materializeReminder(input))._tag).toBe("Created");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM reminder_outbox WHERE user_id=?")
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
          id: schedule.id,
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
