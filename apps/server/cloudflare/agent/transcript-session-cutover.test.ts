import { Effect } from "effect";
import { expect, it } from "vitest";
import { closedContinuityFixture, setup } from "./hosted-turn.test-fixture";
import {
  documentedSqlBlock,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";

it.each(["valid", "wrong-session", "count", "interruption"])(
  "validates original Transcript parent ownership without rewriting entries or ordering: %s",
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
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("DROP TRIGGER transcript_parent_session"),
            db
              .prepare(
                "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status) SELECT 'other-owned-session',user_id,consent_basis_json,started_at_ms,status FROM hosted_agent_sessions WHERE id=?"
              )
              .bind(fixture.sessionId),
            db.prepare("UPDATE sqlite_sequence SET seq=9999 WHERE name='transcript_entries'"),
          ])
        );
        if (historyCase === "wrong-session") {
          yield* Effect.tryPromise(() =>
            db.batch([
              db.prepare("DROP TRIGGER transcript_no_update"),
              db.prepare(
                "UPDATE transcript_entries SET hosted_session_id='other-owned-session' WHERE sequence=(SELECT min(sequence) FROM transcript_entries)"
              ),
              db.prepare(schemaDefinition({ source: current, target: "transcript_no_update" })),
            ])
          );
        }
        const read = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT * FROM transcript_entries ORDER BY sequence"),
            db.prepare("SELECT seq FROM sqlite_sequence WHERE name='transcript_entries'"),
          ]);
        const original = (yield* Effect.tryPromise(read)).map((row) => row.results);
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              ...documentedSqlBlock({ guide, marker: "transcript-session-guard" }).map((sql) =>
                db.prepare(sql).bind(historyCase === "count" ? 3 : 2)
              ),
              db.prepare(
                schemaDefinition({ source: current, target: "transcript_parent_session" })
              ),
              ...(historyCase === "interruption"
                ? [
                    db.prepare(
                      "INSERT INTO sql_assertions VALUES('interrupted_transcript_session',0)"
                    ),
                  ]
                : []),
            ])
          )
        );
        expect(result._tag).toBe(historyCase === "valid" ? "Success" : "Failure");
        expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(original);
        if (historyCase === "valid") {
          yield* Effect.tryPromise(() =>
            db.prepare("DROP TRIGGER transcript_parent_session").run()
          );
          expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(original);
        }
      })
    )
);
