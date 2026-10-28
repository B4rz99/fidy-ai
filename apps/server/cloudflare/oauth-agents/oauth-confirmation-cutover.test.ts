import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  documentedSqlBlock,
  installHistoricalErasureChunk,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { pendingBudgetDeletion, sessionFor, wait } from "./oauth-ingress.test-fixture";

const guards = ["oauth_intent_initial", "oauth_intent_immutable"];
const histories = [
  "pending",
  "approved",
  "foreign-connection",
  "foreign-session",
  "partial-proof",
  "late-proof",
  "interrupted",
] as const;
it.each(histories)("preserves exact OAuth approvals or rejects %s history atomically", (history) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      yield* wait(installHistoricalErasureChunk(fixture.db));
      if (history !== "pending") {
        yield* wait(
          fixture.db
            .prepare(`UPDATE oauth_operation_intents SET browser_approved_at_ms=created_at_ms,
          browser_session_id=(SELECT id FROM web_sessions WHERE user_id=oauth_operation_intents.user_id LIMIT 1)`)
            .run()
        );
      }
      yield* wait(
        fixture.db.batch(guards.map((name) => fixture.db.prepare(`DROP TRIGGER ${name}`)))
      );
      yield* sessionFor({ db: fixture.db, index: 2 });
      const alterations = {
        pending: "",
        approved: "",
        interrupted: "",
        "foreign-connection":
          "UPDATE oauth_operation_intents SET user_id='20000000-0000-4000-8000-000000000001'",
        "foreign-session":
          "UPDATE oauth_operation_intents SET browser_session_id=(SELECT id FROM web_sessions WHERE user_id='20000000-0000-4000-8000-000000000001' LIMIT 1)",
        "partial-proof": "UPDATE oauth_operation_intents SET browser_session_id=NULL",
        "late-proof": "UPDATE oauth_operation_intents SET browser_approved_at_ms=expires_at_ms",
      };
      if (alterations[history].length > 0) {
        yield* wait(fixture.db.prepare(alterations[history]).run());
      }
      const before = yield* wait(
        fixture.db.prepare("SELECT rowid,* FROM oauth_operation_intents").all()
      );
      const originalSchema = yield* wait(
        fixture.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()
      );
      const baseline = schemaStatements(
        yield* wait(Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text())
      );
      const guide = yield* wait(
        Bun.file(
          new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
        ).text()
      );
      const plan = [
        ...documentedSqlBlock({ guide, marker: "oauth-intent-preflight" }),
        ...guards.map((target) => schemaDefinition({ source: baseline, target })),
        ...(history === "interrupted"
          ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('interrupted',0)"]
          : []),
        ...documentedSqlBlock({ guide, marker: "oauth-intent-verify" }),
      ];
      const commit = (): Promise<ReadonlyArray<D1Result>> =>
        fixture.db.batch(plan.map((sql) => fixture.db.prepare(sql)));
      if (history !== "pending" && history !== "approved") {
        yield* wait(expect(commit()).rejects.toThrow());
        expect(
          (yield* wait(fixture.db.prepare("SELECT rowid,* FROM oauth_operation_intents").all()))
            .results
        ).toEqual(before.results);
        expect(
          (yield* wait(fixture.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()))
            .results
        ).toEqual(originalSchema.results);
        return;
      }
      yield* wait(commit());
      expect(
        (yield* wait(fixture.db.prepare("SELECT rowid,* FROM oauth_operation_intents").all()))
          .results
      ).toEqual(before.results);
      for (const sql of [
        "INSERT INTO oauth_operation_intents(reference,user_id,connection_id,operation,input_json,input_digest,binding_json,disclosure_revision,created_at_ms,expires_at_ms) SELECT '14470000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',connection_id,operation,input_json,input_digest,binding_json,disclosure_revision,created_at_ms,expires_at_ms FROM oauth_operation_intents",
        "UPDATE oauth_operation_intents SET input_digest=zeroblob(32)",
        "UPDATE oauth_operation_intents SET binding_json='[]'",
        "UPDATE oauth_operation_intents SET expires_at_ms=expires_at_ms+1",
        "UPDATE oauth_operation_intents SET connection_id='foreign'",
        "UPDATE oauth_operation_intents SET browser_session_id=NULL,browser_approved_at_ms=created_at_ms-1",
      ]) {
        yield* wait(expect(fixture.db.prepare(sql).run()).rejects.toThrow());
      }
      const applied = yield* wait(fixture.call({ action: "accept", content: { confirm: true } }));
      expect(yield* wait(applied.json())).toMatchObject({ result: { isError: false } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) AS total FROM budgets WHERE id=?")
            .bind(fixture.id)
            .first()
        )
      ).toEqual({ total: 0 });
      expect((yield* wait(fixture.db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
        []
      );
    })
  )
);
