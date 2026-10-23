import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { closedContinuityFixture, setup } from "./hosted-turn.test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  installHistoricalErasureStorage,
  makeSchemaCutover,
  precedingSchema,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const tables = ["hosted_mutation_commits", "hosted_turns"];
const { scratch, swap } = makeSchemaCutover(tables);
it.each(["valid", "different-clock", "count", "interruption"])(
  "preserves document proof and exact Turn evidence through clock conversion and rollback: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        yield* Effect.tryPromise(() => installHistoricalErasureStorage(db));
        const fixture = yield* closedContinuityFixture(db);
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO hosted_mutation_commits(rowid,turn_id,tool_call_id,user_id,committed_at_ms) SELECT 83,id,'original-call',user_id,started_at_ms FROM hosted_turns LIMIT 1"
            )
            .run()
        );
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./document-clock-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current, history });
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<D1PreparedStatement> =>
          documentedSqlBlock({ guide, marker: "hosted-document-clock-" + part }).map((sql) =>
            db.prepare(sql)
          );
        const rollback = (): ReadonlyArray<D1PreparedStatement> => [
          db.prepare("PRAGMA defer_foreign_keys=ON"),
          ...block("rollback-guard"),
          ...scratch(previous, tables).map((sql) => db.prepare(sql)),
          ...block("rollback-copy"),
          ...swap({
            db,
            source: current,
            target: previous,
            sourceNames: tables,
            targetNames: tables,
          }),
          ...block("verify"),
        ];
        yield* Effect.tryPromise(() => db.batch(rollback().slice()));
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "UPDATE hosted_turns SET document_media_id='original-media',document_created_at_ms=started_at_ms,document_upload_grant_id='original-lease',document_upload_expires_at_ms=started_at_ms+1 WHERE hosted_session_id=?"
              )
              .bind(fixture.sessionId),
          ])
        );
        if (historyCase === "different-clock") {
          yield* Effect.tryPromise(() =>
            db.batch([
              db.prepare("DROP TRIGGER statement_document_immutable"),
              db.prepare("UPDATE hosted_turns SET document_created_at_ms=document_created_at_ms+1"),
              db.prepare(
                schemaDefinition({ source: previous, target: "statement_document_immutable" })
              ),
            ])
          );
        }
        const read = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT rowid,* FROM hosted_turns ORDER BY id"),
            db.prepare("SELECT * FROM transcript_entries ORDER BY sequence"),
            db.prepare("SELECT rowid,* FROM hosted_agent_sessions ORDER BY id"),
            db.prepare("SELECT rowid,* FROM hosted_mutation_commits ORDER BY turn_id,tool_call_id"),
          ]);
        const original = (yield* Effect.tryPromise(read)).map((row) => row.results);
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              db.prepare("PRAGMA defer_foreign_keys=ON"),
              ...documentedSqlBlock({ guide, marker: "hosted-document-clock-guard" }).map((sql) =>
                db.prepare(sql).bind(historyCase === "count" ? 2 : 1)
              ),
              ...scratch(current, tables).map((sql) => db.prepare(sql)),
              ...block("copy"),
              ...swap({
                db,
                source: previous,
                target: current,
                sourceNames: tables,
                targetNames: tables,
              }),
              ...(historyCase === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupt_document_clock',0)")]
                : []),
              ...block("verify"),
            ])
          )
        );
        if (historyCase !== "valid") {
          expect(result._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(original);
          return;
        }
        expect(result._tag).toBe("Success");
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);

        yield* Effect.tryPromise(() => db.batch(rollback().slice()));
        expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(original);
      })
    )
);
