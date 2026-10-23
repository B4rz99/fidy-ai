import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  activateTestReminder,
  proactivityDatabase,
  proactivityTestDatabases,
  proactivityTestUsers,
} from "../proactivity.test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";

import { findProactivityConsentGrant } from "../consent/operations";

import { makeInsightsErasureStores } from "./runtime";

const stores = ["audit_entries", "proactive_messages"];
const question = "14730000-0000-4000-8000-000000000001";
const missing = "14730000-0000-4000-8000-000000000002";
afterAll(() => proactivityTestDatabases.dispose());
const related = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source.filter(
    (sql) =>
      !sql.startsWith("CREATE TABLE ") &&
      stores.some((store) => new RegExp(`\\b${store}\\b`, "u").test(sql))
  );
const scratch = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  stores.map((target) =>
    schemaDefinition({ source, target }).replace(
      new RegExp(`CREATE TABLE "?${target}"?`, "u"),
      `CREATE TABLE cutover_${target}`
    )
  );
const objectType = (sql: string): string => {
  if (sql.startsWith("CREATE TRIGGER ")) return "TRIGGER";
  if (sql.startsWith("CREATE VIEW ")) return "VIEW";
  return "INDEX";
};
const swap = ({
  db,
  source,
  target,
}: Readonly<{
  db: D1Database;
  source: ReadonlyArray<string>;
  target: ReadonlyArray<string>;
}>): ReadonlyArray<D1PreparedStatement> => [
  ...related(source).map((sql) => db.prepare(`DROP ${objectType(sql)} ${schemaObjectName(sql)}`)),
  ...stores.map((store) => db.prepare(`DROP TABLE ${store}`)),
  ...stores.map((store) => db.prepare(`ALTER TABLE cutover_${store} RENAME TO ${store}`)),
  ...related(target).map((sql) => db.prepare(sql)),
];
it.each([
  "valid",
  "archive",
  "receipt-only",
  "missing-question",
  "foreign-question",
  "two-receipts",
  "malformed-choice",
  "retained-archive",
  "interruption",
])("preserves exact Reminder replay proof and rejects unrepresentable history: %s", (historyCase) =>
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
              "INSERT INTO proactive_messages(kind,id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES('proactivity-delivery',?,?,'reminder-question',?,'Original question',?,?,'America/Bogota',?)"
            )
            .bind(question, userId, grant.id, now, now + 86400000, now),
          ...(historyCase === "receipt-only"
            ? []
            : [
                db
                  .prepare(
                    "INSERT INTO audit_entries(sequence,record_type,id,user_id,operation,outcome,occurred_at_ms) VALUES(17,'publication','original-publication',?,'ingestion.submitForExtraction','success',?)"
                  )
                  .bind(userId, now),
              ]),
        ])
      );
      const current = schemaStatements(
        yield* Effect.tryPromise(() =>
          Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
        )
      );
      const history = yield* Schema.decodeEffect(CutoverHistory)(
        yield* Effect.tryPromise(() =>
          Bun.file(new URL("./control-cutover.test-fixture.json", import.meta.url)).text()
        )
      );
      const previous = precedingSchema({ current, history });
      const guide = yield* Effect.tryPromise(() =>
        Bun.file(
          new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
        ).text()
      );
      const block = (part: string): ReadonlyArray<string> =>
        documentedSqlBlock({ guide, marker: "reminder-control-" + part });
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("PRAGMA defer_foreign_keys=ON"),
          ...block("rollback-guard").map((sql) => db.prepare(sql)),
          ...scratch(previous).map((sql) => db.prepare(sql)),
          ...block("rollback-copy").map((sql) => db.prepare(sql)),
          ...swap({ db, source: current, target: previous }),
        ])
      );
      const receiptOwner = historyCase === "foreign-question" ? proactivityTestUsers[1] : userId;
      const parent = historyCase === "missing-question" ? missing : question;
      const choice = historyCase === "malformed-choice" ? "off" : `reminder:${parent}:stop`;
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,outcome) VALUES(83,'reminder_control',json_array(?,'original-reply'),?,?)"
            )
            .bind(receiptOwner, receiptOwner, choice),
          db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='audit_entries'"),
          ...(historyCase === "two-receipts"
            ? [
                db
                  .prepare(
                    "INSERT INTO audit_entries(record_type,id,user_id,outcome) VALUES('reminder_control',json_array(?,'second-reply'),?,?)"
                  )
                  .bind(userId, userId, choice),
              ]
            : []),
          ...(historyCase === "retained-archive"
            ? [
                db.prepare(
                  "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('prior','deleted',1,'Complete')"
                ),
                db.prepare(
                  "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('prior','reminder_control_receipts','initial:83','{}')"
                ),
              ]
            : []),
        ])
      );
      const snapshot = (): Promise<ReadonlyArray<D1Result>> =>
        db.batch([
          db.prepare("SELECT * FROM audit_entries ORDER BY sequence"),
          db.prepare("SELECT rowid,* FROM proactive_messages ORDER BY rowid"),
          db.prepare("SELECT * FROM sqlite_sequence ORDER BY name"),
          db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name"),
          db.prepare("SELECT * FROM erasure_archives ORDER BY row_ref"),
        ]);
      const before = (yield* Effect.tryPromise(snapshot)).map((result) => result.results);
      const result = yield* Effect.result(
        Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            db.prepare(block("guard")[0] ?? "").bind(historyCase === "two-receipts" ? 2 : 1, 1),
            ...scratch(current).map((sql) => db.prepare(sql)),
            ...block("copy").map((sql) => db.prepare(sql)),
            ...swap({ db, source: previous, target: current }),
            ...(historyCase === "interruption"
              ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupted_control_copy',0)")]
              : []),
          ])
        )
      );
      if (!["valid", "receipt-only", "archive"].includes(historyCase)) {
        expect(result._tag).toBe("Failure");
        expect((yield* Effect.tryPromise(snapshot)).map((row) => row.results)).toEqual(before);
        return;
      }
      expect(result._tag).toBe("Success");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT control_message_id,control_choice,control_audit_sequence FROM proactive_messages WHERE user_id=? AND id=?"
            )
            .bind(userId, question)
            .first()
        )
      ).toEqual({
        control_message_id: "original-reply",
        control_audit_sequence: 83,
        control_choice: choice,
      });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT sequence,record_type,id FROM audit_entries ORDER BY sequence").all()
        )
      ).toMatchObject({
        results:
          historyCase === "receipt-only"
            ? []
            : [{ sequence: 17, record_type: "publication", id: "original-publication" }],
      });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT seq FROM sqlite_sequence WHERE name='audit_entries'").first()
        )
      ).toEqual({ seq: 999 });
      if (historyCase === "archive") {
        const archiveNow = yield* Clock.currentTimeMillis;
        const decision = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          dispositions: {
            schedules: { action: "Retain", retention: { untilMs: archiveNow + 86400000 } },
          },
        });
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES('receipt-case',?,?,'Archiving',?)"
              )
              .bind(userId, archiveNow, decision),
            db.prepare(
              "INSERT INTO erasure_steps(request_id,store_id,data_class) VALUES('receipt-case','reminder_control_receipts','schedules')"
            ),
          ])
        );
        const store = Option.getOrThrow(
          Option.fromUndefinedOr(
            makeInsightsErasureStores(db).find(
              (candidate) => candidate.id === "reminder_control_receipts"
            )
          )
        );
        const scope = { userId, reference: "receipt-case" };
        expect(yield* store.archive(scope)).toBe(true);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT row_ref,json_extract(body,'$.message_id') AS message_id,json_extract(body,'$.choice') AS choice FROM erasure_archives WHERE request_id='receipt-case' AND store_id='reminder_control_receipts'"
              )
              .first()
          )
        ).toEqual({ row_ref: "initial:83", message_id: "original-reply", choice });
        yield* Effect.tryPromise(() =>
          db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id='receipt-case'").run()
        );
        expect(yield* store.remove(scope)).toBe(true);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT control_message_id,control_choice,control_audit_sequence,text FROM proactive_messages WHERE user_id=? AND id=?"
              )
              .bind(userId, question)
              .first()
          )
        ).toEqual({
          control_message_id: null,
          control_choice: null,
          control_audit_sequence: null,
          text: "Original question",
        });
        return;
      }
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE proactive_messages SET text=NULL WHERE user_id=? AND id=?")
          .bind(userId, question)
          .run()
      );
      expect(
        (yield* Effect.exit(
          Effect.tryPromise(() =>
            db
              .prepare("UPDATE proactive_messages SET control_choice=? WHERE user_id=? AND id=?")
              .bind(`reminder:${question}:continue`, userId, question)
              .run()
          )
        ))._tag
      ).toBe("Failure");
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("PRAGMA defer_foreign_keys=ON"),
          ...block("rollback-guard").map((sql) => db.prepare(sql)),
          ...scratch(previous).map((sql) => db.prepare(sql)),
          ...block("rollback-copy").map((sql) => db.prepare(sql)),
          ...swap({ db, source: current, target: previous }),
        ])
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT sequence,id,user_id,outcome FROM audit_entries WHERE record_type='reminder_control'"
            )
            .first()
        )
      ).toEqual({
        id: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
          userId,
          "original-reply",
        ]),
        sequence: 83,
        user_id: userId,
        outcome: choice,
      });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT seq FROM sqlite_sequence WHERE name='audit_entries'").first()
        )
      ).toEqual({ seq: 999 });
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
    })
  )
);
