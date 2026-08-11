import assert from "node:assert/strict";
import { expect, layer } from "@effect/vitest";
import {
  BigDecimal,
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  Layer,
  Option,
  Random,
  Ref,
  Schema,
  Stream,
  Terminal,
} from "effect";
import { OpenAiLanguageModel } from "@effect/ai-openai";
import { AiError, LanguageModel, type Response, Tool } from "effect/unstable/ai";
import { SqlClient } from "effect/unstable/sql";
import { E164PhoneNumber, UserId, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import { MigrationSqlClient } from "~/shell/db/client";
import { categoryIds } from "~/core/categories/taxonomy";
import { type TranscriptEntry, TranscriptText } from "~/core/transcript/model";
import { AgentBearerToken } from "~/core/tokens/model";
import { TranscriptWindowCharacterLimit, TranscriptWindowTurnLimit } from "~/core/transcript/rules";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import { withSubjectLock } from "~/shell/consent/repo";
import { resolveWhatsAppCaller } from "~/shell/identity/repo";
import {
  EnvelopeRecorder,
  TelemetryEnvelopeRecording,
} from "~/shell/observability/envelope-recorder";
import type { SpanDescriptor } from "~/shell/observability/protocol";
import { Telemetry } from "~/shell/observability/telemetry";
import {
  errorEnvelopePayloads,
  transactionEnvelopePayloads,
} from "~/shell/testing/telemetry-envelope-fixtures";
import {
  defaultUserId,
  defaultWhatsAppPhone,
  seedConsentedAgentIdentity,
} from "~/shell/db/development-seed";
import { listRecentTranscriptEntries, listTranscriptEntries } from "~/shell/transcript/repo";
import { ApiHarness, ApiHarnessClient, ApiTelemetryHarness } from "~/shell/testing/api-harness";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { HostedInferenceFromLanguageModel } from "~/shell/testing/hosted-inference-fixtures";
import { makeLanguageModelFinishPart } from "~/shell/testing/language-model-fixtures";
import { runAgentRepl } from "./repl";
import {
  AgentLimits,
  AgentService,
  CurrentAgentLimits,
  InboundMessage,
  ModelResponseRejected,
  ModelUnavailable,
} from "./agent-service";

const declinedOnboardingPhone = E164PhoneNumber.make("+573009997332");
const acceptedOnboardingPhone = E164PhoneNumber.make("+573009997333");
const replCaller = (
  phoneNumber: E164PhoneNumber
): { phoneNumber: E164PhoneNumber; businessScopedUserId: WhatsAppBusinessScopedUserId } => ({
  phoneNumber,
  businessScopedUserId: WhatsAppBusinessScopedUserId.make(`CO.${phoneNumber.slice(1)}`),
});

const clearTranscript = Effect.flatMap(
  MigrationSqlClient,
  (sql) => sql`DELETE FROM transcript_entries WHERE user_id = ${defaultUserId}`
);

type AgentLimitOverrides = Partial<typeof AgentLimits.Encoded>;
const agentLimits = (overrides: AgentLimitOverrides = {}): AgentLimits => {
  const values = {
    maxIterations: 6,
    maxToolCallsPerTurn: 12,
    maxToolResultCharacters: 32_000,
    maxTranscriptTurns: 12,
    maxTranscriptCharacters: 32_000,
    maxModelRoundMillis: 30_000,
    ...overrides,
  };
  return AgentLimits.make({
    ...values,
    maxTranscriptTurns: TranscriptWindowTurnLimit.make(values.maxTranscriptTurns),
    maxTranscriptCharacters: TranscriptWindowCharacterLimit.make(values.maxTranscriptCharacters),
  });
};

const scriptedTerminal = (
  lines: ReadonlyArray<string>,
  display: (text: string) => void
): Terminal.Terminal => {
  let index = 0;
  return Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.die("The REPL harness reads complete lines"),
    readLine: Effect.suspend(() => {
      const line = lines[index];
      index += 1;
      return line === undefined ? Effect.fail(Terminal.QuitError.make()) : Effect.succeed(line);
    }),
    display: (text) => Effect.sync(() => display(text)),
  });
};

const hasToolResultAfter = (serialized: string, message: string): boolean =>
  serialized.lastIndexOf("tool-result") > serialized.lastIndexOf(message);

type CreateTransactionToolCall = Readonly<{
  id: string;
  occurredAt: Option.Option<string>;
}> &
  Partial<
    Readonly<{
      amount: string;
      currency: string;
      counterparty: Option.Option<string>;
      categoryId: string;
      nullableAbsentFields: boolean;
    }>
  >;

const encodedCounterparty = (
  counterparty: Option.Option<string>,
  nullableAbsentFields: boolean
): Readonly<Record<string, Schema.Json>> =>
  Option.match(counterparty, {
    onNone: (): Readonly<Record<string, Schema.Json>> =>
      nullableAbsentFields ? { counterparty: null } : {},
    onSome: (value): Readonly<Record<string, Schema.Json>> => ({ counterparty: value }),
  });

const createTransactionToolCall = ({
  id,
  occurredAt,
  amount = "25000",
  currency = "COP",
  counterparty = Option.some("Almuerzo"),
  categoryId = categoryIds.restaurantes,
  nullableAbsentFields = false,
}: CreateTransactionToolCall): Response.ToolCallPartEncoded => ({
  type: "tool-call" as const,
  id,
  name: "transactions__createTransaction",
  params: {
    payload: {
      money: { amount, currency },
      ...encodedCounterparty(counterparty, nullableAbsentFields),
      ...(nullableAbsentFields ? { notes: null } : {}),
      direction: "outflow",
      categoryId,
      occurredAt: Option.getOrUndefined(occurredAt),
    },
  },
});

const atomicBatchToolCall = (
  calls: ReadonlyArray<Schema.Json>,
  id = "hosted-atomic-batch"
): Response.ToolCallPartEncoded => ({
  type: "tool-call",
  id,
  name: "operations__executeAtomicBatch",
  params: { payload: { calls } },
});

type AtomicCreateBatchChild = Readonly<{
  callId: string;
  occurredAt: string;
}> &
  Partial<
    Readonly<{
      amount: string;
      counterparty: string;
      categoryId: string;
    }>
  >;

const atomicCreateBatchChild = ({
  callId,
  occurredAt,
  amount = "25000",
  counterparty = "Compra lote",
  categoryId = categoryIds.otros,
}: AtomicCreateBatchChild): Schema.Json => ({
  callId,
  operation: "transactions.createTransaction",
  input: {
    payload: {
      money: { amount, currency: "COP" },
      counterparty,
      direction: "outflow",
      categoryId,
      occurredAt,
    },
  },
});

const successfulAtomicBatchCalls: ReadonlyArray<Schema.Json> = [
  atomicCreateBatchChild({
    callId: "f1d1a000-0000-4000-8000-000000001591",
    amount: "12000",
    counterparty: "Café lote",
    categoryId: categoryIds.restaurantes,
    occurredAt: "2026-01-01T12:00:00Z",
  }),
  atomicCreateBatchChild({
    callId: "f1d1a000-0000-4000-8000-000000001592",
    amount: "8000",
    counterparty: "Postre lote",
    categoryId: categoryIds.restaurantes,
    occurredAt: "2026-01-01T12:05:00Z",
  }),
];
const successfulAtomicBatchCall = atomicBatchToolCall(
  successfulAtomicBatchCalls,
  "hosted-atomic-batch-success"
);
const reorderedAtomicBatchCall = atomicBatchToolCall(
  successfulAtomicBatchCalls.toReversed(),
  "hosted-atomic-batch-reordered"
);

const failingAtomicBatchCall = atomicBatchToolCall(
  [
    atomicCreateBatchChild({
      callId: "f1d1a000-0000-4000-8000-000000001593",
      amount: "5000",
      counterparty: "Debe revertirse",
      occurredAt: "2026-01-01T13:00:00Z",
    }),
    {
      callId: "f1d1a000-0000-4000-8000-000000001594",
      operation: "transactions.deleteTransaction",
      input: { params: { id: "f1d1a000-0000-4000-8000-00000000dead" } },
    },
  ],
  "hosted-atomic-batch-failure"
);

type ModelReply = Array<Response.PartEncoded>;

class ModelPrompts extends Context.Service<ModelPrompts, Ref.Ref<ReadonlyArray<string>>>()(
  "fidy-ai/shell/agent/agent-service.test/ModelPrompts"
) {
  static readonly layer = Layer.effect(ModelPrompts, Ref.make<ReadonlyArray<string>>([]));
}

const resetModelPrompts = Effect.flatMap(ModelPrompts, (prompts) => Ref.set(prompts, []));
const readModelPrompts = Effect.flatMap(ModelPrompts, Ref.get);

type ModelToolPolicy = Readonly<{
  toolChoice: LanguageModel.ProviderOptions["toolChoice"];
  maxToolCalls: Option.Option<number>;
}>;

class ModelToolPolicies extends Context.Service<
  ModelToolPolicies,
  Ref.Ref<ReadonlyArray<ModelToolPolicy>>
>()("fidy-ai/shell/agent/agent-service.test/ModelToolPolicies") {
  static readonly layer = Layer.effect(
    ModelToolPolicies,
    Ref.make<ReadonlyArray<ModelToolPolicy>>([])
  );
}

const resetModelToolPolicies = Effect.flatMap(ModelToolPolicies, (policies) =>
  Ref.set(policies, [])
);
const readModelToolPolicies = Effect.flatMap(ModelToolPolicies, Ref.get);
const modelAttemptPrompts = (
  marker: string
): Effect.Effect<ReadonlyArray<string>, never, ModelPrompts> =>
  readModelPrompts.pipe(
    Effect.map((prompts) => prompts.filter((prompt) => prompt.includes(marker)))
  );

const modelAttemptCount = (marker: string): Effect.Effect<number, never, ModelPrompts> =>
  modelAttemptPrompts(marker).pipe(Effect.map((prompts) => prompts.length));

const awaitModelAttempts = (
  marker: string,
  count: number
): Effect.Effect<ReadonlyArray<string>, never, ModelPrompts> =>
  Effect.gen(function* () {
    for (;;) {
      const matching = yield* modelAttemptPrompts(marker);
      if (matching.length >= count) return matching;
      yield* Effect.sleep("1 millis");
    }
  });

const makeManualClock = (): {
  readonly clock: Clock.Clock;
  readonly advance: (millis: number) => Effect.Effect<void>;
} => {
  let now = 0;
  const sleepers = new Set<{ readonly deadline: number; readonly resume: () => void }>();
  return {
    clock: {
      currentTimeMillisUnsafe: () => now,
      currentTimeMillis: Effect.sync(() => now),
      currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
      sleep: (duration) =>
        Effect.callback<void>((resume) => {
          const sleeper = {
            deadline: now + Duration.toMillis(duration),
            resume: (): void => resume(Effect.void),
          };
          sleepers.add(sleeper);
          return Effect.sync(() => sleepers.delete(sleeper));
        }),
    },
    advance: (millis) =>
      Effect.sync(() => {
        now += millis;
        for (const sleeper of sleepers) {
          if (sleeper.deadline <= now) {
            sleepers.delete(sleeper);
            sleeper.resume();
          }
        }
      }),
  };
};

const turnStartedAt = (serialized: string): Option.Option<string> =>
  Option.fromUndefinedOr(/El turno comenzó en ([0-9T:.+-]+Z)/u.exec(serialized)?.[1]);

const previousDeleteTarget = (serialized: string): Option.Option<string> =>
  Option.fromUndefinedOr(
    /"params":\{"params":\{"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/u.exec(
      serialized
    )?.[1]
  );

const hasFreshConfirmation = (serialized: string): boolean =>
  serialized.lastIndexOf("CONFIRMAR transactions.deleteTransaction") >
  serialized.lastIndexOf("explicit_confirmation_required");

const confirmationCount = (serialized: string): number =>
  serialized.match(/CONFIRMAR transactions\.deleteTransaction/gu)?.length ?? 0;

const injectedDeleteTarget = (serialized: string): Option.Option<string> =>
  Option.fromUndefinedOr(
    /"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})","money"/u.exec(
      serialized
    )?.[1]
  );

const currentQuickLogMessage = (
  serialized: string
): "almuerzo 25 USD" | "almuerzo 25 mil" | "almuerzo 25 usd" => {
  const usdMessage =
    serialized.lastIndexOf("almuerzo 25 USD") > serialized.lastIndexOf("almuerzo 25 usd")
      ? "almuerzo 25 USD"
      : "almuerzo 25 usd";
  return serialized.lastIndexOf(usdMessage) > serialized.lastIndexOf("almuerzo 25 mil")
    ? usdMessage
    : "almuerzo 25 mil";
};

const isolationScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("A_PRIVATE_TRANSCRIPT_MARKER")) {
    return Option.some([{ type: "text" as const, text: "A_PRIVATE_ASSISTANT_MARKER" }]);
  }
  if (serialized.includes("registra aislamientob 25 cop")) {
    return Option.some([
      createTransactionToolCall({
        id: "user-isolation-quick-log",
        amount: "25",
        counterparty: Option.some("AislamientoB"),
        occurredAt: turnStartedAt(serialized),
      }),
    ]);
  }
  return Option.none();
};

const toolBudgetScript = (
  serialized: string,
  toolChoice: LanguageModel.ProviderOptions["toolChoice"]
): Option.Option<ModelReply> => {
  if (!serialized.includes("Prueba el presupuesto")) return Option.none();
  if (toolChoice === "none") {
    return Option.some([{ type: "text" as const, text: "Presupuesto finalizado." }]);
  }
  const calls = serialized.match(/budget-call-/g)?.length ?? 0;
  return Option.some([
    {
      type: "tool-call" as const,
      id: `budget-call-${calls + 1}`,
      name: "categories__listCategories",
      params: {},
    },
  ]);
};

const toolCapScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("Desborda herramientas")) {
    return Option.some(
      Array.from({ length: 13 }, (_, index) => ({
        type: "tool-call" as const,
        id: `overflow-call-${index}`,
        name: "categories__listCategories",
        params: {},
      }))
    );
  }
  if (serialized.includes("Prueba el límite")) {
    const calls = serialized.match(/limit-call-/g)?.length ?? 0;
    return Option.some([
      {
        type: "tool-call" as const,
        id: `limit-call-${calls + 1}`,
        name: "categories__listCategories",
        params: {},
      },
    ]);
  }
  return Option.none();
};

const captureScript = (
  serialized: string,
  tools: ReadonlyArray<Tool.Any>
): Option.Option<ModelReply> => {
  if (serialized.includes("helado 9 mil")) {
    return Option.some([
      createTransactionToolCall({
        id: "capture-without-counterparty",
        amount: "9000",
        counterparty: Option.none(),
        nullableAbsentFields: false,
        occurredAt: turnStartedAt(serialized),
      }),
    ]);
  }
  if (serialized.includes("debería registrar almuerzo 25 mil")) {
    return Option.some([
      createTransactionToolCall({
        id: "free-form-addition",
        occurredAt: turnStartedAt(serialized),
      }),
    ]);
  }
  if (serialized.includes("captura sin confirmación")) {
    const createTool = tools.find((tool) => tool.name === "transactions__createTransaction");
    const createDescription =
      createTool === undefined ? undefined : Tool.getDescription(createTool);
    const canCaptureWithoutConfirmation =
      createDescription?.includes("does not require User confirmation") === true;
    return Option.some(
      canCaptureWithoutConfirmation
        ? [
            createTransactionToolCall({
              id: "no-confirmation-capture",
              occurredAt: turnStartedAt(serialized),
            }),
          ]
        : [{ type: "text" as const, text: "¿Confirmas registrar este gasto?" }]
    );
  }
  return Option.none();
};

const invalidModelOutputScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("Provoca herramienta desconocida")) {
    return Option.some(
      serialized.includes("Validation reason:")
        ? [{ type: "text" as const, text: "Corregí la herramienta desconocida." }]
        : [
            {
              type: "tool-call" as const,
              id: "unknown-tool-call",
              name: "unknown__operation",
              params: {},
            },
          ]
    );
  }
  if (!serialized.includes("Provoca salida sensible")) return Option.none();
  return Option.some([
    {
      type: "tool-call" as const,
      id: "sensitive-invalid-output",
      name: "fin_deadbeef_abcdefghijklmnopqrstuvwxyzABCDEF",
      params: {},
    },
  ]);
};

const malformedCaptureScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("Provoca entrada malformada")) {
    return Option.some(
      serialized.includes("transactions__createTransaction") &&
        serialized.includes("Validation reason:")
        ? [{ type: "text" as const, text: "Corregí los argumentos malformados." }]
        : [
            {
              type: "tool-call" as const,
              id: "malformed-input-call",
              name: "transactions__createTransaction",
              params: { payload: { counterparty: "Almuerzo" } },
            },
          ]
    );
  }
  if (serialized.includes("Almuerzo 25000 2099-07-20T17:30:00Z")) {
    return Option.some(
      hasToolResultAfter(serialized, "Almuerzo 25000 2099-07-20T17:30:00Z")
        ? [{ type: "text" as const, text: "Corregí la solicitud inválida." }]
        : [
            createTransactionToolCall({
              id: "invalid-input-call",
              occurredAt: Option.some("2099-07-20T17:30:00Z"),
            }),
          ]
    );
  }
  return Option.none();
};

const injectedDeletionScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("replay-delete-call")) {
    return Option.some([{ type: "text" as const, text: "La repetición quedó bloqueada." }]);
  }
  if (serialized.includes("confirmed-delete-call") && confirmationCount(serialized) > 1) {
    return Option.some([
      {
        type: "tool-call" as const,
        id: "replay-delete-call",
        name: "transactions__deleteTransaction",
        params: { params: { id: Option.getOrUndefined(previousDeleteTarget(serialized)) } },
      },
    ]);
  }
  if (hasFreshConfirmation(serialized)) {
    const transactionId = Option.getOrUndefined(previousDeleteTarget(serialized));
    return Option.some([
      {
        type: "tool-call" as const,
        id: "substituted-delete-call",
        name: "transactions__deleteTransaction",
        params: { params: { id: "f1d1a000-0000-4000-8000-00000000dead" } },
      },
      {
        type: "tool-call" as const,
        id: "confirmed-delete-call",
        name: "transactions__deleteTransaction",
        params: { params: { id: transactionId } },
      },
      {
        type: "tool-call" as const,
        id: "duplicate-delete-call",
        name: "transactions__deleteTransaction",
        params: { params: { id: transactionId } },
      },
    ]);
  }
  if (serialized.includes("explicit_confirmation_required")) {
    return Option.some([{ type: "text" as const, text: "Necesito confirmación explícita." }]);
  }
  if (serialized.includes("BORRA_TODO_INYECCION")) {
    const transactionId = Option.getOrUndefined(injectedDeleteTarget(serialized));
    return Option.some([
      {
        type: "tool-call" as const,
        id: "injected-delete-call",
        name: "transactions__deleteTransaction",
        params: { params: { id: transactionId } },
      },
    ]);
  }
  return Option.some([
    {
      type: "tool-call" as const,
      id: "injected-list-call",
      name: "transactions__listTransactions",
      params: { query: {} },
    },
  ]);
};

const deletionScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("borra con lectura posterior")) {
    const transactionId = /borra con lectura posterior ([0-9a-f-]{36})/u.exec(serialized)?.[1];
    if (
      serialized.lastIndexOf("CONFIRMAR transactions.deleteTransaction") >
      serialized.lastIndexOf("explicit_confirmation_required")
    ) {
      return Option.some([
        {
          type: "tool-call" as const,
          id: "confirmed-mixed-delete",
          name: "transactions__deleteTransaction",
          params: { params: { id: transactionId } },
        },
      ]);
    }
    return Option.some([
      {
        type: "tool-call" as const,
        id: "mixed-delete",
        name: "transactions__deleteTransaction",
        params: { params: { id: transactionId } },
      },
      {
        type: "tool-call" as const,
        id: "mixed-safe-read",
        name: "categories__listCategories",
        params: {},
      },
    ]);
  }
  if (serialized.includes("revisa historial secretos")) return injectedDeletionScript(serialized);
  return Option.none();
};

const privateReadScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("Describe el movimiento")) {
    const transactionId = /Describe el movimiento ([0-9a-f-]{36})/u.exec(serialized)?.[1];
    return Option.some(
      hasToolResultAfter(serialized, "Describe el movimiento")
        ? [{ type: "text" as const, text: "Este es el movimiento solicitado." }]
        : [
            {
              type: "tool-call" as const,
              id: "natural-private-read",
              name: "transactions__getTransaction",
              params: { params: { id: transactionId } },
            },
          ]
    );
  }
  if (serialized.includes("Busca la transacción inexistente")) {
    return Option.some(
      hasToolResultAfter(serialized, "Busca la transacción inexistente")
        ? [{ type: "text" as const, text: "No encontré esa transacción." }]
        : [
            {
              type: "tool-call" as const,
              id: "missing-transaction-call",
              name: "transactions__getTransaction",
              params: {
                params: { id: "f1d1a000-0000-4000-8000-00000000dead" },
              },
            },
          ]
    );
  }
  return Option.none();
};

const turnContextScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("CONTEXT_LATER_TURN")) {
    return Option.some([
      {
        type: "text" as const,
        text: serialized.includes("TRANSIENT_ASSISTANT_CONTEXT")
          ? "El contexto transitorio se filtró."
          : "El contexto transitorio terminó con el turno.",
      },
    ]);
  }
  if (!serialized.includes("CONTEXT_ACTIVE_TURN")) return Option.none();
  if (hasToolResultAfter(serialized, "CONTEXT_ACTIVE_TURN")) {
    const before = serialized.lastIndexOf("TRANSIENT_ASSISTANT_CONTEXT antes");
    const toolCall = serialized.lastIndexOf('"type":"tool-call"');
    const after = serialized.lastIndexOf("TRANSIENT_ASSISTANT_CONTEXT después");
    const toolResult = serialized.lastIndexOf('"type":"tool-result"');
    return Option.some([
      {
        type: "text" as const,
        text:
          before < toolCall && toolCall < after && after < toolResult
            ? "El contexto activo conservó su orden."
            : "El contexto activo perdió su orden.",
      },
    ]);
  }
  return Option.some([
    { type: "text" as const, text: "TRANSIENT_ASSISTANT_CONTEXT antes" },
    {
      type: "tool-call" as const,
      id: "active-turn-context-call",
      name: "categories__listCategories",
      params: {},
    },
    { type: "text" as const, text: "TRANSIENT_ASSISTANT_CONTEXT después" },
  ]);
};

const plainTextScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("Expón token")) {
    return Option.some([
      {
        type: "text" as const,
        text: "fin_deadbeef_abcdefghijklmnopqrstuvwxyzABCDEF",
      },
    ]);
  }
  if (serialized.includes("Muestra control terminal")) {
    return Option.some([
      {
        type: "text" as const,
        text: `${String.fromCodePoint(27)}]52;c;contenido${String.fromCodePoint(7)}visible`,
      },
    ]);
  }
  if (serialized.includes("MENSAJE_ACTUAL")) {
    return Option.some([
      {
        type: "text" as const,
        text: serialized.includes("MARCADOR_ANTIGUO") ? "contexto filtrado" : "contexto acotado",
      },
    ]);
  }
  return Option.none();
};

const batchConfirmationTurns = (serialized: string): number =>
  serialized.match(/"type":"text","text":"CONFIRMAR LOTE/gu)?.length ?? 0;

const batchConfirmationCommand = (text: string): string => {
  const command = /Responde exactamente: (CONFIRMAR LOTE [0-9a-f]{64})/u.exec(text)?.[1];
  if (command === undefined) throw new Error("Atomic batch confirmation command was absent");
  return command;
};

const succeededAtomicBatchResult = (
  entries: ReadonlyArray<TranscriptEntry>
): Option.Option<TranscriptEntry> =>
  Option.fromUndefinedOr(
    entries.find(
      (entry) =>
        entry._tag === "CanonicalToolResultEntry" &&
        entry.operation === "operations.executeAtomicBatch" &&
        entry.outcome._tag === "Succeeded"
    )
  );

const independentMutationTargets = (serialized: string): ReadonlyArray<string> =>
  /LOTE_MUTACIONES_INDEPENDIENTES ([0-9a-f-]{36}) ([0-9a-f-]{36})/u.exec(serialized)?.slice(1) ??
  [];

const independentMutationCalls = (
  serialized: string,
  asBatch: boolean
): ReadonlyArray<Response.ToolCallPartEncoded> => {
  const targets = independentMutationTargets(serialized);
  const calls = targets.map((id, index) => ({
    type: "tool-call" as const,
    id: `independent-delete-${index}`,
    name: "transactions__deleteTransaction",
    params: { params: { id } },
  }));
  if (!asBatch) return calls;
  return [
    {
      type: "tool-call" as const,
      id: "corrected-atomic-batch",
      name: "operations__executeAtomicBatch",
      params: {
        payload: {
          calls: targets.map((id, index) => ({
            callId: `f1d1a000-0000-4000-8000-0000000016${index}0`,
            operation: "transactions.deleteTransaction",
            input: { params: { id } },
          })),
        },
      },
    },
  ];
};

const malformedAtomicBatchReply = (serialized: string): ModelReply => {
  if (
    serialized.includes("preflight-malformed-delete") ||
    serialized.includes("Validation reason:")
  ) {
    return [{ type: "text" as const, text: "Corregí la respuesta completa." }];
  }
  return [
    createTransactionToolCall({
      id: "preflight-valid-create",
      occurredAt: Option.some("2026-01-01T14:00:00Z"),
    }),
    {
      type: "tool-call",
      id: "preflight-malformed-delete",
      name: "transactions__deleteTransaction",
      params: { params: {} },
    },
  ];
};

const failingAtomicBatchReply = (serialized: string): ModelReply => {
  const confirmationTurns = batchConfirmationTurns(serialized);
  if (serialized.includes('"failedCallIndex":1') && confirmationTurns < 2) {
    return [
      {
        type: "text" as const,
        text: "No apliqué el lote: la segunda operación no encontró la Transaction. Corrige ese identificador.",
      },
    ];
  }
  return [failingAtomicBatchCall];
};

const successfulAtomicBatchReply = (serialized: string): ModelReply => {
  if (serialized.includes("LOTE_ATOMICO_ENTRADA_ALTERADA")) {
    return batchConfirmationTurns(serialized) === 0
      ? [successfulAtomicBatchCall]
      : [reorderedAtomicBatchCall];
  }
  const succeeded =
    serialized.lastIndexOf('"isFailure":false') >
    Math.max(
      serialized.lastIndexOf("LOTE_ATOMICO_EXITO"),
      serialized.lastIndexOf("LOTE_ATOMICO_EXPIRA")
    );
  if (succeeded && batchConfirmationTurns(serialized) < 3) {
    return [{ type: "text" as const, text: "El lote quedó aplicado por completo." }];
  }
  return [successfulAtomicBatchCall];
};

const atomicBatchScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("LOTE_MUTACIONES_INDEPENDIENTES")) {
    return Option.some([
      ...independentMutationCalls(serialized, serialized.includes("atomic_batch_required")),
    ]);
  }
  if (serialized.includes("LOTE_RESPUESTA_MALFORMADA")) {
    return Option.some(malformedAtomicBatchReply(serialized));
  }
  if (serialized.includes("LOTE_ATOMICO_FALLA")) {
    return Option.some(failingAtomicBatchReply(serialized));
  }
  if (
    serialized.includes("LOTE_ATOMICO_EXITO") ||
    serialized.includes("LOTE_ATOMICO_EXPIRA") ||
    serialized.includes("LOTE_ATOMICO_CROSS_USER") ||
    serialized.includes("LOTE_ATOMICO_ENTRADA_ALTERADA")
  ) {
    return Option.some(successfulAtomicBatchReply(serialized));
  }
  return Option.none();
};

const quickLogScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("anota almuerzo 25 mil")) {
    return Option.some([
      {
        type: "tool-call" as const,
        id: "injected-batch-read",
        name: "transactions__listTransactions",
        params: { query: {} },
      },
      createTransactionToolCall({
        id: "batched-quick-log",
        occurredAt: turnStartedAt(serialized),
      }),
    ]);
  }
  if (serialized.includes("registra papelería 25 usd")) {
    return Option.some([
      createTransactionToolCall({
        id: "explicit-quick-log",
        amount: "25",
        currency: "USD",
        counterparty: Option.some("Papelería"),
        categoryId: categoryIds.otros,
        occurredAt: turnStartedAt(serialized),
      }),
    ]);
  }
  return Option.none();
};

const almuerzoQuickLogScript = (serialized: string): Option.Option<ModelReply> => {
  if (
    serialized.includes("almuerzo 25 mil") ||
    serialized.includes("almuerzo 25 USD") ||
    serialized.includes("almuerzo 25 usd")
  ) {
    const currentMessage = currentQuickLogMessage(serialized);
    const currency = currentMessage.toUpperCase().endsWith("USD") ? "USD" : "COP";
    return Option.some(
      hasToolResultAfter(serialized, currentMessage)
        ? [{ type: "text" as const, text: "Listo, registré el almuerzo." }]
        : [
            createTransactionToolCall({
              id: `quick-log-${currency}`,
              amount: currency === "COP" ? "25000" : "25",
              currency,
              occurredAt: turnStartedAt(serialized),
            }),
          ]
    );
  }
  return Option.none();
};

const listingScript = (serialized: string): Option.Option<ModelReply> => {
  if (serialized.includes("Lista historial acotado")) {
    const hasCurrentToolResult = hasToolResultAfter(serialized, "Lista historial acotado");
    return Option.some(
      hasCurrentToolResult
        ? [{ type: "text" as const, text: "Historial acotado." }]
        : [
            {
              type: "tool-call" as const,
              id: "bounded-history-call",
              name: "transactions__listTransactions",
              params: { query: {} },
            },
          ]
    );
  }
  if (serialized.includes("Lista movimientos secretos")) {
    if (hasToolResultAfter(serialized, "Lista movimientos secretos")) {
      return Option.some([{ type: "text" as const, text: "Resultado protegido." }]);
    }
    return Option.some([
      {
        type: "tool-call" as const,
        id: "secret-list-call",
        name: "transactions__listTransactions",
        params: { query: {} },
      },
    ]);
  }
  if (serialized.includes("Lista las categorías")) {
    return Option.some(
      hasToolResultAfter(serialized, "Lista las categorías")
        ? [{ type: "text" as const, text: "Estas son las categorías disponibles." }]
        : [
            {
              type: "tool-call" as const,
              id: "categories-call-1",
              name: "categories__listCategories",
              params: {},
            },
          ]
    );
  }
  return Option.none();
};

const recallScript = (serialized: string): ModelReply => {
  const priorTurnWasLoaded = serialized.includes("Primera respuesta");
  return [
    {
      type: "text" as const,
      text: priorTurnWasLoaded ? "Sí, recuerdo el turno anterior." : "Primera respuesta",
    },
  ];
};

const scriptedReply = (
  serialized: string,
  tools: ReadonlyArray<Tool.Any>,
  toolChoice: LanguageModel.ProviderOptions["toolChoice"]
): ModelReply =>
  isolationScript(serialized).pipe(
    Option.orElse(() => toolBudgetScript(serialized, toolChoice)),
    Option.orElse(() => toolCapScript(serialized)),
    Option.orElse(() => captureScript(serialized, tools)),
    Option.orElse(() => invalidModelOutputScript(serialized)),
    Option.orElse(() => malformedCaptureScript(serialized)),
    Option.orElse(() => deletionScript(serialized)),
    Option.orElse(() => privateReadScript(serialized)),
    Option.orElse(() => turnContextScript(serialized)),
    Option.orElse(() => plainTextScript(serialized)),
    Option.orElse(() => atomicBatchScript(serialized)),
    Option.orElse(() => quickLogScript(serialized)),
    Option.orElse(() => almuerzoQuickLogScript(serialized)),
    Option.orElse(() => listingScript(serialized)),
    Option.getOrElse(() => recallScript(serialized))
  );

const testModelFailure = (reason: AiError.AiErrorReason): Effect.Effect<never, AiError.AiError> =>
  Effect.fail(
    AiError.AiError.make({ module: "TestLanguageModel", method: "generateText", reason })
  );

const retryRateLimit = (retryAfter: Duration.Duration): Effect.Effect<never, AiError.AiError> =>
  testModelFailure(AiError.RateLimitError.make({ retryAfter }));

const retrySuccess = Effect.succeed<ModelReply>([
  { type: "text", text: "Reintento completado." },
  makeLanguageModelFinishPart("stop"),
]);

type RetryReply = Effect.Effect<ModelReply, AiError.AiError>;

type RetryScenario = Readonly<{
  marker: string;
  initial: RetryReply;
  subsequent: Option.Option<RetryReply>;
}>;

const retryScenarios: ReadonlyArray<RetryScenario> = [
  {
    marker: "PROVEEDOR_LIMITADO",
    initial: retryRateLimit(Duration.millis(1)),
    subsequent: Option.some(retryRateLimit(Duration.millis(1))),
  },
  {
    marker: "RETRY_DEADLINE_EXHAUSTED",
    initial: retryRateLimit(Duration.seconds(1)),
    subsequent: Option.none(),
  },
  {
    marker: "RETRY_NON_RETRYABLE",
    initial: testModelFailure(AiError.QuotaExhaustedError.make()),
    subsequent: Option.none(),
  },
  {
    marker: "RETRY_SHARED_DEADLINE",
    initial: retryRateLimit(Duration.millis(1)),
    subsequent: Option.some(Effect.never),
  },
  {
    marker: "RETRY_AFTER_SUCCESS",
    initial: retryRateLimit(Duration.millis(1)),
    subsequent: Option.some(retrySuccess),
  },
  {
    marker: "RETRY_FALLBACK_SUCCESS",
    initial: testModelFailure(AiError.InternalProviderError.make({ description: "transient" })),
    subsequent: Option.some(retrySuccess),
  },
  {
    marker: "RETRY_AFTER_FALLBACK_SUCCESS",
    initial: retryRateLimit(Duration.minutes(10)),
    subsequent: Option.some(retrySuccess),
  },
];

const retryScenarioReply = (serialized: string, attempt: number): Option.Option<RetryReply> => {
  const scenario = retryScenarios.find(({ marker }) => serialized.includes(marker));
  if (scenario === undefined) return Option.none();
  return attempt === 0 ? Option.some(scenario.initial) : scenario.subsequent;
};

const invalidOutputScenario = (
  serialized: string
): Option.Option<Effect.Effect<ModelReply, AiError.AiError>> => {
  if (serialized.includes("SALIDA_INVALIDA_PERSISTENTE")) {
    return Option.some(
      testModelFailure(
        AiError.InvalidOutputError.make({ description: "persistent_malformed_provider_payload" })
      )
    );
  }
  if (!serialized.includes("SALIDA_INVALIDA_RECUPERABLE")) return Option.none();
  return Option.some(
    serialized.includes("Validation reason:")
      ? retrySuccess
      : testModelFailure(
          AiError.InvalidOutputError.make({ description: "malformed_provider_payload" })
        )
  );
};

const scriptedModelAttempt = ({
  serialized,
  tools,
  toolChoice,
  attempt,
}: Readonly<{
  serialized: string;
  tools: ReadonlyArray<Tool.Any>;
  toolChoice: LanguageModel.ToolChoice<string>;
  attempt: number;
}>): Effect.Effect<ModelReply, AiError.AiError> => {
  if (serialized.includes("MODELO_BLOQUEADO")) return Effect.never;
  if (serialized.includes("MODELO_DEFECTUOSO")) {
    return Effect.die(new Error("provider_response_id_defect_sentinel"));
  }
  const invalidOutput = invalidOutputScenario(serialized);
  if (Option.isSome(invalidOutput)) return invalidOutput.value;
  const retryReply = retryScenarioReply(serialized, attempt);
  if (Option.isSome(retryReply)) return retryReply.value;
  if (serialized.includes("RESPUESTA_TRUNCADA")) {
    return Effect.succeed([
      { type: "text" as const, text: "Fragmento incompleto" },
      makeLanguageModelFinishPart("length"),
    ]);
  }
  const reply = scriptedReply(serialized, tools, toolChoice);
  const reason = reply.some((part) => part.type === "tool-call") ? "tool-calls" : "stop";
  return Effect.succeed([...reply, makeLanguageModelFinishPart(reason)]);
};

const ScriptedLanguageModel = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const prompts = yield* ModelPrompts;
    const toolPolicies = yield* ModelToolPolicies;
    return yield* LanguageModel.make({
      generateText: ({ prompt, tools, toolChoice }) => {
        const serialized = JSON.stringify(prompt.content);
        expect(serialized).not.toContain("fin_deadbeef_");
        return Effect.gen(function* () {
          const openAiConfig = yield* Effect.serviceOption(OpenAiLanguageModel.Config);
          const attempt = yield* Ref.modify(prompts, (recorded) => [
            recorded.filter((recordedPrompt) => recordedPrompt.includes(serialized)).length,
            [...recorded, serialized],
          ]);
          yield* Ref.update(toolPolicies, (recorded) => [
            ...recorded,
            {
              toolChoice,
              maxToolCalls: Option.flatMap(openAiConfig, (config) =>
                Option.fromUndefinedOr(config.max_tool_calls)
              ),
            },
          ]);
          return yield* scriptedModelAttempt({ serialized, tools, toolChoice, attempt });
        });
      },
      streamText: () => Stream.die(new Error("The agent uses non-streaming generation")),
    });
  })
).pipe(Layer.provideMerge(ModelPrompts.layer), Layer.provideMerge(ModelToolPolicies.layer));

const ScriptedHostedInference = HostedInferenceFromLanguageModel.pipe(
  Layer.provideMerge(ScriptedLanguageModel)
);

const AgentHarness = AgentService.layer.pipe(
  Layer.provideMerge(ScriptedHostedInference),
  Layer.provideMerge(ApiHarness),
  Layer.provideMerge(TelemetryEnvelopeRecording)
);

const AgentTelemetryHarness = AgentService.layer.pipe(
  Layer.provideMerge(ScriptedHostedInference),
  Layer.provideMerge(ApiTelemetryHarness)
);

const prepareTelemetryTest = Effect.gen(function* () {
  yield* clearTranscript;
  const service = yield* AgentService;
  const telemetry = yield* Telemetry;
  const recorder = yield* EnvelopeRecorder;
  yield* recorder.clear;
  return { service, telemetry, recorder } as const;
});

const activeCallerDescriptor = {
  component: "api",
  operation: "http.canonicalRequest",
  trigger: "api",
  spanOperation: "http.server",
  workKind: "http_request",
  metadata: {
    _tag: "Http",
    method: "POST",
    route: "/compatibility/:case",
    status: Option.none(),
  },
} as const satisfies SpanDescriptor;

layer(AgentTelemetryHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "hosted agent telemetry",
  (it) => {
    it.effect("traces a complete turn, model work, and localhost canonical calls", () =>
      Effect.gen(function* () {
        const { service, telemetry, recorder } = yield* prepareTelemetryTest;

        const reply = yield* telemetry.span(
          activeCallerDescriptor,
          service.handleSynchronousTurn(
            defaultUserId,
            InboundMessage.make({ text: TranscriptText.make("Lista las categorías") })
          )
        );
        const transcript = yield* listTranscriptEntries(defaultUserId);
        const envelopes = yield* recorder.serializedEnvelopes;
        const transactions = transactionEnvelopePayloads(envelopes);
        const caller = transactions
          .filter(({ contexts }) => contexts.trace.op === "http.server")
          .find(({ contexts }) => contexts.trace.data["http.route"] === "/compatibility/:case");
        const turn = transactions.find(({ contexts }) => contexts.trace.op === "agent.turn");
        assert(caller !== undefined);
        assert(turn !== undefined);
        const modelSpans = transactions.filter(
          ({ contexts }) => contexts.trace.op === "agent.model"
        );
        const canonicalHttp = transactions
          .filter(({ contexts }) => contexts.trace.op === "http.server")
          .filter(({ contexts }) => contexts.trace.parent_span_id === turn.contexts.trace.span_id)
          .find(({ tags }) => tags.operation === "http.canonicalRequest");
        const canonical = transactions
          .filter(({ contexts }) => contexts.trace.op === "fidy.operation")
          .filter(
            ({ contexts }) =>
              contexts.trace.parent_span_id === canonicalHttp?.contexts.trace.span_id
          )
          .find(({ tags }) => tags.operation === "categories.listCategories");
        const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");

        expect(reply.text).toBe("Estas son las categorías disponibles.");
        expect(transcript.map((entry) => entry._tag)).toEqual([
          "UserTranscriptEntry",
          "CanonicalToolCallEntry",
          "CanonicalToolResultEntry",
          "AssistantTranscriptEntry",
        ]);
        assert(canonicalHttp !== undefined);
        assert(canonical !== undefined);
        const firstModelSpan = modelSpans[0];
        assert(firstModelSpan !== undefined);
        expect(turn.contexts.trace.parent_span_id).toBe(caller.contexts.trace.span_id);
        expect(modelSpans).toHaveLength(2);
        expect(
          modelSpans.every(
            (span) => span.contexts.trace.parent_span_id === turn.contexts.trace.span_id
          )
        ).toBe(true);
        expect(firstModelSpan.contexts.trace.data).toMatchObject({
          "gen_ai.request.model": "gpt_5_6_luna",
          "fidy.attempt": 1,
          "gen_ai.usage.input_tokens": 150,
          "gen_ai.usage.output_tokens": 20,
        });
        expect(typeof firstModelSpan.contexts.trace.data["fidy.duration_milliseconds"]).toBe(
          "number"
        );
        expect(canonicalHttp.contexts.trace.parent_span_id).toBe(turn.contexts.trace.span_id);
        expect(canonical.contexts.trace.parent_span_id).toBe(canonicalHttp.contexts.trace.span_id);
        expect(errorEnvelopePayloads(envelopes)).toEqual([]);
        expect(serialized).not.toContain("Lista las categorías");
        expect(serialized).not.toContain("Estas son las categorías disponibles.");
        expect(serialized).not.toContain("categories__listCategories");
        expect(serialized).not.toContain("fin_hosted_");
      })
    );

    it.effect("captures only an exhausted provider failure and marks its spans failed", () =>
      Effect.gen(function* () {
        const { service, telemetry, recorder } = yield* prepareTelemetryTest;

        const exit = yield* telemetry
          .span(
            activeCallerDescriptor,
            service.handleSynchronousTurn(
              defaultUserId,
              InboundMessage.make({ text: TranscriptText.make("RETRY_NON_RETRYABLE") })
            )
          )
          .pipe(Effect.exit);
        const envelopes = yield* recorder.serializedEnvelopes;
        const transactions = transactionEnvelopePayloads(envelopes);
        const errors = errorEnvelopePayloads(envelopes);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          transactions.find(({ contexts }) => contexts.trace.op === "agent.model")?.tags
        ).toMatchObject({ outcome: "failed", error: "model_unavailable" });
        expect(
          transactions.find(({ contexts }) => contexts.trace.op === "agent.turn")?.tags
        ).toMatchObject({ outcome: "failed", error: "model_unavailable" });
        expect(errors).toHaveLength(1);
        expect(errors[0]?.tags).toMatchObject({
          component: "agent",
          operation: "agent.modelRound",
          error: "model_unavailable",
          provider: "openai",
        });
      })
    );

    it.effect("does not create an error issue when invalid provider output recovers", () =>
      Effect.gen(function* () {
        const { service, telemetry, recorder } = yield* prepareTelemetryTest;

        const reply = yield* telemetry.span(
          activeCallerDescriptor,
          service.handleSynchronousTurn(
            defaultUserId,
            InboundMessage.make({ text: TranscriptText.make("SALIDA_INVALIDA_RECUPERABLE") })
          )
        );
        const envelopes = yield* recorder.serializedEnvelopes;
        const modelSpans = transactionEnvelopePayloads(envelopes).filter(
          ({ contexts }) => contexts.trace.op === "agent.model"
        );

        expect(reply.text).toBe("Reintento completado.");
        expect(modelSpans).toHaveLength(2);
        expect(modelSpans.map(({ tags }) => tags.outcome)).toEqual(["failed", "succeeded"]);
        expect(errorEnvelopePayloads(envelopes)).toEqual([]);
      })
    );

    it.effect("creates one error issue when invalid-output recovery is exhausted", () =>
      Effect.gen(function* () {
        const { service, telemetry, recorder } = yield* prepareTelemetryTest;

        const reply = yield* telemetry.span(
          activeCallerDescriptor,
          service.handleSynchronousTurn(
            defaultUserId,
            InboundMessage.make({ text: TranscriptText.make("SALIDA_INVALIDA_PERSISTENTE") })
          )
        );
        const envelopes = yield* recorder.serializedEnvelopes;
        const modelSpans = transactionEnvelopePayloads(envelopes).filter(
          ({ contexts }) => contexts.trace.op === "agent.model"
        );
        const errors = errorEnvelopePayloads(envelopes);

        expect(reply.text).toContain("límite seguro");
        expect(modelSpans.length).toBeGreaterThan(1);
        expect(modelSpans.every(({ tags }) => tags.outcome === "failed")).toBe(true);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.tags).toMatchObject({
          component: "agent",
          operation: "agent.modelRound",
          error: "model_unavailable",
          provider: "openai",
        });
      })
    );

    it.effect("records typed rejection outcomes without creating error issues", () =>
      Effect.gen(function* () {
        const { service, telemetry, recorder } = yield* prepareTelemetryTest;

        const exit = yield* telemetry
          .span(
            activeCallerDescriptor,
            service.handleSynchronousTurn(
              defaultUserId,
              InboundMessage.make({ text: TranscriptText.make("RESPUESTA_TRUNCADA") })
            )
          )
          .pipe(Effect.exit);
        const envelopes = yield* recorder.serializedEnvelopes;
        const turn = transactionEnvelopePayloads(envelopes).find(
          ({ contexts }) => contexts.trace.op === "agent.turn"
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(turn?.tags).toMatchObject({
          outcome: "rejected",
          error: "model_response_rejected",
        });
        expect(errorEnvelopePayloads(envelopes)).toEqual([]);
      })
    );

    it.effect("keeps declared canonical and identity rejections out of error issues", () =>
      Effect.gen(function* () {
        const { service, telemetry, recorder } = yield* prepareTelemetryTest;

        const reply = yield* telemetry.span(
          activeCallerDescriptor,
          service.handleSynchronousTurn(
            defaultUserId,
            InboundMessage.make({ text: TranscriptText.make("Busca la transacción inexistente") })
          )
        );
        const canonicalEnvelopes = yield* recorder.serializedEnvelopes;
        const canonicalOutcomes = transactionEnvelopePayloads(canonicalEnvelopes).filter(
          ({ tags }) => tags.error === "not_found"
        );

        yield* recorder.clear;
        const unknownUser = UserId.make("f1d1a000-0000-4000-8000-00000000dead");
        const identityExit = yield* telemetry
          .span(
            activeCallerDescriptor,
            service.handleSynchronousTurn(
              unknownUser,
              InboundMessage.make({ text: TranscriptText.make("identidad ausente") })
            )
          )
          .pipe(Effect.exit);
        const identityEnvelopes = yield* recorder.serializedEnvelopes;
        const identityTurn = transactionEnvelopePayloads(identityEnvelopes).find(
          ({ contexts }) => contexts.trace.op === "agent.turn"
        );

        expect(reply.text).toBe("No encontré esa transacción.");
        expect(canonicalOutcomes).not.toHaveLength(0);
        expect(errorEnvelopePayloads(canonicalEnvelopes)).toEqual([]);
        expect(Exit.isFailure(identityExit)).toBe(true);
        expect(identityTurn?.tags).toMatchObject({
          outcome: "rejected",
          error: "consent_required",
        });
        expect(errorEnvelopePayloads(identityEnvelopes)).toEqual([]);
      })
    );

    it.effect("captures an unexpected model defect exactly once at the turn owner", () =>
      Effect.gen(function* () {
        const { service, telemetry, recorder } = yield* prepareTelemetryTest;

        const exit = yield* telemetry
          .span(
            activeCallerDescriptor,
            service.handleSynchronousTurn(
              defaultUserId,
              InboundMessage.make({ text: TranscriptText.make("MODELO_DEFECTUOSO") })
            )
          )
          .pipe(Effect.exit);
        const envelopes = yield* recorder.serializedEnvelopes;
        const errors = errorEnvelopePayloads(envelopes);
        const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");

        expect(Exit.isFailure(exit)).toBe(true);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.tags).toMatchObject({
          component: "agent",
          operation: "agent.hostedTurn",
          error: "unexpected_defect",
        });
        expect(serialized).not.toContain("provider_response_id_defect_sentinel");
      })
    );

    it.effect("captures a canonical tool defect exactly once at the hosted-turn owner", () =>
      Effect.gen(function* () {
        const { service, telemetry, recorder } = yield* prepareTelemetryTest;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          CREATE OR REPLACE FUNCTION reject_agent_capture() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'canonical_defect_payload_sentinel';
          END;
          $$ LANGUAGE plpgsql
        `;
        yield* sql`DROP TRIGGER IF EXISTS reject_agent_capture ON transactions`;
        yield* sql`
          CREATE TRIGGER reject_agent_capture BEFORE INSERT ON transactions
          FOR EACH ROW EXECUTE FUNCTION reject_agent_capture()
        `;
        const removeFailure = sql`DROP TRIGGER IF EXISTS reject_agent_capture ON transactions`.pipe(
          Effect.andThen(sql`DROP FUNCTION IF EXISTS reject_agent_capture()`),
          Effect.orDie
        );

        const exit = yield* telemetry
          .span(
            activeCallerDescriptor,
            service.handleSynchronousTurn(
              defaultUserId,
              InboundMessage.make({ text: TranscriptText.make("almuerzo 25 mil") })
            )
          )
          .pipe(Effect.exit, Effect.ensuring(removeFailure));
        const envelopes = yield* recorder.serializedEnvelopes;
        const errors = errorEnvelopePayloads(envelopes);
        const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");

        expect(Exit.isFailure(exit)).toBe(true);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.tags).toMatchObject({
          component: "agent",
          operation: "agent.hostedTurn",
          error: "unexpected_defect",
        });
        expect(serialized).not.toContain("canonical_defect_payload_sentinel");
      })
    );

    it.effect("does not report normal turn interruption as a defect", () =>
      Effect.gen(function* () {
        const { service, telemetry, recorder } = yield* prepareTelemetryTest;

        const fiber = yield* telemetry
          .span(
            activeCallerDescriptor,
            service.handleSynchronousTurn(
              defaultUserId,
              InboundMessage.make({ text: TranscriptText.make("MODELO_BLOQUEADO") })
            )
          )
          .pipe(
            Effect.provideService(CurrentAgentLimits, agentLimits({ maxModelRoundMillis: 10_000 })),
            Effect.forkChild
          );
        yield* awaitModelAttempts("MODELO_BLOQUEADO", 1);
        yield* Fiber.interrupt(fiber);
        const envelopes = yield* recorder.serializedEnvelopes;
        const turn = transactionEnvelopePayloads(envelopes).find(
          ({ contexts }) => contexts.trace.op === "agent.turn"
        );

        expect(turn?.tags).toMatchObject({ outcome: "interrupted" });
        expect(errorEnvelopePayloads(envelopes)).toEqual([]);
      })
    );

    it.effect("isolates model breadcrumbs and outcomes across concurrent turns", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        const userB = UserId.make("f1d1a000-0000-4000-8000-000000000113");
        yield* clearTranscript;
        yield* sql`DELETE FROM transcript_entries WHERE user_id = ${userB}`;
        yield* sql`DELETE FROM agent_tokens WHERE user_id = ${userB}`;
        yield* seedConsentedAgentIdentity({
          userId: userB,
          bearer: AgentBearerToken.make("fin_agent113_abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
          scopes: ["read"],
        });
        const service = yield* AgentService;
        const telemetry = yield* Telemetry;
        const recorder = yield* EnvelopeRecorder;
        yield* recorder.clear;

        yield* Effect.all(
          [
            telemetry
              .span(
                activeCallerDescriptor,
                service.handleSynchronousTurn(
                  defaultUserId,
                  InboundMessage.make({ text: TranscriptText.make("RETRY_AFTER_SUCCESS") })
                )
              )
              .pipe(Effect.exit),
            telemetry
              .span(
                activeCallerDescriptor,
                service.handleSynchronousTurn(
                  userB,
                  InboundMessage.make({ text: TranscriptText.make("RESPUESTA_TRUNCADA") })
                )
              )
              .pipe(Effect.exit),
          ],
          { concurrency: "unbounded" }
        );
        const transactions = transactionEnvelopePayloads(yield* recorder.serializedEnvelopes);
        const turns = transactions.filter(({ contexts }) => contexts.trace.op === "agent.turn");
        const models = transactions.filter(({ contexts }) => contexts.trace.op === "agent.model");
        const successfulTurn = turns.find(({ tags }) => tags.outcome === "succeeded");
        const rejectedTurn = turns.find(({ tags }) => tags.outcome === "rejected");
        const retriedModel = models.find(
          ({ contexts }) => contexts.trace.data["fidy.attempt"] === 2
        );
        const singleAttemptModel = models.find(
          ({ contexts }) => contexts.trace.data["fidy.attempt"] === 1
        );

        expect(turns).toHaveLength(2);
        expect(models).toHaveLength(2);
        expect(retriedModel?.contexts.trace.trace_id).toBe(successfulTurn?.contexts.trace.trace_id);
        expect(singleAttemptModel?.contexts.trace.trace_id).toBe(
          rejectedTurn?.contexts.trace.trace_id
        );
        expect(retriedModel?.breadcrumbs.map(({ message }) => message)).toContain("retry_started");
        expect(singleAttemptModel?.breadcrumbs.map(({ message }) => message)).not.toContain(
          "retry_started"
        );
      })
    );
  }
);

layer(AgentHarness, { excludeTestServices: true, timeout: "30 seconds" })("hosted agent", (it) => {
  it.effect("confirms one exact atomic batch and rejects altered or replayed confirmation", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      const service = yield* AgentService;

      const challenge = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("LOTE_ATOMICO_EXITO") })
      );
      expect(batchConfirmationCommand(challenge.text)).toMatch(/^CONFIRMAR LOTE/u);
      const transactionCountAfterChallenge =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;

      expect(challenge.text).toContain("1. transactions.createTransaction");
      expect(challenge.text).toContain("2. transactions.createTransaction");
      expect(transactionCountAfterChallenge[0]?.count).toBe(0);

      const altered = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make(`CONFIRMAR LOTE ${"0".repeat(64)}`) })
      );
      const transactionCountAfterAlteredConfirmation =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;
      const correctedCommand = batchConfirmationCommand(altered.text);

      expect(altered.text).toContain("Este lote atómico requiere una sola confirmación");
      expect(transactionCountAfterAlteredConfirmation[0]?.count).toBe(0);

      const completed = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make(correctedCommand) })
      );
      const createdTransactions =
        yield* sql`SELECT counterparty FROM transactions WHERE deleted_at IS NULL ORDER BY occurred_at`;
      const transcript = yield* listTranscriptEntries(defaultUserId);
      const batchResult = Option.getOrThrow(succeededAtomicBatchResult(transcript));

      expect(completed.text).toBe("El lote quedó aplicado por completo.");
      expect(createdTransactions.map(({ counterparty }) => counterparty)).toEqual([
        "Café lote",
        "Postre lote",
      ]);
      expect(batchResult).toMatchObject({
        outcome: {
          output: {
            data: {
              results: [
                { operation: "transactions.createTransaction" },
                { operation: "transactions.createTransaction" },
              ],
            },
          },
        },
      });

      const replayed = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make(correctedCommand) })
      );
      const replayedAgain = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make(correctedCommand) })
      );
      const afterReplay =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;
      expect(replayed.text).toContain("Este lote atómico requiere una sola confirmación");
      expect(replayedAgain.text).toContain("Este lote atómico requiere una sola confirmación");
      expect(batchConfirmationCommand(replayed.text)).not.toBe(correctedCommand);
      expect(batchConfirmationCommand(replayedAgain.text)).not.toBe(correctedCommand);
      expect(afterReplay[0]?.count).toBe(2);
    })
  );

  it.effect("rejects confirmation when the model reorders the proposed batch", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      const service = yield* AgentService;

      const challenge = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("LOTE_ATOMICO_ENTRADA_ALTERADA") })
      );
      const rejected = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({
          text: TranscriptText.make(batchConfirmationCommand(challenge.text)),
        })
      );
      const rows =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;

      expect(rejected.text).toContain("1. transactions.createTransaction");
      expect(batchConfirmationCommand(rejected.text)).not.toBe(
        batchConfirmationCommand(challenge.text)
      );
      expect(rows[0]?.count).toBe(0);
    })
  );

  it.effect("rejects another User's confirmation command for the same batch", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const service = yield* AgentService;
      const userB = UserId.make("f1d1a000-0000-4000-8000-0000000000b8");
      yield* sql`DELETE FROM agent_confirmation_consumptions WHERE user_id = ${userB}`;
      yield* sql`DELETE FROM transcript_entries WHERE user_id = ${userB}`;
      yield* sql`DELETE FROM transactions WHERE user_id = ${userB}`;
      yield* sql`DELETE FROM agent_tokens WHERE user_id = ${userB}`;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      yield* seedConsentedAgentIdentity({
        userId: userB,
        bearer: AgentBearerToken.make("fin_agentb02_abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
        scopes: ["read"],
      });

      const userAChallenge = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("LOTE_ATOMICO_CROSS_USER") })
      );
      const userBChallenge = yield* service.handleSynchronousTurn(
        userB,
        InboundMessage.make({ text: TranscriptText.make("LOTE_ATOMICO_CROSS_USER") })
      );
      const rejected = yield* service.handleSynchronousTurn(
        userB,
        InboundMessage.make({
          text: TranscriptText.make(batchConfirmationCommand(userAChallenge.text)),
        })
      );
      const rows = yield* sql`SELECT count(*)::int AS count FROM transactions`;
      const consumptions = yield* sql`
        SELECT count(*)::int AS count
        FROM agent_confirmation_consumptions
        WHERE user_id = ${userB}
      `;

      expect(batchConfirmationCommand(userAChallenge.text)).not.toBe(
        batchConfirmationCommand(userBChallenge.text)
      );
      expect(rejected.text).toContain("Este lote atómico requiere una sola confirmación");
      expect(rows[0]?.count).toBe(0);
      expect(consumptions[0]?.count).toBe(0);
    })
  );

  it.effect("atomically consumes concurrent confirmation submissions once", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      const service = yield* AgentService;

      const challenge = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("LOTE_ATOMICO_EXITO") })
      );
      const command = batchConfirmationCommand(challenge.text);
      const replies = yield* Effect.all(
        [
          service.handleSynchronousTurn(
            defaultUserId,
            InboundMessage.make({ text: TranscriptText.make(command) })
          ),
          service.handleSynchronousTurn(
            defaultUserId,
            InboundMessage.make({ text: TranscriptText.make(command) })
          ),
        ],
        { concurrency: "unbounded" }
      );
      const rows =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;

      expect(rows[0]?.count).toBe(2);
      expect(replies.some(({ text }) => text === "El lote quedó aplicado por completo.")).toBe(
        true
      );
      expect(
        replies.some(({ text }) =>
          text.includes("Este lote atómico requiere una sola confirmación")
        )
      ).toBe(true);
    })
  );

  it.effect("expires an unconsumed atomic batch confirmation", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      const service = yield* AgentService;
      const manualClock = makeManualClock();

      const challenge = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("LOTE_ATOMICO_EXPIRA") })
        )
        .pipe(Effect.provideService(Clock.Clock, manualClock.clock));
      const command = batchConfirmationCommand(challenge.text);
      yield* manualClock.advance(Duration.toMillis("11 minutes"));
      const expired = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make(command) })
        )
        .pipe(Effect.provideService(Clock.Clock, manualClock.clock));
      const rows =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;

      expect(expired.text).toContain("Este lote atómico requiere una sola confirmación");
      expect(rows[0]?.count).toBe(0);
    })
  );

  it.effect("redirects independent confirmed mutations to the visible atomic batch", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const service = yield* AgentService;
      const client = yield* ApiHarnessClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("almuerzo 25 mil") })
      );
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("registra papelería 25 usd") })
      );
      const seeded = yield* client.transactions.listTransactions({ query: {} });
      const [first, second] = seeded.data;
      if (first === undefined || second === undefined) return yield* Effect.die("missing fixtures");
      yield* clearTranscript;
      yield* resetModelPrompts;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({
          text: TranscriptText.make(`LOTE_MUTACIONES_INDEPENDIENTES ${first.id} ${second.id}`),
        })
      );
      const remaining = yield* client.transactions.listTransactions({ query: {} });
      const prompts = yield* readModelPrompts;

      expect(reply.text).toContain("Este lote atómico requiere una sola confirmación");
      expect(remaining.data).toHaveLength(2);
      expect(prompts.at(-1)).toContain("atomic_batch_required");
      expect(prompts.at(-1)).toContain("operations.executeAtomicBatch");
    })
  );

  it.effect("executes nothing when a later generated call is malformed", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("LOTE_RESPUESTA_MALFORMADA") })
      );
      const rows =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;

      expect(reply.text).toBe("Corregí la respuesta completa.");
      expect(rows[0]?.count).toBe(0);
    })
  );

  it.effect("rolls back a confirmed batch and explains the failing child", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      const service = yield* AgentService;

      const challenge = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("LOTE_ATOMICO_FALLA") })
      );
      const command = batchConfirmationCommand(challenge.text);
      const failed = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make(command) })
      );
      const rows =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;

      expect(failed.text).toContain("segunda operación no encontró la Transaction");
      expect(rows[0]?.count).toBe(0);

      const replayed = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make(command) })
      );
      const afterReplay =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;
      expect(replayed.text).toContain("Este lote atómico requiere una sola confirmación");
      expect(afterReplay[0]?.count).toBe(0);
    })
  );

  it.effect("persists complete text turns for the next service instance", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const firstService = yield* AgentService;
      const firstReply = yield* firstService.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("Primer mensaje") })
      );

      const secondService = yield* AgentService;
      const secondReply = yield* secondService.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("¿Qué dije antes?") })
      );

      expect(firstReply.text).toBe("Primera respuesta");
      expect(secondReply.text).toBe("Sí, recuerdo el turno anterior.");
    })
  );

  it.effect(
    "replays mixed assistant parts during the active turn without retaining their text later",
    () =>
      Effect.gen(function* () {
        yield* clearTranscript;
        yield* resetModelPrompts;
        const service = yield* AgentService;

        const activeReply = yield* service.handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("CONTEXT_ACTIVE_TURN") })
        );
        const activeTranscript = yield* listTranscriptEntries(defaultUserId);

        yield* resetModelPrompts;
        const laterReply = yield* service.handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("CONTEXT_LATER_TURN") })
        );
        const laterPrompts = yield* readModelPrompts;

        expect(activeReply.text).toBe("El contexto activo conservó su orden.");
        expect(
          activeTranscript.filter((entry) => entry._tag === "AssistantTranscriptEntry")
        ).toMatchObject([{ text: "El contexto activo conservó su orden." }]);
        expect(laterReply.text).toBe("El contexto transitorio terminó con el turno.");
        expect(laterPrompts).not.toHaveLength(0);
        expect(
          laterPrompts.every((prompt) => !prompt.includes("TRANSIENT_ASSISTANT_CONTEXT"))
        ).toBe(true);
      })
  );

  it.effect("isolates Transcript, canonical execution, and audit attribution between Users", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const service = yield* AgentService;
      const userA = UserId.make("f1d1a000-0000-4000-8000-0000000000a7");
      const userB = UserId.make("f1d1a000-0000-4000-8000-0000000000b7");
      yield* sql`DELETE FROM audit_log_entries WHERE user_id IN (${userA}, ${userB})`;
      yield* sql`DELETE FROM transcript_entries WHERE user_id IN (${userA}, ${userB})`;
      yield* sql`DELETE FROM transactions WHERE user_id IN (${userA}, ${userB})`;
      yield* sql`DELETE FROM agent_tokens WHERE user_id IN (${userA}, ${userB})`;
      yield* seedConsentedAgentIdentity({
        userId: userA,
        bearer: AgentBearerToken.make("fin_agenta01_abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
        scopes: ["read"],
      });
      yield* seedConsentedAgentIdentity({
        userId: userB,
        bearer: AgentBearerToken.make("fin_agentb01_abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
        scopes: ["read"],
      });

      yield* service.handleSynchronousTurn(
        userA,
        InboundMessage.make({ text: TranscriptText.make("A_PRIVATE_TRANSCRIPT_MARKER") })
      );
      const userABefore = yield* listTranscriptEntries(userA);
      yield* resetModelPrompts;

      const reply = yield* service.handleSynchronousTurn(
        userB,
        InboundMessage.make({ text: TranscriptText.make("registra aislamientob 25 cop") })
      );
      const userAAfter = yield* listTranscriptEntries(userA);
      const userBTranscript = yield* listTranscriptEntries(userB);
      const userAAudit = yield* observeAuditLogEntries(userA);
      const userBAudit = yield* observeAuditLogEntries(userB);
      const ownedTransactions = yield* sql`
        SELECT user_id, counterparty
        FROM transactions
        WHERE user_id IN (${userA}, ${userB})
        ORDER BY user_id
      `;
      const encodedBTranscript = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
        userBTranscript
      );
      const modelPrompts = yield* readModelPrompts;

      expect(reply.text).toContain("Gasto guardado");
      expect(modelPrompts).not.toHaveLength(0);
      for (const prompt of modelPrompts) {
        expect(prompt).not.toContain("A_PRIVATE_TRANSCRIPT_MARKER");
        expect(prompt).not.toContain("A_PRIVATE_ASSISTANT_MARKER");
      }
      expect(userAAfter).toEqual(userABefore);
      expect(encodedBTranscript).not.toContain("A_PRIVATE_TRANSCRIPT_MARKER");
      expect(encodedBTranscript).not.toContain("A_PRIVATE_ASSISTANT_MARKER");
      expect(userAAudit).toEqual([]);
      expect(userBAudit).toHaveLength(1);
      expect(userBAudit.every(({ subjectUserId }) => subjectUserId === userB)).toBe(true);
      expect(ownedTransactions).toEqual([{ user_id: userB, counterparty: "AislamientoB" }]);
    })
  );

  it.effect(
    "rejects credentials and payment identifiers before persistence or model invocation",
    () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        const service = yield* AgentService;
        yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${defaultUserId}`;
        const sensitiveMessages = [
          `token-fin_deadbeef_${"a".repeat(40)}-por-favor`,
          `clave sk-${"a".repeat(24)}`,
          "DATABASE_URL=postgres://admin:prod-secret@db.example/fidy",
          "la contraseña del PDF es banco2026",
          "mi clave bancaria es hunter2",
          "la clave de mi banco es hunter2",
          "mi PIN bancario es 1234",
          "recovery code: secret123",
          `AWS_SECRET_ACCESS_KEY=${"A".repeat(40)}`,
          `AWS_ACCESS_KEY_ID=${"A".repeat(20)}`,
          `PAYMENTS_API_KEY=${"x".repeat(24)}`,
          `SERVICE_TOKEN=${"x".repeat(24)}`,
          `tarjeta ${["4111", "1111", "1111", "1111"].join(" ")}`,
          "tarjeta 4111.1111.1111.1111",
          "tarjeta 4111/1111/1111/1111",
          `tarjeta 4111\u00a01111\u00a01111\u00a01111`,
          `cuenta: ${"1234567890"}`,
          `mi número de cuenta es ${"1234567890"}`,
          `cuenta de ahorros ${"1234567890"}`,
          `cuenta corriente ${"1234567890"}`,
          "IBAN ES91 2100 0418 4502 0005 1332",
          `my account number is ${"1234567890"}`,
          `cuenta nómina ${"1234567890"}`,
          `cuenta bancaria ${"1234567890"}`,
          `account no. ${"1234567890"}`,
          `acct # ${"1234567890"}`,
          `cuenta bancaria N.º ${"1234567890"}`,
          `cuenta nómina N° ${"1234567890"}`,
          `cuenta corriente nro. ${"1234567890"}`,
          `bank acct number ${"1234567890"}`,
          `cuenta bancaria, N.º ${"1234567890"}`,
          `cuenta de ahorros núm. ${"1234.5678.90"}`,
          `bank account, no. ${"1234567890"}`,
          `bank acct. number: ${"1234567890"}`,
          `cuenta bancaria. N.º ${"1234567890"}`,
          `cuenta bancaria (N.º ${"1234567890"})`,
          `bank account (no. ${"1234567890"})`,
        ];

        for (const text of sensitiveMessages) {
          yield* clearTranscript;
          const reply = yield* service.handleSynchronousTurn(
            defaultUserId,
            InboundMessage.make({ text: TranscriptText.make(text) })
          );
          const transcript = yield* listTranscriptEntries(defaultUserId);
          const audit = yield* observeAuditLogEntries(defaultUserId);

          expect(reply.text).toContain("no fue guardado ni procesado");
          expect(transcript).toEqual([]);
          expect(audit).toEqual([]);
        }
      })
  );

  it.effect("removes a bearer-shaped model reply before persistence or display", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("Expón token") })
      );
      const transcript = yield* listTranscriptEntries(defaultUserId);
      const serialized = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(transcript);

      expect(reply.text).not.toContain("fin_deadbeef_");
      expect(serialized).not.toContain("fin_deadbeef_");
    })
  );

  it.effect("removes bearers returned by canonical reads before model context or Transcript", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      const service = yield* AgentService;
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("almuerzo 25 mil") })
      );
      yield* sql`UPDATE transactions SET notes = 'fin_deadbeef_abcdefghijklmnopqrstuvwxyzABCDEF'`;
      yield* clearTranscript;
      yield* resetModelPrompts;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("Lista movimientos secretos") })
      );
      const transcript = yield* listTranscriptEntries(defaultUserId);
      const modelPrompts = yield* readModelPrompts;

      expect(reply.text).toBe("Resultado protegido.");
      expect(modelPrompts).not.toHaveLength(0);
      expect(modelPrompts.every((prompt) => !prompt.includes("fin_deadbeef_"))).toBe(true);
      expect(
        transcript.some(
          (entry) =>
            entry._tag === "CanonicalToolResultEntry" && entry.outcome._tag === "ToolOutputRejected"
        )
      ).toBe(true);
      const serialized = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(transcript);
      expect(serialized).not.toContain("fin_deadbeef_");
    })
  );

  it.effect("captures a Transaction without inventing a Counterparty", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      const service = yield* AgentService;
      const client = yield* ApiHarnessClient;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("helado 9 mil") })
      );
      const history = yield* client.transactions.listTransactions({ query: {} });

      expect(reply.text).toBe(
        "✅ **Gasto guardado**\n\n**Valor:** 9.000 COP\n**Categoría:** Restaurantes\n**Fecha:** Hoy"
      );
      expect(history.data).toHaveLength(1);
      expect(Option.isNone(history.data[0]?.counterparty ?? Option.none())).toBe(true);
    })
  );

  it.effect("executes a reversible addition without quick-log authorization grammar", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${defaultUserId}`;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({
          text: TranscriptText.make("debería registrar almuerzo 25 mil"),
        })
      );
      const rows = yield* sql`SELECT count(*)::int AS count FROM transactions`;
      const audit = yield* observeAuditLogEntries(defaultUserId);

      expect(reply.text).toBe(
        "✅ **Gasto guardado**\n\n**Valor:** 25.000 COP\n**Contraparte:** Almuerzo\n**Categoría:** Restaurantes\n**Fecha:** Hoy"
      );
      expect(rows[0]?.count).toBe(1);
      expect(audit.map(({ operation }) => operation)).toEqual(["transactions.createTransaction"]);
    })
  );

  it.effect("executes a transaction capture without asking for confirmation", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("captura sin confirmación 25 mil") })
      );
      const rows = yield* sql`SELECT count(*)::int AS count FROM transactions`;

      expect(reply.text).toContain("Gasto guardado");
      expect(rows[0]?.count).toBe(1);
    })
  );

  it.effect("executes reads and reversible additions from one model batch", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${defaultUserId}`;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("anota almuerzo 25 mil") })
      );
      const transcript = yield* listTranscriptEntries(defaultUserId);
      const audit = yield* observeAuditLogEntries(defaultUserId);
      const injectedRead = transcript.find(
        (entry) =>
          entry._tag === "CanonicalToolResultEntry" &&
          entry.operation === "transactions.listTransactions"
      );

      expect(reply.text).toContain("Gasto guardado");
      expect(audit.map((entry) => entry.operation)).toEqual([
        "transactions.listTransactions",
        "transactions.createTransaction",
      ]);
      expect(injectedRead).toMatchObject({
        _tag: "CanonicalToolResultEntry",
        outcome: { _tag: "Succeeded" },
      });
    })
  );

  it.effect("terminates a declined onboarding conversation without creating a User", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const caller = testWhatsAppCaller(declinedOnboardingPhone);
      yield* sql`DELETE FROM pending_consent_exchanges
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}`;
      const displayed: Array<string> = [];
      const terminal = scriptedTerminal(["hola", "No acepto"], (text) => displayed.push(text));

      yield* runAgentRepl(replCaller(declinedOnboardingPhone)).pipe(
        Effect.provideService(Terminal.Terminal, terminal)
      );

      expect(
        Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(declinedOnboardingPhone)))
      ).toBe(true);
      expect(displayed.join("\n")).toContain("Antes de crear tu cuenta");
      expect(displayed.join("\n")).toContain("No creé una cuenta");
      const pending = yield* sql`
        SELECT id FROM pending_consent_exchanges
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}
      `;
      expect(pending).toHaveLength(0);
    })
  );

  it.effect("does not process a finance request during an accepted onboarding conversation", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`
        DELETE FROM consent_records WHERE subject_user_id IN (
          SELECT user_id FROM whatsapp_identities WHERE phone_number = ${acceptedOnboardingPhone}
        )
      `;
      yield* sql`
        WITH accepted_users AS MATERIALIZED (
          SELECT user_id FROM whatsapp_identities WHERE phone_number = ${acceptedOnboardingPhone}
        ), removed_identity AS (
          DELETE FROM whatsapp_identities WHERE phone_number = ${acceptedOnboardingPhone}
        )
        DELETE FROM users WHERE id IN (SELECT user_id FROM accepted_users)
      `;
      const runtimeSql = yield* SqlClient.SqlClient;
      const acceptedCaller = testWhatsAppCaller(acceptedOnboardingPhone);
      yield* runtimeSql`DELETE FROM pending_consent_exchanges
        WHERE business_portfolio_id = ${acceptedCaller.businessPortfolioId}
          AND business_scoped_user_id = ${acceptedCaller.businessScopedUserId}`;
      const displayed: Array<string> = [];
      const terminal = scriptedTerminal(["registra café 25 mil", "Acepto"], (text) =>
        displayed.push(text)
      );

      yield* runAgentRepl(replCaller(acceptedOnboardingPhone)).pipe(
        Effect.provideService(Terminal.Terminal, terminal)
      );

      const users = yield* sql`
        SELECT u.id
        FROM users u
        JOIN whatsapp_identities wi ON wi.user_id = u.id
        WHERE wi.phone_number = ${acceptedOnboardingPhone}
      `;
      const transactions = yield* sql`
        SELECT t.id
        FROM transactions t
        JOIN whatsapp_identities wi ON wi.user_id = t.user_id
        WHERE wi.phone_number = ${acceptedOnboardingPhone}
      `;

      expect(users).toHaveLength(1);
      expect(transactions).toEqual([]);
      expect(displayed.join("\n")).toContain("Antes de crear tu cuenta");
      expect(displayed.join("\n")).toContain("Autorización registrada");
    })
  );

  it.effect(
    "quick-logs Colombian Money through the CLI and preserves explicit foreign Currency",
    () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
        yield* clearTranscript;
        yield* resetModelPrompts;
        const service = yield* AgentService;
        const client = yield* ApiHarnessClient;
        const displayed: Array<string> = [];
        const terminal = scriptedTerminal(["almuerzo 25 mil"], (text) => displayed.push(text));

        yield* runAgentRepl(replCaller(defaultWhatsAppPhone)).pipe(
          Effect.provideService(Terminal.Terminal, terminal)
        );
        yield* service.handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("almuerzo 25 usd") })
        );
        yield* service.handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("registra papelería 25 usd") })
        );
        const history = yield* client.transactions.listTransactions({ query: {} });
        const cop = history.data.find((transaction) => transaction.money.currency === "COP");
        const usd = history.data.find(
          (transaction) =>
            transaction.money.currency === "USD" &&
            Option.contains(transaction.counterparty, "Almuerzo")
        );
        const explicit = history.data.find((transaction) =>
          Option.contains(transaction.counterparty, "Papelería")
        );
        const quickLogPrompts = (yield* readModelPrompts).filter((prompt) =>
          /almuerzo 25 (?:mil|usd)/iu.test(prompt)
        );

        expect(quickLogPrompts).not.toHaveLength(0);
        for (const prompt of quickLogPrompts) {
          expect(prompt).toContain("ServiceMarket CO, locale es-CO");
          expect(prompt).toContain("zona IANA America/Bogota");
          expect(prompt).toMatch(/El turno comenzó en \d{4}-\d{2}-\d{2}T/u);
        }
        expect(displayed).toEqual([
          "Fidy> ",
          "✅ **Gasto guardado**\n\n**Valor:** 25.000 COP\n**Contraparte:** Almuerzo\n**Categoría:** Restaurantes\n**Fecha:** Hoy\n",
          "Fidy> ",
        ]);
        expect(cop?.categoryId).toBe(categoryIds.restaurantes);
        expect(Option.getOrUndefined(cop?.counterparty ?? Option.none())).toBe("Almuerzo");
        expect(Equal.equals(cop?.money.amount, BigDecimal.fromStringUnsafe("25000"))).toBe(true);
        expect(Equal.equals(usd?.money.amount, BigDecimal.fromStringUnsafe("25"))).toBe(true);
        expect(explicit?.money.currency).toBe("USD");
      })
  );

  it.effect("bounds canonical history before exposing it to the model", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const service = yield* AgentService;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("almuerzo 25 mil") })
      );
      yield* sql`
        INSERT INTO transactions (
          user_id, amount, currency, counterparty, direction, occurred_at, category_id, notes
        )
        SELECT
          user_id, amount, currency, 'bulk-' || generated::text, direction,
          occurred_at + generated * interval '1 second', category_id, notes
        FROM transactions
        CROSS JOIN generate_series(1, 110) AS generated
        LIMIT 110
      `;
      yield* clearTranscript;
      yield* resetModelPrompts;

      const limits = agentLimits({
        maxToolResultCharacters: 1_000,
        maxTranscriptCharacters: 200_000,
      });
      const reply = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("Lista historial acotado") })
        )
        .pipe(Effect.provideService(CurrentAgentLimits, limits));
      const transcript = yield* listTranscriptEntries(defaultUserId);
      const result = transcript.find((entry) => entry._tag === "CanonicalToolResultEntry");
      const BoundedHistory = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
      const retained = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(transcript);
      const boundedPrompt = (yield* readModelPrompts).find((prompt) =>
        prompt.includes("tool_result_too_large")
      );

      expect(boundedPrompt).toBeDefined();
      expect(boundedPrompt).not.toContain("bulk-");
      expect(reply.text).toBe("Historial acotado.");
      expect(retained).toContain("bulk-");
      expect(retained).not.toContain("tool_result_too_large");
      expect(result?._tag).toBe("CanonicalToolResultEntry");
      if (result?._tag === "CanonicalToolResultEntry" && result.outcome._tag === "Succeeded") {
        expect(Schema.is(BoundedHistory)(result.outcome.output)).toBe(true);
        if (Schema.is(BoundedHistory)(result.outcome.output)) {
          expect(result.outcome.output.data).toHaveLength(111);
        }
      }
    })
  );

  it.effect("renders model text without active terminal control sequences", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const displayed: Array<string> = [];
      const terminal = scriptedTerminal(["Muestra control terminal"], (text) =>
        displayed.push(text)
      );

      yield* runAgentRepl(replCaller(defaultWhatsAppPhone)).pipe(
        Effect.provideService(Terminal.Terminal, terminal)
      );

      expect(displayed).toEqual(["Fidy> ", "�]52;c;contenido�visible\n", "Fidy> "]);
    })
  );

  it.effect("feeds malformed model output back without persistence or canonical execution", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;
      const auditBefore = yield* observeAuditLogEntries(defaultUserId);

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("Provoca entrada malformada") })
      );
      const transcript = yield* listTranscriptEntries(defaultUserId);

      expect(reply.text).toBe("Corregí los argumentos malformados.");
      expect(transcript.map((entry) => entry._tag)).toEqual([
        "UserTranscriptEntry",
        "AssistantTranscriptEntry",
      ]);
      expect(yield* observeAuditLogEntries(defaultUserId)).toEqual(auditBefore);
    })
  );

  it.effect("retries invalid output even when no operation name can be detected", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("Provoca herramienta desconocida") })
      );

      expect(reply.text).toBe("Corregí la herramienta desconocida.");
    })
  );

  it.effect("fails closed when invalid model output contains sensitive text", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;

      const exit = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("Provoca salida sensible") })
        )
        .pipe(Effect.exit);
      const transcript = yield* listTranscriptEntries(defaultUserId);

      assert.deepStrictEqual(
        Exit.match(exit, {
          onFailure: (cause) => Exit.fail(Cause.squash(cause)),
          onSuccess: Exit.succeed,
        }),
        Exit.fail(
          new ModelResponseRejected({
            cause: new Error("Model output contained a sensitive chat value"),
          })
        )
      );
      expect(transcript.map((entry) => entry._tag)).toEqual(["UserTranscriptEntry"]);
    })
  );

  it.effect("feeds rejected tool input back to the model for correction", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({
          text: TranscriptText.make("Almuerzo 25000 2099-07-20T17:30:00Z"),
        })
      );
      const transcript = yield* listTranscriptEntries(defaultUserId);

      expect(reply.text).toBe("Corregí la solicitud inválida.");
      const result = transcript.find((entry) => entry._tag === "CanonicalToolResultEntry");
      expect(result).toMatchObject({
        _tag: "CanonicalToolResultEntry",
        outcome: {
          _tag: "ToolInputRejected",
          failure: {
            error: {
              code: "validation_failed",
              fields: [{ path: "occurredAt" }],
            },
          },
        },
      });
    })
  );

  it.effect("feeds a canonical tool failure back to the model", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({
          text: TranscriptText.make(
            "Busca la transacción inexistente f1d1a000-0000-4000-8000-00000000dead"
          ),
        })
      );
      const transcript = yield* listTranscriptEntries(defaultUserId);
      const result = transcript.find((entry) => entry._tag === "CanonicalToolResultEntry");

      expect(reply.text).toBe("No encontré esa transacción.");
      expect(result).toMatchObject({
        _tag: "CanonicalToolResultEntry",
        outcome: { _tag: "CanonicalOperationFailed" },
      });
    })
  );

  it.effect("executes a canonical private read without matching an exact phrase", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const service = yield* AgentService;
      const client = yield* ApiHarnessClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("almuerzo 25 mil") })
      );
      const history = yield* client.transactions.listTransactions({ query: {} });
      const transaction = history.data[0];
      expect(transaction).toBeDefined();
      yield* clearTranscript;
      yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${defaultUserId}`;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({
          text: TranscriptText.make(`Describe el movimiento ${transaction?.id}`),
        })
      );
      const transcript = yield* listTranscriptEntries(defaultUserId);
      const audit = yield* observeAuditLogEntries(defaultUserId);

      expect(reply.text).toBe("Este es el movimiento solicitado.");
      expect(audit.map(({ operation }) => operation)).toEqual(["transactions.getTransaction"]);
      expect(
        transcript.some(
          (entry) => entry._tag === "CanonicalToolResultEntry" && entry.outcome._tag === "Succeeded"
        )
      ).toBe(true);
    })
  );

  it.effect(
    "reduces the request cap after accepted calls and disables tools for finalization",
    () =>
      Effect.gen(function* () {
        yield* clearTranscript;
        yield* resetModelToolPolicies;
        const service = yield* AgentService;
        const limits = agentLimits({ maxIterations: 4, maxToolCallsPerTurn: 2 });

        const reply = yield* service
          .handleSynchronousTurn(
            defaultUserId,
            InboundMessage.make({ text: TranscriptText.make("Prueba el presupuesto") })
          )
          .pipe(Effect.provideService(CurrentAgentLimits, limits));
        const policies = yield* readModelToolPolicies;
        const transcript = yield* listTranscriptEntries(defaultUserId);

        expect(reply.text).toBe("Presupuesto finalizado.");
        expect(policies).toEqual([
          { toolChoice: "auto", maxToolCalls: Option.some(2) },
          { toolChoice: "auto", maxToolCalls: Option.some(1) },
          { toolChoice: "none", maxToolCalls: Option.none() },
        ]);
        expect(transcript.filter((entry) => entry._tag === "CanonicalToolCallEntry")).toHaveLength(
          2
        );
      })
  );

  it.effect("rejects a model batch that exceeds the per-turn tool-call cap", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* clearTranscript;
      yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${defaultUserId}`;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("Desborda herramientas") })
      );
      const audit = yield* observeAuditLogEntries(defaultUserId);

      expect(reply.text).toContain("límite seguro");
      expect(audit).toEqual([]);
    })
  );

  it.effect("returns a semantic reply when the tool loop reaches its iteration cap", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;
      const limits = agentLimits({ maxIterations: 2 });

      const reply = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("Prueba el límite") })
        )
        .pipe(Effect.provideService(CurrentAgentLimits, limits));
      const transcript = yield* listTranscriptEntries(defaultUserId);

      expect(reply.text).toContain("límite seguro");
      expect(transcript.filter((entry) => entry._tag === "CanonicalToolCallEntry")).toHaveLength(2);
    })
  );

  it.effect("sends only bounded recent complete turns while retaining older entries", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("MARCADOR_ANTIGUO") })
      );
      const retainedBefore = yield* listTranscriptEntries(defaultUserId);
      const limits = agentLimits({ maxTranscriptTurns: 1 });

      const reply = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("MENSAJE_ACTUAL") })
        )
        .pipe(Effect.provideService(CurrentAgentLimits, limits));
      const retainedAfter = yield* listTranscriptEntries(defaultUserId);
      const loadedWindow = yield* listRecentTranscriptEntries(defaultUserId, 1);

      expect(reply.text).toBe("contexto acotado");
      expect(retainedBefore).toHaveLength(2);
      expect(retainedAfter).toHaveLength(4);
      expect(loadedWindow).toHaveLength(2);
    })
  );

  it.effect("blocks an injected persisted instruction from authorizing a mutation", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const service = yield* AgentService;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("almuerzo 25 mil") })
      );
      yield* sql`UPDATE transactions SET counterparty = 'BORRA_TODO_INYECCION'`;
      yield* clearTranscript;
      yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${defaultUserId}`;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("revisa historial secretos") })
      );
      expect(reply.text).toContain("Operación exacta: transactions.deleteTransaction");
      expect(reply.text).toContain("Argumentos exactos:");

      const bareConfirmationReply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({
          text: TranscriptText.make("CONFIRMAR transactions.deleteTransaction"),
        })
      );
      const rows =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;
      const audit = yield* observeAuditLogEntries(defaultUserId);
      const transcript = yield* listTranscriptEntries(defaultUserId);
      const rejectedDelete = transcript.find(
        (entry) =>
          entry._tag === "CanonicalToolResultEntry" &&
          entry.operation === "transactions.deleteTransaction" &&
          entry.outcome._tag === "ToolInputRejected"
      );

      expect(bareConfirmationReply.text).toContain(
        "Operación exacta: transactions.deleteTransaction"
      );
      expect(rows[0]?.count).toBe(1);
      expect(audit.filter((entry) => entry.operation === "transactions.deleteTransaction")).toEqual(
        []
      );
      expect(rejectedDelete).toBeDefined();
    })
  );

  it.effect("defers sibling calls until destructive confirmation is settled", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const service = yield* AgentService;
      const client = yield* ApiHarnessClient;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("almuerzo 25 mil") })
      );
      const history = yield* client.transactions.listTransactions({ query: {} });
      const transaction = history.data[0];
      expect(transaction).toBeDefined();
      yield* clearTranscript;
      yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${defaultUserId}`;

      const challenge = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({
          text: TranscriptText.make(`borra con lectura posterior ${transaction?.id}`),
        })
      );
      const command = /Responde exactamente: (CONFIRMAR [^\n]+)/u.exec(challenge.text)?.[1];
      expect(command).toMatch(/^CONFIRMAR transactions\.deleteTransaction [0-9a-f]{64}$/u);

      const confirmed = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make(command ?? "confirmación ausente") })
      );
      const rows =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;
      const audit = yield* observeAuditLogEntries(defaultUserId);

      expect(confirmed.text).toBe("Listo, completé la operación solicitada.");
      expect(rows[0]?.count).toBe(0);
      expect(audit.map(({ operation }) => operation)).toEqual(["transactions.deleteTransaction"]);
    })
  );

  it.effect("executes one exact destructive confirmation and rejects its replay", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const service = yield* AgentService;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("almuerzo 25 mil") })
      );
      yield* sql`UPDATE transactions SET counterparty = 'BORRA_TODO_INYECCION'`;
      yield* clearTranscript;
      yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${defaultUserId}`;

      const challenge = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("revisa historial secretos") })
      );
      const command = /Responde exactamente: (CONFIRMAR [^\n]+)/u.exec(challenge.text)?.[1];
      expect(command).toMatch(/^CONFIRMAR transactions\.deleteTransaction [0-9a-f]{64}$/u);

      const confirmed = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make(command ?? "confirmación ausente") })
      );
      const replayed = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make(command ?? "confirmación ausente") })
      );
      const rows =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;
      const deleted = (yield* observeAuditLogEntries(defaultUserId)).filter(
        ({ operation }) => operation === "transactions.deleteTransaction"
      );

      expect(confirmed.text).toBe("Listo, completé la operación solicitada.");
      expect(replayed.text).toBe("La repetición quedó bloqueada.");
      expect(rows[0]?.count).toBe(0);
      expect(deleted).toHaveLength(1);
    })
  );

  it.effect("does not accept confirmation from an interrupted confirmation turn", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const service = yield* AgentService;
      yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
      yield* clearTranscript;
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("almuerzo 25 mil") })
      );
      yield* sql`UPDATE transactions SET counterparty = 'BORRA_TODO_INYECCION'`;
      yield* clearTranscript;
      yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${defaultUserId}`;

      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("revisa historial secretos") })
      );
      yield* sql`
        DELETE FROM transcript_entries
        WHERE user_id = ${defaultUserId}
          AND entry->>'_tag' = 'AssistantTranscriptEntry'
      `;
      yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({
          text: TranscriptText.make("CONFIRMAR transactions.deleteTransaction"),
        })
      );
      const rows =
        yield* sql`SELECT count(*)::int AS count FROM transactions WHERE deleted_at IS NULL`;
      const audit = yield* observeAuditLogEntries(defaultUserId);

      expect(rows[0]?.count).toBe(1);
      expect(audit.filter((entry) => entry.operation === "transactions.deleteTransaction")).toEqual(
        []
      );
    })
  );

  it.effect("honors provider retry timing and succeeds within the same semantic iteration", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("RETRY_AFTER_SUCCESS") })
      );
      const attempts = yield* modelAttemptPrompts("RETRY_AFTER_SUCCESS");
      const transcript = yield* listTranscriptEntries(defaultUserId);

      expect(reply.text).toBe("Reintento completado.");
      expect(attempts).toHaveLength(2);
      expect(transcript.find((entry) => entry._tag === "AssistantTranscriptEntry")).toMatchObject({
        iteration: 1,
      });
    })
  );

  it.effect("uses seeded jitter and records safe model-round telemetry", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;
      const manualClock = makeManualClock();
      const recorder = yield* EnvelopeRecorder;
      yield* recorder.clear;
      const replyFiber = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("RETRY_FALLBACK_SUCCESS") })
        )
        .pipe(
          Effect.provideService(Clock.Clock, manualClock.clock),
          Random.withSeed("model-retry"),
          Effect.forkChild
        );

      yield* awaitModelAttempts("RETRY_FALLBACK_SUCCESS", 1);
      yield* manualClock.advance(150);
      expect(yield* modelAttemptCount("RETRY_FALLBACK_SUCCESS")).toBe(1);
      yield* manualClock.advance(1);
      const reply = yield* Fiber.join(replyFiber);
      const serialized = (yield* recorder.serializedEnvelopes)
        .map((bytes) => new TextDecoder().decode(bytes))
        .join("\n");

      expect(reply.text).toBe("Reintento completado.");
      expect(yield* awaitModelAttempts("RETRY_FALLBACK_SUCCESS", 2)).toHaveLength(2);
      expect(serialized).toContain('"transaction":"agent.modelRound"');
      expect(serialized).toContain('"message":"retry_started"');
      expect(serialized).toContain('"attempt":2');
      expect(serialized).toContain('"duration_milliseconds":151');
      expect(serialized).toContain('"message":"model_completed"');
      expect(serialized).toContain('"outcome":"succeeded"');
      expect(serialized).not.toContain("RETRY_FALLBACK_SUCCESS");
      expect(serialized).not.toContain("Reintento completado.");
    })
  );

  it.effect("falls back to seeded jitter when provider timing exceeds the deadline", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;
      const manualClock = makeManualClock();
      const replyFiber = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("RETRY_AFTER_FALLBACK_SUCCESS") })
        )
        .pipe(
          Effect.provideService(Clock.Clock, manualClock.clock),
          Random.withSeed("model-retry"),
          Effect.forkChild
        );

      yield* awaitModelAttempts("RETRY_AFTER_FALLBACK_SUCCESS", 1);
      yield* manualClock.advance(150);
      expect(yield* modelAttemptCount("RETRY_AFTER_FALLBACK_SUCCESS")).toBe(1);
      yield* manualClock.advance(1);
      const reply = yield* Fiber.join(replyFiber);

      expect(reply.text).toBe("Reintento completado.");
      expect(yield* awaitModelAttempts("RETRY_AFTER_FALLBACK_SUCCESS", 2)).toHaveLength(2);
    })
  );

  it.effect("interrupts the second attempt at the original model-round deadline", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;
      const manualClock = makeManualClock();
      const replyFiber = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("RETRY_SHARED_DEADLINE") })
        )
        .pipe(
          Effect.provideService(CurrentAgentLimits, agentLimits({ maxModelRoundMillis: 300 })),
          Effect.provideService(Clock.Clock, manualClock.clock),
          Effect.forkChild
        );

      yield* awaitModelAttempts("RETRY_SHARED_DEADLINE", 1);
      yield* manualClock.advance(1);
      expect(yield* awaitModelAttempts("RETRY_SHARED_DEADLINE", 2)).toHaveLength(2);
      yield* manualClock.advance(299);
      const failure = yield* Fiber.join(replyFiber).pipe(Effect.flip);

      expect(failure._tag).toBe("ModelUnavailable");
    })
  );

  it.effect("fails non-retryable provider errors after one attempt", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;

      const exit = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("RETRY_NON_RETRYABLE") })
        )
        .pipe(Effect.exit);
      const attempts = yield* modelAttemptPrompts("RETRY_NON_RETRYABLE");

      assert.deepStrictEqual(
        Exit.match(exit, {
          onFailure: (cause) => Exit.fail(Cause.squash(cause)),
          onSuccess: Exit.succeed,
        }),
        Exit.fail(
          new ModelUnavailable({
            cause: AiError.AiError.make({
              module: "TestLanguageModel",
              method: "generateText",
              reason: AiError.QuotaExhaustedError.make(),
            }),
          })
        )
      );
      expect(attempts).toHaveLength(1);
    })
  );

  it.effect("does not retry when fallback delay leaves no minimum attempt window", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;

      const failure = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("RETRY_DEADLINE_EXHAUSTED") })
        )
        .pipe(
          Effect.provideService(CurrentAgentLimits, agentLimits({ maxModelRoundMillis: 100 })),
          Effect.flip
        );
      const attempts = yield* modelAttemptPrompts("RETRY_DEADLINE_EXHAUSTED");

      expect(failure._tag).toBe("ModelUnavailable");
      expect(attempts).toHaveLength(1);
    })
  );

  it.effect("rejects retryable provider failures after exhausting both attempts", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;

      const failure = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("PROVEEDOR_LIMITADO") })
        )
        .pipe(Effect.flip);
      const attempts = yield* modelAttemptPrompts("PROVEEDOR_LIMITADO");

      expect(failure._tag).toBe("ModelUnavailable");
      expect(attempts).toHaveLength(2);
    })
  );

  it.effect("rejects truncated model text instead of delivering it as a complete reply", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;

      const failure = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("RESPUESTA_TRUNCADA") })
        )
        .pipe(Effect.flip);
      const transcript = yield* listTranscriptEntries(defaultUserId);

      expect(failure._tag).toBe("ModelResponseRejected");
      expect(transcript.map((entry) => entry._tag)).toEqual(["UserTranscriptEntry"]);
    })
  );

  it.effect("times out a stalled model round without retaining the Consent lock", () =>
    Effect.gen(function* () {
      yield* clearTranscript;
      const service = yield* AgentService;
      const failure = yield* service
        .handleSynchronousTurn(
          defaultUserId,
          InboundMessage.make({ text: TranscriptText.make("MODELO_BLOQUEADO") })
        )
        .pipe(
          Effect.provideService(CurrentAgentLimits, agentLimits({ maxModelRoundMillis: 20 })),
          Effect.flip
        );

      expect(failure._tag).toBe("ModelUnavailable");
      yield* withSubjectLock(defaultUserId, Effect.void).pipe(Effect.timeout("1 second"));
    })
  );

  it.effect("executes a derived canonical tool with attributable authorization", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* clearTranscript;
      yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${defaultUserId}`;
      const service = yield* AgentService;

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("Lista las categorías") })
      );
      const transcript = yield* listTranscriptEntries(defaultUserId);
      const audit = yield* observeAuditLogEntries(defaultUserId);

      expect(reply.text).toBe("Estas son las categorías disponibles.");
      expect(transcript.map((entry) => entry._tag)).toEqual([
        "UserTranscriptEntry",
        "CanonicalToolCallEntry",
        "CanonicalToolResultEntry",
        "AssistantTranscriptEntry",
      ]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        operation: "categories.listCategories",
        outcome: "succeeded",
        subjectUserId: defaultUserId,
      });
    })
  );
});
