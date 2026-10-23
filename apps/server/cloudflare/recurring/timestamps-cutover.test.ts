import { DateTime, Effect, Option, Schema } from "effect";
import { RecurringSeries, RecurringSeriesConfirmed } from "../../src/core/recurring/contract";
import { afterAll, expect, it } from "vitest";
import { normalizeCounterparty } from "../../src/core/recurring/operations";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { seedDetectionHistory, userId } from "./detection-comparison.test-fixture";
import {
  evaluateRecurringSeries,
  readRecurringConfirmations,
  readRecurringDigestSource,
  recurringDigestSourceIdentities,
} from "./operations";

const projectionGuards = Effect.fn(function* (db: D1Database, sql: string) {
  const raw = yield* Effect.tryPromise(() =>
    db.prepare("SELECT rowid,series_json FROM recurring_series ORDER BY rowid").all()
  );
  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ rowid: Schema.Int, series_json: Schema.String }))
  )(raw.results);
  return yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const series = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.toCodecJson(RecurringSeries))
      )(row.series_json);
      return db
        .prepare(sql)
        .bind(row.rowid, row.series_json, normalizeCounterparty(series.counterparty));
    })
  );
});
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const tables = ["recurring_evaluation_records", "recurring_series"];
const foreign = "14710000-0000-4000-8000-000000000002";
const seriesId = "14710000-0000-4000-8000-000000000003";
const confirmationId = "14710000-0000-4000-8000-000000000004";
const lastId = "14700000-0000-4000-8000-000000000105";
const completedAt = "2026-10-01T05:01:02.009Z";
const context = { serviceMarket: "CO", locale: "es-CO", timeZone: "America/Bogota" };
const original = {
  id: confirmationId,
  seriesId,
  counterparty: "Original Provider",
  money: { amount: "100.01", currency: "COP" },
  cadence: { kind: "monthly" },
  confirmedAt: completedAt,
  announcement: { kind: "suppressed", reason: "backfill" },
};
const series = {
  id: seriesId,
  counterparty: "Provider 000",
  money: { amount: "100.02", currency: "COP" },
  cadence: original.cadence,
  firstOccurredAt: "2020-01-15T12:00:00.007Z",
  lastOccurredAt: "2020-06-15T12:00:00.007Z",
  confirmedAt: completedAt,
  announcement: original.announcement,
};
const related = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source.filter((sql) => tables.some((table) => new RegExp(`\\b${table}\\b`, "u").test(sql)));
const dropObjects = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  related(source)
    .filter((sql) => !sql.startsWith("CREATE TABLE "))
    .map(
      (sql) =>
        `DROP ${sql.startsWith("CREATE TRIGGER ") ? "TRIGGER" : "INDEX"} ${schemaObjectName(sql)}`
    );
const scratchDefinitions = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  tables.map((table) =>
    schemaDefinition({ source, target: table }).replace(
      new RegExp(`CREATE TABLE "?${table}"?`, "u"),
      `CREATE TABLE cutover_${table}`
    )
  );
const swap = (
  db: D1Database,
  source: ReadonlyArray<string>,
  target: ReadonlyArray<string>
): ReadonlyArray<D1PreparedStatement> => [
  ...dropObjects(source).map((sql) => db.prepare(sql)),
  ...tables.map((table) => db.prepare(`DROP TABLE ${table}`)),
  ...tables.map((table) => db.prepare(`ALTER TABLE cutover_${table} RENAME TO ${table}`)),
  ...related(target)
    .filter((sql) => !sql.startsWith("CREATE TABLE "))
    .map((sql) => db.prepare(sql)),
];

it.each([
  "valid",
  "lossy-clock",
  "confirmation-mismatch",
  "counterparty-mismatch",
  "retained-archive",
  "interruption",
])(
  "preserves Recurring financial evidence and exact instants through conversion/rollback: %s",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* seedDetectionHistory(db, { count: 6, groups: 1 });
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const saved = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./timestamps-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = saved.originalDefinitions;
        // The two owner stores are empty; all other production stores and constraints stay installed.
        yield* Effect.tryPromise(() =>
          db.batch([
            ...scratchDefinitions(previous).map((sql) => db.prepare(sql)),
            ...swap(db, current, previous),
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
              )
              .bind(foreign),
            db
              .prepare(`INSERT INTO recurring_evaluation_records(rowid,user_id,kind,id,group_key,revision,phase,cursor_at,cursor_id,evaluated_at,evaluated_revision,first_captured_at,time_zone)
 VALUES(11,?,'progress','progress','COP|provider 000',6,'complete','2020-06-15T12:00:00.007Z',?,?,6,'2020-01-15T12:00:00.007Z','America/Bogota')`)
              .bind(userId, lastId, completedAt),
            db
              .prepare(`INSERT INTO recurring_evaluation_records(rowid,user_id,kind,id,group_key,revision,phase,cursor_at,cursor_id,evaluated_at,evaluated_revision,first_captured_at,time_zone)
 VALUES(12,?,'progress','progress','',7,'scan','','',?,6,'2020-01-15T12:00:00.007Z','America/Bogota')`)
              .bind(foreign, completedAt),
            db
              .prepare(`INSERT INTO recurring_series(rowid,user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,confirmed_at,confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence)
 VALUES(21,?,?,'COP','provider 000',?,?,?,1,?,?,?,?,0,7)`)
              .bind(
                userId,
                seriesId,
                json(series),
                json({
                  supportingTransactionIds: [
                    "14700000-0000-4000-8000-000000000100",
                    "14700000-0000-4000-8000-000000000101",
                    "14700000-0000-4000-8000-000000000102",
                  ],
                  latestTransactionId: lastId,
                  detectorRevision: "monthly-v1",
                  evaluatedFactRevision: 6,
                }),
                json(original.money),
                confirmationId,
                completedAt,
                json(context),
                json(original)
              ),
          ])
        );
        if (history === "lossy-clock") {
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "UPDATE recurring_evaluation_records SET cursor_at='2020-06-15T12:00:00.0071Z' WHERE rowid=11"
              )
              .run()
          );
        }
        if (history === "confirmation-mismatch") {
          // Independent original occurrence facts must not be silently repaired from current series.
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "UPDATE recurring_series SET series_json=json_set(series_json,'$.confirmedAt','2026-10-01T05:01:02.010Z') WHERE rowid=21"
              )
              .run()
          );
        }
        if (history === "counterparty-mismatch") {
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "UPDATE recurring_series SET counterparty_key='wrong counterparty' WHERE rowid=21"
              )
              .run()
          );
        }
        if (history === "retained-archive") {
          yield* Effect.tryPromise(() =>
            db.batch([
              db.prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('prior','deleted',1,'Complete')"
              ),
              db.prepare(
                "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('prior','recurring_progress','initial:11','{}')"
              ),
            ])
          );
        }
        const snapshot = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            ...tables.map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
            db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name"),
            db.prepare("SELECT * FROM erasure_archives ORDER BY row_ref"),
            db.prepare("SELECT * FROM recurring_dispatch"),
          ]);
        const before = (yield* Effect.tryPromise(snapshot)).map((result) => result.results);
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<string> =>
          documentedSqlBlock({ guide, marker: "recurring-instant-" + part });
        const checkedProjections = yield* projectionGuards(db, block("series-guard")[0] ?? "");
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              db.prepare(block("guard")[0] ?? "").bind(2, 1),
              ...checkedProjections,
              ...scratchDefinitions(current).map((sql) => db.prepare(sql)),
              ...block("copy").map((sql) => db.prepare(sql)),
              ...swap(db, previous, current),
              ...(history === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupted_recurring_copy',0)")]
                : []),
            ])
          )
        );
        if (history !== "valid") {
          expect(result._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(snapshot)).map((row) => row.results)).toEqual(before);
          return;
        }
        expect(result._tag).toBe("Success");
        const page = yield* readRecurringConfirmations({ db, userId, cursor: Option.none() });
        expect(page.confirmations).toHaveLength(1);

        expect(
          yield* Schema.encodeEffect(Schema.toCodecJson(RecurringSeriesConfirmed))(
            Option.getOrThrow(Option.fromUndefinedOr(page.confirmations[0])).occurrence
          )
        ).toEqual(original);
        expect(
          DateTime.formatIso(
            Option.getOrThrow(Option.fromUndefinedOr(page.confirmations[0])).occurrence.confirmedAt
          )
        ).toBe(completedAt);
        const source = yield* readRecurringDigestSource({ db, userId, cursor: Option.none() });
        const identity = recurringDigestSourceIdentities();
        expect(source.sourceIdentity).toBe("6:2026-10-01T05:01:02.009Z:7:1");
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(identity.sql)
              .bind(...identity.params)
              .first("source_identity")
          )
        ).toBe(source.sourceIdentity);
        yield* evaluateRecurringSeries({ db, userId });
        expect(
          (yield* readRecurringDigestSource({ db, userId, cursor: Option.none() })).sourceIdentity
        ).toBe(source.sourceIdentity);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT cursor_at_ms,cursor_id,evaluated_at_ms,evaluated_revision FROM recurring_evaluation_records WHERE rowid=12"
              )
              .first()
          )
        ).toEqual({
          cursor_at_ms: null,
          cursor_id: "",
          evaluated_at_ms: 1790830862009,
          evaluated_revision: 6,
        });
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare(block("rollback-guard")[0] ?? "").bind(2, 1),
            ...scratchDefinitions(previous).map((sql) => db.prepare(sql)),
            ...block("rollback-copy").map((sql) => db.prepare(sql)),
            ...swap(db, current, previous),
          ])
        );
        expect((yield* Effect.tryPromise(snapshot)).map((row) => row.results)).toEqual(before);
      })
    ),
  30000
);
