import { Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  proactivityDatabase,
  proactivityTestDatabases,
  proactivityTestUsers,
} from "../proactivity.test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  makeSchemaCutover,
  precedingSchema,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const tables = ["memories"];
const { scratch, swap } = makeSchemaCutover(tables);
afterAll(() => proactivityTestDatabases.dispose());
it.each(["valid", "precision", "invalid", "count", "interruption"])(
  "preserves exact Memory identity, instants and ordering through conversion and rollback: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./timestamps-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current, history });
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<string> =>
          documentedSqlBlock({ guide, marker: "memory-clock-" + part });
        const creation =
          { invalid: "2026-02-30T00:00:00.007Z", precision: "1969-12-31T23:59:59.0071Z" }[
            historyCase
          ] ?? "1969-12-31T23:59:59.007Z";
        yield* Effect.tryPromise(() =>
          db.batch([
            ...scratch(previous, tables).map((sql) => db.prepare(sql)),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: tables,
              targetNames: tables,
            }),
            db
              .prepare(
                "INSERT INTO memories(rowid,id,user_id,text,created_at,updated_at) VALUES(17,'20000000-0000-4000-8000-000000000077',?,'Original prose',?,?)"
              )
              .bind(proactivityTestUsers[0], creation, "2026-10-05T23:00:00.019Z"),
            db
              .prepare(
                "INSERT INTO memories(rowid,id,user_id,text,created_at,updated_at) VALUES(83,'20000000-0000-4000-8000-000000000078',?,'Other User', '0001-01-01T00:00:00.000Z','9999-12-31T23:59:59.999Z')"
              )
              .bind(proactivityTestUsers[1]),
          ])
        );
        const read = (): Promise<D1Result> =>
          db.prepare("SELECT rowid,* FROM memories ORDER BY user_id,id").all();
        const original = (yield* Effect.tryPromise(read)).results;
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              ...block("guard").map((sql) => db.prepare(sql).bind(historyCase === "count" ? 3 : 2)),
              ...scratch(current, tables).map((sql) => db.prepare(sql)),
              ...block("copy").map((sql) => db.prepare(sql)),
              ...swap({
                db,
                source: previous,
                target: current,
                sourceNames: tables,
                targetNames: tables,
              }),
              ...(historyCase === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupt_memory',0)")]
                : []),
            ])
          )
        );
        if (historyCase !== "valid") {
          expect(result._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(read)).results).toEqual(original);
          return;
        }
        expect(result._tag).toBe("Success");
        expect((yield* Effect.tryPromise(read)).results).toEqual([
          {
            rowid: 17,
            id: "20000000-0000-4000-8000-000000000077",
            user_id: proactivityTestUsers[0],
            text: "Original prose",
            created_at_ms: -993,
            updated_at_ms: 1791241200019,
          },
          {
            rowid: 83,
            id: "20000000-0000-4000-8000-000000000078",
            user_id: proactivityTestUsers[1],
            text: "Other User",
            created_at_ms: -62135596800000,
            updated_at_ms: 253402300799999,
          },
        ]);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);
        yield* Effect.tryPromise(() =>
          db.batch([
            ...block("rollback-guard").map((sql) => db.prepare(sql)),
            ...scratch(previous, tables).map((sql) => db.prepare(sql)),
            ...block("rollback-copy").map((sql) => db.prepare(sql)),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: tables,
              targetNames: tables,
            }),
          ])
        );
        expect((yield* Effect.tryPromise(read)).results).toEqual(original);
      })
    )
);
