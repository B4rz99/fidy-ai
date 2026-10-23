import { DateTime, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  activateTestReminder,
  proactivityDatabase,
  proactivityTestDatabases,
  proactivityTestUsers,
} from "../proactivity.test-fixture";
import { findProactivityConsentGrant } from "../consent/operations";
import {
  CutoverHistory,
  documentedSqlBlock,
  makeSchemaCutover,
  precedingSchema,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const currentNames = [
  "weekly_proactivity_state",
  "reminder_proactivity_state",
  "proactive_transcript_entries",
];
const previousNames = ["proactivity_governors", "proactive_transcript_entries"];
const allNames = [...currentNames, ...previousNames];
const question = "14740000-0000-4000-8000-000000000001";
afterAll(() => proactivityTestDatabases.dispose());
const { scratch, swap } = makeSchemaCutover(allNames);
it.each(["valid", "orphan-transcript", "retained-archive", "interruption"])(
  "preserves populated governor and Transcript history or rejects conversion atomically: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        const userId = proactivityTestUsers[0];
        yield* activateTestReminder(db);
        const grant = Option.getOrThrow(
          yield* findProactivityConsentGrant({ db, userId, kind: "manual-entry-reminder" })
        );
        const now = DateTime.makeUnsafe("2026-10-08T23:00:00.007Z").epochMilliseconds;
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "UPDATE reminder_proactivity_state SET rowid=83,standing_json=json_object('_tag','QuestionDelivered','unanswered',4),question_id=?,question_delivered_at_ms=?,notice_turn_id='original-reminder-notice' WHERE user_id=?"
              )
              .bind(question, now, userId),
            db
              .prepare(
                "INSERT INTO weekly_proactivity_state(rowid,user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed) VALUES(17,?,5,?,1,1,?,'original-weekly-origin',?,'original-session','original-weekly-notice',0)"
              )
              .bind(userId, now - 10000, now - 2000, now),
            db
              .prepare(
                "INSERT INTO proactive_messages(kind,id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES('proactivity-delivery',?,?,'reminder-question',?,'Original question',?,?,'America/Bogota',?)"
              )
              .bind(question, userId, grant.id, now, now + 86400000, now),
            db
              .prepare(
                "INSERT INTO proactive_transcript_entries(sequence,kind,id,user_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) VALUES(101,'message','original-transcript',?,?,'reminder-question',?,'Exact retained transcript',?)"
              )
              .bind(userId, question, now, now + 2592000000),
            db.prepare(
              "UPDATE sqlite_sequence SET seq=999 WHERE name='proactive_transcript_entries'"
            ),
          ])
        );
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./governor-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current, history });
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<string> =>
          documentedSqlBlock({ guide, marker: "insight-governor-" + part });
        const read = (names: ReadonlyArray<string>): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            ...names.map((name) => db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`)),
            db.prepare("SELECT seq FROM sqlite_sequence WHERE name='proactive_transcript_entries'"),
          ]);
        const expected = (yield* Effect.tryPromise(() => read(currentNames))).map(
          (row) => row.results
        );
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...block("rollback-guard").map((sql) => db.prepare(sql)),
            ...scratch(previous, previousNames).map((sql) => db.prepare(sql)),
            ...block("rollback-copy").map((sql) => db.prepare(sql)),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: currentNames,
              targetNames: previousNames,
            }),
          ])
        );
        const originalGovernors = (yield* Effect.tryPromise(() => read(previousNames))).map(
          (row) => row.results
        );
        if (historyCase === "orphan-transcript") {
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "INSERT INTO proactive_transcript_entries(sequence,kind,id,user_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) SELECT 102,kind,'orphan-transcript',user_id,'missing-message',role,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries WHERE sequence=101"
              )
              .run()
          );
        }
        if (historyCase === "retained-archive") {
          yield* Effect.tryPromise(() =>
            db.batch([
              db.prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('prior','deleted',1,'Complete')"
              ),
              db.prepare(
                "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('prior','weekly_governors','initial:17','{}')"
              ),
            ])
          );
        }
        const before = (yield* Effect.tryPromise(() => read(previousNames))).map(
          (row) => row.results
        );
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              db.prepare("PRAGMA defer_foreign_keys=ON"),
              ...block("guard").map((sql) =>
                db.prepare(sql).bind(2, historyCase === "orphan-transcript" ? 2 : 1)
              ),
              ...scratch(current, currentNames).map((sql) => db.prepare(sql)),
              ...block("copy").map((sql) => db.prepare(sql)),
              ...swap({
                db,
                source: previous,
                target: current,
                sourceNames: previousNames,
                targetNames: currentNames,
              }),
              ...(historyCase === "interruption"
                ? [
                    db.prepare(
                      "INSERT INTO sql_assertions VALUES('interrupted_governor_cutover',0)"
                    ),
                  ]
                : []),
            ])
          )
        );
        if (historyCase !== "valid") {
          expect(result._tag).toBe("Failure");
          expect(
            (yield* Effect.tryPromise(() => read(previousNames))).map((row) => row.results)
          ).toEqual(before);
          return;
        }
        expect(result._tag).toBe("Success");
        expect(
          (yield* Effect.tryPromise(() => read(currentNames))).map((row) => row.results)
        ).toEqual(expected);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);
        // The qualified reference refuses a same-ID link to a different owner or source role.
        expect(
          (yield* Effect.result(
            Effect.tryPromise(() =>
              db
                .prepare("UPDATE proactive_transcript_entries SET user_id=? WHERE sequence=101")
                .bind(proactivityTestUsers[1])
                .run()
            )
          ))._tag
        ).toBe("Failure");
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...block("rollback-guard").map((sql) => db.prepare(sql)),
            ...scratch(previous, previousNames).map((sql) => db.prepare(sql)),
            ...block("rollback-copy").map((sql) => db.prepare(sql)),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: currentNames,
              targetNames: previousNames,
            }),
          ])
        );
        expect(
          (yield* Effect.tryPromise(() => read(previousNames))).map((row) => row.results)
        ).toEqual(originalGovernors);
      })
    )
);
