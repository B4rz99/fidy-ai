import { type DateTime, Data } from "effect";
import { type TransactionId } from "./model";

/**
 * The asked-for transaction is not in this user's history.
 *
 * Carries the id so the shell can name it back to the caller. It deliberately
 * does not distinguish "no such row" from "somebody else's row": the caller may
 * not learn which ids exist outside their own history (ARCHITECTURE.md §5), and
 * a failure that told them apart would be exactly that leak.
 */
export class TransactionNotFound extends Data.TaggedError("TransactionNotFound")<{
  readonly transactionId: TransactionId;
}> {}

/**
 * The movement being recorded is dated after the moment it was recorded, so it
 * has not happened yet and is not a Transaction (CONTEXT.md).
 *
 * Carries both instants because only the pair explains the failure: the caller
 * needs to know what it sent and what the product considered "now" to correct
 * the value — a clock skew and a typo look identical from one of them alone.
 */
export class TransactionNotYetOccurred extends Data.TaggedError("TransactionNotYetOccurred")<{
  readonly occurredAt: DateTime.Utc;
  readonly now: DateTime.Utc;
}> {}

/** A two-ended query period is empty or reversed; `from` must be strictly before `to`. */
export class InvalidTransactionPeriod extends Data.TaggedError("InvalidTransactionPeriod")<{
  readonly from: DateTime.Utc;
  readonly to: DateTime.Utc;
}> {}

/**
 * Every way an operation on transactions can fail for a reason its caller could
 * act on. Infrastructure that no caller can respond to — a dead connection, a
 * row the model rejects — is a defect and is absent from this union by design.
 *
 * Carries no status, no code, no message: how a failure reaches the API response is
 * decided once per slice in `shell/transactions/errors.ts`, which switches over
 * this union exhaustively. Widening it without extending that switch fails the
 * build (ARCHITECTURE.md §6).
 */
export type TransactionFailure =
  | InvalidTransactionPeriod
  | TransactionNotFound
  | TransactionNotYetOccurred;
