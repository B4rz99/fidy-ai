import { DateTime, Effect, Option, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import {
  activateTestReminder,
  proactivityDatabase,
  proactivityTestCallers,
  proactivityTestDatabases,
  proactivityTestUsers,
  seedRecurringDigestSource,
} from "../proactivity.test-fixture";
import {
  activateWeeklySummaryForUser,
  seedWeeklySummaryActivity,
} from "../weekly-summary.test-fixture";
import {
  createProactivityConsentOffer,
  recordProactivityConsentDisclosure,
} from "../consent/operations";
import {
  advanceRecurringDigest,
  findRecurringDigestReport,
  findWeeklySummaryReport,
  materializeReminder,
  materializeWeeklySummary,
  recordRecurringDigestDecision,
} from "./operations";

import { RecurringDigestReport } from "../../src/core/insights/contract";
import { WeeklySummaryPayload } from "../../src/core/insights/weekly-summary/contract";
import { InsightTemplateSummary } from "../../src/shell/channels/whatsapp/contract";

const jsonGuards = Effect.fn(function* (db: D1Database, sql: string) {
  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        rowid: Schema.Int,
        kind: Schema.String,
        payload_json: Schema.OptionFromNullOr(Schema.String),
        presentation_json: Schema.OptionFromNullOr(Schema.String),
        report_json: Schema.OptionFromNullOr(Schema.String),
      })
    )
  )(
    (yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT rowid,kind,payload_json,presentation_json,report_json FROM insight_reports WHERE kind='weekly-summary' OR report_json IS NOT NULL ORDER BY rowid"
        )
        .all()
    )).results
  );
  return yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      if (row.kind === "weekly-summary") {
        yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(WeeklySummaryPayload)),
          { onExcessProperty: "error" }
        )(Option.getOrThrow(row.payload_json));
        yield* Schema.decodeEffect(Schema.fromJsonString(InsightTemplateSummary), {
          onExcessProperty: "error",
        })(Option.getOrThrow(row.presentation_json));
      } else {
        yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(RecurringDigestReport)),
          { onExcessProperty: "error" }
        )(Option.getOrThrow(row.report_json));
      }
      return db
        .prepare(sql)
        .bind(
          row.rowid,
          Option.getOrNull(row.payload_json),
          Option.getOrNull(row.presentation_json),
          Option.getOrNull(row.report_json)
        );
    })
  );
});

const tables = [
  "insight_events",
  "insight_reports",
  "proactive_messages",
  "insight_offer_requests",
  "weekly_question_requests",
];
const oldTables = tables.slice(0, 2);
afterAll(() => proactivityTestDatabases.dispose());
afterEach(() => vi.restoreAllMocks());
const affected = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source.filter(
    (sql) =>
      !sql.startsWith("CREATE TABLE ") &&
      tables.some((table) => new RegExp(`\\b${table}\\b`, "u").test(sql))
  );
const scratch = (
  source: ReadonlyArray<string>,
  names: ReadonlyArray<string>
): ReadonlyArray<string> =>
  names.map((target) => {
    let sql = schemaDefinition({ source, target });
    for (const table of names) {
      sql = sql.replace(new RegExp(`\\b${table}\\b`, "gu"), `cutover_${table}`);
    }
    return sql;
  });
const objectType = (sql: string): string => {
  if (sql.startsWith("CREATE TRIGGER ")) return "TRIGGER";
  if (sql.startsWith("CREATE VIEW ")) return "VIEW";
  return "INDEX";
};
const swap = ({
  db,
  source,
  target,
  sourceNames,
  targetNames,
}: Readonly<{
  db: D1Database;
  source: ReadonlyArray<string>;
  target: ReadonlyArray<string>;
  sourceNames: ReadonlyArray<string>;
  targetNames: ReadonlyArray<string>;
}>): ReadonlyArray<D1PreparedStatement> => [
  ...affected(source).map((sql) => db.prepare(`DROP ${objectType(sql)} ${schemaObjectName(sql)}`)),
  ...sourceNames.map((name) => db.prepare(`DROP TABLE ${name}`)),
  ...targetNames.map((name) => db.prepare(`ALTER TABLE cutover_${name} RENAME TO ${name}`)),
  ...affected(target).map((sql) => db.prepare(sql)),
];

it.each([
  "valid",
  "header-mismatch",
  "day-mismatch",
  "extra-payload-field",
  "lossy-clock",
  "retained-archive",
  "interruption",
])(
  "preserves populated Insight history and refuses inconsistent or interrupted conversion: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        const userId = proactivityTestUsers[0];
        const accepted = DateTime.makeUnsafe("2026-10-06T18:00:00.007Z");
        vi.spyOn(Date, "now").mockReturnValue(accepted.epochMilliseconds);
        const reminder = yield* activateTestReminder(db);
        const reminderResult = yield* materializeReminder({
          db,
          userId,
          id: reminder.id,
          now: DateTime.makeUnsafe("2026-10-06T23:00:00Z"),
        });
        expect(reminderResult._tag).toBe("Created");
        const context = {
          db,
          userId,
          caller: proactivityTestCallers[0],
          kind: "new-recurring-series" as const,
          now: accepted,
        };
        const offer = Option.getOrThrow(yield* createProactivityConsentOffer(context));
        yield* recordProactivityConsentDisclosure({
          ...context,
          offerId: offer.id,
          disclosureMessageId: "cutover-disclosure",
        });
        yield* recordRecurringDigestDecision({
          ...context,
          choice: offer.acceptChoice,
          decisionMessageId: "cutover-accept",
        });
        yield* seedRecurringDigestSource({
          db,
          userId,
          confirmedAt: "2026-10-06T19:00:00.009Z",
          counterparty: "Original Provider",
          index: 1,
        });
        vi.spyOn(Date, "now").mockReturnValue(
          DateTime.makeUnsafe("2026-10-07T04:59:59Z").epochMilliseconds
        );
        yield* advanceRecurringDigest({
          db,
          userId,
          now: DateTime.makeUnsafe("2026-10-07T04:59:59Z"),
        });
        const now = DateTime.makeUnsafe("2026-10-07T05:00:00Z");
        vi.spyOn(Date, "now").mockReturnValue(now.epochMilliseconds);
        let digest = yield* advanceRecurringDigest({ db, userId, now });
        for (let pass = 0; pass < 8 && digest._tag === "Progress"; pass++) {
          digest = yield* advanceRecurringDigest({ db, userId, now });
        }
        if (digest._tag !== "Created") {
          return yield* Effect.die("Expected recurring content: " + digest._tag);
        }
        const beforeDigest = Option.getOrThrow(
          yield* findRecurringDigestReport({ db, userId, id: digest.id })
        );
        const weekly = yield* activateWeeklySummaryForUser({
          db,
          userId,
          caller: proactivityTestCallers[0],
          now: accepted,
        });
        yield* seedWeeklySummaryActivity({ db, at: DateTime.formatIso(accepted) });
        const weeklyResult = yield* materializeWeeklySummary({
          db,
          userId,
          id: weekly.id,
          now: weekly.nextScheduledAt,
        });
        if (weeklyResult._tag !== "Created") return yield* Effect.die("Expected weekly content");
        const beforeWeekly = Option.getOrThrow(
          yield* findWeeklySummaryReport({ db, userId, id: weeklyResult.id })
        );
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./content-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current, history });
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<string> =>
          documentedSqlBlock({ guide, marker: "insight-content-" + part });
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "UPDATE proactive_messages SET text=NULL WHERE kind='proactivity-delivery' AND id=?"
              )
              .bind(digest.id),
            db
              .prepare(
                "UPDATE insight_events SET lifecycle_state='read',delivery_receipt_id=id,delivery_sent_at_ms=?,delivery_channel='whatsapp',delivery_provider='kapso',delivery_provider_message_id='original-proof' WHERE id=?"
              )
              .bind(now.epochMilliseconds + 9, digest.id),
            db
              .prepare(
                "INSERT INTO proactive_messages(kind,id,user_id,role,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES('proactivity-delivery','14720000-0000-4000-8000-000000000010',?,'budget-offer','original-offer','Original offer',?,?, 'UTC',?)"
              )
              .bind(
                userId,
                now.epochMilliseconds,
                now.epochMilliseconds + 1000,
                now.epochMilliseconds
              ),
            db
              .prepare(
                "INSERT INTO insight_offer_requests(id,user_id,request_kind,request_message_id,created_at_ms,last_evaluated_at_ms,materialized_at_ms,offer_message_id) VALUES('14720000-0000-4000-8000-000000000011',?,'budget-threshold','original-request',?,?,?,'14720000-0000-4000-8000-000000000010')"
              )
              .bind(userId, now.epochMilliseconds, now.epochMilliseconds, now.epochMilliseconds),
            db
              .prepare(
                "INSERT INTO weekly_question_requests(id,user_id,origin,request_message_id,created_at_ms,state,last_attempt_at_ms,restart_attempts) VALUES('14720000-0000-4000-8000-000000000012',?,'requested','weekly-request',?,'ready',0,0)"
              )
              .bind(userId, now.epochMilliseconds),
          ])
        );
        const corrupt = (): ReadonlyArray<D1PreparedStatement> => {
          if (historyCase === "header-mismatch") {
            return [
              db.prepare(
                "UPDATE cutover_insight_reports SET report_json=json_set(report_json,'$.locale','en-CO') WHERE report_json IS NOT NULL"
              ),
            ];
          }
          if (historyCase === "day-mismatch") {
            return [
              db.prepare(
                "UPDATE cutover_insight_reports SET report_json=json_set(report_json,'$.payload.confirmationDay.localDate','2026-10-05') WHERE report_json IS NOT NULL"
              ),
            ];
          }
          if (historyCase === "extra-payload-field") {
            return [
              db.prepare(
                "UPDATE cutover_insight_reports SET report_json=json_set(report_json,'$.payload.unexplained','original data') WHERE report_json IS NOT NULL"
              ),
            ];
          }
          if (historyCase === "lossy-clock") {
            return [
              db.prepare(
                "UPDATE cutover_insight_events SET scheduled_at='2026-10-07T05:00:00.0001Z' WHERE kind='new-recurring-series'"
              ),
            ];
          }
          return [];
        };
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...block("rollback-guard").map((sql) => db.prepare(sql)),
            ...scratch(previous, oldTables).map((sql) => db.prepare(sql)),
            ...block("rollback-copy").map((sql) => db.prepare(sql)),
            ...corrupt(),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: tables,
              targetNames: oldTables,
            }),
          ])
        );
        if (historyCase === "retained-archive") {
          yield* Effect.tryPromise(() =>
            db.batch([
              db.prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('prior','deleted',1,'Complete')"
              ),
              db.prepare(
                "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('prior','insight_reports','initial:17','{}')"
              ),
            ])
          );
        }
        const snapshot = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT rowid,* FROM insight_events ORDER BY rowid"),
            db.prepare("SELECT rowid,* FROM insight_reports ORDER BY rowid"),
            db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name"),
            db.prepare("SELECT * FROM erasure_archives ORDER BY row_ref"),
          ]);
        const before = (yield* Effect.tryPromise(snapshot)).map((result) => result.results);
        const counts = yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT (SELECT count(*) FROM insight_events) AS events,(SELECT count(*) FROM insight_reports) AS reports"
            )
            .first()
        );
        const count = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ events: Schema.Int, reports: Schema.Int })
        )(counts);
        const definitions = scratch(current, tables).map((sql) => db.prepare(sql));
        const copies = block("copy").map((sql) => db.prepare(sql));
        const converted = yield* Effect.result(
          Effect.gen(function* () {
            const pins = yield* jsonGuards(db, block("json-guard")[0] ?? "");
            return yield* Effect.tryPromise(() =>
              db.batch([
                db.prepare("PRAGMA defer_foreign_keys=ON"),
                db.prepare(block("guard")[0] ?? "").bind(count.events, count.reports),
                ...pins,
                ...definitions,
                ...copies,
                ...swap({
                  db,
                  source: previous,
                  target: current,
                  sourceNames: oldTables,
                  targetNames: tables,
                }),
                ...(historyCase === "interruption"
                  ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupted_insight_copy',0)")]
                  : []),
              ])
            );
          })
        );
        if (historyCase !== "valid") {
          expect(converted._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(snapshot)).map((result) => result.results)).toEqual(
            before
          );
          return;
        }
        expect(converted._tag).toBe("Success");

        expect(
          Option.getOrThrow(yield* findRecurringDigestReport({ db, userId, id: digest.id }))
        ).toEqual(beforeDigest);
        expect(
          Option.getOrThrow(yield* findWeeklySummaryReport({ db, userId, id: weeklyResult.id }))
        ).toEqual(beforeWeekly);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT lifecycle_state,delivery_provider_message_id,delivery_sent_at_ms FROM insight_events WHERE id=?"
              )
              .bind(digest.id)
              .first()
          )
        ).toEqual({
          lifecycle_state: "read",
          delivery_provider_message_id: "original-proof",
          delivery_sent_at_ms: now.epochMilliseconds + 9,
        });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT text FROM proactive_messages WHERE kind='proactivity-delivery' AND id=?"
              )
              .bind(digest.id)
              .first()
          )
        ).toEqual({ text: null });
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS total FROM insight_events").first()
          )
        ).toEqual({ total: 3 });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT request_message_id,offer_message_id FROM insight_offer_requests")
              .first()
          )
        ).toEqual({
          request_message_id: "original-request",
          offer_message_id: "14720000-0000-4000-8000-000000000010",
        });
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT state,restart_attempts FROM weekly_question_requests").first()
          )
        ).toEqual({ state: "ready", restart_attempts: 0 });
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);
      })
    )
);
