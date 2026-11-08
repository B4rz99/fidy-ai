import { Effect } from "effect";
import { expect, it } from "vitest";
import { reply, setup } from "./hosted-turn.test-fixture";
import {
  exerciseTurn,
  successfulCapability,
  toolReply,
} from "./whatsapp-capabilities.test-fixture";

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
        "No pude preparar esos cambios. Vuelve a pedirlos para revisarlos antes de confirmar.",
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
    generated: "### Tu presupuesto\n**Restaurantes:** 300.000 pesos.\n* Total: **300.000 pesos**",
    delivered: "Tu presupuesto\nRestaurantes: 300.000 pesos.\n- Total: 300.000 pesos",
  },
  {
    generated: JSON.stringify({
      source: "transcript_assistant",
      text: "Tienes Pro. No hay una suscripción de pago que cancelar.",
    }),
    delivered: "Tienes Pro. No hay una suscripción de pago que cancelar.",
  },
  {
    generated: `**CONFIR**MAR ${"a".repeat(64)}`,
    delivered:
      "No pude preparar esos cambios. Vuelve a pedirlos para revisarlos antes de confirmar.",
  },
  {
    generated: "12.500 * 2 = 25.000 pesos; 2,50 USD.",
    delivered: "12.500 * 2 = 25.000 pesos; 2,50 USD.",
  },
  {
    generated: `Responde CONFIRMAR ${"a".repeat(64)} para continuar.`,
    delivered:
      "No pude preparar esos cambios. Vuelve a pedirlos para revisarlos antes de confirmar.",
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

it("describes a budget confirmation in Spanish without exposing the operation, JSON or category identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const result = yield* exerciseTurn({
        db,
        text: "Quiero un presupuesto de 300 mil pesos para restaurantes.",
        messageId: "wamid.budget-friendly-confirmation",
        generate: () =>
          Promise.resolve(
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
                          categoryId: "10000000-0000-4000-8000-000000000001",
                          cap: { amount: "300000", currency: "COP" },
                        },
                      },
                    },
                  ],
                },
              },
            })
          ),
      });
      expect(result.sent).toHaveLength(1);
      const text = result.sent[0];
      expect(text).toContain("Restaurantes");
      expect(text).toContain("300.000");
      expect(text).not.toContain("budgets.createBudget");
      expect(text).not.toContain("categoryId");
      expect(text).not.toContain("10000000-0000-4000-8000-000000000001");
      expect(text).not.toContain('{"');
      expect(text).not.toMatch(/CONFIRMAR [a-f0-9]{64}/u);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT count(*) AS total FROM budgets").first())
      ).toEqual({ total: 0 });
    })
  ));
