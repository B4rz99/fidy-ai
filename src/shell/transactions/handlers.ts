import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { SqlClient } from "effect/unstable/sql";
import { type UserId } from "~/core/identity/reference";
import { TransactionNotFound } from "~/core/transactions/errors";
import {
  type SourceAttestation,
  type Transaction,
  type TransactionId,
  TransactionQuery,
  type TransactionQueryValues,
} from "~/core/transactions/model";
import { checkTransactionPeriod } from "~/core/transactions/rules";
import { ResolvedCaller } from "~/shell/_shared/authz";
import type { ValidationFailed } from "~/shell/_shared/errors";
import {
  type SuggestedOperationCaller,
  makeFreeSuggestedOperationCaller,
} from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import {
  type TransactionApiFailure,
  mapTransactionFailure,
  mapTransactionValidationFailure,
} from "./errors";
import { correctTransaction, createTransaction, deleteTransaction } from "./mutations";
import { findTransaction, listSourceAttestations, listTransactions } from "./repo";

const missingTransaction = (transactionId: TransactionId) => (): TransactionNotFound =>
  new TransactionNotFound({ transactionId });

const resolveTransactionCaller: Effect.Effect<
  { userId: UserId; caller: SuggestedOperationCaller },
  never,
  ResolvedCaller
> = Effect.map(ResolvedCaller, ({ scopes, subjectUserId }) => ({
  userId: subjectUserId,
  caller: makeFreeSuggestedOperationCaller(scopes),
}));

const toTransactionQuery = (
  filters: Partial<typeof TransactionQueryValues.Type>
): TransactionQuery =>
  TransactionQuery.make({
    from: Option.fromUndefinedOr(filters.from),
    to: Option.fromUndefinedOr(filters.to),
    categoryId: Option.fromUndefinedOr(filters.categoryId),
    counterparty: Option.fromUndefinedOr(filters.counterparty),
    direction: Option.fromUndefinedOr(filters.direction),
    currency: Option.fromUndefinedOr(filters.currency),
  });

const listUserTransactions = ({
  userId,
  filters,
  caller,
}: Readonly<{
  userId: UserId;
  filters: Partial<typeof TransactionQueryValues.Type>;
  caller: SuggestedOperationCaller;
}>): Effect.Effect<ReadonlyArray<Transaction>, ValidationFailed, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const query = toTransactionQuery(filters);
    yield* checkTransactionPeriod({ from: query.from, to: query.to }).pipe(
      mapTransactionValidationFailure({ caller })
    );
    return yield* listTransactions(userId, query);
  });

const readSourceAttestations = ({
  userId,
  transactionId,
  caller,
}: Readonly<{
  userId: UserId;
  transactionId: TransactionId;
  caller: SuggestedOperationCaller;
}>): Effect.Effect<ReadonlyArray<SourceAttestation>, TransactionApiFailure, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const attestations = yield* listSourceAttestations(userId, transactionId);
    if (attestations.length === 0) {
      return yield* Effect.fail(missingTransaction(transactionId)()).pipe(
        mapTransactionFailure({ caller })
      );
    }
    return attestations;
  });

/** Provides caller-owned Transaction capture, history, correction, deletion, and provenance. */
export const TransactionsLive = HttpApiBuilder.group(FidyApi, "transactions", (handlers) =>
  handlers
    .handle("createTransaction", ({ payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveTransactionCaller;
        return yield* createTransaction({ userId, payload, caller });
      })
    )
    .handle("listTransactions", ({ query: filters }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveTransactionCaller;
        const transactions = yield* listUserTransactions({ userId, filters, caller });
        return { data: transactions, next: [] };
      })
    )
    .handle("getTransaction", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveTransactionCaller;
        const transaction = yield* findTransaction(userId, params.id).pipe(
          Effect.flatMap(Effect.fromOption(missingTransaction(params.id))),
          mapTransactionFailure({ caller })
        );
        return { data: transaction, next: [] };
      })
    )
    .handle("updateTransaction", ({ params, payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveTransactionCaller;
        return yield* correctTransaction({
          userId,
          transactionId: params.id,
          payload,
          caller,
        });
      })
    )
    .handle("deleteTransaction", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveTransactionCaller;
        return yield* deleteTransaction({
          userId,
          transactionId: params.id,
          caller,
        });
      })
    )
    .handle("listSourceAttestations", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveTransactionCaller;
        const attestations = yield* readSourceAttestations({
          userId,
          transactionId: params.id,
          caller,
        });
        return { data: attestations, next: [] };
      })
    )
);
