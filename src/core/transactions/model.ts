import { BigDecimal, Function, Schema, SchemaTransformation, Struct } from "effect";
import { CategoryId } from "~/core/categories/reference";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { Currency, Money } from "~/core/_shared/money";

/**
 * Names one Transaction. Assigned at insert and never sent by a caller, so a
 * value of this type always came back from fidy and always denotes a row that
 * existed at the moment it was handed out.
 *
 * A surrogate UUID rather than anything derived from the movement: two genuine
 * purchases can share merchant, amount and instant, and whether a second
 * capture of the same movement is a duplicate is reconciliation's decision to
 * make (CONTEXT.md) — not one an id can make by colliding.
 */
export const TransactionId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("TransactionId")
);
export type TransactionId = typeof TransactionId.Type;

const zero = BigDecimal.make(0n, 0);

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

/** A UTC instant encoded as a validated ISO date-time string. */
export const UtcTimestamp = Schema.String.annotate({ format: "date-time" }).pipe(
  Schema.decodeTo(Schema.DateTimeUtc, SchemaTransformation.dateTimeUtcFromString)
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
  merchant: Schema.NonEmptyString.check(Schema.isTrimmed()).annotate({
    description:
      "Who the money went to, or came from when the direction is inflow, as the user names " +
      'them — "El Corral", "Claro", "Nómina". Free text the user would recognise, not a ' +
      "normalised identifier, so one shop may be spelled several ways across a history.",
  }),
  direction: Direction,
  categoryId: CategoryId,
  notes: Schema.OptionFromOptionalKey(
    Schema.NonEmptyString.check(Schema.isTrimmed()).check(Schema.isMaxLength(500))
  ),
  occurredAt: UtcTimestamp.pipe(
    Schema.annotateEncoded({
      description:
        "When the money actually moved. It must already have happened — a Transaction dated " +
        "in the future is rejected — and the history is ordered by it, so send the instant " +
        "the user is describing rather than the moment you are recording it.",
    })
  ),
  createdAt: UtcTimestamp.pipe(
    Schema.annotateEncoded({
      description:
        "When fidy learned of it, which can be long after it occurred: a statement read in " +
        "July carries movements from March. Reason about the user's spending from " +
        "`occurredAt`; read this only to tell how freshly the record was captured.",
    })
  ),
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

/** A complete replacement of editable facts; omission of notes explicitly clears them. */
export const UpdateTransactionInput = Transaction.mapFields(Struct.omit(["id", "createdAt"]))
  .check(positiveTransactionMoney)
  .annotate({ identifier: "UpdateTransactionInput" });
export type UpdateTransactionInput = typeof UpdateTransactionInput.Type;

/** Facts an extractor may propose, derived from the canonical model and nested Money. */
export const TransactionExtraction = Transaction.mapFields(
  Struct.pick(["money", "merchant", "direction", "occurredAt"])
)
  .check(positiveTransactionMoney)
  .annotate({ identifier: "TransactionExtraction" });
export type TransactionExtraction = typeof TransactionExtraction.Type;

const MerchantFilter = Schema.NonEmptyString.check(Schema.isTrimmed()).check(
  Schema.isMaxLength(120)
);

/** The constrained values from which every Transaction history filter is composed. */
export const TransactionQueryValues = Schema.Struct({
  from: UtcTimestamp,
  to: UtcTimestamp,
  categoryId: CategoryId,
  merchant: MerchantFilter,
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
  merchant: Schema.Option(TransactionQueryValues.fields.merchant),
  direction: Schema.Option(TransactionQueryValues.fields.direction),
  currency: Schema.Option(TransactionQueryValues.fields.currency),
}).annotate({ identifier: "TransactionQuery" });
export type TransactionQuery = typeof TransactionQuery.Type;

/** Stable identity of one immutable provenance statement attached to a Transaction. */
export const SourceAttestationId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("SourceAttestationId")
);
export type SourceAttestationId = typeof SourceAttestationId.Type;

const SourceName = Schema.NonEmptyString.check(Schema.isTrimmed()).check(Schema.isMaxLength(80));

/** Names the parser, extractor, or manual interpretation contract used at capture time. */
export const InterpretationRevision = Schema.NonEmptyString.check(Schema.isTrimmed())
  .check(Schema.isMaxLength(80))
  .pipe(Schema.brand("InterpretationRevision"));
export type InterpretationRevision = typeof InterpretationRevision.Type;

/** Immutable evidence of the context that interpreted one manually captured Transaction. */
export const SourceAttestation = Schema.Struct({
  id: SourceAttestationId,
  transactionId: TransactionId,
  kind: Schema.Literal("manual"),
  serviceMarket: ServiceMarket,
  locale: Locale,
  timeZone: IanaTimeZone,
  sourceChannel: Schema.OptionFromOptionalKey(SourceName),
  sourceProvider: Schema.OptionFromOptionalKey(SourceName),
  interpretationRevision: InterpretationRevision,
  createdAt: UtcTimestamp,
}).annotate({ identifier: "SourceAttestation" });
export type SourceAttestation = typeof SourceAttestation.Type;

/** User interpretation context frozen into provenance when a Transaction is captured. */
export const CapturedInterpretationContext = SourceAttestation.mapFields(
  Struct.pick(["serviceMarket", "locale", "timeZone"])
);
export type CapturedInterpretationContext = typeof CapturedInterpretationContext.Type;
