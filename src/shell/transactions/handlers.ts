import { DateTime, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { TransactionNotFound } from "~/core/transactions/errors";
import { type TransactionId } from "~/core/transactions/model";
import { checkAlreadyOccurred } from "~/core/transactions/rules";
import { resolveCaller } from "~/shell/_shared/authz";
import { FidyApi, operationId } from "~/shell/api";
import { toApiFailure } from "./errors";
import { findTransaction, insertTransaction, listTransactions } from "./repo";

/**
 * The domain failure for an id that names nothing of the caller's, deferred:
 * `Effect.fromOption` wants a thunk, and builds the failure only on absence.
 */
const missingTransaction = (transactionId: TransactionId) => () =>
  new TransactionNotFound({ transactionId });

/**
 * Load, decide, persist — and, first, whose. Each handler resolves the request
 * to a user once and hands that id to the repo explicitly; there is no ambient
 * caller for a query to forget to filter on.
 *
 * No handler wraps its work in `orDie`. What the repo can fail with is already
 * a defect and has already died there, so what remains in a handler's error
 * channel is exactly what a caller can act on: a failure to resolve them, and
 * the slice's domain failures translated by the one mapper in `./errors`.
 */
export const TransactionsLive = HttpApiBuilder.group(FidyApi, "transactions", (handlers) =>
  handlers
    .handle("createTransaction", ({ payload, request }) =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* resolveCaller(request);

        // The clock is read here and handed to core as a value, because core
        // reads no clock (ARCHITECTURE.md §3). The rule cannot live in the
        // input schema for the same reason: "not in the future" is not a property
        // of the payload alone.
        const now = yield* DateTime.now;
        yield* checkAlreadyOccurred({ occurredAt: payload.occurredAt, now }).pipe(
          Effect.mapError(toApiFailure)
        );

        const transaction = yield* insertTransaction({ userId, input: payload });

        return {
          data: transaction,
          next: [
            {
              tool: operationId("transactions.listTransactions"),
              hint: "List transactions to see the new entry in the history.",
            },
          ],
        };
      })
    )
    .handle("listTransactions", ({ request }) =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* resolveCaller(request);
        const transactions = yield* listTransactions(userId);

        return { data: transactions, next: [] };
      })
    )
    .handle("getTransaction", ({ params, request }) =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* resolveCaller(request);
        const found = yield* findTransaction({ userId, id: params.id });

        // Here is where absence stops being data and becomes a failure: this
        // operation was asked for one specific record, so not having it is an
        // answer the caller must handle. `listTransactions` reads the same
        // absence as an empty history and succeeds.
        const transaction = yield* found.pipe(
          Effect.fromOption(missingTransaction(params.id)),
          Effect.mapError(toApiFailure)
        );

        return { data: transaction, next: [] };
      })
    )
);
