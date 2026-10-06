import { afterAll, expect, it } from "vitest";
import { type Cause, DateTime, Effect, Option } from "effect";
import { makeAudit } from "../../src/shell/audit/runtime";
import { ToolCallId, TranscriptTurnId } from "../../src/core/agent/contract";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import {
  executeCanonicalWork,
  executeHostedStatementCall,
  executeHostedStatementQuery,
  installedCanonicalOperations,
  installedHostedStatementOperations,
} from "../canonical-operations/operations";
import { callerAuthority } from "../canonical-work/operations";
import { type AuthorizedPAT } from "../tokens/contract";
import { UserId } from "../../src/core/identity/contract";
import {
  activateTestReminder,
  endTestHostedAuthority,
  proactivityDatabase,
  proactivityHostedCaller,
  proactivityTestDatabases,
  proactivityTestNow,
  proactivityTestUsers,
} from "../proactivity.test-fixture";
import {
  findReminderSchedule,
  prepareCanonicalReminderRevision,
  readCanonicalReminderSchedule,
  readHeldReminderSchedule,
} from "./operations";

const sessionId = "10000000-0000-4000-8000-000000000071";
const subject = {
  id: sessionId,
  userId: proactivityTestUsers[0],
  digest: new Uint8Array(32).fill(7),
};
afterAll(() => proactivityTestDatabases.dispose());

it("requires exact live PAT capabilities and atomically accounts for activity without granting Consent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const current = proactivityTestNow.epochMilliseconds;
      const pat: AuthorizedPAT = {
        patId: sessionId,
        userId: subject.userId,
        digest: subject.digest,
        requiredScope: Option.some("read"),
      };
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO pats(id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id) VALUES (?,?,'12345678',?,'agent','[\"write\"]',7,?,?,?,?)"
          )
          .bind(pat.patId, pat.userId, pat.digest, current, current, current + 600000, sessionId)
          .run()
      );
      expect((yield* readCanonicalReminderSchedule({ db, subject: pat, current })).status).not.toBe(
        200
      );
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE pats SET scopes_json='[\"read\"]' WHERE id=?").bind(pat.patId).run()
      );
      const deniedWrite = yield* executeCanonicalWork({
        oauthConfirmation: Option.none(),
        db,
        subject: pat,
        current,
        bucket: Option.none(),
        hostedFence: Option.none(),
        inference: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("insights.updateReminderSchedule"),
          input: {
            payload: {
              expectedVersion: schedule.version,
              cadence: { kind: "daily" },
              timing: { hour: 10, minute: 0 },
              timeZone: schedule.timeZone,
            },
          },
        },
      });
      expect(deniedWrite.status).not.toBe(200);
      expect(
        Option.getOrThrow(yield* findReminderSchedule({ db, userId: subject.userId })).version
      ).toBe(1);
      yield* Effect.tryPromise(() =>
        db
          .prepare('UPDATE pats SET scopes_json=\'["read","write"]\' WHERE id=?')
          .bind(pat.patId)
          .run()
      );
      expect((yield* readCanonicalReminderSchedule({ db, subject: pat, current })).status).toBe(
        200
      );
      const result = yield* executeCanonicalWork({
        oauthConfirmation: Option.none(),
        db,
        subject: pat,
        current,
        bucket: Option.none(),
        hostedFence: Option.none(),
        inference: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("insights.updateReminderSchedule"),
          input: {
            payload: {
              expectedVersion: schedule.version,
              cadence: { kind: "daily" },
              timing: { hour: 10, minute: 0 },
              timeZone: schedule.timeZone,
            },
          },
        },
      });
      expect(result.status).toBe(200);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT last_used_at_ms FROM pats WHERE id=?").bind(pat.patId).first()
        )
      ).toEqual({ last_used_at_ms: current });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT operation,outcome FROM pat_audit WHERE user_id=? AND outcome='accepted' ORDER BY rowid"
            )
            .bind(pat.userId)
            .all()
        )
      ).toMatchObject({
        results: [
          { operation: "insights.getReminderSchedule", outcome: "accepted" },
          { operation: "insights.updateReminderSchedule", outcome: "accepted" },
        ],
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS n FROM proactivity_consent_records WHERE user_id=?")
            .bind(pat.userId)
            .first()
        )
      ).toEqual({ n: 1 });
    })
  ));
it("binds held reminder reads to the authority's User and refuses expired sessions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      yield* activateTestReminder(db);
      yield* seedSession(db);
      const current = proactivityTestNow.epochMilliseconds;
      const substituted = yield* readHeldReminderSchedule({
        db,
        userId: proactivityTestUsers[1],
        authority: callerAuthority({ subject, current }),
        requiredScope: Option.none(),
        current,
      });
      expect(substituted.status).not.toBe(200);
      expect(
        (yield* readCanonicalReminderSchedule({ db, subject, current: current + 3600000 })).status
      ).not.toBe(200);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS n FROM insight_audit").first()
        )
      ).toEqual({ n: 0 });
    })
  ));

it("rolls back a competing prepared canonical edit and all its Audit without rewriting the winning instructions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      yield* seedSession(db);
      const input = {
        expectedVersion: schedule.version,
        cadence: schedule.cadence,
        timing: { hour: 10, minute: 0 },
        timeZone: schedule.timeZone,
      };
      const first = yield* prepareCanonicalReminderRevision({
        db,
        subject,
        current: proactivityTestNow.epochMilliseconds,
        input,
      });
      const second = yield* prepareCanonicalReminderRevision({
        db,
        subject,
        current: proactivityTestNow.epochMilliseconds,
        input: { ...input, timing: { hour: 11, minute: 0 } },
      });
      if (first._tag !== "Prepared" || second._tag !== "Prepared") {
        throw new Error("Expected preparations");
      }
      yield* Effect.tryPromise(() => db.batch([...first.mutation.statements, completion(db)]));
      expect(
        (yield* Effect.exit(
          Effect.tryPromise(() => db.batch([...second.mutation.statements, completion(db)]))
        ))._tag
      ).toBe("Failure");
      expect(
        Option.getOrThrow(yield* findReminderSchedule({ db, userId: subject.userId })).timing.hour
      ).toBe(10);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT (SELECT count(*) FROM insight_audit) AS audits,(SELECT count(*) FROM reminder_schedule_revisions) AS revisions"
            )
            .first()
        )
      ).toEqual({ audits: 1, revisions: 2 });
    })
  ));

it("shares canonical reads with live hosted authority, attributes Audit to the Turn, and rejects unconfirmed or inactive work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      const caller = yield* proactivityHostedCaller(db);
      const work = {
        db,
        bucket: Option.none<R2Bucket>(),
        caller,
        current: proactivityTestNow.epochMilliseconds,
        input: {},
      };
      expect(
        (yield* executeHostedStatementQuery({ ...work, operation: "insights.getReminderSchedule" }))
          .status
      ).toBe(200);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT hosted_turn_id,session_id,operation FROM insight_audit WHERE user_id=?"
            )
            .bind(caller.userId)
            .first()
        )
      ).toEqual({
        hosted_turn_id: caller.turnId,
        session_id: null,
        operation: "insights.getReminderSchedule",
      });
      const evidence = yield* makeAudit({ database: db }).query({
        userId: caller.userId,
        limit: 10,
      });
      expect(evidence).toMatchObject([
        {
          caller: { _tag: "HostedTurn", turnId: caller.turnId },
          operation: "insights.getReminderSchedule",
          outcome: "succeeded",
        },
      ]);
      const rejected = yield* executeHostedStatementCall({
        ...work,
        operation: "insights.updateReminderSchedule",
        input: {
          payload: {
            expectedVersion: schedule.version,
            cadence: schedule.cadence,
            timing: { hour: 10, minute: 0 },
            timeZone: schedule.timeZone,
          },
        },
        fence: {
          turnId: TranscriptTurnId.make(caller.turnId),
          toolCallId: ToolCallId.make("unconfirmed-reminder"),
        },
      });
      expect(rejected.status).not.toBe(200);
      yield* endTestHostedAuthority({ db, caller });
      expect(
        (yield* executeHostedStatementQuery({ ...work, operation: "insights.getReminderSchedule" }))
          .status
      ).not.toBe(200);
      expect(
        Option.getOrThrow(yield* findReminderSchedule({ db, userId: subject.userId })).version
      ).toBe(1);
    })
  ));

const completion = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "INSERT INTO insight_mutation_assertion(id,accepted) VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted"
  );
const seedSession = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => {
    const now = proactivityTestNow.epochMilliseconds;
    return db
      .batch([
        db
          .prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,'123456789',?,?,'consumed',?,?)"
          )
          .bind(sessionId, subject.digest, subject.userId, now, now + 600000),
        db
          .prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)"
          )
          .bind(
            sessionId,
            sessionId,
            subject.userId,
            subject.digest,
            now,
            now + 600000,
            now + 3600000,
            now + 7776000000
          ),
      ])
      .then(() => undefined);
  });

it("reads and revises reminder instructions through live canonical authority with atomic Audit and stale-version refusal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      yield* seedSession(db);
      const read = yield* readCanonicalReminderSchedule({
        db,
        subject,
        current: proactivityTestNow.epochMilliseconds,
      });
      expect(read.status).toBe(200);
      expect(yield* Effect.tryPromise(() => read.json())).toMatchObject({
        data: { id: schedule.id, version: 1 },
      });
      const input = {
        expectedVersion: schedule.version,
        cadence: { kind: "weekdays" as const },
        timing: { hour: 9, minute: 0 },
        timeZone: schedule.timeZone,
      };
      expect(installedCanonicalOperations().map((operation) => operation.id)).toContain(
        "insights.updateReminderSchedule"
      );
      expect(installedHostedStatementOperations().map((operation) => operation.id)).toContain(
        "insights.updateReminderSchedule"
      );
      const committed = yield* executeCanonicalWork({
        oauthConfirmation: Option.none(),
        db,
        subject,
        current: proactivityTestNow.epochMilliseconds,
        bucket: Option.none(),
        hostedFence: Option.none(),
        inference: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("insights.updateReminderSchedule"),
          input: { payload: input },
        },
      });
      expect(committed.status).toBe(200);
      expect(yield* Effect.tryPromise(() => committed.json())).toMatchObject({
        data: { version: 2 },
      });
      const revised = Option.getOrThrow(
        yield* findReminderSchedule({ db, userId: subject.userId })
      );
      expect(revised.version).toBe(2);
      expect(revised.timing.hour).toBe(9);
      expect(DateTime.formatIso(revised.nextScheduledAt)).toBe("2026-10-06T14:00:00.000Z");
      expect(
        (yield* prepareCanonicalReminderRevision({
          db,
          subject,
          current: proactivityTestNow.epochMilliseconds,
          input,
        }))._tag
      ).toBe("Refused");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT operation,outcome FROM insight_audit WHERE user_id=? ORDER BY rowid")
            .bind(subject.userId)
            .all()
        )
      ).toMatchObject({
        results: [
          { operation: "insights.getReminderSchedule", outcome: "accepted" },
          { operation: "insights.updateReminderSchedule", outcome: "accepted" },
        ],
      });
    })
  ));

it("refuses a foreign or expired canonical credential without reading instructions or committing revision/Audit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const schedule = yield* activateTestReminder(db);
      yield* seedSession(db);
      const input = {
        expectedVersion: schedule.version,
        cadence: schedule.cadence,
        timing: { hour: 10, minute: 0 },
        timeZone: schedule.timeZone,
      };
      for (const candidate of [
        { ...subject, userId: UserId.make(proactivityTestUsers[1]) },
        { ...subject, digest: new Uint8Array(32).fill(9) },
      ]) {
        const read = yield* readCanonicalReminderSchedule({
          db,
          subject: candidate,
          current: proactivityTestNow.epochMilliseconds,
        });
        expect(read.status).not.toBe(200);
      }
      const prepared = yield* prepareCanonicalReminderRevision({
        db,
        subject,
        current: proactivityTestNow.epochMilliseconds,
        input,
      });
      if (prepared._tag !== "Prepared") throw new Error("Expected preparation");
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms=? WHERE id=?")
          .bind(proactivityTestNow.epochMilliseconds, subject.id)
          .run()
      );
      expect(
        (yield* Effect.exit(
          Effect.tryPromise(() => db.batch([...prepared.mutation.statements, completion(db)]))
        ))._tag
      ).toBe("Failure");
      expect(
        Option.getOrThrow(yield* findReminderSchedule({ db, userId: subject.userId })).version
      ).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS n FROM insight_audit WHERE user_id=?")
            .bind(subject.userId)
            .first()
        )
      ).toEqual({ n: 0 });
    })
  ));
