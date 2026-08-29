import { BigDecimal, Function, Schema, Struct } from "effect";
import { CategoryId } from "~/core/categories/reference";
import { CapturedInterpretationContext } from "~/core/_shared/captured-interpretation-context";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import { Currency, Money } from "~/core/_shared/money";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import { UtcTimestamp } from "~/core/_shared/time";
import {
  EmailSourceFormat,
  ResendReceivedEmailId,
  StatementSourceFormat,
  StatementSubmissionId,
} from "~/core/ingestion/reference";
import { TransactionId } from "./reference";

export { TransactionId } from "./reference";

const zero = BigDecimal.make(0n, 0);
const maximumTransactionNotesLength = 500;
const maximumCounterpartyLength = 120;
const maximumAttestationNameLength = 80;

// Money itself permits zero. A Transaction is specifically a movement, so the
// owning model adds positivity while retaining Money's exact-decimal and
// Currency rules. The nested path makes the correction actionable at the API
// validation seam. `mapFields` drops struct checks, so the create input below
// reapplies this one shared decision after deriving its fields.
const positiveTransactionMoney = Schema.makeFilter<{
  readonly money: { readonly amount: Readonly<BigDecimal.BigDecimal> };
}>((transaction) =>
  BigDecimal.Order(transaction.money.amount, zero) === 1
    ? undefined
    : { path: ["money", "amount"], issue: "Transaction Money must be greater than zero" }
);

/**
 * A closed pair rather than a sign on `Amount`, so "how much" and "which way"
 * stay separate questions: an amount cannot be silently negated, arithmetic on
 * a history has to say which direction it is summing, and a third kind of
 * movement — a transfer between the user's own accounts, say — would be a
 * domain decision that fails the build everywhere until it is answered.
 */
export const Direction = Schema.Literals(["inflow", "outflow"]).annotate({
  description:
    "Which way the money moved, seen from the user: `outflow` is money leaving them, " +
    "`inflow` is money reaching them. The amount is unsigned, so this is the only field " +
    "that carries the sign.",
});
export type Direction = typeof Direction.Type;

/** A user-recognizable person or organization explicitly identified on the other side. */
export const Counterparty = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumCounterpartyLength)
);
export type Counterparty = typeof Counterparty.Type;

/** Named so the derived documents carry one definition each rather than a copy per payload. */
const OccurredAt = UtcTimestamp.pipe(
  Schema.annotateEncoded({
    identifier: "TransactionOccurredAt",
    description:
      "When the money actually moved. It must already have happened — a Transaction dated " +
      "in the future is rejected — and the history is ordered by it, so send the instant " +
      "the user is describing rather than the moment you are recording it.",
  })
);

const CreatedAt = UtcTimestamp.pipe(
  Schema.annotateEncoded({
    identifier: "TransactionCreatedAt",
    description:
      "When fidy learned of it, which can be long after it occurred: a statement read in " +
      "July carries movements from March. Reason about the user's spending from " +
      "`occurredAt`; read this only to tell how freshly the record was captured.",
  })
);

/**
 * One movement of money — how much, which way, who with, and when it happened
 * (CONTEXT.md). This is the canonical shape of the entity: the input schema,
 * the row schema and the transport schemas are all derived from it, so a field added
 * here reaches every one of them and a field added anywhere else is a parallel
 * definition (ARCHITECTURE.md §4).
 *
 * `occurredAt` is when the money moved and `createdAt` is when fidy learned of
 * it. Both are ISO date-times, so their descriptions are the only thing telling
 * them apart — which is why `UtcTimestamp` carries none of its own. `id` is
 * undescribed on purpose: a UUID named `id` already says what it means.
 */
export const Transaction = Schema.Struct({
  id: TransactionId,
  money: Money,
  counterparty: Schema.OptionFromOptionalKey(
    Counterparty.annotate({
      description:
        "The person or organization on the other side when the captured material explicitly " +
        'identifies one — "El Corral", "Claro", "Acme S.A.". Omit this field rather than ' +
        "inferring a business, using a purchased item or purpose, or sending a placeholder.",
    })
  ),
  direction: Direction,
  categoryId: CategoryId,
  notes: Schema.OptionFromOptionalKey(
    Schema.NonEmptyString.check(Schema.isTrimmed()).check(
      Schema.isMaxLength(maximumTransactionNotesLength)
    )
  ),
  occurredAt: OccurredAt,
  createdAt: CreatedAt,
})
  .check(positiveTransactionMoney)
  .annotate({ identifier: "Transaction" });
export type Transaction = typeof Transaction.Type;

/**
 * What a caller supplies to record a Transaction: the canonical shape minus the
 * two fields it does not own. `id` and `createdAt` are both assigned at insert,
 * so sending them would be naming a record's identity and claiming when fidy
 * learned of it.
 *
 * Derived from `Transaction` rather than declared beside it, so a field added
 * to the canonical shape reaches the input without anyone remembering and the
 * two cannot drift (ARCHITECTURE.md §4). There is no owner to send either:
 * ownership is the context the call runs in, not a field (ARCHITECTURE.md §5).
 */
export const CreateTransactionInput = Transaction.mapFields(
  Function.flow(
    Struct.omit(["id", "createdAt"]),
    Struct.evolve({ categoryId: () => Schema.OptionFromOptionalKey(CategoryId) })
  )
)
  .check(positiveTransactionMoney)
  .annotate({ identifier: "CreateTransactionInput" });
export type CreateTransactionInput = typeof CreateTransactionInput.Type;

/** A complete replacement of editable facts; omitting Counterparty or notes clears that fact. */
export const UpdateTransactionInput = Transaction.mapFields(Struct.omit(["id", "createdAt"]))
  .check(positiveTransactionMoney)
  .annotate({ identifier: "UpdateTransactionInput" });
export type UpdateTransactionInput = typeof UpdateTransactionInput.Type;

/** Facts an extractor may propose, derived from the canonical model and nested Money. */
export const TransactionExtraction = Transaction.mapFields(
  Struct.pick(["money", "counterparty", "direction", "occurredAt"])
)
  .check(positiveTransactionMoney)
  .annotate({ identifier: "TransactionExtraction" });
export type TransactionExtraction = typeof TransactionExtraction.Type;

/** The constrained values from which every Transaction history filter is composed. */
export const TransactionQueryValues = Schema.Struct({
  from: UtcTimestamp,
  to: UtcTimestamp,
  categoryId: CategoryId,
  counterparty: Counterparty,
  direction: Direction,
  currency: Currency,
});

/**
 * Canonical history filters. Every possible absence is explicit, periods are half-open, and every
 * provided field combines with AND.
 */
export const TransactionQuery = Schema.Struct({
  from: Schema.Option(TransactionQueryValues.fields.from),
  to: Schema.Option(TransactionQueryValues.fields.to),
  categoryId: Schema.Option(TransactionQueryValues.fields.categoryId),
  counterparty: Schema.Option(TransactionQueryValues.fields.counterparty),
  direction: Schema.Option(TransactionQueryValues.fields.direction),
  currency: Schema.Option(TransactionQueryValues.fields.currency),
}).annotate({ identifier: "TransactionQuery" });
export type TransactionQuery = typeof TransactionQuery.Type;

/** Stable identity of one immutable provenance statement attached to a Transaction. */
export const SourceAttestationId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("SourceAttestationId"))
  .annotate({ identifier: "SourceAttestationId" });
export type SourceAttestationId = typeof SourceAttestationId.Type;

const SourceName = Schema.NonEmptyString.check(Schema.isTrimmed()).check(
  Schema.isMaxLength(maximumAttestationNameLength)
);

/** Fields shared by every immutable provenance statement. */
export const SourceAttestationCommon = Schema.Struct({
  id: SourceAttestationId,
  transactionId: TransactionId,
  ...CapturedInterpretationContext.fields,
  sourceChannel: Schema.OptionFromOptionalKey(SourceName),
  sourceProvider: Schema.OptionFromOptionalKey(SourceName),
  interpretationRevision: InterpretationRevision,
  createdAt: UtcTimestamp,
});

const ManualSourceAttestation = Schema.Struct({
  ...SourceAttestationCommon.fields,
  kind: Schema.Literal("manual"),
});

/** Immutable provenance linking a captured Transaction to one parsed statement record. */
export const StatementLineSourceAttestation = Schema.Struct({
  ...SourceAttestationCommon.fields,
  kind: Schema.Literal("statement-line"),
  statementSubmissionId: StatementSubmissionId,
  statementRecordNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  statementContentHash: Schema.NonEmptyString,
  sourceFormat: StatementSourceFormat,
  extractorRevision: InterpretationRevision,
});
export type StatementLineSourceAttestation = typeof StatementLineSourceAttestation.Type;

/** Immutable provenance linking one captured Transaction to one authenticated Resend email. */
export const NotificationEmailSourceAttestation = Schema.Struct({
  ...SourceAttestationCommon.fields,
  kind: Schema.Literal("notification-email"),
  receivedEmailId: ResendReceivedEmailId,
  messageEvidence: ProviderMessageEvidence,
  messageContentSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  sourceFormat: EmailSourceFormat,
  extractorRevision: InterpretationRevision,
});
export type NotificationEmailSourceAttestation = typeof NotificationEmailSourceAttestation.Type;

/** Immutable evidence of the context and mechanism that interpreted one Transaction. */
export const SourceAttestation = Schema.Union([
  ManualSourceAttestation,
  StatementLineSourceAttestation,
  NotificationEmailSourceAttestation,
]).annotate({ identifier: "SourceAttestation" });
export type SourceAttestation = typeof SourceAttestation.Type;
