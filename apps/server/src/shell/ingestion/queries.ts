import { Effect } from "effect";
import type { UserId } from "~/core/identity/reference";
import type { StatementSubmissionId } from "~/core/ingestion/reference";
import { NotFound } from "~/shell/_shared/errors";
import {
  type NeedsReviewPageRequest,
  applyNeedsReviewPageDefaults,
  findSubmission,
  selectNeedsReviewItems,
} from "./repo";

const submissionNotFound = (id: StatementSubmissionId): NotFound =>
  NotFound.make({
    error: {
      code: "not_found",
      message: `No visible statement submission exists for id ${id}. Check the id and retry.`,
    },
    next: [],
  });

export type GetStatementSubmissionInput = Readonly<{
  userId: UserId;
  submissionId: StatementSubmissionId;
}>;

/** Reads one caller-owned Statement Submission. Foreign and absent ids answer identically. */
export const getStatementSubmission = Effect.fn("getStatementSubmission")(function* ({
  userId,
  submissionId,
}: GetStatementSubmissionInput) {
  const data = yield* findSubmission(userId, submissionId).pipe(
    Effect.flatMap(Effect.fromOption(() => submissionNotFound(submissionId)))
  );
  return { data, next: [] };
});

export type ListNeedsReviewItemsInput = Readonly<{
  userId: UserId;
  page: NeedsReviewPageRequest;
}>;

/**
 * Reads one page of the caller's items still awaiting review. Absent bounds resolve to the default
 * page here rather than at either adapter, so both answer an unbounded request identically.
 */
export const listNeedsReviewItems = Effect.fn("listNeedsReviewItems")(function* ({
  userId,
  page,
}: ListNeedsReviewItemsInput) {
  return {
    data: yield* selectNeedsReviewItems(userId, applyNeedsReviewPageDefaults(page)),
    next: [],
  };
});
