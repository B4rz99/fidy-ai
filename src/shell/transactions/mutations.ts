import { DateTime, Effect, Option, type Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { type Category } from "~/core/categories/model";
import { CategoryNotFound } from "~/core/categories/errors";
import { type CategoryId } from "~/core/categories/reference";
import { TransactionNotFound } from "~/core/transactions/errors";
import {
  type CreateTransactionInput,
  type Transaction,
  type TransactionId,
  UpdateTransactionInput,
} from "~/core/transactions/model";
import { checkAlreadyOccurred } from "~/core/transactions/rules";
import { type UserId } from "~/core/identity/reference";
import { type CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import { type NotFound, type ValidationFailed } from "~/shell/_shared/errors";
import { type OperationResponse, type SuggestedOperation } from "~/shell/_shared/response";
import {
  type SuggestedOperationCaller,
  checkpointSuggestedOperations,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";
import { categorizeCapture } from "~/shell/categories/categorizer";
import { toApiFailure as categoryToApiFailure } from "~/shell/categories/errors";
import { findCategory } from "~/shell/categories/repo";
import { findUserInScope } from "~/shell/identity/repo";
import { type TransactionApiFailure, mapTransactionFailure } from "./errors";
import {
  insertManualSourceAttestationInScope,
  insertTransactionInScope,
  softDeleteTransactionInScope,
  updateTransactionInScope,
} from "./repo";

const missingTransaction = (transactionId: TransactionId) => (): TransactionNotFound =>
  new TransactionNotFound({ transactionId });
const missingCategory = (categoryId: CategoryId) => (): CategoryNotFound =>
  new CategoryNotFound({ categoryId });

const requireKnownCategory = (
  categoryId: CategoryId,
  caller: SuggestedOperationCaller
): Effect.Effect<Category, NotFound | ValidationFailed, SqlClient.SqlClient> =>
  findCategory(categoryId).pipe(
    Effect.flatMap(Effect.fromOption(missingCategory(categoryId))),
    Effect.mapError((failure) => categoryToApiFailure({ failure, caller }))
  );

type MutationResponse<Data extends Schema.Top> = ReturnType<typeof OperationResponse<Data>>["Type"];

const captureCategory = (
  userId: UserId,
  input: CreateTransactionInput,
  caller: SuggestedOperationCaller
): Effect.Effect<CategoryId, NotFound | ValidationFailed, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const callerCategory = yield* Option.match(input.categoryId, {
      onNone: () => Effect.succeed(Option.none<CategoryId>()),
      onSome: (categoryId) =>
        requireKnownCategory(categoryId, caller).pipe(Effect.as(Option.some(categoryId))),
    });
    return yield* categorizeCapture({ userId, counterparty: input.counterparty, callerCategory });
  });

const capturedTransactionOperations = (
  caller: SuggestedOperationCaller
): ReadonlyArray<SuggestedOperation> =>
  checkpointSuggestedOperations({
    candidates: [
      suggestOperation({
        tool: "transactions.listTransactions",
        args: Option.none(),
        hint: "List transactions to see the new entry in the history.",
      }),
    ],
    caller,
  });

/** Identifies the authorized User and caller policy shared by canonical Transaction mutations. */
export type TransactionMutationContext = Readonly<{
  userId: UserId;
  caller: SuggestedOperationCaller;
}>;

/** Facts supplied after canonical decoding and caller authorization for Transaction creation. */
export type CreateTransactionMutationInput = TransactionMutationContext &
  Readonly<{
    payload: CreateTransactionInput;
  }>;

/** Creates a normalized Transaction and provenance inside the caller-owned transaction. */
export const createTransaction: CanonicalMutationImplementation<
  CreateTransactionMutationInput,
  MutationResponse<typeof Transaction>,
  TransactionApiFailure
> = Effect.fn("createTransaction")(function* ({
  userId,
  caller,
  payload,
}: CreateTransactionMutationInput) {
  const now = yield* DateTime.now;
  yield* checkAlreadyOccurred({ occurredAt: payload.occurredAt, now }).pipe(
    mapTransactionFailure({ caller })
  );
  const categoryId = yield* captureCategory(userId, payload, caller);
  const input = UpdateTransactionInput.make({ ...payload, categoryId });
  const user = yield* findUserInScope(userId).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
  const transaction = yield* insertTransactionInScope(userId, input);
  yield* insertManualSourceAttestationInScope(userId, transaction.id, {
    serviceMarket: user.serviceMarket,
    locale: user.locale,
    timeZone: user.timeZone,
  });
  return { data: transaction, next: capturedTransactionOperations(caller) };
});

/** Facts supplied after canonical decoding and caller authorization for Transaction correction. */
export type CorrectTransactionInput = TransactionMutationContext &
  Readonly<{
    transactionId: TransactionId;
    payload: UpdateTransactionInput;
  }>;

/**
 * Corrects one Transaction without opening a transaction. The caller must run this under the
 * matching User-scoped transaction and owns rollback, including any sibling atomic mutations.
 */
export const correctTransaction: CanonicalMutationImplementation<
  CorrectTransactionInput,
  MutationResponse<typeof Transaction>,
  TransactionApiFailure
> = Effect.fn("correctTransaction")(function* ({
  userId,
  transactionId,
  payload,
  caller,
}: CorrectTransactionInput) {
  const now = yield* DateTime.now;
  yield* checkAlreadyOccurred({ occurredAt: payload.occurredAt, now }).pipe(
    mapTransactionFailure({ caller })
  );
  yield* requireKnownCategory(payload.categoryId, caller);
  const transaction = yield* updateTransactionInScope(userId, transactionId, payload).pipe(
    Effect.flatMap(Effect.fromOption(missingTransaction(transactionId))),
    mapTransactionFailure({ caller })
  );
  return { data: transaction, next: [] };
});

/** Facts supplied after canonical decoding and caller authorization for Transaction deletion. */
export type DeleteTransactionInput = TransactionMutationContext &
  Readonly<{
    transactionId: TransactionId;
  }>;

/**
 * Deletes one Transaction without opening a transaction. The caller must run this under the
 * matching User-scoped transaction and owns rollback, including any sibling atomic mutations.
 */
export const deleteTransaction: CanonicalMutationImplementation<
  DeleteTransactionInput,
  MutationResponse<typeof TransactionId>,
  TransactionApiFailure
> = Effect.fn("deleteTransaction")(function* ({
  userId,
  transactionId,
  caller,
}: DeleteTransactionInput) {
  const id = yield* softDeleteTransactionInScope(userId, transactionId).pipe(
    Effect.flatMap(Effect.fromOption(missingTransaction(transactionId))),
    mapTransactionFailure({ caller })
  );
  return { data: id, next: [] };
});
