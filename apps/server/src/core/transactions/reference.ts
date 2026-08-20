import { Schema } from "effect";

const maximumCounterpartyLength = 120;

/** Assigned once at capture and stable independently of later Reconciliation. */
export const TransactionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("TransactionId"))
  .annotate({ identifier: "TransactionId" });
export type TransactionId = typeof TransactionId.Type;

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
