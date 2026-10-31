import { Effect } from "effect";
import { expect, it } from "vitest";
import { pendingBudgetDeletion, sessionFor, wait } from "./oauth-ingress.test-fixture";

it.each(["pending", "approved"] as const)(
  "protects exact %s OAuth approval inputs and ownership",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* pendingBudgetDeletion();
        if (history === "approved") {
          yield* wait(
            fixture.db
              .prepare(`UPDATE oauth_operation_intents SET browser_approved_at_ms=created_at_ms,
        browser_session_id=(SELECT id FROM web_sessions WHERE user_id=oauth_operation_intents.user_id LIMIT 1)`)
              .run()
          );
        }
        yield* sessionFor({ db: fixture.db, index: 2 });
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
