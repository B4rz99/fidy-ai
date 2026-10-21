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
  times: Readonly<{
    occurredAt: string;
    dateOnly: string;
    recurringDate: string;
    recurring: "observe" | "ask" | "invent" | "ask-after-read" | "stale";
    recurringRead:
      | "observe"
      | "historical"
      | "past"
      | "occurrence"
      | "inactive"
      | "contradictory"
      | "extra-evidence"
      | "derived";
  }> = {
    occurredAt: "2026-09-22T12:00:00Z",
    dateOnly: "2026-09-21T05:00:00Z",
    recurringDate: "2026-09-22",
    recurring: "observe",
    recurringRead: "observe",
  }
): Effect.Effect<HostedInferenceService> =>
  Effect.gen(function* () {
    const recurring = times.recurring;
    const recurringRead = times.recurringRead;
    const occurredAt = times.occurredAt;
    const dateOnly = times.dateOnly;
    const textRound = yield* Ref.make(0);
    let mutationRound = 0;
    let recurringRound = 0;
    let recurringReadRound = 0;
    const recurringReadResult = (): Omit<HostedTextResult, "continuation"> => {
      recurringReadRound++;
      const maximumReads = recurringRead === "derived" || recurringRead === "past" ? 1 : 2;
      if (recurringReadRound > maximumReads) {
        const replies = {
          observe: '{"state":"active","nextDate":"2026-10-18"}',
          historical: '{"state":"active","nextDate":"2026-10-18"}',
          past: '{"state":"active","nextDate":"2026-09-18"}',
          occurrence: '{"state":"unconfirmed","nextDate":"2026-10-18"}',
          inactive: '{"state":"inactive","nextDate":"2026-10-18"}',
          "extra-evidence":
            '{"state":"active","nextDate":"2026-10-18","explanation":"El plan no está activo"}',
          derived: '{"state":"active","nextDate":"2026-10-18"}',
          contradictory:
            "El plan no está activo; próxima fecha 2026-09-18; después aparece 2026-10-18",
        };
        return result(replies[recurringRead]);
      }
      return result("", [
        {
          id: `recurring-read-${recurringReadRound}`,
          operation: CanonicalOperationId.make(
            recurringRead === "historical"
              ? "recurring.listRecurringSeries"
              : "recurringPlans.getRecurringWorkspace"
          ),
          params: { query: { month: recurringReadRound === 1 ? "2026-09" : "2026-10" } },
        },
      ]);
    };
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
        case "recurringPlans.applyRecurringEdit":
          return {
            payload: {
              expectedRevision: recurring === "stale" ? 1 : 2,
              edit: {
                kind: "lifecycle",
                planId: "00000000-0000-4000-8000-000000000002",
                date: times.recurringDate,
                action: "stop",
              },
            },
          };
        case "transactions.deleteTransaction":
          return { params: { id: "00000000-0000-4000-8000-000000000001" } };
        default:
          return { query: {} };
      }
    };
    const recurringResult = (): Effect.Effect<Omit<HostedTextResult, "continuation">> => {
      if (recurring === "ask" || (recurring === "ask-after-read" && recurringRound > 0)) {
        return Effect.succeed(result("Necesito expectedRevision."));
      }
      const operation = CanonicalOperationId.make(
        recurring === "invent" || recurringRound++ > 0
          ? "recurringPlans.applyRecurringEdit"
          : "recurringPlans.getRecurringWorkspace"
      );
      return Effect.succeed(
        result("", [
          {
            id: `recurring-call-${recurringRound}`,
            operation,
            params:
              operation === "recurringPlans.getRecurringWorkspace"
                ? { query: { month: "2026-09" } }
                : toolArguments(operation),
          },
        ])
      );
    };
    return makeHostedInferenceStub({
      countText: () => Effect.succeed(1),
      countTranscript: () => Effect.succeed(1),
      validate: () => Effect.void,
      generate: (policy) => {
        if (
          policy.availableOperations.includes(
            CanonicalOperationId.make("recurring.listRecurringSeries")
          )
        ) {
          return Effect.sync(recurringReadResult);
        }
        if (policy.toolChoice === "auto") {
          if (
            policy.availableOperations.includes(
              CanonicalOperationId.make("recurringPlans.getRecurringWorkspace")
            )
          ) {
            return recurringResult();
          }
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

it.effect("accepts the correct future date derived from the complete canonical plan", () =>
  Effect.gen(function* () {
    const inference = yield* conformanceStub("inválido", representativeAmount, {
      occurredAt: "2026-09-22T12:00:00Z",
      dateOnly: "2026-09-21T05:00:00Z",
      recurringDate: "2026-09-22",
      recurring: "observe",
      recurringRead: "derived",
    });
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
      recurringDate: "2026-09-22",
      recurring: "observe",
      recurringRead: "observe",
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

it.effect("rejects UTC midnight and an invented daylight-saving offset for a date in Bogotá", () =>
  Effect.gen(function* () {
    for (const dateOnly of ["2026-09-21T00:00:00Z", "2026-09-21T04:00:00Z"]) {
      const inference = yield* conformanceStub("inválido", representativeAmount, {
        occurredAt: "2026-09-22T12:00:00Z",
        dateOnly,
        recurringDate: "2026-09-22",
        recurring: "observe",
        recurringRead: "observe",
      });
      assert.deepStrictEqual(
        yield* Effect.exit(verifyHostedInferenceConformanceChecks(inference)),
        Exit.fail({ check: "canonical_date_only", category: "InvalidOutput" })
      );
    }
  })
);

it.effect("rejects timestamps and a different calendar day for recurring lifecycle changes", () =>
  Effect.gen(function* () {
    for (const recurringDate of ["2026-09-22T05:00:00Z", "2026-09-23"]) {
      const inference = yield* conformanceStub("inválido", representativeAmount, {
        occurredAt: "2026-09-22T12:00:00Z",
        dateOnly: "2026-09-21T05:00:00Z",
        recurringDate,
        recurring: "observe",
        recurringRead: "observe",
      });
      assert.deepStrictEqual(
        yield* Effect.exit(verifyHostedInferenceConformanceChecks(inference)),
        Exit.fail({ check: "canonical_recurring_lifecycle", category: "InvalidOutput" })
      );
    }
  })
);

it.effect("requires a workspace read followed by an edit using the observed revision", () =>
  Effect.gen(function* () {
    for (const recurring of ["ask", "invent", "ask-after-read", "stale"] as const) {
      const inference = yield* conformanceStub("inválido", representativeAmount, {
        occurredAt: "2026-09-22T12:00:00Z",
        dateOnly: "2026-09-21T05:00:00Z",
        recurringDate: "2026-09-22",
        recurring,
        recurringRead: "observe",
      });
      assert.deepStrictEqual(
        yield* Effect.exit(verifyHostedInferenceConformanceChecks(inference)),
        Exit.fail({ check: "canonical_recurring_lifecycle", category: "InvalidOutput" })
      );
    }
  })
);

it.effect(
  "rejects historical-pattern substitution, an overdue next date and occurrence state as plan state",
  () =>
    Effect.gen(function* () {
      for (const recurringRead of [
        "historical",
        "past",
        "occurrence",
        "inactive",
        "contradictory",
        "extra-evidence",
      ] as const) {
        const inference = yield* conformanceStub("inválido", representativeAmount, {
          occurredAt: "2026-09-22T12:00:00Z",
          dateOnly: "2026-09-21T05:00:00Z",
          recurringDate: "2026-09-22",
          recurring: "observe",
          recurringRead,
        });
        assert.deepStrictEqual(
          yield* Effect.exit(verifyHostedInferenceConformanceChecks(inference)),
          Exit.fail({ check: "canonical_recurring_read", category: "InvalidOutput" })
        );
      }
    })
);
