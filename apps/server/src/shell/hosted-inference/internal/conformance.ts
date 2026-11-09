import { SubscriptionStatus } from "~/core/subscription/contract";
import { BigDecimal, Brand, DateTime, Effect, Option, Predicate, Schema } from "effect";
import {
  CreateTransactionInput,
  TransactionId,
  UpdateTransactionInput,
} from "~/core/transactions/contract";
import { ToolCallId } from "~/core/agent/contract";
import { IanaTimeZone } from "~/core/_shared/context";
import { RecurringCommand, RecurringDocument } from "~/core/recurring-plans/contract";
import { projectRecurringMonth, summarizeRecurring } from "~/core/recurring-plans/operations";
import { RecurringWorkspace } from "~/shell/recurring-plans/contract";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedInitialTextContext,
  type HostedTextResult,
  HostedToolCallMaximum,
} from "~/shell/hosted-inference/contract";

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
        channel: "web",
        user: {
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: IanaTimeZone.make("America/Bogota"),
        },
      },
      {
        _tag: "TurnStarted",
        timeZone: "America/Bogota",
        startedAt: DateTime.makeUnsafe("2026-09-22T12:00:00Z"),
      },
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

export const verifyCanonicalQuery = (
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
      {
        return yield* conformanceFailure();
      }
    }
  });

const MutationArguments = Schema.Struct({ payload: CreateTransactionInput });
type MutationArguments = typeof MutationArguments.Type;

export const verifyCanonicalMutation = (
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
      {
        return yield* conformanceFailure();
      }
    }
    return yield* Schema.decodeUnknownEffect(MutationArguments)(mutationCall.params).pipe(
      Effect.mapError(() => conformanceFailure())
    );
  });

export const verifyMutationMoney = (
  args: MutationArguments
): Effect.Effect<void, HostedInferenceError> =>
  args.payload.money.currency === "COP" &&
  args.payload.direction === "outflow" &&
  BigDecimal.equals(args.payload.money.amount, BigDecimal.make(42_000n, 0))
    ? Effect.void
    : Effect.fail(conformanceFailure());

export const verifyMutationTime = (
  args: MutationArguments
): Effect.Effect<void, HostedInferenceError> =>
  DateTime.formatIso(args.payload.occurredAt) === "2026-09-22T12:00:00.000Z"
    ? Effect.void
    : Effect.fail(conformanceFailure());

const isCorrectionMoney = (money: UpdateTransactionInput["changes"]["money"]): boolean =>
  money?.currency === "COP" && BigDecimal.equals(money.amount, BigDecimal.make(2345n, 0));

const representativeTransactionId = "00000000-0000-4000-8000-000000000001";

export const verifyTransactionCorrection = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedInferenceError> =>
  Effect.gen(function* () {
    const prepared = yield* inference.prepareText({
      context: context(
        `Corrige únicamente el monto de la transacción ${representativeTransactionId}, revisión actual 2, a 2.345 COP. Usa la herramienta; no crees otra transacción.`
      ),
      availableOperations: [CanonicalOperationId.make("transactions.updateTransaction")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });
    const result = yield* prepared.execute;
    const call = result.toolCalls[0];
    if (result.toolCalls.length !== 1 || call?.operation !== "transactions.updateTransaction") {
      return yield* conformanceFailure();
    }
    const args = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        params: Schema.Struct({ id: TransactionId }),
        payload: UpdateTransactionInput,
      })
    )(call.params).pipe(Effect.mapError(conformanceFailure));
    const money = args.payload.changes.money;
    if (money === undefined) {
      return yield* conformanceFailure();
    }

    if (
      args.params.id !== representativeTransactionId ||
      args.payload.expectedRevision !== 2 ||
      !isCorrectionMoney(money)
    ) {
      return yield* conformanceFailure();
    }
  });

export const verifyTransactionDeletion = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedInferenceError> =>
  Effect.gen(function* () {
    const prepared = yield* inference.prepareText({
      context: context(
        `Elimina únicamente la transacción ${representativeTransactionId} usando la herramienta.`
      ),
      availableOperations: [CanonicalOperationId.make("transactions.deleteTransaction")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });
    const result = yield* prepared.execute;
    const call = result.toolCalls[0];
    if (result.toolCalls.length !== 1 || call?.operation !== "transactions.deleteTransaction") {
      return yield* conformanceFailure();
    }
    const args = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ params: Schema.Struct({ id: TransactionId }) })
    )(call.params).pipe(Effect.mapError(conformanceFailure));
    if (args.params.id !== representativeTransactionId) {
      return yield* conformanceFailure();
    }
  });

const representativePlanId = "00000000-0000-4000-8000-000000000002";
const expectedRecurringLifecycle = Schema.Struct({
  expectedRevision: Schema.Literal(2),
  edit: Schema.Struct({
    kind: Schema.Literal("lifecycle"),
    planId: Schema.Literal(representativePlanId),
    action: Schema.Literal("stop"),
    date: Schema.Literal("2026-09-22"),
  }),
});

const laterRecurringPlan = {
  id: "00000000-0000-4000-8000-000000000003",
  revisions: [
    {
      from: "2026-10-20",
      plan: {
        name: "Pago posterior",
        kind: "expense",
        currency: "COP",
        amountMode: "fixed",
        money: { amount: "107", currency: "COP" },
        frequency: "monthly",
        firstDate: "2026-10-20",
        timeZone: "America/Bogota",
      },
    },
  ],
  pauses: [],
} as const;

const representativeRecurringWorkspace = (
  month: "2026-09" | "2026-10" = "2026-09",
  firstDate: "2026-09-18" | "2026-09-22" = "2026-09-22"
): Effect.Effect<Schema.Json, HostedInferenceError> =>
  Effect.gen(function* () {
    const document = yield* Schema.decodeEffect(RecurringDocument)({
      revision: 2,
      plans: [
        laterRecurringPlan,
        {
          id: representativePlanId,
          revisions: [
            {
              from: firstDate,
              plan: {
                name: "Plan de prueba",
                kind: "expense",
                currency: "COP",
                amountMode: "unknown",
                frequency: "monthly",
                firstDate,
                timeZone: "America/Bogota",
              },
            },
          ],
          pauses: [],
        },
      ],
      exceptions: [],
      fulfillments: [],
      excludedTransactionIds: [],
      suggestions: [],
    });
    const occurrences = projectRecurringMonth({
      document,
      month,
      now: DateTime.makeUnsafe("2026-09-22T12:00:00Z"),
    });
    return yield* Schema.encodeEffect(Schema.toCodecJson(RecurringWorkspace))({
      document,
      month,
      today: "2026-09-22",
      occurrences,
      previous: [],
      summary: summarizeRecurring(occurrences),
      linkedTransactions: [],
      invalidFulfillmentIds: [],
      matches: [],
      matchesComplete: true,
    });
  }).pipe(Effect.mapError(conformanceFailure));

const verifyRecurringReadAnswer = (answer: unknown): Effect.Effect<void, HostedInferenceError> =>
  Effect.gen(function* () {
    const text = yield* Schema.decodeUnknownEffect(Schema.String)(answer).pipe(
      Effect.mapError(conformanceFailure)
    );
    yield* requireTextEvidence(text, "activo");
    yield* requireTextEvidence(text, "plan de prueba");
    yield* requireTextEvidence(text, "18 de octubre de 2026");
    yield* forbidTextEvidence(text, "pago posterior");
    yield* forbidTextEvidence(text, "20 de octubre");
    if (
      /[`*]|^\s*[[{#]|\b(?:state|nextDate|unconfirmed)\b|no\s+(?:está|sigue)\s+activo|inactivo|sin confirmar|pausado|detenido|2026-09-18|18 de septiembre/imu.test(
        text
      )
    ) {
      return yield* conformanceFailure();
    }
  });

/** A maintained plan is distinct from both historical detection and a past occurrence's state. */
export const verifyRecurringPlanRead = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedInferenceError> =>
  Effect.gen(function* () {
    const maximumReads = 2;
    const prepared = yield* inference.prepareText({
      context: context(
        "¿Sigue activo mi plan «Plan de prueba»? ¿Cuál es mi próximo pago recurrente? Estamos en septiembre de 2026. Solo quiero consultar, sin hacer cambios."
      ),
      availableOperations: [
        CanonicalOperationId.make("recurring.listRecurringSeries"),
        CanonicalOperationId.make("recurringPlans.getRecurringWorkspace"),
      ],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(maximumReads),
    });
    let result = yield* prepared.execute;
    let reads = 0;
    for (let round = 0; round < maximumReads && result.toolCalls.length > 0; round++) {
      const outputs = yield* Effect.forEach(result.toolCalls, (call) =>
        Effect.gen(function* () {
          if (call.operation !== "recurringPlans.getRecurringWorkspace") {
            return yield* conformanceFailure();
          }
          const args = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              query: Schema.Struct({
                month: Schema.optionalKey(Schema.Literals(["2026-09", "2026-10"])),
              }),
            })
          )(call.params).pipe(Effect.mapError(conformanceFailure));
          const output = yield* representativeRecurringWorkspace(
            args.query.month ?? "2026-09",
            "2026-09-18"
          );
          return {
            _tag: "ToolResult" as const,
            toolCallId: yield* Schema.decodeEffect(ToolCallId)(call.id).pipe(
              Effect.mapError(conformanceFailure)
            ),
            operation: call.operation,
            outcome: { _tag: "Succeeded" as const, output: { data: output, next: [] } },
          };
        })
      );
      reads += outputs.length;
      const next = yield* result.continuation.prepare(outputs);
      result = yield* next.execute;
    }
    if (reads === 0 || result.toolCalls.length !== 0) return yield* conformanceFailure();
    yield* verifyRecurringReadAnswer(result.text);
  });

export const verifyRecurringLifecycle = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedInferenceError> =>
  Effect.gen(function* () {
    const prepared = yield* inference.prepareText({
      context: context(
        "Deja de seguir únicamente el plan recurrente de gastos «Plan de prueba» desde el 22 de septiembre de 2026. Conserva su historial y no cambies ningún otro plan."
      ),
      availableOperations: [
        CanonicalOperationId.make("recurringPlans.getRecurringWorkspace"),
        CanonicalOperationId.make("recurringPlans.applyRecurringEdit"),
      ],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(2),
    });
    const discovery = yield* prepared.execute;
    const query = discovery.toolCalls[0];
    if (
      discovery.toolCalls.length !== 1 ||
      query?.operation !== "recurringPlans.getRecurringWorkspace"
    ) {
      return yield* conformanceFailure();
    }
    yield* Schema.decodeUnknownEffect(
      Schema.Struct({ query: Schema.Struct({ month: Schema.Literal("2026-09") }) })
    )(query.params).pipe(Effect.mapError(conformanceFailure));
    const output = yield* representativeRecurringWorkspace();
    const next = yield* discovery.continuation.prepare([
      {
        _tag: "ToolResult",
        toolCallId: yield* Schema.decodeEffect(ToolCallId)(query.id).pipe(
          Effect.mapError(conformanceFailure)
        ),
        operation: query.operation,
        outcome: { _tag: "Succeeded", output: { data: output, next: [] } },
      },
    ]);
    const result = yield* next.execute;
    const call = result.toolCalls[0];
    if (result.toolCalls.length !== 1 || call?.operation !== "recurringPlans.applyRecurringEdit") {
      return yield* conformanceFailure();
    }
    const args = yield* Schema.decodeUnknownEffect(Schema.Struct({ payload: RecurringCommand }))(
      call.params
    ).pipe(Effect.mapError(conformanceFailure));
    if (!Schema.is(expectedRecurringLifecycle)(args.payload)) {
      return yield* conformanceFailure();
    }
  });

export const verifyDateOnlyMutation = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedInferenceError> =>
  Effect.gen(function* () {
    const prepared = yield* inference.prepareText({
      context: context(
        "Registra con la herramienta un gasto de 42.000 COP en mercado del 21 de septiembre de 2026. No tengo una hora específica."
      ),
      availableOperations: [CanonicalOperationId.make("transactions.createTransaction")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });
    const result = yield* prepared.execute;
    const call = result.toolCalls[0];
    if (result.toolCalls.length !== 1 || call?.operation !== "transactions.createTransaction") {
      return yield* conformanceFailure();
    }
    const args = yield* Schema.decodeUnknownEffect(MutationArguments)(call.params).pipe(
      Effect.mapError(conformanceFailure)
    );
    if (DateTime.formatIso(args.payload.occurredAt) !== "2026-09-21T05:00:00.000Z") {
      return yield* conformanceFailure();
    }
  });

export const verifyInvalidOutputRecovery = (
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

export const verifyStructuredColombianSpanish = (
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

const subscriptionStatusCodec = Schema.toCodecJson(SubscriptionStatus);
const representativeProStatus = Schema.decodeEffect(subscriptionStatusCodec)({
  accessTier: "pro",
  hasProGrant: true,
  trialPeriod: { startedAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-08T00:00:00Z" },
  paidSubscription: null,
  cancellation: null,
  recentAttempts: [
    {
      status: "failed",
      id: "00000000-0000-4000-8000-000000000001",
      priceId: "00000000-0000-4000-8000-000000000002",
      money: { amount: "9900", currency: "COP" },
      billingPeriod: "weekly",
      serviceMarket: "CO",
      taxTreatment: "not-taxable",
      timeZone: "America/Bogota",
      createdAt: "2026-08-10T12:00:00Z",
      failedAt: "2026-08-10T12:01:00Z",
    },
  ],
}).pipe(
  Effect.flatMap(Schema.encodeEffect(subscriptionStatusCodec)),
  Effect.mapError(conformanceFailure)
);

const isFinishedReply = (answer: HostedTextResult): boolean =>
  answer.toolCalls.length === 0 && answer.finishReason === "stop";
const maximumConversationalReplyLength = 500;
export const verifyConversationalSpanish = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedInferenceError> =>
  Effect.gen(function* () {
    const operation = CanonicalOperationId.make("subscription.getSubscriptionStatus");
    const prepared = yield* inference.prepareText({
      context: context("¿Tengo Pro? ¿Hay alguna suscripción de pago que pueda cancelar?"),
      availableOperations: [operation],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });
    const requested = yield* prepared.execute;
    if (requested.toolCalls.length !== 1 || requested.toolCalls[0]?.operation !== operation) {
      return yield* conformanceFailure();
    }
    const call = requested.toolCalls[0];
    const next = yield* requested.continuation.prepare([
      {
        _tag: "ToolResult",
        toolCallId: ToolCallId.make(call.id),
        operation,
        outcome: {
          _tag: "Succeeded",
          output: {
            data: yield* representativeProStatus,
            next: [],
          },
        },
      },
    ]);
    const answer = yield* next.execute;
    const text = yield* Schema.decodeUnknownEffect(Schema.String)(answer.text).pipe(
      Effect.mapError(conformanceFailure)
    );
    if (
      !isFinishedReply(answer) ||
      /[`*]|^\s*[[{#]|\b(?:ManualProGrant|hasProGrant|paidSubscription|accessTier|trialPeriod|recentAttempts|cancellation|API|JSON|UUID|ID)\b|[0-9a-f]{8}-[0-9a-f-]{27}|subscription\.|intento.{0,40}(?:cobro|pago)|9[.,]900|10 de agosto/imu.test(
        text
      )
    ) {
      return yield* conformanceFailure();
    }
    if (text.length > maximumConversationalReplyLength) {
      return yield* conformanceFailure();
    }
    yield* requireTextEvidence(text, "pro");
    if (!/(?:no (?:tienes|hay|aparece)|ninguna).{0,70}suscripci[oó]n/iu.test(text)) {
      return yield* conformanceFailure();
    }
  });
