import { DateTime, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { BudgetCrossing } from "../../src/core/budgets/contract";
import { encodeMoneyAmount } from "../../src/core/_shared/money";
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
import { readBudgetCaps } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const owner = "14680000-0000-4000-8000-000000000001";
const foreign = "14680000-0000-4000-8000-000000000002";
const tables = [
  "budgets",
  "budget_month_latches",
  "budget_threshold_alerts",
  "budget_month_plan_records",
];
const id = (ordinal: number): string =>
  `14680000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const native = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const instant = (raw: string): Option.Option<number> =>
  /[1-9]/u.test((/\.(\d+)/u.exec(raw)?.[1] ?? "").slice(3))
    ? Option.none()
    : Option.map(Schema.decodeOption(UtcTimestamp)(raw), DateTime.toEpochMillis);
const BudgetClock = Schema.Struct({
  rowid: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
});
const PeriodClock = Schema.Struct({ rowid: Schema.Int, from_utc: Schema.String });
const budgetCopies = Effect.fn(function* (db: D1Database, guide: string) {
  const statements: D1PreparedStatement[] = [];
  const budgets = yield* Schema.decodeUnknownEffect(Schema.Array(BudgetClock))(
    (yield* native(() =>
      db.prepare("SELECT rowid,created_at,updated_at FROM budgets ORDER BY rowid").all()
    )).results
  );
  const block = (part: string): ReadonlyArray<string> =>
    documentedSqlBlock({ guide, marker: "budget-months-" + part });
  for (const row of budgets) {
    const created = instant(row.created_at);
    const updated = instant(row.updated_at);
    statements.push(
      db
        .prepare(block("budget-guard")[0] ?? "")
        .bind(
          Option.isSome(created) && Option.isSome(updated) ? 1 : 0,
          row.rowid,
          row.created_at,
          row.updated_at
        )
    );
    statements.push(
      db.prepare(block("budget-copy")[0] ?? "").bind(
        Option.getOrElse(created, () => 0),
        Option.getOrElse(updated, () => 0),
        row.rowid
      )
    );
  }
  return statements;
});
const periodCopies = Effect.fn(function* (db: D1Database, guide: string, table: string) {
  const statements: D1PreparedStatement[] = [];
  const block = (part: string): ReadonlyArray<string> =>
    documentedSqlBlock({ guide, marker: "budget-months-" + part });
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(PeriodClock))(
    (yield* native(() => db.prepare(`SELECT rowid,from_utc FROM ${table} ORDER BY rowid`).all()))
      .results
  );
  for (const row of rows) {
    const from = instant(row.from_utc);
    statements.push(
      db
        .prepare(block(table + "-guard")[0] ?? "")
        .bind(Option.isSome(from) ? 1 : 0, row.rowid, row.from_utc)
    );
    statements.push(
      db.prepare(block(table + "-copy")[0] ?? "").bind(
        Option.getOrElse(from, () => 0),
        row.rowid
      )
    );
  }
  return statements;
});
const clockCopies = Effect.fn(function* (db: D1Database, guide: string) {
  return [
    ...(yield* budgetCopies(db, guide)),
    ...(yield* periodCopies(db, guide, "budget_month_latches")),
    ...(yield* periodCopies(db, guide, "budget_threshold_alerts")),
  ];
});
const dropDefinition = (sql: string): string => {
  if (sql.startsWith("CREATE TRIGGER ")) return `DROP TRIGGER ${schemaObjectName(sql)}`;
  if (sql.startsWith("CREATE VIEW ")) return `DROP VIEW ${schemaObjectName(sql)}`;
  return `DROP INDEX ${schemaObjectName(sql)}`;
};
const swap = (source: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...source.filter((sql) => !sql.startsWith("CREATE TABLE ")).map(dropDefinition),
  ...tables.slice(1).map((table) => `DROP TABLE ${table}`),
  "DROP TABLE budgets",
  ...tables.map((table) => `ALTER TABLE cutover_${table} RENAME TO ${table}`),
];
const related = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source.filter((sql) => tables.some((table) => new RegExp(`\\b${table}\\b`, "u").test(sql)));

it.each(["valid", "invalid-flags", "lossy-clock", "retained-archive", "interruption"])(
  "preserves populated Budget plans and threshold history or refuses the entire conversion: %s",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* native(() => databases.acquire());
        const source = schemaStatements(
          yield* native(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const saved = yield* Schema.decodeEffect(CutoverHistory)(
          yield* native(() =>
            Bun.file(new URL("./months-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current: source, history: saved });
        yield* native(() => db.batch(previous.map((sql) => db.prepare(sql))));
        const month = DateTime.formatIsoDateUtc(DateTime.nowUnsafe()).slice(0, 7);
        const crossing = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(BudgetCrossing))
        )(
          yield* Schema.decodeEffect(Schema.toCodecJson(BudgetCrossing))({
            budgetId: id(22),
            categoryId: id(12),
            cap: { amount: "100.01", currency: "COP" },
            spent: { amount: "110.02", currency: "COP" },
            period: {
              from: "2026-07-01T05:00:00.000Z",
              to: "2026-08-01T05:00:00.000Z",
              timeZone: "America/Bogota",
            },
            threshold: 100,
            detectedAt: "2026-07-15T12:00:00.123Z",
            serviceMarket: "CO",
            locale: "es-CO",
          })
        );

        yield* native(() =>
          db.batch([
            ...[owner, foreign].map((userId) =>
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(userId)
            ),
            ...[10, 11, 12].map((ordinal) =>
              db
                .prepare("INSERT INTO categories(id,label,display_order) VALUES(?,?,?)")
                .bind(id(ordinal), "Category " + ordinal, ordinal + 1000)
            ),
            ...[0, 1, 2].map((index) =>
              db
                .prepare(
                  "INSERT INTO budgets(rowid,id,user_id,category_id,currency,cap,created_at,updated_at,group_name,starts_month) VALUES(?,?,?,?,'COP','9007199254740993.15','2026-09-01T05:01:02.007Z','2026-09-01T21:00:02.009+15:59','Monthly',NULL)"
                )
                .bind(17 + index, id(20 + index), owner, id(10 + index))
            ),
            db
              .prepare(
                "INSERT INTO budgets(rowid,id,user_id,category_id,currency,cap,created_at,updated_at) VALUES(31,?,?,?,'COP','9','2026-01-01T00:00:00.001Z','2026-01-01T00:00:00.002Z')"
              )
              .bind(id(30), foreign, id(10)),
            ...[0, 1, 2].map((index) =>
              db
                .prepare(
                  "INSERT INTO budget_month_latches(rowid,user_id,budget_id,from_utc,time_zone,reached_80,reached_100) VALUES(?,?,?,'2026-07-01T05:00:00.000Z','America/Bogota',?,?)"
                )
                .bind(41 + index, owner, id(20 + index), index > 0 ? 1 : 0, index === 2 ? 1 : 0)
            ),
            db
              .prepare(
                "INSERT INTO budget_month_plan_records(rowid,kind,user_id,month) VALUES(51,'plan',?,'2020-01')"
              )
              .bind(owner),
            db
              .prepare(
                "INSERT INTO budget_month_plan_records(rowid,kind,user_id,month) VALUES(52,'plan',?,?)"
              )
              .bind(owner, month),
            db
              .prepare(
                "INSERT INTO budget_month_plan_records(rowid,kind,user_id,budget_id,month,cap) VALUES(53,'cap',?,?,?,'19.02')"
              )
              .bind(owner, id(20), month),
            db
              .prepare(
                "INSERT INTO budget_month_plan_records(rowid,kind,user_id,group_name,month,currency) VALUES(54,'currency',?,'Monthly',?,'COP')"
              )
              .bind(owner, month),
            db
              .prepare(
                "INSERT INTO budget_threshold_alerts(rowid,user_id,budget_id,from_utc,time_zone,threshold,state,crossing_json,delivery_group_id,consent_grant_id) VALUES(61,?,?,'2026-07-01T05:00:00.000Z','America/Bogota',80,'read',NULL,?,NULL)"
              )
              .bind(owner, id(22), id(60)),
            db
              .prepare(
                "INSERT INTO budget_threshold_alerts(rowid,user_id,budget_id,from_utc,time_zone,threshold,state,crossing_json,delivery_group_id,consent_grant_id) VALUES(62,?,?,'2026-07-01T05:00:00.000Z','America/Bogota',100,'dismissed',?,?,NULL)"
              )
              .bind(owner, id(22), crossing, id(60)),
          ])
        );
        if (history === "invalid-flags") {
          yield* native(() =>
            db.batch([
              db.prepare("PRAGMA ignore_check_constraints=ON"),
              db.prepare(
                "UPDATE budget_month_latches SET reached_80=0,reached_100=1 WHERE rowid=43"
              ),
              db.prepare("PRAGMA ignore_check_constraints=OFF"),
            ])
          );
        }
        if (history === "lossy-clock") {
          yield* native(() =>
            db
              .prepare("UPDATE budgets SET updated_at='2026-09-01T00:00:00.0001Z' WHERE rowid=17")
              .run()
          );
        }
        if (history === "retained-archive") {
          yield* native(() =>
            db.batch([
              db.prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('prior','deleted',1,'Complete')"
              ),
              db.prepare(
                "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('prior','budgets','initial:17','{}')"
              ),
            ])
          );
        }
        const guide = yield* native(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<D1PreparedStatement> =>
          documentedSqlBlock({ guide, marker: "budget-months-" + part }).map((sql) =>
            part === "guard"
              ? db.prepare(sql).bind(...before.slice(0, 4).map((rows) => rows.length))
              : db.prepare(sql)
          );
        const snapshot = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            ...tables.map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
            db.prepare("SELECT * FROM budget_state ORDER BY kind,user_id,occurred_at,record_id"),
            db.prepare("SELECT * FROM erasure_archives ORDER BY row_ref"),
            db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name"),
          ]);
        const before = (yield* native(snapshot)).map((result) => result.results);
        const target = related(source);
        const create = tables.map((table) =>
          schemaDefinition({ source, target: table })
            .replace(`CREATE TABLE ${table}`, `CREATE TABLE cutover_${table}`)
            .replaceAll("REFERENCES budgets(", "REFERENCES cutover_budgets(")
        );
        const copies = yield* clockCopies(db, guide);
        const converted = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              ...block("guard"),
              ...create.map((sql) => db.prepare(sql)),
              ...copies,
              ...block("plans-copy"),
              ...swap(related(previous)).map((sql) => db.prepare(sql)),
              ...target
                .filter((sql) => !sql.startsWith("CREATE TABLE "))
                .map((sql) => db.prepare(sql)),
              ...(history === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupted_budget_copy',0)")]
                : []),
            ])
          )
        );
        if (history !== "valid") {
          expect(converted._tag).toBe("Failure");
          expect((yield* native(snapshot)).map((result) => result.results)).toEqual(before);
          return;
        }
        expect(converted._tag).toBe("Success");
        const caps = Option.getOrThrow(yield* readBudgetCaps({ db, userId: owner }));
        expect(caps.find((budget) => budget.id === id(20))?.createdAt.epochMilliseconds).toBe(
          1788238862007
        );
        const selected = Option.getOrThrow(
          Option.fromUndefinedOr(caps.find((budget) => budget.id === id(20)))
        );
        expect(selected.cap.currency).toBe("COP");
        expect(encodeMoneyAmount(selected.cap.amount)).toBe("19.02");
        expect(
          encodeMoneyAmount(
            Option.getOrThrow(Option.fromUndefinedOr(caps.find((budget) => budget.id === id(21))))
              .cap.amount
          )
        ).toBe("9007199254740993.15");
        expect(
          yield* native(() =>
            db
              .prepare(
                "SELECT state,crossing_json,delivery_group_id,consent_grant_id,from_utc_ms FROM budget_threshold_alerts WHERE rowid=62"
              )
              .first()
          )
        ).toEqual({
          state: "dismissed",
          crossing_json: crossing,
          delivery_group_id: id(60),
          consent_grant_id: null,
          from_utc_ms: 1782882000000,
        });
        expect(
          (yield* native(() =>
            db.prepare("SELECT highest_reached FROM budget_month_latches ORDER BY rowid").all()
          )).results
        ).toEqual([{ highest_reached: 0 }, { highest_reached: 80 }, { highest_reached: 100 }]);
        expect(
          (yield* native(() =>
            db.prepare("SELECT rowid,* FROM budget_month_plan_records ORDER BY rowid").all()
          )).results
        ).toEqual(before[3]);
        expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
          []
        );
        const restore = tables.map((table) =>
          schemaDefinition({ source: previous, target: table })
            .replace(`CREATE TABLE ${table}`, `CREATE TABLE cutover_${table}`)
            .replaceAll("REFERENCES budgets(", "REFERENCES cutover_budgets(")
        );
        yield* native(() =>
          db.batch([
            ...block("guard"),
            ...restore.map((sql) => db.prepare(sql)),
            ...block("rollback-copy"),
            ...swap(target).map((sql) => db.prepare(sql)),
            ...related(previous)
              .filter((sql) => !sql.startsWith("CREATE TABLE "))
              .map((sql) => db.prepare(sql)),
          ])
        );
        const restored = (yield* native(snapshot)).map((result) => result.results);
        expect(restored[1]).toEqual(before[1]);
        expect(restored[2]).toEqual(before[2]);
        expect(restored[3]).toEqual(before[3]);
        expect(restored[4]).toEqual(before[4]);
        expect(restored[5]).toEqual(before[5]);
        const oldBudgets = yield* Schema.decodeUnknownEffect(Schema.Array(BudgetClock))(before[0]);
        const newBudgets = yield* Schema.decodeUnknownEffect(Schema.Array(BudgetClock))(
          restored[0]
        );
        expect(
          newBudgets.map((row) => [row.rowid, instant(row.created_at), instant(row.updated_at)])
        ).toEqual(
          oldBudgets.map((row) => [row.rowid, instant(row.created_at), instant(row.updated_at)])
        );
      })
    ),
  30000
);
