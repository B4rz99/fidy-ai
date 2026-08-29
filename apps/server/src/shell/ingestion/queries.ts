import { DateTime, Effect } from "effect";
import { decideEffectiveAccess } from "~/core/identity/rules";
import { freeForwardedEmailDeferredCap } from "~/core/ingestion/email-policy";
import { emailAllowancePeriod, forwardedEmailAllowanceRemaining } from "~/core/ingestion/rules";
import type { UserId } from "~/core/identity/reference";
import type { StatementSubmissionId } from "~/core/ingestion/reference";
import { NotFound } from "~/shell/_shared/errors";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { findUserInScope } from "~/shell/identity/repo";
import {
  type NeedsReviewPageRequest,
  applyNeedsReviewPageDefaults,
  findSubmission,
  selectNeedsReviewItems,
} from "./repo";
import {
  countDeferredEmailsInScope,
  countForwardedEmailsInPeriodInScope,
  findEmailForwardingAddressInScope,
  selectEmailNeedsReviewItemsInScope,
} from "./email-forwarding-repo";

const submissionNotFound = (id: StatementSubmissionId): NotFound =>
  NotFound.make({
    error: {
      code: "not_found",
      message: `No visible statement submission exists for id ${id}. Check the id and retry.`,
    },
    next: [],
  });

/** Reads the permanent address and current Colombia-month allowance status. */
export const getEmailForwarding = Effect.fn("getEmailForwarding")(function* (userId: UserId) {
  const { ingestDomain } = yield* externalEndpoints.pipe(Effect.orDie);
  const now = yield* DateTime.now;
  const period = emailAllowancePeriod(now);
  return yield* withUserTransaction(
    userId,
    Effect.gen(function* () {
      const user = yield* findUserInScope(userId).pipe(
        Effect.flatMap(Effect.fromOption),
        Effect.orDie
      );
      const access = yield* decideEffectiveAccess(user, now);
      const consumed = yield* countForwardedEmailsInPeriodInScope(userId, period);
      const remaining = forwardedEmailAllowanceRemaining({ access, consumed });
      const deferredEmails = yield* countDeferredEmailsInScope(userId);
      return {
        data: {
          address: yield* findEmailForwardingAddressInScope(userId, ingestDomain),
          remainingThisMonth: remaining,
          deferredEmails,
          deferredCapacityRemaining: Math.max(0, freeForwardedEmailDeferredCap - deferredEmails),
          resetsAt: period.toExclusive,
        },
        next: [],
      };
    })
  );
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
  const bounded = applyNeedsReviewPageDefaults(page);
  const prefixLimit = bounded.offset + bounded.limit;
  const [statement, email] = yield* Effect.all([
    selectNeedsReviewItems(userId, { offset: 0, limit: prefixLimit }),
    withUserTransaction(userId, selectEmailNeedsReviewItemsInScope(userId, prefixLimit)).pipe(
      Effect.orDie
    ),
  ]);
  const data = [...statement, ...email]
    .sort((left, right) => {
      if (left.status === "pending" && right.status !== "pending") return -1;
      if (left.status !== "pending" && right.status === "pending") return 1;
      return DateTime.Order(left.createdAt, right.createdAt);
    })
    .slice(bounded.offset, prefixLimit);
  return { data, next: [] };
});
