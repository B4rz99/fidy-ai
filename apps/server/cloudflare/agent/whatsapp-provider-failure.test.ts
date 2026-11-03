import { Effect } from "effect";
import { expect, it } from "vitest";
import { setup } from "./hosted-turn.test-fixture";
import {
  exerciseTurn,
  successfulCapability,
  toolReply,
} from "./whatsapp-capabilities.test-fixture";

const refusal = (code: string, status = 429): Response =>
  Response.json({ error: { code, message: "private provider detail" } }, { status });

const failureReply = "No pude completar tu solicitud en este momento. Inténtalo más tarde.";

it.each([
  ["insufficient_quota", 429],
  ["rate_limit_exceeded", 429],
  ["server_error", 503],
])("sends one safe WhatsApp reply for provider refusal %s/%i", (code, status) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      let rounds = 0;
      const result = yield* exerciseTurn({
        db,
        text: "Consulta mis presupuestos.",
        messageId: `wamid.qa-provider-refusal-${code}`,
        generate: () => {
          rounds += 1;
          return Promise.resolve(refusal(code, status));
        },
      });
      expect(result.sent).toEqual([failureReply]);
      expect(result.response.status).toBe(202);
      expect(rounds).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT status FROM hosted_turns WHERE id=?")
            .bind(result.turnId)
            .first<string>("status")
        )
      ).toBe("pending");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM hosted_mutation_commits WHERE turn_id=?")
            .bind(result.turnId)
            .first<number>("count")
        )
      ).toBe(0);
    })
  )
);

it("reports provider failure after a successful query without repeating the query", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      let rounds = 0;
      const result = yield* exerciseTurn({
        db,
        text: "Consulta mis categorías.",
        messageId: "wamid.qa-provider-refusal-after-query",
        generate: () =>
          Promise.resolve(
            ++rounds === 1
              ? toolReply({ operation: "categories.listCategories", input: {} })
              : refusal("insufficient_quota")
          ),
      });
      expect(result.sent).toEqual([failureReply]);
      expect(rounds).toBe(2);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM transcript_entries WHERE turn_id=? AND kind='tool_call'"
            )
            .bind(result.turnId)
            .first<number>("count")
        )
      ).toBe(1);
    })
  ));

it("keeps a mutation attempt out of the provider-failure reply path", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const input = {
        payload: {
          categoryId: "10000000-0000-4000-8000-000000000016",
          cap: { amount: "31001", currency: "COP" },
        },
      };
      yield* successfulCapability({ db, operation: "budgets.createBudget", input });
      let rounds = 0;
      const result = yield* exerciseTurn({
        db,
        text: "Crea otro presupuesto para Otros.",
        messageId: "wamid.qa-provider-refusal-after-mutation",
        generate: () =>
          Promise.resolve(
            ++rounds === 1
              ? toolReply({ operation: "budgets.createBudget", input })
              : refusal("insufficient_quota")
          ),
      });
      expect(result.sent).toEqual([]);
      expect(result.response.status).toBe(429);
      expect(rounds).toBe(2);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM budgets").first<number>("count")
        )
      ).toBe(1);
    })
  ));
