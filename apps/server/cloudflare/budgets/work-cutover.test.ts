import { DateTime, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { UtcTimestamp } from "../../src/core/_shared/time";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { discoverBudgetCrossingUsers, noteBudgetCrossingEvaluation } from "./operations";
import { UserId } from "../../src/core/identity/contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const owner = UserId.make("14690000-0000-4000-8000-000000000001");
const foreign = UserId.make("14690000-0000-4000-8000-000000000002");
const tables = ["budget_user_state", "budget_evaluation_work", "budget_publications"];
const Work = Schema.Struct({ rowid: Schema.Int, occurred_at: Schema.String, version: Schema.Int });
const instant = (raw: string): Option.Option<number> =>
  /[1-9]/u.test((/\.(\d+)/u.exec(raw)?.[1] ?? "").slice(3))
    ? Option.none()
    : Option.map(Schema.decodeOption(UtcTimestamp)(raw), DateTime.toEpochMillis);
const related = (
  source: ReadonlyArray<string>,
  names: ReadonlyArray<string>
): ReadonlyArray<string> =>
  source.filter((sql) => names.some((table) => new RegExp(`\\b${table}\\b`, "u").test(sql)));
const drop = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source
    .filter((sql) => !sql.startsWith("CREATE TABLE "))
    .map((sql) => {
      if (sql.startsWith("CREATE TRIGGER ")) return `DROP TRIGGER ${schemaObjectName(sql)}`;
      if (sql.startsWith("CREATE VIEW ")) return `DROP VIEW ${schemaObjectName(sql)}`;
      return `DROP INDEX ${schemaObjectName(sql)}`;
    });
const workCopies = Effect.fn(function* (db: D1Database, guide: string) {
  const work = yield* Schema.decodeUnknownEffect(Schema.Array(Work))(
    (yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT rowid,occurred_at,version FROM budget_state WHERE kind='work' ORDER BY rowid"
        )
        .all()
    )).results
  );
  const copies: D1PreparedStatement[] = [];
  for (const row of work) {
    const timestamp = instant(row.occurred_at);
    copies.push(
      db
        .prepare(documentedSqlBlock({ guide, marker: "budget-work-instant-guard" })[0] ?? "")
        .bind(Option.isSome(timestamp) ? 1 : 0, row.rowid, row.occurred_at, row.version)
    );
    copies.push(
      db.prepare(documentedSqlBlock({ guide, marker: "budget-work-instant-copy" })[0] ?? "").bind(
        Option.getOrElse(timestamp, () => 0),
        row.rowid
      )
    );
  }

  return copies;
});
const damageHistory = Effect.fn(function* (db: D1Database, history: string) {
  if (history === "lossy-clock") {
    yield* Effect.tryPromise(() =>
      db
        .prepare("UPDATE budget_state SET occurred_at='2026-09-01T00:00:00.0001Z' WHERE rowid=11")
        .run()
    );
  }
  if (history === "invalid-version") {
    yield* Effect.tryPromise(() =>
      db.prepare("UPDATE budget_state SET version=-1 WHERE rowid=11").run()
    );
  }
  if (history === "collision") {
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT INTO budget_state(kind,user_id,occurred_at) VALUES('work',?,'2026-09-01T05:01:02.009Z')"
        )
        .bind(owner)
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
          "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('prior','budget_reconciliation_work','initial:11','{}')"
        ),
      ])
    );
  }
});
it.each([
  "valid",
  "lossy-clock",
  "collision",
  "invalid-version",
  "retained-archive",
  "interruption",
])(
  "preserves Budget work/offer identity and refuses an unsafe entire copy: %s",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        const source = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const saved = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./work-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current: source, history: saved });
        yield* Effect.tryPromise(() => db.batch(previous.map((sql) => db.prepare(sql))));
        yield* Effect.tryPromise(() =>
          db.batch([
            ...[owner, foreign].map((userId) =>
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(userId)
            ),
            db
              .prepare(
                "INSERT INTO budget_state(rowid,kind,user_id,budget_id,created_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms) VALUES(7,'user',?,'deleted-original-budget',1788238862007,10000,NULL,NULL)"
              )
              .bind(owner),
            db
              .prepare(
                "INSERT INTO budget_state(rowid,kind,user_id,budget_id,created_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms) VALUES(8,'user',?,'foreign-original',1,5,NULL,NULL)"
              )
              .bind(foreign),
            db
              .prepare(
                "INSERT INTO budget_state(rowid,kind,user_id,occurred_at,version,last_evaluated_at_ms) VALUES(11,'work',?,'2026-09-01T21:00:02.009+15:59',4,20)"
              )
              .bind(owner),
            db
              .prepare(
                "INSERT INTO budget_state(rowid,kind,user_id,record_id,detected_at_ms,version,last_evaluated_at_ms) VALUES(13,'publication',?,'group',1788238862007,NULL,30)"
              )
              .bind(owner),
            db
              .prepare(
                "INSERT INTO budget_state(rowid,kind,user_id,record_id,detected_at_ms,materialized_at_ms,version,last_evaluated_at_ms) VALUES(14,'publication',?,'complete',1788238862007,1788238862008,NULL,0)"
              )
              .bind(owner),
            db
              .prepare("UPDATE budget_state SET revision=9 WHERE kind='user' AND user_id=?")
              .bind(owner),
          ])
        );
        yield* damageHistory(db, history);
        const snapshot = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT rowid,* FROM budget_state ORDER BY rowid"),
            db.prepare("SELECT * FROM erasure_archives ORDER BY row_ref"),
            db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name"),
          ]);
        const before = (yield* Effect.tryPromise(snapshot)).map((result) => result.results);
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<string> =>
          documentedSqlBlock({ guide, marker: "budget-work-" + part });
        const copies = yield* workCopies(db, guide);
        const target = related(source, tables);
        const converted = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              db.prepare(block("guard")[0] ?? "").bind(before[0]?.length ?? 0),
              ...tables.map((table) =>
                db.prepare(
                  schemaDefinition({ source, target: table }).replace(
                    `CREATE TABLE ${table}`,
                    `CREATE TABLE cutover_${table}`
                  )
                )
              ),
              ...block("roots-copy").map((sql) => db.prepare(sql)),
              ...copies,
              ...drop(related(previous, ["budget_state"])).map((sql) => db.prepare(sql)),
              db.prepare("DROP TABLE budget_state"),
              ...tables.map((table) =>
                db.prepare(`ALTER TABLE cutover_${table} RENAME TO ${table}`)
              ),
              ...target
                .filter((sql) => !sql.startsWith("CREATE TABLE "))
                .map((sql) => db.prepare(sql)),
              ...(history === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupted_budget_work',0)")]
                : []),
            ])
          )
        );
        if (history !== "valid") {
          expect(converted._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(snapshot)).map((result) => result.results)).toEqual(
            before
          );
          return;
        }
        expect(converted._tag).toBe("Success");
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT * FROM budget_user_state WHERE user_id=?").bind(owner).first()
          )
        ).toEqual({
          user_id: owner,
          revision: 9,
          first_budget_id: "deleted-original-budget",
          first_created_at_ms: 1788238862007,
          offer_requested_at_ms: null,
          last_evaluated_at_ms: 20,
        });
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT rowid,* FROM budget_evaluation_work").first()
          )
        ).toEqual({ rowid: 11, user_id: owner, occurred_at_ms: 1788238862009, version: 4 });
        expect(yield* discoverBudgetCrossingUsers({ db })).toEqual([foreign, owner]);
        yield* noteBudgetCrossingEvaluation({ db, userId: foreign, now: 1000 });
        expect(yield* discoverBudgetCrossingUsers({ db })).toEqual([owner, foreign]);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);
        // A stale completion after a new invalidation cannot remove the pending scope.
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "UPDATE budget_evaluation_work SET version=version+1 WHERE user_id=? AND occurred_at_ms=1788238862009"
              )
              .bind(owner),
            db
              .prepare(
                "DELETE FROM budget_evaluation_work WHERE user_id=? AND occurred_at_ms=1788238862009 AND version=4"
              )
              .bind(owner),
          ])
        );
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT version FROM budget_evaluation_work WHERE user_id=?")
              .bind(owner)
              .first()
          )
        ).toEqual({ version: 5 });
        const counts = (yield* Effect.tryPromise(() =>
          db.batch(tables.map((table) => db.prepare(`SELECT count(*) AS total FROM ${table}`)))
        )).map(
          (result) =>
            Schema.decodeUnknownSync(Schema.Struct({ total: Schema.Int }))(result.results[0]).total
        );
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare(block("rollback-guard")[0] ?? "").bind(...counts),
            db.prepare(
              schemaDefinition({ source: previous, target: "budget_state" }).replace(
                'CREATE TABLE "budget_state"',
                "CREATE TABLE cutover_budget_state"
              )
            ),
            ...block("rollback-copy").map((sql) => db.prepare(sql)),
            ...drop(target).map((sql) => db.prepare(sql)),
            ...tables.map((table) => db.prepare(`DROP TABLE ${table}`)),
            db.prepare("ALTER TABLE cutover_budget_state RENAME TO budget_state"),
            ...related(previous, ["budget_state"])
              .filter((sql) => !sql.startsWith("CREATE TABLE "))
              .map((sql) => db.prepare(sql)),
          ])
        );
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT budget_id,created_at_ms,offer_requested_at_ms,revision FROM budget_state WHERE kind='user' AND user_id=?"
              )
              .bind(owner)
              .first()
          )
        ).toEqual({
          budget_id: "deleted-original-budget",
          created_at_ms: 1788238862007,
          offer_requested_at_ms: null,
          revision: 10,
        });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT occurred_at,version FROM budget_state WHERE kind='work' AND user_id=?"
              )
              .bind(owner)
              .first()
          )
        ).toEqual({ occurred_at: "2026-09-01T05:01:02.009Z", version: 5 });
        expect(
          (yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT record_id,detected_at_ms,materialized_at_ms FROM budget_state WHERE kind='publication' ORDER BY record_id"
              )
              .all()
          )).results
        ).toEqual([
          {
            record_id: "complete",
            detected_at_ms: 1788238862007,
            materialized_at_ms: 1788238862008,
          },
          { record_id: "group", detected_at_ms: 1788238862007, materialized_at_ms: null },
        ]);
        expect((yield* Effect.tryPromise(snapshot))[1]?.results).toEqual(before[1]);
      })
    ),
  30000
);
