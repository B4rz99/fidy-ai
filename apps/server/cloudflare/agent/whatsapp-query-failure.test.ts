import { Effect } from "effect";
import { expect, it } from "vitest";
import { reply, setup } from "./hosted-turn.test-fixture";
import { exerciseTurn, toolReply } from "./whatsapp-capabilities.test-fixture";

it("does not turn an invalid Insight cursor into a claim that zero Insights exist", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      let rounds = 0;
      const result = yield* exerciseTurn({
        db,
        text: "Consulta mis Insights pendientes; no modifiques datos.",
        messageId: "wamid.qa-invalid-insight-cursor",
        generate: () =>
          Promise.resolve(
            ++rounds === 1
              ? toolReply({
                  operation: "insights.listPendingInsights",
                  input: { query: { cursor: "null" } },
                })
              : reply("Tienes 0 Insights pendientes.")
          ),
      });
      expect(result.sent).toEqual([
        "No pude completar la consulta solicitada. No puedo confirmar sus resultados. Inténtalo de nuevo.",
      ]);
      expect(rounds).toBe(1);
    })
  ));

it.each([{}, { cursor: null }])(
  "allows a confirmed empty query result with %j to be summarized as zero",
  (query) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        let rounds = 0;
        const result = yield* exerciseTurn({
          db,
          text: "Consulta mis Insights pendientes; no modifiques datos.",
          messageId: "wamid.qa-valid-empty-insights",
          generate: () =>
            Promise.resolve(
              ++rounds === 1
                ? toolReply({ operation: "insights.listPendingInsights", input: { query } })
                : reply("Tienes 0 Insights pendientes.")
            ),
        });
        expect(result.sent).toEqual(["Tienes 0 Insights pendientes."]);
        expect(rounds).toBe(2);
      })
    )
);
