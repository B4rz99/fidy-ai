import { DateTime, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { CategoryId, CategoryKeyword, KeywordRuleId } from "../../src/core/categories/contract";
import { UserId } from "../../src/core/identity/contract";
import { UtcTimestamp } from "../../src/core/_shared/time";
import { normalizeSearchText } from "../../src/core/search/operations";
import { categorizeCaptures } from "./operations";
import { makeCategoriesErasureStores } from "./runtime";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const owner = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const rule = "30000000-0000-4000-8000-000000000001";
const transaction = "40000000-0000-4000-8000-000000000001";
const oldCategory = CategoryId.make("10000000-0000-4000-8000-000000000003");
const targetCategory = CategoryId.make("10000000-0000-4000-8000-000000000004");
const SourceRule = Schema.Struct({
  rowid: Schema.Int,
  id: KeywordRuleId,
  user_id: UserId,
  keyword: Schema.String,
  normalized_keyword: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});
const exactInstant = (value: string): Option.Option<DateTime.Utc> =>
  /[1-9]/u.test((/\.(\d+)/u.exec(value)?.[1] ?? "").slice(3))
    ? Option.none()
    : Schema.decodeOption(UtcTimestamp)(value);

it.each([
  "valid",
  "wrong-normalization",
  "lossy-time",
  "interrupted-copy",
  "interrupted-swap",
] as const)(
  "preserves Category ownership, exact instants and classification history or rolls back %s conversion",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* wait(() => databases.acquire());
        const current = schemaStatements(
          yield* wait(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const original = yield* Schema.decodeEffect(CutoverHistory)(
          yield* wait(() =>
            Bun.file(new URL("./keyword-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const source = precedingSchema({ current, history: original });
        yield* wait(() => db.batch(source.map((sql) => db.prepare(sql))));
        yield* wait(() =>
          db.batch([
            ...[owner, other].map((id) =>
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(id)
            ),
            db
              .prepare(
                "INSERT INTO keyword_rules(rowid,id,user_id,keyword,normalized_keyword,category_id,created_at,updated_at) VALUES(71,?,?,'CAFÉ',?,?,'2026-09-01T05:01:02.003Z',?)"
              )
              .bind(
                rule,
                owner,
                history === "wrong-normalization" ? "wrong" : "cafe",
                targetCategory,
                history === "lossy-time" ? "2026-09-01T05:01:02.0031Z" : "2026-09-02T05:01:02.007Z"
              ),
            db
              .prepare(
                "INSERT INTO keyword_rules(rowid,id,user_id,keyword,normalized_keyword,category_id,created_at,updated_at) VALUES(92,'30000000-0000-4000-8000-000000000002',?,'CAFÉ','cafe',?,'2026-09-01T00:01:02.003-05:00','2026-09-01T00:01:02.003-05:00')"
              )
              .bind(other, oldCategory),
            db
              .prepare(
                "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms,counterparty) VALUES(?,?,'45000','COP','outflow',?,1788238862003,1788238862003,'CAFÉ')"
              )
              .bind(transaction, owner, oldCategory),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('old-completed-erasure','old-deleted-owner',1,'Complete')"
            ),
            db.prepare(
              'INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES(\'old-completed-erasure\',\'keyword_rules\',\'initial:71\',\'{"keyword":"CAFÉ","normalized_keyword":"cafe","created_at":"2026-09-01T05:01:02.003Z"}\')'
            ),
          ])
        );
        const state = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(
            [
              "SELECT rowid,* FROM keyword_rules ORDER BY rowid",
              "SELECT * FROM transactions",
              "SELECT * FROM erasure_archives",
              "SELECT * FROM sqlite_sequence",
              "SELECT name,sql FROM sqlite_schema ORDER BY name",
            ].map((sql) => db.prepare(sql))
          );
        const before = (yield* wait(state)).map((result) => result.results);
        const rows = yield* Schema.decodeUnknownEffect(Schema.Array(SourceRule))(
          (yield* wait(() => db.prepare("SELECT rowid,* FROM keyword_rules ORDER BY rowid").all()))
            .results
        );
        const guide = yield* wait(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (marker: string): ReadonlyArray<D1PreparedStatement> =>
          documentedSqlBlock({ guide, marker }).map((sql) => db.prepare(sql));
        const rowGuard =
          documentedSqlBlock({ guide, marker: "category-keyword-row-preflight" })[0] ?? "";
        const bound = rows.map((row) => {
          const normalized = normalizeSearchText(row.keyword);
          const created = exactInstant(row.created_at),
            updated = exactInstant(row.updated_at);
          const accepted =
            Option.isSome(Schema.decodeOption(CategoryKeyword)(row.keyword)) &&
            Option.isSome(Schema.decodeOption(CategoryKeyword)(normalized)) &&
            Option.isSome(created) &&
            Option.isSome(updated);
          return db
            .prepare(rowGuard)
            .bind(
              accepted ? 1 : 0,
              row.rowid,
              row.keyword,
              normalized,
              row.created_at,
              row.updated_at,
              Option.isSome(created) ? DateTime.toEpochMillis(created.value) : 0,
              Option.isSome(updated) ? DateTime.toEpochMillis(updated.value) : 0
            );
        });
        const objects = (yield* wait(() =>
          db
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE tbl_name='keyword_rules' AND sql IS NOT NULL AND type IN('trigger','index')"
            )
            .all<{ type: string; name: string }>()
        )).results;
        const installed = current.filter(
          (sql) =>
            /^CREATE (?:UNIQUE )?INDEX \w+ ON keyword_rules\b/u.test(sql) ||
            /^CREATE TRIGGER \w+ [\s\S]*?\bON keyword_rules\b/u.test(sql)
        );
        const plan = [
          ...block("category-keyword-preflight"),
          ...bound,
          db.prepare(
            schemaDefinition({ source: current, target: "keyword_rules" }).replace(
              "CREATE TABLE keyword_rules",
              "CREATE TABLE keyword_rules_1461"
            )
          ),
          ...block("category-keyword-copy"),
          ...block("category-keyword-copy-check"),
          ...(history === "interrupted-copy"
            ? [
                db.prepare(
                  "INSERT INTO sql_assertions(scope,accepted) VALUES('interrupted-copy',0)"
                ),
              ]
            : []),
          ...objects.map((object) =>
            db.prepare(`DROP ${object.type.toUpperCase()} "${object.name}"`)
          ),
          ...block("category-keyword-swap"),
          ...(history === "interrupted-swap"
            ? [
                db.prepare(
                  "INSERT INTO sql_assertions(scope,accepted) VALUES('interrupted-swap',0)"
                ),
              ]
            : []),
          ...installed.map((sql) => db.prepare(sql)),
          ...block("category-keyword-verify"),
        ];
        if (history !== "valid") {
          yield* wait(() => expect(db.batch(plan)).rejects.toThrow(/CHECK constraint failed/u));
          expect((yield* wait(state)).map((result) => result.results)).toEqual(before);
          return;
        }
        yield* wait(() => db.batch(plan));
        expect(
          (yield* wait(() =>
            db
              .prepare(
                "SELECT rowid,keyword,created_at_ms,updated_at_ms FROM keyword_rules ORDER BY rowid"
              )
              .all()
          )).results
        ).toEqual([
          {
            rowid: 71,
            keyword: "cafe",
            created_at_ms: 1788238862003,
            updated_at_ms: 1788325262007,
          },
          {
            rowid: 92,
            keyword: "cafe",
            created_at_ms: 1788238862003,
            updated_at_ms: 1788238862003,
          },
        ]);
        expect((yield* wait(() => db.prepare("SELECT * FROM transactions").all())).results).toEqual(
          before[1]
        );
        expect(
          (yield* wait(() => db.prepare("SELECT * FROM erasure_archives").all())).results
        ).toEqual(before[2]);
        const capture = {
          caller: Option.none<CategoryId>(),
          counterparty: Option.some("CAFÉ Bogotá"),
          direction: "outflow" as const,
        };
        expect(
          yield* categorizeCaptures({
            db,
            userId: owner,
            captures: [capture, { ...capture, caller: Option.some(oldCategory) }],
          })
        ).toEqual([targetCategory, oldCategory]);
        expect(yield* categorizeCaptures({ db, userId: other, captures: [capture] })).toEqual([
          oldCategory,
        ]);
        const reference = "category-erasure";
        const decision = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          dispositions: {
            projections: {
              action: "Retain",
              retention: { untilMs: DateTime.toEpochMillis(yield* DateTime.now) + 86400000 },
            },
          },
        });
        yield* wait(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES(?,?,1,'Archiving',?)"
              )
              .bind(reference, owner, decision),
            db
              .prepare(
                "INSERT INTO erasure_steps(request_id,store_id,data_class) VALUES(?,'keyword_rules','projections')"
              )
              .bind(reference),
          ])
        );
        const store = makeCategoriesErasureStores(db)[0];
        if (store === undefined) throw new Error("Missing Category disposition");
        expect(yield* store.archive({ userId: owner, reference })).toBe(true);
        yield* wait(() =>
          db.batch([
            db.prepare("UPDATE erasure_requests SET state='Draining' WHERE id=?").bind(reference),
            db.prepare("DELETE FROM keyword_rules WHERE user_id=?").bind(owner),
          ])
        );
        const retained = yield* wait(() =>
          db
            .prepare("SELECT body FROM erasure_archives WHERE request_id=? ORDER BY row_ref")
            .bind(reference)
            .all<{ body: string }>()
        );
        const expectedBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          id: rule,
          user_id: owner,
          keyword: "cafe",
          normalized_keyword: "cafe",
          category_id: targetCategory,
          created_at: "2026-09-01T05:01:02.003Z",
          updated_at: "2026-09-02T05:01:02.007Z",
        });
        expect(retained.results.map((row) => row.body)).toEqual([expectedBody, expectedBody]);
        expect(yield* categorizeCaptures({ db, userId: other, captures: [capture] })).toEqual([
          oldCategory,
        ]);
        expect((yield* wait(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
          []
        );
      })
    )
);
