import { DateTime, Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { SqlClient } from "effect/unstable/sql";
import { type Category } from "~/core/categories/model";
import { type CategoryId } from "~/core/categories/reference";
import { type UserId } from "~/core/identity/reference";
import { CategoryNotFound } from "~/core/categories/errors";
import { TransactionNotFound } from "~/core/transactions/errors";
import {
  type CapturedInterpretationContext,
  type CreateTransactionInput,
  type SourceAttestation,
  type Transaction,
  type TransactionId,
  TransactionQuery,
  type TransactionQueryValues,
  UpdateTransactionInput,
} from "~/core/transactions/model";
import { checkAlreadyOccurred, checkTransactionPeriod } from "~/core/transactions/rules";
import { ResolvedCaller } from "~/shell/_shared/authz";
import type { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { type SuggestedOperation } from "~/shell/_shared/response";
import {
  type SuggestedOperationCaller,
  checkpointSuggestedOperations,
  makeFreeSuggestedOperationCaller,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { categorizeCapture } from "~/shell/categories/categorizer";
import { toApiFailure as categoryToApiFailure } from "~/shell/categories/errors";
import { findCategory } from "~/shell/categories/repo";
import { findUser } from "~/shell/identity/repo";
import {
  type TransactionApiFailure,
  mapTransactionFailure,
  mapTransactionValidationFailure,
} from "./errors";
import {
  findTransaction,
  insertManualSourceAttestation,
  insertTransaction,
  listSourceAttestations,
  listTransactions,
  softDeleteTransaction,
  updateTransaction,
} from "./repo";

const missingTransaction = (transactionId: TransactionId) => (): TransactionNotFound =>
  new TransactionNotFound({ transactionId });
const missingCategory = (categoryId: CategoryId) => (): CategoryNotFound =>
  new CategoryNotFound({ categoryId });

const resolveTransactionCaller: Effect.Effect<
  { userId: UserId; caller: SuggestedOperationCaller },
  never,
  ResolvedCaller
> = Effect.map(ResolvedCaller, ({ scopes, subjectUserId }) => ({
  userId: subjectUserId,
  caller: makeFreeSuggestedOperationCaller(scopes),
}));

const captureCategory = (
  userId: Parameters<typeof categorizeCapture>[0]["userId"],
  input: CreateTransactionInput,
  caller: SuggestedOperationCaller
): Effect.Effect<CategoryId, NotFound | ValidationFailed, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const callerCategory = yield* Option.match(input.categoryId, {
      onNone: () => Effect.succeed(Option.none<CategoryId>()),
      onSome: (categoryId) =>
        findCategory(categoryId).pipe(
          Effect.flatMap(Effect.fromOption(missingCategory(categoryId))),
          Effect.as(Option.some(categoryId)),
          Effect.mapError((failure) => categoryToApiFailure({ failure, caller }))
        ),
    });
    return yield* categorizeCapture({ userId, counterparty: input.counterparty, callerCategory });
  });

const requireKnownCategory = (
  categoryId: CategoryId,
  caller: SuggestedOperationCaller
): Effect.Effect<Category, NotFound | ValidationFailed, SqlClient.SqlClient> =>
  findCategory(categoryId).pipe(
    Effect.flatMap(Effect.fromOption(missingCategory(categoryId))),
    Effect.mapError((failure) => categoryToApiFailure({ failure, caller }))
  );

const persistManualCapture = (
  userId: UserId,
  input: UpdateTransactionInput,
  context: CapturedInterpretationContext
): Effect.Effect<Transaction, never, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const inserted = yield* insertTransaction(userId, input);
        yield* insertManualSourceAttestation(userId, inserted.id, context);
        return inserted;
      })
    )
  ).pipe(Effect.catchTag("SqlError", Effect.die));

const captureTransaction = ({
  userId,
  payload,
  caller,
}: Readonly<{
  userId: UserId;
  payload: CreateTransactionInput;
  caller: SuggestedOperationCaller;
}>): Effect.Effect<Transaction, TransactionApiFailure, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* checkAlreadyOccurred({ occurredAt: payload.occurredAt, now }).pipe(
      mapTransactionFailure({ caller })
    );

    const categoryId = yield* captureCategory(userId, payload, caller);
    const input = UpdateTransactionInput.make({ ...payload, categoryId });
    const user = yield* findUser(userId).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
    return yield* persistManualCapture(userId, input, {
      serviceMarket: user.serviceMarket,
      locale: user.locale,
      timeZone: user.timeZone,
    }).pipe(mapTransactionFailure({ caller }));
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

const correctTransaction = ({
  userId,
  transactionId,
  payload,
  caller,
}: Readonly<{
  userId: UserId;
  transactionId: TransactionId;
  payload: UpdateTransactionInput;
  caller: SuggestedOperationCaller;
}>): Effect.Effect<Transaction, TransactionApiFailure, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* checkAlreadyOccurred({ occurredAt: payload.occurredAt, now }).pipe(
      mapTransactionFailure({ caller })
    );
    yield* requireKnownCategory(payload.categoryId, caller);
    return yield* updateTransaction(userId, transactionId, payload).pipe(
      Effect.flatMap(Effect.fromOption(missingTransaction(transactionId))),
      mapTransactionFailure({ caller })
    );
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
        const transaction = yield* captureTransaction({ userId, payload, caller });
        return { data: transaction, next: capturedTransactionOperations(caller) };
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
        const transaction = yield* correctTransaction({
          userId,
          transactionId: params.id,
          payload,
          caller,
        });
        return { data: transaction, next: [] };
      })
    )
    .handle("deleteTransaction", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveTransactionCaller;
        const id = yield* softDeleteTransaction(userId, params.id).pipe(
          Effect.flatMap(Effect.fromOption(missingTransaction(params.id))),
          mapTransactionFailure({ caller })
        );
        return { data: id, next: [] };
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
