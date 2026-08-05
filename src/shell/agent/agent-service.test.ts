import { expect, layer } from "@effect/vitest";
import { BigDecimal, Effect, Equal, Layer, Option, Schema, Terminal } from "effect";
import { LanguageModel, Tool } from "effect/unstable/ai";
import { SqlClient } from "effect/unstable/sql";
import { E164PhoneNumber, UserId, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import { MigrationSqlClient } from "~/shell/db/client";
import { categoryIds } from "~/core/categories/taxonomy";
import { TranscriptText } from "~/core/transcript/model";
import { AgentBearerToken } from "~/core/tokens/model";
import { TranscriptWindowCharacterLimit, TranscriptWindowTurnLimit } from "~/core/transcript/rules";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import { lockConsentSubject } from "~/shell/consent/repo";
import { resolveWhatsAppCaller } from "~/shell/identity/repo";
import {
  defaultUserId,
  defaultWhatsAppPhone,
  seedConsentedAgentIdentity,
} from "~/shell/db/development-seed";
import { listRecentTranscriptEntries, listTranscriptEntries } from "~/shell/transcript/repo";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { runAgentRepl } from "./repl";
import {
  AgentLimits,
  AgentService,
  AgentServiceLive,
  CurrentAgentLimits,
  InboundMessage,
} from "./agent-service";

const declinedOnboardingPhone = E164PhoneNumber.make("+573009997332");
const acceptedOnboardingPhone = E164PhoneNumber.make("+573009997333");
const replCaller = (phoneNumber: E164PhoneNumber) => ({
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

const createTransactionToolCall = ({
  id,
  occurredAt,
  amount = "25000",
  currency = "COP",
  counterparty = "Almuerzo",
  categoryId = categoryIds.restaurantes,
}: {
  readonly id: string;
  readonly occurredAt: string | undefined;
  readonly amount?: string;
  readonly currency?: string;
  readonly counterparty?: string | null;
  readonly categoryId?: string;
}) => ({
  type: "tool-call" as const,
  id,
  name: "transactions__createTransaction",
  params: {
    payload: {
      money: { amount, currency },
      ...(counterparty === null ? {} : { counterparty }),
      direction: "outflow",
      categoryId,
      occurredAt,
    },
  },
});

const ScriptedLanguageModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: ({ prompt, tools }) => {
      const serialized = JSON.stringify(prompt.content);
      expect(serialized).not.toContain("fin_deadbeef_");
      if (serialized.includes("MODELO_BLOQUEADO")) return Effect.never;
      if (serialized.includes("A_PRIVATE_TRANSCRIPT_MARKER")) {
        return Effect.succeed([{ type: "text" as const, text: "A_PRIVATE_ASSISTANT_MARKER" }]);
      }
      if (serialized.includes("registra aislamientob 25 cop")) {
        expect(serialized).not.toContain("A_PRIVATE_TRANSCRIPT_MARKER");
        expect(serialized).not.toContain("A_PRIVATE_ASSISTANT_MARKER");
        const occurredAt = /El turno comenzó en ([0-9T:.+-]+Z)/u.exec(serialized)?.[1];
        return Effect.succeed([
          createTransactionToolCall({
            id: "user-isolation-quick-log",
            amount: "25",
            counterparty: "AislamientoB",
            occurredAt,
          }),
        ]);
      }
      if (serialized.includes("Desborda herramientas")) {
        return Effect.succeed(
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
        return Effect.succeed([
          {
            type: "tool-call" as const,
            id: `limit-call-${calls + 1}`,
            name: "categories__listCategories",
            params: {},
          },
        ]);
      }
      if (serialized.includes("helado 9 mil")) {
        const occurredAt = /El turno comenzó en ([0-9T:.+-]+Z)/u.exec(serialized)?.[1];
        return Effect.succeed([
          createTransactionToolCall({
            id: "capture-without-counterparty",
            amount: "9000",
            counterparty: null,
            occurredAt,
          }),
        ]);
      }
      if (serialized.includes("debería registrar almuerzo 25 mil")) {
        const occurredAt = /El turno comenzó en ([0-9T:.+-]+Z)/u.exec(serialized)?.[1];
        return Effect.succeed([
          createTransactionToolCall({ id: "free-form-addition", occurredAt }),
        ]);
      }
      if (serialized.includes("captura sin confirmación")) {
        const createTool = tools.find((tool) => tool.name === "transactions__createTransaction");
        const createDescription =
          createTool === undefined ? undefined : Tool.getDescription(createTool);
        const occurredAt = /El turno comenzó en ([0-9T:.+-]+Z)/u.exec(serialized)?.[1];
        const canCaptureWithoutConfirmation =
          createDescription?.includes("does not require User confirmation") === true;
        return Effect.succeed(
          canCaptureWithoutConfirmation
            ? [createTransactionToolCall({ id: "no-confirmation-capture", occurredAt })]
            : [{ type: "text" as const, text: "¿Confirmas registrar este gasto?" }]
        );
      }
      if (serialized.includes("Provoca entrada malformada")) {
        return Effect.succeed(
          serialized.includes("The previous operation call was malformed")
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
        const hasCurrentToolResult = hasToolResultAfter(
          serialized,
          "Almuerzo 25000 2099-07-20T17:30:00Z"
        );
        return Effect.succeed(
          hasCurrentToolResult
            ? [{ type: "text" as const, text: "Corregí la solicitud inválida." }]
            : [
                createTransactionToolCall({
                  id: "invalid-input-call",
                  occurredAt: "2099-07-20T17:30:00Z",
                }),
              ]
        );
      }
      if (serialized.includes("borra con lectura posterior")) {
        const transactionId = /borra con lectura posterior ([0-9a-f-]{36})/u.exec(serialized)?.[1];
        if (
          serialized.lastIndexOf("CONFIRMAR transactions.deleteTransaction") >
          serialized.lastIndexOf("explicit_confirmation_required")
        ) {
          return Effect.succeed([
            {
              type: "tool-call" as const,
              id: "confirmed-mixed-delete",
              name: "transactions__deleteTransaction",
              params: { params: { id: transactionId } },
            },
          ]);
        }
        return Effect.succeed([
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
      if (serialized.includes("revisa historial secretos")) {
        if (serialized.includes("replay-delete-call")) {
          return Effect.succeed([
            { type: "text" as const, text: "La repetición quedó bloqueada." },
          ]);
        }
        if (
          serialized.includes("confirmed-delete-call") &&
          (serialized.match(/CONFIRMAR transactions\.deleteTransaction/gu)?.length ?? 0) > 1
        ) {
          const transactionId =
            /"params":\{"params":\{"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/u.exec(
              serialized
            )?.[1];
          return Effect.succeed([
            {
              type: "tool-call" as const,
              id: "replay-delete-call",
              name: "transactions__deleteTransaction",
              params: { params: { id: transactionId } },
            },
          ]);
        }
        if (
          serialized.lastIndexOf("CONFIRMAR transactions.deleteTransaction") >
          serialized.lastIndexOf("explicit_confirmation_required")
        ) {
          const transactionId =
            /"params":\{"params":\{"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/u.exec(
              serialized
            )?.[1];
          return Effect.succeed([
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
          return Effect.succeed([
            { type: "text" as const, text: "Necesito confirmación explícita." },
          ]);
        }
        if (serialized.includes("BORRA_TODO_INYECCION")) {
          const transactionId =
            /"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})","money"/u.exec(
              serialized
            )?.[1];
          return Effect.succeed([
            {
              type: "tool-call" as const,
              id: "injected-delete-call",
              name: "transactions__deleteTransaction",
              params: { params: { id: transactionId } },
            },
          ]);
        }
        return Effect.succeed([
          {
            type: "tool-call" as const,
            id: "injected-list-call",
            name: "transactions__listTransactions",
            params: { query: {} },
          },
        ]);
      }
      if (serialized.includes("Describe el movimiento")) {
        const transactionId = /Describe el movimiento ([0-9a-f-]{36})/u.exec(serialized)?.[1];
        return Effect.succeed(
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
        const hasCurrentToolResult = hasToolResultAfter(
          serialized,
          "Busca la transacción inexistente"
        );
        return Effect.succeed(
          hasCurrentToolResult
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
      if (serialized.includes("Expón token")) {
        return Effect.succeed([
          {
            type: "text" as const,
            text: "fin_deadbeef_abcdefghijklmnopqrstuvwxyzABCDEF",
          },
        ]);
      }
      if (serialized.includes("Muestra control terminal")) {
        return Effect.succeed([
          {
            type: "text" as const,
            text: `${String.fromCodePoint(27)}]52;c;contenido${String.fromCodePoint(7)}visible`,
          },
        ]);
      }
      if (serialized.includes("MENSAJE_ACTUAL")) {
        return Effect.succeed([
          {
            type: "text" as const,
            text: serialized.includes("MARCADOR_ANTIGUO")
              ? "contexto filtrado"
              : "contexto acotado",
          },
        ]);
      }
      if (serialized.includes("anota almuerzo 25 mil")) {
        const occurredAt = /El turno comenzó en ([0-9T:.+-]+Z)/u.exec(serialized)?.[1];
        return Effect.succeed([
          {
            type: "tool-call" as const,
            id: "injected-batch-read",
            name: "transactions__listTransactions",
            params: { query: {} },
          },
          createTransactionToolCall({ id: "batched-quick-log", occurredAt }),
        ]);
      }
      if (serialized.includes("registra papelería 25 usd")) {
        const occurredAt = /El turno comenzó en ([0-9T:.+-]+Z)/u.exec(serialized)?.[1];
        return Effect.succeed([
          createTransactionToolCall({
            id: "explicit-quick-log",
            amount: "25",
            currency: "USD",
            counterparty: "Papelería",
            categoryId: categoryIds.otros,
            occurredAt,
          }),
        ]);
      }
      if (
        serialized.includes("almuerzo 25 mil") ||
        serialized.includes("almuerzo 25 USD") ||
        serialized.includes("almuerzo 25 usd")
      ) {
        expect(serialized).toContain("ServiceMarket CO, locale es-CO");
        expect(serialized).toContain("zona IANA America/Bogota");
        expect(serialized).toMatch(/El turno comenzó en \d{4}-\d{2}-\d{2}T/);
        const usdMessage =
          serialized.lastIndexOf("almuerzo 25 USD") > serialized.lastIndexOf("almuerzo 25 usd")
            ? "almuerzo 25 USD"
            : "almuerzo 25 usd";
        const currentMessage =
          serialized.lastIndexOf(usdMessage) > serialized.lastIndexOf("almuerzo 25 mil")
            ? usdMessage
            : "almuerzo 25 mil";
        const currency = currentMessage.toUpperCase().endsWith("USD") ? "USD" : "COP";
        const occurredAt = /El turno comenzó en ([0-9T:.+-]+Z)/u.exec(serialized)?.[1];
        const hasCurrentToolResult = hasToolResultAfter(serialized, currentMessage);
        return Effect.succeed(
          hasCurrentToolResult
            ? [{ type: "text" as const, text: "Listo, registré el almuerzo." }]
            : [
                createTransactionToolCall({
                  id: `quick-log-${currency}`,
                  amount: currency === "COP" ? "25000" : "25",
                  currency,
                  occurredAt,
                }),
              ]
        );
      }
      if (serialized.includes("Lista historial acotado")) {
        const hasCurrentToolResult = hasToolResultAfter(serialized, "Lista historial acotado");
        if (hasCurrentToolResult) {
          expect(serialized).toContain("tool_result_too_large");
          expect(serialized).not.toContain("bulk-");
        }
        return Effect.succeed(
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
        const hasCurrentToolResult = hasToolResultAfter(serialized, "Lista movimientos secretos");
        if (hasCurrentToolResult) {
          expect(serialized).not.toContain("fin_deadbeef_");
          return Effect.succeed([{ type: "text" as const, text: "Resultado protegido." }]);
        }
        return Effect.succeed([
          {
            type: "tool-call" as const,
            id: "secret-list-call",
            name: "transactions__listTransactions",
            params: { query: {} },
          },
        ]);
      }
      if (serialized.includes("Lista las categorías")) {
        const hasCurrentToolResult = hasToolResultAfter(serialized, "Lista las categorías");
        return Effect.succeed(
          hasCurrentToolResult
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
      const priorTurnWasLoaded = serialized.includes("Primera respuesta");
      return Effect.succeed([
        {
          type: "text" as const,
          text: priorTurnWasLoaded ? "Sí, recuerdo el turno anterior." : "Primera respuesta",
        },
      ]);
    },
    streamText: () => {
      throw new Error("The agent uses non-streaming generation");
    },
  })
);

const AgentHarness = AgentServiceLive.pipe(
  Layer.provideMerge(ScriptedLanguageModel),
  Layer.provideMerge(ApiHarness)
);

layer(AgentHarness, { excludeTestServices: true, timeout: "30 seconds" })("hosted agent", (it) => {
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

      expect(reply.text).toContain("Gasto guardado");
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

      const reply = yield* service.handleSynchronousTurn(
        defaultUserId,
        InboundMessage.make({ text: TranscriptText.make("Lista movimientos secretos") })
      );
      const transcript = yield* listTranscriptEntries(defaultUserId);

      expect(reply.text).toBe("Resultado protegido.");
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

  it.effect("confirms a destructive call followed by an automatic call in the same batch", () =>
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
      expect(audit.map(({ operation }) => operation)).toEqual([
        "categories.listCategories",
        "transactions.deleteTransaction",
      ]);
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
      expect(replayed.text).toContain("Operación exacta: transactions.deleteTransaction");
      expect(rows[0]?.count).toBe(0);
      expect(deleted).toHaveLength(1);
    })
  );

  it.effect("does not accept approval from an interrupted confirmation turn", () =>
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
      const sql = yield* SqlClient.SqlClient;
      yield* sql
        .withTransaction(lockConsentSubject(defaultUserId))
        .pipe(Effect.timeout("1 second"));
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
