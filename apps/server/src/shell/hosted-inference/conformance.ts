import { BigDecimal, Brand, DateTime, Effect, Option, Predicate, Schema } from "effect";
import { CreateTransactionInput } from "~/core/transactions/model";
import { IanaTimeZone } from "~/core/_shared/context";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedInitialTextContext,
  HostedToolCallMaximum,
} from "./contract";

const makeInitialContext = Brand.nominal<HostedInitialTextContext>();
const representativeAmount = 42_000;

const conformanceFailure = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "InvalidOutput", description: "Hosted provider response was invalid" },
    retryable: false,
    retryAfter: Option.none(),
  });

const context = (text: string): HostedInitialTextContext =>
  makeInitialContext({
    sections: [
      {
        _tag: "AssistantPolicy",
        user: {
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: IanaTimeZone.make("America/Bogota"),
        },
      },
      { _tag: "TurnStarted", startedAt: DateTime.makeUnsafe("2026-09-22T12:00:00Z") },
    ],
    activeRequest: { _tag: "Present", text },
  });

const requireTextEvidence = (
  value: unknown,
  expected: string
): Effect.Effect<void, HostedInferenceError> =>
  Predicate.isString(value) && value.toLocaleLowerCase("es-CO").includes(expected)
    ? Effect.void
    : Effect.fail(conformanceFailure());

const forbidTextEvidence = (
  value: unknown,
  forbidden: string
): Effect.Effect<void, HostedInferenceError> =>
  Predicate.isString(value) && !value.toLocaleLowerCase("es-CO").includes(forbidden)
    ? Effect.void
    : Effect.fail(conformanceFailure());

const verifyCanonicalQuery = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedInferenceError> =>
  Effect.gen(function* () {
    const query = yield* inference.prepareText({
      context: context(
        "Usa la herramienta para listar mis transacciones sin filtros. No respondas sin usarla."
      ),
      availableOperations: [CanonicalOperationId.make("transactions.listTransactions")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });
    const queryResult = yield* query.execute;
    if (
      queryResult.toolCalls.length !== 1 ||
      queryResult.toolCalls[0]?.operation !== "transactions.listTransactions"
    ) {
      return yield* conformanceFailure();
    }
  });

const MutationArguments = Schema.Struct({ payload: Schema.toType(CreateTransactionInput) });
type MutationArguments = typeof MutationArguments.Type;

const verifyCanonicalMutation = (
  inference: HostedInferenceService
): Effect.Effect<MutationArguments, HostedInferenceError> =>
  Effect.gen(function* () {
    const mutation = yield* inference.prepareText({
      context: context(
        "Registra con la herramienta un gasto de 42.000 COP en mercado ocurrido el 22 de septiembre de 2026 a las 07:00 en Bogotá."
      ),
      availableOperations: [CanonicalOperationId.make("transactions.createTransaction")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });
    const mutationResult = yield* mutation.execute;
    const mutationCall = mutationResult.toolCalls[0];
    if (
      mutationResult.toolCalls.length !== 1 ||
      mutationCall?.operation !== "transactions.createTransaction"
    ) {
      return yield* conformanceFailure();
    }
    if (!Schema.is(MutationArguments)(mutationCall.params)) {
      return yield* conformanceFailure();
    }
    return mutationCall.params;
  });

const verifyMutationMoney = (args: MutationArguments): Effect.Effect<void, HostedInferenceError> =>
  args.payload.money.currency === "COP" &&
  args.payload.direction === "outflow" &&
  BigDecimal.equals(args.payload.money.amount, BigDecimal.make(42_000n, 0))
    ? Effect.void
    : Effect.fail(conformanceFailure());

const verifyMutationTime = (args: MutationArguments): Effect.Effect<void, HostedInferenceError> =>
  DateTime.formatIso(args.payload.occurredAt) === "2026-09-22T12:00:00.000Z"
    ? Effect.void
    : Effect.fail(conformanceFailure());

const verifyInvalidOutputRecovery = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedInferenceError> =>
  Effect.gen(function* () {
    const prepared = yield* inference.prepareText({
      context: context("Responde exactamente con una sola palabra: inválido."),
      availableOperations: [],
      toolChoice: "none",
    });
    const first = yield* prepared.execute;
    yield* requireTextEvidence(first.text, "inválido");
    yield* forbidTextEvidence(first.text, "pesos colombianos");
    const corrected = yield* first.continuation.prepare([
      {
        _tag: "InvalidOutputFeedback",
        description:
          "La respuesta anterior no fue válida. Corrígela e incluye exactamente la frase: pesos colombianos.",
      },
    ]);
    const result = yield* corrected.execute;
    yield* requireTextEvidence(result.text, "pesos colombianos");
  });

const verifyStructuredColombianSpanish = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedInferenceError> =>
  inference
    .prepareStructured({
      context: { prior: Option.some("Ayer me gasté 42 lucas en el mercado."), entries: [] },
      purpose: "conversation-compaction",
      outputSchema: Schema.Struct({
        amount: Schema.Literal(representativeAmount),
        currency: Schema.Literal("COP"),
        direction: Schema.Literal("outflow"),
        locale: Schema.Literal("es-CO"),
      }),
    })
    .pipe(
      Effect.flatMap((prepared) => prepared.execute),
      Effect.asVoid
    );

/** Closed live approval checks, identifying a failing capability without exposing model content. */
export type HostedConformanceCheck =
  | "canonical_query"
  | "canonical_mutation"
  | "canonical_mutation_money"
  | "canonical_mutation_time"
  | "invalid_output_recovery"
  | "structured_es_co";

/** Only a closed check and failure category may leave the live conformance boundary. */
export type HostedConformanceFailure = Readonly<{
  check: HostedConformanceCheck;
  category: HostedInferenceError["reason"]["_tag"];
}>;

/** Evaluate a live model candidate; return no generated content, only closed failure evidence. */
export const verifyHostedInferenceConformanceChecks = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedConformanceFailure> => {
  const check = <A>(
    name: HostedConformanceCheck,
    work: Effect.Effect<A, HostedInferenceError>
  ): Effect.Effect<A, HostedConformanceFailure> =>
    work.pipe(
      Effect.mapError((error): HostedConformanceFailure => ({
        check: name,
        category: error.reason._tag,
      }))
    );
  return check("canonical_query", verifyCanonicalQuery(inference)).pipe(
    Effect.andThen(check("canonical_mutation", verifyCanonicalMutation(inference))),
    Effect.flatMap((args) =>
      check("canonical_mutation_money", verifyMutationMoney(args)).pipe(
        Effect.andThen(check("canonical_mutation_time", verifyMutationTime(args)))
      )
    ),
    Effect.andThen(check("invalid_output_recovery", verifyInvalidOutputRecovery(inference))),
    Effect.andThen(check("structured_es_co", verifyStructuredColombianSpanish(inference)))
  );
};
