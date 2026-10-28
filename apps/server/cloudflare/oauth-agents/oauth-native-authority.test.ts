import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { pendingBudgetDeletion, wait } from "./oauth-ingress.test-fixture";

it("retired browser operation routes cannot disclose, approve or cancel native work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      for (const decision of ["approve", "cancel"] as const) {
        const response = yield* wait(
          fixture.send("/web/oauth/operation-decision", {
            method: "POST",
            headers: fixture.headers,
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
              reference: fixture.reference,
              decision,
            }),
          })
        );
        expect(response.status).toBe(404);
      }
      const response = yield* wait(
        fixture.send(`/web/oauth/operation-review?reference=${fixture.reference}`, {
          headers: fixture.headers,
        })
      );
      expect(response.status).toBe(404);
      expect(yield* wait(response.text())).not.toContain(fixture.id);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id=?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(1);
      const native = yield* wait(fixture.call({ action: "accept", content: { confirm: true } }));
      expect(yield* wait(native.json())).toMatchObject({ result: { isError: false } });
    })
  ));

it.each(["input_digest", "disclosure_revision"] as const)(
  "rejects a changed %s without consuming the intent or mutating",
  (field) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* pendingBudgetDeletion();
        yield* wait(fixture.db.prepare("DROP TRIGGER oauth_intent_immutable").run());
        yield* wait(
          fixture.db
            .prepare(
              field === "input_digest"
                ? "UPDATE oauth_operation_intents SET input_digest=zeroblob(32) WHERE reference=?"
                : "UPDATE oauth_operation_intents SET disclosure_revision='oauth-first-party-1381-v1' WHERE reference=?"
            )
            .bind(fixture.reference)
            .run()
        );
        const response = yield* wait(
          fixture.call({ action: "accept", content: { confirm: true } })
        );
        expect(yield* wait(response.json())).toMatchObject({ result: { isError: true } });
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM budgets WHERE id=?")
              .bind(fixture.id)
              .first<number>("count(*)")
          )
        ).toBe(1);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference=?")
              .bind(fixture.reference)
              .first<number>("count(*)")
          )
        ).toBe(1);
      })
    )
);
