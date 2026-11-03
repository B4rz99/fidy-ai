import { Effect } from "effect";
import { expect, it } from "vitest";
import { setup } from "./hosted-turn.test-fixture";
import {
  exerciseTurn,
  successfulCapability,
  toolReply,
} from "./whatsapp-capabilities.test-fixture";

const categoryQueryReply = (): Response =>
  Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "query-categories",
              type: "function",
              function: { name: "categories__listCategories", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
  });

const invalidBatchReply = (): Response =>
  Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "invalid-batch",
              type: "function",
              function: { name: "operations__executeAtomicBatch", arguments: "{" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
  });

it("repairs invalid mutation arguments after a successful query without repeating that query", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      let rounds = 0;
      const result = yield* exerciseTurn({
        db,
        text: "Consulta mis categorías y prepara un presupuesto de 31001 COP para Otros.",
        messageId: "wamid.qa-repair-after-query",
        generate: () => {
          rounds += 1;
          if (rounds === 1) {
            return Promise.resolve(categoryQueryReply());
          }
          if (rounds === 2) {
            return Promise.resolve(invalidBatchReply());
          }
          return Promise.resolve(
            toolReply({
              operation: "operations.executeAtomicBatch",
              input: {
                payload: {
                  calls: [
                    {
                      callId: "70000000-0000-4000-8000-000000000001",
                      operation: "budgets.createBudget",
                      input: {
                        payload: {
                          categoryId: "10000000-0000-4000-8000-000000000016",
                          cap: { amount: "31001", currency: "COP" },
                        },
                      },
                    },
                  ],
                },
              },
            })
          );
        },
      });
      expect(rounds).toBe(3);
      expect(result.sent).toHaveLength(1);
      expect(result.sent[0]).toContain("Responde exactamente: CONFIRMAR ");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM transcript_entries WHERE turn_id=? AND kind='tool_call' AND operation='categories.listCategories'"
            )
            .bind(result.turnId)
            .first<number>("count")
        )
      ).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM budgets").first<number>("count")
        )
      ).toBe(0);
    })
  ));

it("stops after one failed repair of invalid arguments following a query", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      let rounds = 0;
      const result = yield* exerciseTurn({
        db,
        text: "Consulta mis categorías y prepara un presupuesto para Otros.",
        messageId: "wamid.qa-bounded-repair-after-query",
        generate: () =>
          Promise.resolve(++rounds === 1 ? categoryQueryReply() : invalidBatchReply()),
      });
      expect(rounds).toBe(3);
      expect(result.response.status).toBe(503);
      expect(result.sent).toEqual([]);
    })
  ));

it("does not repair a later model output after a rejected mutation attempt", () =>
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
        messageId: "wamid.qa-no-repair-after-mutation",
        generate: () =>
          Promise.resolve(
            ++rounds === 1
              ? toolReply({ operation: "budgets.createBudget", input })
              : invalidBatchReply()
          ),
      });
      expect(rounds).toBe(2);
      expect(result.response.status).toBe(503);
      expect(result.sent).toEqual([]);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM budgets").first<number>("count")
        )
      ).toBe(1);
    })
  ));
