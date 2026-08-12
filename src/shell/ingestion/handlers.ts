import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { UserId } from "~/core/identity/reference";
import type { StatementSubmissionId } from "~/core/ingestion/reference";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { NotFound } from "~/shell/_shared/errors";
import {
  type SuggestedOperationCaller,
  makeFreeSuggestedOperationCaller,
} from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { resolveNeedsReviewItemMutation, submitForExtractionInScope } from "./mutations";
import { findSubmission, listNeedsReviewItems } from "./repo";

const submissionNotFound = (id: StatementSubmissionId): NotFound =>
  NotFound.make({
    error: {
      code: "not_found",
      message: `No visible statement submission exists for id ${id}. Check the id and retry.`,
    },
    next: [],
  });

const requireSubmission = Effect.fn("requireStatementSubmission")(function* (
  userId: UserId,
  id: StatementSubmissionId
) {
  return yield* findSubmission(userId, id).pipe(
    Effect.flatMap(Effect.fromOption(() => submissionNotFound(id)))
  );
});

type IngestionCaller = Readonly<{
  userId: UserId;
  caller: SuggestedOperationCaller;
}>;

const resolveCaller: Effect.Effect<IngestionCaller, never, ResolvedCaller> = Effect.map(
  ResolvedCaller,
  ({ scopes, subjectUserId }) => ({
    userId: subjectUserId,
    caller: makeFreeSuggestedOperationCaller(scopes),
  })
);

/** Provides durable statement admission, status, review visibility, and later resolution. */
export const IngestionLive = HttpApiBuilder.group(FidyApi, "ingestion", (handlers) =>
  handlers
    .handle("submitForExtraction", ({ payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveCaller;
        return yield* submitForExtractionInScope({ userId, caller, payload });
      })
    )
    .handle("getStatementSubmission", ({ params }) =>
      Effect.gen(function* () {
        const { userId } = yield* resolveCaller;
        const submission = yield* requireSubmission(userId, params.id);
        return { data: submission, next: [] };
      })
    )
    .handle("listNeedsReviewItems", ({ query }) =>
      Effect.gen(function* () {
        const { userId } = yield* resolveCaller;
        return {
          data: yield* listNeedsReviewItems(userId, {
            offset: Option.getOrUndefined(query.offset) ?? 0,
            limit: Option.getOrUndefined(query.limit) ?? 100,
          }),
          next: [],
        };
      })
    )
    .handle("resolveNeedsReviewItem", ({ params, payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveCaller;
        return yield* resolveNeedsReviewItemMutation({
          userId,
          caller,
          id: params.id,
          extraction: payload.extraction,
        });
      })
    )
);
