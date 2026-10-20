import { afterAll, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { recordAuthorizedCall } from "../../../src/shell/audit/operations";
import { makeAudit, makeAuditRetention } from "../../../src/shell/audit/runtime";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import { executeHostedStatementQuery } from "../../canonical-operations/operations";
import {
  proactivityDatabase,
  proactivityHostedCaller,
  proactivityTestBrowser,
  proactivityTestDatabases,
  proactivityTestNow,
  proactivityTestPAT,
  proactivityTestUsers,
} from "../../proactivity.test-fixture";
import { readCanonicalReminderSchedule } from "../../insights/operations";
import { newId } from "../../secret-material/operations";

const current = proactivityTestNow.epochMilliseconds;
const retentionLifetimeMs = 365 * 86400000;
afterAll(() => proactivityTestDatabases.dispose());
it("reads mixed browser/PAT/hosted attribution and enforces append-only and same-User retention guards", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const browser = yield* proactivityTestBrowser(db);
      const id = newId();
      const statement = recordAuthorizedCall({
        authority: liveWebSessionAuthority({ subject: browser, current }),
        id,
        operation: "insights.listPendingInsights",
        outcome: "accepted",
        current,
        afterOwnerWrite: false,
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      const before = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM (SELECT id,user_id,session_id,hosted_turn_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='insight_call') AS insight_audit"
          )
          .all()
      );
      expect(before.results).toHaveLength(1);
      for (const sql of [
        "UPDATE audit_entries SET outcome='rejected' WHERE record_type='insight_call' AND id=?",
        "DELETE FROM audit_entries WHERE record_type='insight_call' AND id=?",
      ]) {
        expect(
          (yield* Effect.exit(Effect.tryPromise(() => db.prepare(sql).bind(id).run())))._tag
        ).toBe("Failure");
      }
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO audit_retention_permits(user_id,cutoff_ms) VALUES (?,?)")
          .bind(proactivityTestUsers[1], current + 1)
          .run()
      );
      expect(
        (yield* Effect.exit(
          Effect.tryPromise(() =>
            db
              .prepare("DELETE FROM audit_entries WHERE record_type='insight_call' AND id=?")
              .bind(id)
              .run()
          )
        ))._tag
      ).toBe("Failure");
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM (SELECT id,user_id,session_id,hosted_turn_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='insight_call') AS insight_audit"
            )
            .all()
        )).results
      ).toEqual(before.results);
      yield* Effect.tryPromise(() => db.prepare("DELETE FROM audit_retention_permits").run());
      const caller = yield* proactivityHostedCaller({ db, userIndex: 0 });
      expect(
        (yield* executeHostedStatementQuery({
          db,
          bucket: Option.none(),
          caller,
          current,
          input: {},
          operation: "insights.getReminderSchedule",
        })).status
      ).toBe(200);
      const pat = yield* proactivityTestPAT(db);
      expect((yield* readCanonicalReminderSchedule({ db, subject: pat, current })).status).toBe(
        200
      );
      const audit = makeAudit({ database: db });
      expect(
        (yield* audit.query({ userId: browser.userId, limit: 10 }))
          .map((entry) => entry.caller._tag)
          .sort()
      ).toEqual(["HostedTurn", "PAT", "WebSession"]);
      expect(yield* audit.query({ userId: proactivityTestUsers[1], limit: 10 })).toEqual([]);
      const retention = makeAuditRetention({ database: db });
      expect(
        yield* retention.retain({ userId: browser.userId, now: current + retentionLifetimeMs })
      ).toBe(0);
      expect(
        yield* retention.retain({ userId: browser.userId, now: current + retentionLifetimeMs + 1 })
      ).toBe(3);
      expect(yield* audit.query({ userId: browser.userId, limit: 10 })).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM audit_retention_permits").all()))
          .results
      ).toEqual([]);
    })
  ));
