import { BigDecimal, DateTime, Option, Schema, Struct } from "effect";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { CreateTransactionInput } from "~/core/transactions/model";
import type { AgentIteration } from "~/core/transcript/model";
import type { TranscriptWindowEntry } from "~/core/transcript/rules";
import type { AgentOperationBinding } from "./toolkit";

const ConfirmationRequiredFailure = Schema.Struct({
  code: Schema.Literal("explicit_confirmation_required"),
  message: Schema.Literal(
    "Ask the User to reply with exactly CONFIRMAR followed by this canonical operation id."
  ),
});
const ConfirmationRequiredCode = ConfirmationRequiredFailure.mapFields(Struct.pick(["code"]));

/** Canonical safe failure persisted when host authority requires exact User confirmation. */
export const confirmationRequired: Schema.Json = ConfirmationRequiredFailure.make({
  code: "explicit_confirmation_required",
  message: "Ask the User to reply with exactly CONFIRMAR followed by this canonical operation id.",
});
/** The only canonical write eligible for grounded first-iteration implicit authority. */
export const directQuickLogOperation = CanonicalOperationId.make("transactions.createTransaction");

const QuickLogEvidence = Schema.Struct({
  payload: Schema.toEncoded(CreateTransactionInput),
});
const bareQuickLogConcepts = new Set([
  "almuerzo",
  "desayuno",
  "cena",
  "mercado",
  "transporte",
  "taxi",
  "arriendo",
]);
const publicCategoryRead = CanonicalOperationId.make("categories.listCategories");
const unfilteredTransactionRead = CanonicalOperationId.make("transactions.listTransactions");
const transactionByIdRead = CanonicalOperationId.make("transactions.getTransaction");

/** Exact canonical call facts recoverable from the newest completed confirmation challenge. */
export type PendingApproval = Pick<
  Extract<TranscriptWindowEntry, { readonly _tag: "CanonicalToolCallEntry" }>,
  "operation" | "input"
>;

type ToolExecutionRequest = {
  readonly binding: Readonly<AgentOperationBinding>;
  readonly message: { readonly text: string };
  readonly iteration: AgentIteration;
  readonly input: unknown;
  readonly quickLogAvailable: boolean;
  readonly occurredAt: DateTime.Utc;
};

/** Finds the newest unstaled confirmation challenge in completed Transcript evidence. */
export const findPendingApproval = (
  entries: ReadonlyArray<TranscriptWindowEntry>
): Option.Option<PendingApproval> => {
  let newerCallSeen = false;
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const result = entries[index];
    const call = entries[index - 1];
    if (
      result?._tag === "CanonicalToolResultEntry" &&
      result.outcome._tag === "ToolInputRejected" &&
      Schema.is(ConfirmationRequiredCode)(result.outcome.failure) &&
      call?._tag === "CanonicalToolCallEntry" &&
      call.toolCallId === result.toolCallId
    ) {
      return newerCallSeen
        ? Option.none()
        : Option.some({ operation: call.operation, input: call.input });
    }
    if (result?._tag === "CanonicalToolCallEntry") newerCallSeen = true;
  }
  return Option.none();
};

/** Checks that a confirmation applies to the exact canonical operation and serialized input. */
export const matchesApprovedCall = ({
  pending,
  binding,
  input,
}: {
  readonly pending: Readonly<PendingApproval>;
  readonly binding: Readonly<AgentOperationBinding>;
  readonly input: unknown;
}): boolean =>
  pending.operation === binding.operation &&
  JSON.stringify(pending.input) === JSON.stringify(input);

const groundsDirectQuickLog = (
  message: { readonly text: string },
  occurredAt: DateTime.Utc,
  input: unknown
): boolean => {
  if (!Schema.is(QuickLogEvidence)(input)) return false;
  const normalizedMessage = message.text.trim();
  if (
    /[¿?]/u.test(normalizedMessage) ||
    /\b(?:no|nunca|jamás|tampoco|sin|solo|solamente|explica|explícame|simula|simular|supón|imagina|si|quizá|tal vez|puedes|podrías|debería|quiero saber)\b/iu.test(
      normalizedMessage
    )
  ) {
    return false;
  }
  const parsed = Option.fromNullishOr(
    /^(?:(registra|anota)\s+)?([\p{L}][\p{L}\p{N}.'-]*)\s+(\d+(?:[.,]\d+)?)(?:\s+(mil|k|[a-z]{3}))?(?:\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z))?$/iu.exec(
      normalizedMessage
    )
  );
  if (Option.isNone(parsed)) return false;
  const explicitCommand = parsed.value[1] !== undefined;
  const merchant = Option.fromNullishOr(parsed.value[2]).pipe(Option.getOrElse(() => ""));
  const amountText = Option.fromNullishOr(parsed.value[3]).pipe(Option.getOrElse(() => ""));
  const unit = Option.fromNullishOr(parsed.value[4]);
  const normalizedMerchant = merchant.toLocaleLowerCase("es-CO");
  if (!explicitCommand && !bareQuickLogConcepts.has(normalizedMerchant)) return false;
  const merchantGrounded = normalizedMerchant === input.payload.merchant.toLocaleLowerCase("es-CO");
  const statedAmount = BigDecimal.fromString(amountText.replace(",", "."));
  const inputAmount = BigDecimal.fromString(input.payload.money.amount);
  const isThousands = Option.exists(unit, (value) => /^(?:mil|k)$/iu.test(value));
  const expectedAmount = Option.map(statedAmount, (amount) =>
    isThousands ? BigDecimal.multiply(amount, BigDecimal.fromBigInt(1_000n)) : amount
  );
  const amountGrounded = Option.zipWith(inputAmount, expectedAmount, BigDecimal.equals).pipe(
    Option.getOrElse(() => false)
  );
  const expectedCurrency = isThousands
    ? "COP"
    : Option.match(unit, {
        onNone: () => "COP",
        onSome: (value) => (/^[a-z]{3}$/iu.test(value) ? value.toUpperCase() : "COP"),
      });
  const statedInstant = Option.fromNullishOr(parsed.value[5]);
  const expectedInstant = Option.match(statedInstant, {
    onNone: () => Option.some(occurredAt),
    onSome: DateTime.make,
  });
  const inputInstant = DateTime.make(input.payload.occurredAt);
  const occurredAtGrounded = Option.zipWith(
    inputInstant,
    expectedInstant,
    (actual, expected) => DateTime.toEpochMillis(actual) === DateTime.toEpochMillis(expected)
  ).pipe(Option.getOrElse(() => false));
  const defaultsGrounded =
    input.payload.direction === "outflow" &&
    !Object.hasOwn(input.payload, "notes") &&
    occurredAtGrounded;
  return (
    merchantGrounded &&
    amountGrounded &&
    input.payload.money.currency === expectedCurrency &&
    defaultsGrounded
  );
};

const isEmptyObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && Object.keys(value).length === 0;

const groundsUnfilteredTransactionRead = (message: string, input: unknown): boolean => {
  if (typeof input !== "object" || input === null || !("query" in input)) return false;
  if (!isEmptyObject(input.query) || Object.keys(input).length !== 1) return false;
  return /^(?:lista|muestra|muéstrame|consulta|revisa)\s+(?:(?:mi|el)\s+)?(?:historial|movimientos|transacciones|gastos)(?:\s+(?:completo|reciente|recientes|acotado|secretos))?$/iu.test(
    message.trim()
  );
};

const groundsTransactionByIdRead = (message: string, input: unknown): boolean => {
  if (typeof input !== "object" || input === null || !("params" in input)) return false;
  const params = input.params;
  if (typeof params !== "object" || params === null || !("id" in params)) return false;
  if (typeof params.id !== "string") return false;
  const normalized = message.trim().toLocaleLowerCase("es-CO");
  const id = params.id.toLowerCase();
  return new Set([
    `busca la transacción ${id}`,
    `busca la transacción inexistente ${id}`,
    `muestra la transacción ${id}`,
    `consulta la transacción ${id}`,
    `revisa la transacción ${id}`,
  ]).has(normalized);
};

const groundsRead = (
  operation: CanonicalOperationId,
  message: { readonly text: string },
  input: unknown
): boolean =>
  operation === publicCategoryRead ||
  (operation === unfilteredTransactionRead &&
    groundsUnfilteredTransactionRead(message.text, input)) ||
  (operation === transactionByIdRead && groundsTransactionByIdRead(message.text, input));

/** Grants host authority only to grounded reads or one grounded direct quick-log. */
export const mayExecuteToolCall = ({
  binding,
  message,
  iteration,
  input,
  quickLogAvailable,
  occurredAt,
}: ToolExecutionRequest): boolean =>
  (binding.policy.requiredScope === "read" && groundsRead(binding.operation, message, input)) ||
  (quickLogAvailable &&
    binding.operation === directQuickLogOperation &&
    Number(iteration) === 1 &&
    groundsDirectQuickLog(message, occurredAt, input));
