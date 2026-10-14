import { Currency, Money, type ReadonlyMoney } from "~/core/_shared/money";
import {
  BigDecimal,
  Data,
  type DateTime,
  Function,
  Schema,
  SchemaTransformation,
  Struct,
} from "effect";
import { CategoryId } from "~/core/categories/contract";
import { UtcTimestamp } from "~/core/_shared/time";

/** Assigned once at capture and stable independently of later Reconciliation. */
export const TransactionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("TransactionId"))
  .annotate({ identifier: "TransactionId" });
export type TransactionId = typeof TransactionId.Type;

const maxHintTextCodePoints = 64;

/** An explicitly identified card or account suffix; leading zeros are significant. */
export const LastFourDigits = Schema.String.check(Schema.isPattern(/^[0-9]{4}$/u))
  .pipe(Schema.brand("LastFourDigits"))
  .annotate({ identifier: "LastFourDigits" });
export type LastFourDigits = typeof LastFourDigits.Type;

export const NotificationFormatId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  Schema.isMaxLength(maxHintTextCodePoints)
)
  .pipe(Schema.brand("NotificationFormatId"))
  .annotate({ identifier: "NotificationFormatId" });
export type NotificationFormatId = typeof NotificationFormatId.Type;

export const NotificationCurrencyBasis = Schema.Literals(["explicit", "format-cop-default-v1"]);
export type NotificationCurrencyBasis = typeof NotificationCurrencyBasis.Type;

const normalizeInstrumentLabel = (text: string): string =>
  text
    .normalize("NFKC")
    .replaceAll(/\p{White_Space}+/gu, " ")
    .trim()
    .toLowerCase();

/**
 * A normalized explicit product label, not an institution or inferred account identity.
 * Formatting validation does not prove arbitrary prose safe: capture must independently restrict
 * label evidence before retaining it. The limit counts Unicode code points, not UTF-16 units.
 */
export const InstrumentLabel = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter(
        (text) =>
          text.length > 0 &&
          Array.from(text).length <= maxHintTextCodePoints &&
          !/[\p{Cc}\p{Cf}]/u.test(text)
      )
    ).pipe(Schema.brand("InstrumentLabel")),
    SchemaTransformation.transform({
      decode: normalizeInstrumentLabel,
      encode: (text) => text,
    })
  )
).annotate({ identifier: "InstrumentLabel" });
export type InstrumentLabel = typeof InstrumentLabel.Type;

/**
 * Safe, partial SourceAttestation evidence. Slots are independently absent; equal digits across
 * card and account namespaces are not comparable and no hint establishes a Transaction match.
 */
export const AccountHints = Schema.Struct({
  cardLastFour: Schema.OptionFromOptionalKey(LastFourDigits),
  accountLastFour: Schema.OptionFromOptionalKey(LastFourDigits),
  instrumentLabel: Schema.OptionFromOptionalKey(InstrumentLabel),
}).annotate({ identifier: "AccountHints" });
export type AccountHints = typeof AccountHints.Type;

/** Versioned safe evidence retained only for a deterministically interpreted notification email. */
export const NotificationInterpretationEvidence = Schema.Struct({
  formatId: NotificationFormatId,
  currencyBasis: NotificationCurrencyBasis,
  accountHints: AccountHints,
}).annotate({ identifier: "NotificationInterpretationEvidence" });
export type NotificationInterpretationEvidence = typeof NotificationInterpretationEvidence.Type;

const zero = BigDecimal.make(0n, 0);
const maximumTransactionNotesLength = 500;
const maximumCounterpartyLength = 120;

// Transaction Money must be positive. mapFields drops struct checks, so derived
// create input reapplies this filter.
const positiveTransactionMoney = Schema.makeFilter<{
  readonly money: { readonly amount: Readonly<BigDecimal.BigDecimal> };
}>((transaction) =>
  BigDecimal.Order(transaction.money.amount, zero) === 1
    ? undefined
    : { path: ["money", "amount"], issue: "Transaction Money must be greater than zero" }
);

/** Inflow or outflow direction, independent of the non-negative Money amount. */
export const Direction = Schema.Literals(["inflow", "outflow"]).annotate({
  description:
    "Which way the money moved, seen from the user: `outflow` is money leaving them, " +
    "`inflow` is money reaching them. The amount is unsigned, so this is the only field " +
    "that carries the sign.",
});
export type Direction = typeof Direction.Type;

/** Purpose-neutral effective facts grouped by interval, Category, Currency, and direction. */
export type EffectiveTransactionAggregate = Readonly<{
  categoryId: CategoryId;
  direction: Direction;
  sum: Money;
  maximum: Money;
  count: bigint;
}>;

/** One half-open UTC selection of effective financial facts. */
export type TransactionPeriod = Readonly<{ from: DateTime.Utc; toExclusive: DateTime.Utc }>;

/** Complete exact aggregates for one explicitly selected interval, not a bounded history page. */
export type PeriodAggregates = Readonly<{
  period: TransactionPeriod;
  aggregates: ReadonlyArray<EffectiveTransactionAggregate>;
}>;

/** Two positional selections observed at one revision; callers bind each position to their own purpose. */
export type CompletePeriodAggregates = Readonly<{
  revision: number;
  periods: readonly [PeriodAggregates, PeriodAggregates];
}>;

export const Counterparty = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumCounterpartyLength)
);
export type Counterparty = typeof Counterparty.Type;

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
 * One completed Money movement. occurredAt is when Money moved; createdAt is
 * when Fidy learned of it.
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
  /** Starts at zero; each accepted correction advances it once. */
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
  .check(positiveTransactionMoney)
  .annotate({ identifier: "Transaction" });
export type Transaction = typeof Transaction.Type;

/** Minimal effective outflow facts for recurring detection; capture lag, not source kind, classifies backfill. */
export const RecurringTransactionFact = Schema.Struct({
  id: TransactionId,
  money: Transaction.fields.money,
  counterparty: Transaction.fields.counterparty,
  occurredAt: Transaction.fields.occurredAt,
  backfill: Schema.Boolean,
}).check(positiveTransactionMoney);
/** Exact immutable Money and explicit absence consumed by recurring detection. */
export type RecurringTransactionFact = Omit<typeof RecurringTransactionFact.Type, "money"> &
  Readonly<{ money: ReadonlyMoney }>;

/** An exact pair supplied to reversible Transaction linking; ownership is resolved from the caller. */
export const TransactionPairInput = Schema.Struct({
  firstTransactionId: TransactionId,
  secondTransactionId: TransactionId,
}).annotate({ identifier: "TransactionPairInput" });
export type TransactionPairInput = typeof TransactionPairInput.Type;

const IndependentPresentationMetadata = Schema.Struct({
  kind: Schema.Literal("independent"),
});
/** How a requested member maps to the visible identity of its linked pair. */
const LinkedPresentationMetadata = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("visible-member"),
  }),
  Schema.Struct({
    kind: Schema.Literal("suppressed-member"),
    requestedId: TransactionId,
  }),
]);
const IndependentTransactionPresentation = Schema.Struct({
  ...Transaction.fields,
  presentation: IndependentPresentationMetadata,
}).check(positiveTransactionMoney);

/**
 * One effective Transaction with metadata explaining how the requested id maps to its visible
 * identity. The nested discriminated union makes invalid presentation states unrepresentable.
 */
export const TransactionPresentation = Schema.Struct({
  ...Transaction.fields,
  presentation: Schema.Union([IndependentPresentationMetadata, LinkedPresentationMetadata]),
})
  .check(positiveTransactionMoney)
  .annotate({ identifier: "TransactionPresentation" });
export type TransactionPresentation = typeof TransactionPresentation.Type;

/** The canonically ordered independent originals restored by one successful unlink mutation. */
export const RestoredTransactionPair = Schema.Struct({
  firstTransaction: IndependentTransactionPresentation,
  secondTransaction: IndependentTransactionPresentation,
}).annotate({ identifier: "RestoredTransactionPair" });
export type RestoredTransactionPair = typeof RestoredTransactionPair.Type;

/**
 * Caller-supplied Transaction facts. Persistence assigns id and createdAt;
 * ownership comes from the authenticated call context.
 */
export const CreateTransactionInput = Transaction.mapFields(
  Function.flow(
    Struct.omit(["id", "createdAt", "revision"]),
    Struct.evolve({ categoryId: () => Schema.OptionFromOptionalKey(CategoryId) })
  )
)
  .check(positiveTransactionMoney)
  .annotate({ identifier: "CreateTransactionInput" });
export type CreateTransactionInput = typeof CreateTransactionInput.Type;

/** Replace only explicitly supplied facts at the revision observed by the caller. Null clears an optional fact. */
export const UpdateTransactionInput = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  changes: Schema.Struct({
    money: Schema.optionalKey(Money),
    direction: Schema.optionalKey(Direction),
    categoryId: Schema.optionalKey(CategoryId),
    counterparty: Schema.optionalKey(Schema.NullOr(Counterparty)),
    notes: Schema.optionalKey(
      Schema.NullOr(
        Schema.NonEmptyString.check(Schema.isTrimmed()).check(
          Schema.isMaxLength(maximumTransactionNotesLength)
        )
      )
    ),
    occurredAt: Schema.optionalKey(OccurredAt),
  }),
}).annotate({ identifier: "UpdateTransactionInput" });
export type UpdateTransactionInput = typeof UpdateTransactionInput.Type;

/** Facts an extractor may propose, derived from the canonical model and nested Money. */
export const TransactionExtraction = Transaction.mapFields(
  Struct.pick(["money", "counterparty", "direction", "occurredAt"])
)
  .check(positiveTransactionMoney)
  .annotate({ identifier: "TransactionExtraction" });
export type TransactionExtraction = typeof TransactionExtraction.Type;

export const TransactionQueryValues = Schema.Struct({
  from: UtcTimestamp,
  to: UtcTimestamp,
  categoryId: CategoryId,
  counterparty: Counterparty,
  direction: Direction,
  currency: Currency,
  /** A validated keyset position, never authorization evidence. */
  cursor: Schema.String.check(
    Schema.isPattern(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f-]{36}$/u
    )
  ),
});

const maximumSearchLength = 80;

/** Bounded literal text search; a cursor is only a position in the caller's own result set. */
export const TransactionSearchQuery = Schema.Struct({
  q: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(maximumSearchLength)),
  cursor: Schema.optionalKey(TransactionQueryValues.fields.cursor),
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
  cursor: Schema.Option(TransactionQueryValues.fields.cursor),
}).annotate({ identifier: "TransactionQuery" });
export type TransactionQuery = typeof TransactionQuery.Type;

/** Missing and foreign Transaction identities produce the same failure. */
export class TransactionNotFound extends Data.TaggedError("TransactionNotFound")<{
  readonly transactionId: TransactionId;
}> {}

/** The movement is after now; both instants identify the caller correction. */
export class TransactionNotYetOccurred extends Data.TaggedError("TransactionNotYetOccurred")<{
  readonly occurredAt: DateTime.Utc;
  readonly now: DateTime.Utc;
}> {}

/** A two-ended query period is empty or reversed; `from` must be strictly before `to`. */
export class InvalidTransactionPeriod extends Data.TaggedError("InvalidTransactionPeriod")<{
  readonly from: DateTime.Utc;
  readonly to: DateTime.Utc;
}> {}

export class SameTransactionPair extends Data.TaggedError("SameTransactionPair")<{
  readonly transactionId: TransactionId;
}> {}

/** The exact pair cannot represent one effective Transaction under the linking invariants. */
export class IneligibleTransactionPair extends Data.TaggedError("IneligibleTransactionPair")<{
  readonly reason: "different-currency" | "different-amount" | "incompatible-direction";
}> {}

/** Caller-actionable Transaction failures; infrastructure failures remain defects. */
export type TransactionFailure =
  | IneligibleTransactionPair
  | InvalidTransactionPeriod
  | SameTransactionPair
  | TransactionNotFound
  | TransactionNotYetOccurred;

/**
 * Whether the User explicitly decided each current Transaction field state. A true Counterparty or
 * notes decision includes explicitly clearing that field; false means its state was automatic.
 */
export const TransactionUserDecisions = Schema.Struct({
  category: Schema.Boolean,
  counterparty: Schema.Boolean,
  notes: Schema.Boolean,
});
export type TransactionUserDecisions = typeof TransactionUserDecisions.Type;

/** Canonical policy facts required to validate a link and choose its visible member. */
export type ReconciliationMember = Readonly<{
  id: Transaction["id"];
  money: ReadonlyMoney;
  direction: Transaction["direction"];
  createdAt: DateTime.Utc;
}>;

/** Canonically ordered pair used by persistence so caller order cannot create a second decision. */
export type TransactionPair = TransactionPairInput;

/**
 * The one reversible decision persistence stores: the canonical pair and the member a caller reads
 * the effective Transaction under. Effective fact authorities are never stored; the shared read
 * relation selects them from the retained members on every read.
 */
export type LinkedTransactionDecision = Readonly<{
  pair: TransactionPair;
  visibleTransactionId: TransactionId;
}>;
