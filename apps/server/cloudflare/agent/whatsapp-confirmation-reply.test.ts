import { Effect } from "effect";
import { expect, it } from "vitest";
import { reply, setup } from "./hosted-turn.test-fixture";
import { exerciseTurn, successfulCapability } from "./whatsapp-capabilities.test-fixture";

it("does not present a consumed confirmation as approval for a new WhatsApp update", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* successfulCapability({
        db,
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
      });
      const command = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT command FROM hosted_confirmations WHERE consumed_turn_id IS NOT NULL LIMIT 1"
          )
          .first<string>("command")
      );
      expect(command).toEqual(expect.any(String));
      const result = yield* exerciseTurn({
        db,
        text: "Actualiza el presupuesto de Otros a 32002 COP.",
        messageId: "wamid.qa-stale-model-confirmation",
        generate: () =>
          Promise.resolve(reply(`Para actualizar el presupuesto, responde *${command}*.`)),
      });
      expect(result.sent).toEqual([
        "No preparé una confirmación válida para estos cambios. No uses códigos anteriores; vuelve a solicitar la operación.",
      ]);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM hosted_confirmations WHERE issued_turn_id=?")
            .bind(result.turnId)
            .first<number>("count")
        )
      ).toBe(0);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT cap FROM budgets LIMIT 1").first<string>("cap")
        )
      ).toBe("31001");
    })
  ));

it.each([
  {
    generated: `Responde CONFIRMAR ${"a".repeat(64)} para continuar.`,
    delivered:
      "No preparé una confirmación válida para estos cambios. No uses códigos anteriores; vuelve a solicitar la operación.",
  },
  {
    generated: "Las operaciones sensibles requieren la confirmación del host.",
    delivered: "Las operaciones sensibles requieren la confirmación del host.",
  },
])(
  "only suppresses executable model confirmation commands: $generated",
  ({ generated, delivered }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        const result = yield* exerciseTurn({
          db,
          text: "¿Cómo confirmo un cambio?",
          messageId: "wamid.qa-model-confirmation-reply",
          generate: () => Promise.resolve(reply(generated)),
        });
        expect(result.sent).toEqual([delivered]);
      })
    )
);
