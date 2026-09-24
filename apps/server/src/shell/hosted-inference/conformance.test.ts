import { strict as assert } from "node:assert";
import { it } from "@effect/vitest";
import { Effect, Exit, Option, Ref, Schema } from "effect";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { CreateTransactionInput } from "~/core/transactions/model";
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedTextResult,
} from "./contract";
import { verifyHostedInferenceConformance } from "./conformance";
import { makeHostedInferenceStub } from "./operations";

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
  amount = representativeAmount,
  occurredAt = "2026-09-22T12:00:00Z"
): Effect.Effect<HostedInferenceService> =>
  Effect.gen(function* () {
    const textRound = yield* Ref.make(0);
    return makeHostedInferenceStub({
      countText: () => Effect.succeed(1),
      countTranscript: () => Effect.succeed(1),
      validate: () => Effect.void,
      generate: (policy) => {
        if (policy.toolChoice === "auto") {
          return Effect.succeed(
            result("", [
              {
                id: "call-1",
                operation:
                  policy.availableOperations[0] ??
                  CanonicalOperationId.make("transactions.listTransactions"),
                params:
                  policy.availableOperations[0] === "transactions.createTransaction"
                    ? Schema.decodeSync(Schema.Struct({ payload: CreateTransactionInput }))({
                        payload: {
                          money: { amount: String(amount), currency: "COP" },
                          direction: "outflow",
                          occurredAt,
                        },
                      })
                    : { query: {} },
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

it.effect("accepts canonical tools, corrected repeated rounds, structured output, and es-CO", () =>
  Effect.gen(function* () {
    const inference = yield* conformanceStub("inválido");

    yield* verifyHostedInferenceConformance(inference);
  })
);

it.effect("rejects a canonical mutation whose Money differs from the User's request", () =>
  Effect.gen(function* () {
    const inference = yield* conformanceStub("inválido", 41_000);
    assert.deepStrictEqual(
      yield* Effect.exit(verifyHostedInferenceConformance(inference)),
      Exit.fail(
        new HostedInferenceError({
          reason: { _tag: "InvalidOutput", description: "Hosted provider response was invalid" },
          retryable: false,
          retryAfter: Option.none(),
        })
      )
    );
  })
);

it.effect("rejects local wall time when the canonical mutation needs the UTC instant", () =>
  Effect.gen(function* () {
    const inference = yield* conformanceStub(
      "inválido",
      representativeAmount,
      "2026-09-22T07:00:00Z"
    );
    assert.deepStrictEqual(
      yield* Effect.exit(verifyHostedInferenceConformance(inference)),
      Exit.fail(
        new HostedInferenceError({
          reason: { _tag: "InvalidOutput", description: "Hosted provider response was invalid" },
          retryable: false,
          retryAfter: Option.none(),
        })
      )
    );
  })
);

it.effect("fails closed when Spanish invalid-output evidence is absent", () =>
  Effect.gen(function* () {
    const inference = yield* conformanceStub("I can help with your finances.");

    assert.deepStrictEqual(
      yield* Effect.exit(verifyHostedInferenceConformance(inference)),
      Exit.fail(
        new HostedInferenceError({
          reason: { _tag: "InvalidOutput", description: "Hosted provider response was invalid" },
          retryable: false,
          retryAfter: Option.none(),
        })
      )
    );
  })
);
