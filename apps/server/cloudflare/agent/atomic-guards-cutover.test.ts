import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { closedContinuityFixture, setup } from "./hosted-turn.test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  makeSchemaCutover,
  precedingSchema,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const tables = ["hosted_agent_sessions", "hosted_mutation_commits"];
const { scratch, swap } = makeSchemaCutover(tables);
it.each(["valid", "foreign-owner", "interruption", "foreign-key-verification"])(
  "preserves exact hosted continuity and committed evidence through guard conversion and rollback: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        const fixture = yield* closedContinuityFixture(db);
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./atomic-guards-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current, history });
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<string> =>
          documentedSqlBlock({ guide, marker: "hosted-guard-" + part });
        const inverse = (part: string, map: string): ReadonlyArray<D1PreparedStatement> =>
          block(part).map((sql) =>
            sql.includes("json_each(?)") ? db.prepare(sql).bind(map) : db.prepare(sql)
          );
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...inverse("rollback-guard", "[]"),
            ...scratch(previous, tables).map((sql) => db.prepare(sql)),
            ...inverse("rollback-copy", "[]"),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: tables,
              targetNames: tables,
            }),
            db
              .prepare(
                "UPDATE hosted_agent_sessions SET compacted_text='Original continuity',compacted_through_sequence=0,compacted_revision=7,compacted_nonce='original-proof',compacted_at_ms=17 WHERE id=?"
              )
              .bind(fixture.sessionId),
            db.prepare(
              "INSERT INTO hosted_mutation_commits(rowid,turn_id,tool_call_id,user_id,committed_at_ms,valid) SELECT 83,id,'retained-call',user_id,19,1 FROM hosted_turns LIMIT 1"
            ),
            ...block("verify").map((sql) => db.prepare(sql)),
          ])
        );
        const read = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT rowid,* FROM hosted_agent_sessions ORDER BY id"),
            db.prepare("SELECT rowid,* FROM hosted_mutation_commits ORDER BY turn_id,tool_call_id"),
            db.prepare("SELECT * FROM transcript_entries ORDER BY sequence"),
          ]);
        const original = (yield* Effect.tryPromise(read)).map((row) => row.results);
        const nonceMap = yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT json_group_array(json_object('id',id,'user_id',user_id,'compacted_revision',compacted_revision,'compacted_nonce',compacted_nonce)) AS map FROM hosted_agent_sessions"
            )
            .first<string>("map")
        );
        if (nonceMap === null) return yield* Effect.die("Missing original nonce map");
        if (historyCase === "foreign-owner") {
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "UPDATE hosted_mutation_commits SET user_id='10000000-0000-4000-8000-000000000072'"
              )
              .run()
          );
        }
        const before = (yield* Effect.tryPromise(read)).map((row) => row.results);
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              db.prepare("PRAGMA defer_foreign_keys=ON"),
              ...block("guard").map((sql) => db.prepare(sql).bind(1, 1)),
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
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupt_hosted',0)")]
                : []),
              ...(historyCase === "foreign-key-verification"
                ? [db.prepare("UPDATE hosted_mutation_commits SET user_id='foreign'")]
                : []),
              ...block("verify").map((sql) => db.prepare(sql)),
            ])
          )
        );
        if (historyCase !== "valid") {
          expect(result._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(before);
          return;
        }
        expect(result._tag).toBe("Success");
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);
        expect((yield* Effect.tryPromise(read))[2]?.results).toEqual(original[2]);
        const converted = (yield* Effect.tryPromise(read)).map((row) => row.results);
        expect(
          (yield* Effect.result(
            Effect.tryPromise(() => db.batch([...inverse("rollback-guard", "[]")]))
          ))._tag
        ).toBe("Failure");
        expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(converted);
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...inverse("rollback-guard", nonceMap),
            ...scratch(previous, tables).map((sql) => db.prepare(sql)),
            ...inverse("rollback-copy", nonceMap),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: tables,
              targetNames: tables,
            }),
            ...block("verify").map((sql) => db.prepare(sql)),
          ])
        );
        expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(original);
      })
    )
);
