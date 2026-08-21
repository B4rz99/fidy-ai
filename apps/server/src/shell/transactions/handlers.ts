import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { resolveFreeSuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { correctTransaction, createTransaction, deleteTransaction } from "./mutations";
import { getTransaction, listSourceAttestations, listTransactions } from "./queries";

/** Provides caller-owned Transaction capture, history, correction, deletion, and provenance. */
export const TransactionsLive = HttpApiBuilder.group(FidyApi, "transactions", (handlers) =>
  handlers
    .handle("createTransaction", ({ payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* createTransaction({ userId, payload, caller });
      })
    )
    .handle("listTransactions", ({ query: filters }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* listTransactions({ userId, filters, caller });
      })
    )
    .handle("getTransaction", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* getTransaction({ userId, transactionId: params.id, caller });
      })
    )
    .handle("updateTransaction", ({ params, payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
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
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* deleteTransaction({
          userId,
          transactionId: params.id,
          caller,
        });
      })
    )
    .handle("listSourceAttestations", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* listSourceAttestations({ userId, transactionId: params.id, caller });
      })
    )
);
