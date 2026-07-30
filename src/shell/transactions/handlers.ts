import { DateTime, Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { SqlClient } from "effect/unstable/sql";
import { type CategoryId } from "~/core/_shared/category";
import { type UserId } from "~/core/_shared/user";
import { CategoryNotFound } from "~/core/categories/errors";
import { TransactionNotFound } from "~/core/transactions/errors";
import {
  type CapturedInterpretationContext,
  type CreateTransactionInput,
  type TransactionId,
  TransactionQuery,
  UpdateTransactionInput,
} from "~/core/transactions/model";
import { checkAlreadyOccurred, checkTransactionPeriod } from "~/core/transactions/rules";
import { resolveCaller } from "~/shell/_shared/authz";
import {
  checkpointSuggestedOperations,
  type SuggestedOperationCaller,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { categorizeCapture } from "~/shell/categories/categorizer";
import { toApiFailure as categoryToApiFailure } from "~/shell/categories/errors";
import { findCategory } from "~/shell/categories/repo";
import { findUser } from "~/shell/identity/repo";
import { mapTransactionFailure } from "./errors";
import {
  findTransaction,
  insertManualSourceAttestation,
  insertTransaction,
  listSourceAttestations,
  listTransactions,
  softDeleteTransaction,
  updateTransaction,
} from "./repo";

const missingTransaction = (transactionId: TransactionId) => () =>
  new TransactionNotFound({ transactionId });
const missingCategory = (categoryId: CategoryId) => () => new CategoryNotFound({ categoryId });

const suggestedOperationCaller = (
  scopes: SuggestedOperationCaller["scopes"]
): SuggestedOperationCaller => ({ scopes, tier: "free" });

const captureCategory = (
  userId: Parameters<typeof categorizeCapture>[0]["userId"],
  input: CreateTransactionInput
) =>
  Effect.gen(function* () {
    const callerCategory = yield* Option.match(input.categoryId, {
      onNone: () => Effect.succeed(Option.none<CategoryId>()),
      onSome: (categoryId) =>
        findCategory(categoryId).pipe(
          Effect.flatMap(Effect.fromOption(missingCategory(categoryId))),
          Effect.as(Option.some(categoryId)),
          Effect.mapError(categoryToApiFailure)
        ),
    });
    return yield* categorizeCapture({ userId, merchant: input.merchant, callerCategory });
  });

const persistManualCapture = (
  userId: UserId,
  input: UpdateTransactionInput,
  context: CapturedInterpretationContext
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const inserted = yield* insertTransaction(userId, input);
        yield* insertManualSourceAttestation(userId, inserted.id, context);
        return inserted;
      })
    )
  ).pipe(Effect.catchTag("SqlError", Effect.die));

/** Provides caller-owned Transaction capture, history, correction, deletion, and provenance. */
export const TransactionsLive = HttpApiBuilder.group(FidyApi, "transactions", (handlers) =>
  handlers
    .handle("createTransaction", ({ payload, request }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* resolveCaller(request);
        const caller = suggestedOperationCaller(scopes);
        const now = yield* DateTime.now;
        yield* checkAlreadyOccurred({ occurredAt: payload.occurredAt, now }).pipe(
          mapTransactionFailure({ caller })
        );

        const categoryId = yield* captureCategory(userId, payload);
        const input = UpdateTransactionInput.make({ ...payload, categoryId });
        const user = yield* findUser(userId).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
        const transaction = yield* persistManualCapture(userId, input, {
          serviceMarket: user.serviceMarket,
          locale: user.locale,
          timeZone: user.timeZone,
        }).pipe(mapTransactionFailure({ caller }));

        return {
          data: transaction,
          next: checkpointSuggestedOperations({
            candidates: [
              suggestOperation({
                tool: "transactions.listTransactions",
                hint: "List transactions to see the new entry in the history.",
              }),
            ],
            caller,
          }),
        };
      })
    )
    .handle("listTransactions", ({ query: parameters, request }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* resolveCaller(request);
        const caller = suggestedOperationCaller(scopes);
        const query = TransactionQuery.make({
          from: Option.fromUndefinedOr(parameters.from),
          to: Option.fromUndefinedOr(parameters.to),
          categoryId: Option.fromUndefinedOr(parameters.categoryId),
          merchant: Option.fromUndefinedOr(parameters.merchant),
          direction: Option.fromUndefinedOr(parameters.direction),
          currency: Option.fromUndefinedOr(parameters.currency),
        });
        yield* checkTransactionPeriod({ from: query.from, to: query.to }).pipe(
          mapTransactionFailure({ caller })
        );
        return { data: yield* listTransactions(userId, query), next: [] };
      })
    )
    .handle("getTransaction", ({ params, request }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* resolveCaller(request);
        const caller = suggestedOperationCaller(scopes);
        const transaction = yield* findTransaction(userId, params.id).pipe(
          Effect.flatMap(Effect.fromOption(missingTransaction(params.id))),
          mapTransactionFailure({ caller })
        );
        return { data: transaction, next: [] };
      })
    )
    .handle("updateTransaction", ({ params, payload, request }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* resolveCaller(request);
        const caller = suggestedOperationCaller(scopes);
        const now = yield* DateTime.now;
        yield* checkAlreadyOccurred({ occurredAt: payload.occurredAt, now }).pipe(
          mapTransactionFailure({ caller })
        );
        yield* findCategory(payload.categoryId).pipe(
          Effect.flatMap(Effect.fromOption(missingCategory(payload.categoryId))),
          Effect.mapError(categoryToApiFailure)
        );
        const transaction = yield* updateTransaction(userId, params.id, payload).pipe(
          Effect.flatMap(Effect.fromOption(missingTransaction(params.id))),
          mapTransactionFailure({ caller })
        );
        return { data: transaction, next: [] };
      })
    )
    .handle("deleteTransaction", ({ params, request }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* resolveCaller(request);
        const caller = suggestedOperationCaller(scopes);
        const id = yield* softDeleteTransaction(userId, params.id).pipe(
          Effect.flatMap(Effect.fromOption(missingTransaction(params.id))),
          mapTransactionFailure({ caller })
        );
        return { data: id, next: [] };
      })
    )
    .handle("listSourceAttestations", ({ params, request }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* resolveCaller(request);
        const caller = suggestedOperationCaller(scopes);
        const attestations = yield* listSourceAttestations(userId, params.id);
        if (attestations.length === 0) {
          return yield* Effect.fail(missingTransaction(params.id)()).pipe(
            mapTransactionFailure({ caller })
          );
        }
        return { data: attestations, next: [] };
      })
    )
);
