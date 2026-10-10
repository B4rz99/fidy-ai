import { strict as assert } from "node:assert";
import { it } from "@effect/vitest";
import { Effect, Exit, Ref, Schema } from "effect";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { type HostedInferenceService, type HostedTextResult } from "./contract";
import { makeHostedInferenceStub, verifyHostedInferenceConformanceChecks } from "./operations";

const representativeAmount = 42_000;

const result = (
  text: string,
  toolCalls: HostedTextResult["toolCalls"] = []
): Omit<HostedTextResult, "continuation"> => ({
  text,
  toolCalls,
  finishReason: toolCalls.length === 0 ? "stop" : "tool-calls",
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
});

const conformanceStub = (
  firstText: string,
  amount: number | string = representativeAmount,
  times: Readonly<{ occurredAt: string; dateOnly: string }> = {
    occurredAt: "2026-09-22T12:00:00Z",
    dateOnly: "2026-09-21T05:00:00Z",
  }
): Effect.Effect<HostedInferenceService> =>
  Effect.gen(function* () {
    const occurredAt = times.occurredAt;
    const dateOnly = times.dateOnly;
    const textRound = yield* Ref.make(0);
    let mutationRound = 0;
    const toolArguments = (operation: CanonicalOperationId): Schema.Json => {
      switch (operation) {
        case "transactions.createTransaction":
          return {
            payload: {
              money: { amount: String(amount), currency: "COP" },
              direction: "outflow",
              occurredAt: mutationRound++ === 0 ? occurredAt : dateOnly,
            },
          };
        case "transactions.updateTransaction":
          return {
            params: { id: "00000000-0000-4000-8000-000000000001" },
            payload: {
              expectedRevision: 2,
              changes: { money: { amount: "2345", currency: "COP" } },
            },
          };
        case "transactions.deleteTransaction":
          return { params: { id: "00000000-0000-4000-8000-000000000001" } };
        default:
          return { query: {} };
      }
    };
    return makeHostedInferenceStub({
      countText: () => Effect.succeed(1),
      countTranscript: () => Effect.succeed(1),
      validate: () => Effect.void,
      generate: (policy) => {
        if (policy.toolChoice === "auto") {
          return Effect.sync(() =>
            result("", [
              {
                id: "call-1",
                operation:
                  policy.availableOperations[0] ??
                  CanonicalOperationId.make("transactions.listTransactions"),
                params: toolArguments(
                  policy.availableOperations[0] ??
                    CanonicalOperationId.make("transactions.listTransactions")
                ),
              },
            ])
          );
        }
        return Ref.getAndUpdate(textRound, (round) => round + 1).pipe(
          Effect.map((round) => result(round === 0 ? firstText : "Trabajo con pesos colombianos."))
        );
      },
      generateStructured: (outputSchema) =>
        Schema.decodeUnknownEffect(outputSchema)({
          amount: representativeAmount,
          currency: "COP",
          direction: "outflow",
          locale: "es-CO",
        }).pipe(Effect.orDie),
    });
  });

it.effect(
  "accepts wire tool arguments, corrected repeated rounds, structured output, and es-CO",
  () =>
    Effect.gen(function* () {
      const inference = yield* conformanceStub("inválido");

      yield* verifyHostedInferenceConformanceChecks(inference);
    })
);

it.effect("rejects malformed wire Money before checking the requested amount", () =>
  Effect.gen(function* () {
    const inference = yield* conformanceStub("inválido", "not-money");

    assert.deepStrictEqual(
      yield* Effect.exit(verifyHostedInferenceConformanceChecks(inference)),
      Exit.fail({ check: "canonical_mutation", category: "InvalidOutput" })
    );
  })
);

it.effect("rejects a canonical mutation whose Money differs from the User's request", () =>
  Effect.gen(function* () {
    const inference = yield* conformanceStub("inválido", 41_000);
    assert.deepStrictEqual(
      yield* Effect.exit(verifyHostedInferenceConformanceChecks(inference)),
      Exit.fail({ check: "canonical_mutation_money", category: "InvalidOutput" })
    );
  })
);

it.effect("rejects local wall time when the canonical mutation needs the UTC instant", () =>
  Effect.gen(function* () {
    const inference = yield* conformanceStub("inválido", representativeAmount, {
      occurredAt: "2026-09-22T07:00:00Z",
      dateOnly: "2026-09-21T05:00:00Z",
    });
    assert.deepStrictEqual(
      yield* Effect.exit(verifyHostedInferenceConformanceChecks(inference)),
      Exit.fail({ check: "canonical_mutation_time", category: "InvalidOutput" })
    );
  })
);

it.effect("fails closed when Spanish invalid-output evidence is absent", () =>
  Effect.gen(function* () {
    const inference = yield* conformanceStub("I can help with your finances.");

    assert.deepStrictEqual(
      yield* Effect.exit(verifyHostedInferenceConformanceChecks(inference)),
      Exit.fail({ check: "invalid_output_recovery", category: "InvalidOutput" })
    );
  })
);

it.effect("rejects UTC midnight for a date requested without a time in Bogotá", () =>
  Effect.gen(function* () {
    const inference = yield* conformanceStub("inválido", representativeAmount, {
      occurredAt: "2026-09-22T12:00:00Z",
      dateOnly: "2026-09-21T00:00:00Z",
    });
    assert.deepStrictEqual(
      yield* Effect.exit(verifyHostedInferenceConformanceChecks(inference)),
      Exit.fail({ check: "canonical_date_only", category: "InvalidOutput" })
    );
  })
);
