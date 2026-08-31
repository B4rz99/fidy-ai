import { Effect, Option } from "effect";
import type { UserId } from "~/core/identity/reference";
import { TransactionNotFound } from "~/core/transactions/errors";
import {
  type TransactionId,
  TransactionQuery,
  type TransactionQueryValues,
} from "~/core/transactions/model";
import { checkTransactionPeriod } from "~/core/transactions/rules";
import type { SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { mapTransactionFailure, mapTransactionValidationFailure } from "./errors";
import { findTransactionPresentation, selectSourceAttestations, selectTransactions } from "./reads";

const missingTransaction = (transactionId: TransactionId) => (): TransactionNotFound =>
  new TransactionNotFound({ transactionId });

export type ListTransactionsInput = Readonly<{
  userId: UserId;
  filters: Partial<typeof TransactionQueryValues.Type>;
  caller: SuggestedOperationCaller;
}>;

/**
 * Reads the caller's Transaction history. Absent filters mean unfiltered, and the period is
 * validated before the query runs so an inverted range is refused rather than answered empty.
 */
export const listTransactions = Effect.fn("listTransactions")(function* ({
  userId,
  filters,
  caller,
}: ListTransactionsInput) {
  const query = TransactionQuery.make({
    from: Option.fromUndefinedOr(filters.from),
    to: Option.fromUndefinedOr(filters.to),
    categoryId: Option.fromUndefinedOr(filters.categoryId),
    counterparty: Option.fromUndefinedOr(filters.counterparty),
    direction: Option.fromUndefinedOr(filters.direction),
    currency: Option.fromUndefinedOr(filters.currency),
  });
  yield* checkTransactionPeriod({ from: query.from, to: query.to }).pipe(
    mapTransactionValidationFailure({ caller })
  );
  return { data: yield* selectTransactions(userId, query), next: [] };
});

export type GetTransactionInput = Readonly<{
  userId: UserId;
  transactionId: TransactionId;
  caller: SuggestedOperationCaller;
}>;

/** Reads one caller-owned Transaction. Foreign and absent ids are indistinguishable. */
export const getTransaction = Effect.fn("getTransaction")(function* ({
  userId,
  transactionId,
  caller,
}: GetTransactionInput) {
  const presentation = yield* findTransactionPresentation(userId, transactionId).pipe(
    Effect.flatMap(Effect.fromOption(missingTransaction(transactionId))),
    mapTransactionFailure({ caller })
  );
  return { data: presentation.transaction, next: [] };
});

export type ListSourceAttestationsInput = Readonly<{
  userId: UserId;
  transactionId: TransactionId;
  caller: SuggestedOperationCaller;
}>;

/**
 * Reads one Transaction's provenance. An empty result is reported as a missing Transaction, because
 * every visible Transaction has at least one attestation and a foreign id must not be identifiable.
 */
export const listSourceAttestations = Effect.fn("listSourceAttestations")(function* ({
  userId,
  transactionId,
  caller,
}: ListSourceAttestationsInput) {
  const data = yield* selectSourceAttestations(userId, transactionId);
  if (data.length === 0) {
    return yield* Effect.fail(missingTransaction(transactionId)()).pipe(
      mapTransactionFailure({ caller })
    );
  }
  return { data, next: [] };
});
