import { Schema, SchemaTransformation, Struct } from "effect";

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

/**
 * Whole COP pesos — COP has no fractional unit in practice. Bounded to the
 * JSON-safe integer range so amounts roundtrip exactly as plain JSON numbers;
 * the database column is bigint with the same cap.
 */
export const Amount = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
  .annotate({
    description:
      "Whole Colombian pesos. COP has no fractional unit in daily use, so 25000 means " +
      "$25.000 COP and never 250 pesos with 00 centavos. Always positive, whichever way the " +
      "money went; `direction` is what carries that.",
  })
  .pipe(Schema.brand("Amount"));
export type Amount = typeof Amount.Type;

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

/**
 * DateTime.Utc in the domain; on the wire, a validated ISO date-time string
 * that the derived OpenAPI spec advertises as `format: date-time`.
 *
 * Describe fields of this type with `annotateEncoded`, never `annotate`. The
 * spec is generated from the encoded side, so an annotation on the decoded
 * `DateTime.Utc` reaches nothing and reports no error: the description is
 * dropped in silence and the field ships undocumented.
 */
const UtcTimestamp = Schema.String.annotate({ format: "date-time" }).pipe(
  Schema.decodeTo(Schema.DateTimeUtc, SchemaTransformation.dateTimeUtcFromString)
);

/**
 * One movement of money — how much, which way, who with, and when it happened
 * (CONTEXT.md). This is the canonical shape of the entity: the input schema,
 * the row schema and the wire schemas are all derived from it, so a field added
 * here reaches every one of them and a field added anywhere else is a parallel
 * definition (ARCHITECTURE.md §4).
 *
 * `occurredAt` is when the money moved and `createdAt` is when fidy learned of
 * it. Both are ISO date-times, so their descriptions are the only thing telling
 * them apart — which is why `UtcTimestamp` carries none of its own. `id` and
 * `currency` are undescribed on purpose: a UUID named `id` and a single-member
 * enum spelled `COP` already say what they mean.
 */
export const Transaction = Schema.Struct({
  id: TransactionId,
  amount: Amount,
  currency: Schema.Literal("COP"),
  merchant: Schema.NonEmptyString.check(Schema.isTrimmed()).annotate({
    description:
      "Who the money went to, or came from when the direction is inflow, as the user names " +
      'them — "El Corral", "Claro", "Nómina". Free text the user would recognise, not a ' +
      "normalised identifier, so one shop may be spelled several ways across a history.",
  }),
  direction: Direction,
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
}).annotate({ identifier: "Transaction" });
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
  Struct.omit(["id", "createdAt"])
).annotate({ identifier: "CreateTransactionInput" });
export type CreateTransactionInput = typeof CreateTransactionInput.Type;
