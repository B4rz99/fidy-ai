import { Brand, DateTime, Effect, Option, Predicate, Schema } from "effect";
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

const verifyCanonicalTools = (
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

    const mutation = yield* inference.prepareText({
      context: context(
        "Registra con la herramienta un gasto de 42.000 COP en mercado ocurrido el 22 de septiembre de 2026 a las 07:00 en Bogotá."
      ),
      availableOperations: [CanonicalOperationId.make("transactions.createTransaction")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });
    const mutationResult = yield* mutation.execute;
    if (
      mutationResult.toolCalls.length !== 1 ||
      mutationResult.toolCalls[0]?.operation !== "transactions.createTransaction"
    ) {
      return yield* conformanceFailure();
    }
  });

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

/**
 * Live provider-conformance gate for an approval candidate. It intentionally returns no generated
 * content: callers may report only pass/fail metadata. The gate script first runs deterministic
 * adapter conformance for malformed output and arguments, recovery, bounds, interruption, and
 * hidden-retry prohibition; this live phase then verifies approved-model behavior.
 */
export const verifyHostedInferenceConformance = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedInferenceError> =>
  verifyCanonicalTools(inference).pipe(
    Effect.andThen(verifyInvalidOutputRecovery(inference)),
    Effect.andThen(verifyStructuredColombianSpanish(inference))
  );
