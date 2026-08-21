import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { resolveFreeSuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { resolveNeedsReviewItemMutation, submitForExtractionInScope } from "./mutations";
import { getStatementSubmission, listNeedsReviewItems } from "./queries";

/** Provides durable statement admission, status, review visibility, and later resolution. */
export const IngestionLive = HttpApiBuilder.group(FidyApi, "ingestion", (handlers) =>
  handlers
    .handle("submitForExtraction", ({ payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* submitForExtractionInScope({ userId, caller, payload });
      })
    )
    .handle("getStatementSubmission", ({ params }) =>
      Effect.gen(function* () {
        const { userId } = yield* resolveFreeSuggestedOperationCaller;
        return yield* getStatementSubmission({ userId, submissionId: params.id });
      })
    )
    .handle("listNeedsReviewItems", ({ query }) =>
      Effect.gen(function* () {
        const { userId } = yield* resolveFreeSuggestedOperationCaller;
        return yield* listNeedsReviewItems({ userId, page: query });
      })
    )
    .handle("resolveNeedsReviewItem", ({ params, payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* resolveNeedsReviewItemMutation({
          userId,
          caller,
          id: params.id,
          extraction: payload.extraction,
        });
      })
    )
);
