import { PATActivityParams } from "../../../src/shell/tokens/contract";
import { RecurringDigestReportParams } from "../../../src/core/insights/contract";
import { operationCatalog } from "../../../src/shell/api";
import { type Cause, Effect, Option, Schema } from "effect";
import {
  type QueryCaller,
  isOAuthCaller,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { executeProtectedCategories, listOwnKeywordRules } from "../../categories/operations";
import { executeProtectedQuotaQuery } from "../../quotas/operations";
import { executeProtectedSubscriptionQuery } from "../../subscription/operations";
import { browseBudgets } from "../../budgets/operations";
import { browseTransactions } from "../../transactions/operations";
import { browseDashboard } from "../../dashboard/operations";
import { recallMemories } from "../../memory/operations";
import { listRecurringSeries } from "../../recurring/operations";
import {
  listPendingInsights,
  readCanonicalRecurringDigestReport,
  readCanonicalReminderSchedule,
  readHeldRecurringDigestReport,
  readHeldReminderSchedule,
} from "../../insights/operations";
import { getHeldPATActivity, getPATActivity, listPATs } from "../../tokens/operations";
import type { StatementDecisionWork } from "../../ingestion/contract";
import {
  forwardingAddressResponse,
  listNeedsReviewItems,
  readHeldStatementQuery,
  readStatementSubmission,
} from "../../ingestion/operations";

export type QueryWork = Readonly<{
  db: D1Database;
  subject: QueryCaller;
  request: Request;
  bucket: Option.Option<R2Bucket>;
  browserOrigin: Option.Option<string>;
}>;
export type QueryOwner = (work: QueryWork) => Effect.Effect<Response, Cause.UnknownError>;

const budgetOwner =
  (
    operation: "budgets.listBudgets" | "budgets.getBudget" | "budgets.getBudgetStatus"
  ): QueryOwner =>
  ({ db, subject, request }) =>
    browseBudgets({ db, subject, request, operation });
const historyOwner =
  (
    operation:
      | "transactions.listTransactions"
      | "transactions.searchTransactions"
      | "transactions.getTransaction"
  ): QueryOwner =>
  ({ db, subject, request }) =>
    browseTransactions({
      db,
      selection:
        operation === "transactions.searchTransactions"
          ? { request, subject, search: true, id: Option.none() }
          : {
              request,
              subject,
              search: false,
              id:
                operation === "transactions.getTransaction"
                  ? Option.some(new URL(request.url).pathname.split("/").at(-1) ?? "")
                  : Option.none(),
            },
    });

// This installed-owner registry selects only canonical catalog entries; it declares no private tool.
const queryOwners = new Map<string, QueryOwner>([
  [
    "quota.getQuota",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      executeProtectedQuotaQuery({ db, subject }),
  ],
  [
    "subscription.getUpgradeUrl",
    ({ db, subject, browserOrigin }): Effect.Effect<Response, Cause.UnknownError> =>
      executeProtectedSubscriptionQuery({
        db,
        subject,
        operation: "subscription.getUpgradeUrl",
        browserOrigin,
      }),
  ],
  [
    "pats.getPATActivity",
    ({ db, subject, request }): Effect.Effect<Response> =>
      isOAuthCaller(subject)
        ? Effect.succeed(transactionUnavailable())
        : getPATActivity({
            db,
            subject,
            shortId: new URL(request.url).pathname.split("/")[2] ?? "",
          }),
  ],
  [
    "pats.listPATs",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      isOAuthCaller(subject) ? Effect.succeed(transactionUnavailable()) : listPATs({ db, subject }),
  ],
  [
    "categories.listCategories",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      executeProtectedCategories({ db, subject }),
  ],
  [
    "categories.listKeywordRules",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      listOwnKeywordRules({ db, subject }),
  ],
  [
    "subscription.listSubscriptionOffers",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      executeProtectedSubscriptionQuery({
        db,
        subject,
        operation: "subscription.listSubscriptionOffers",
      }),
  ],
  [
    "subscription.getSubscriptionStatus",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      executeProtectedSubscriptionQuery({
        db,
        subject,
        operation: "subscription.getSubscriptionStatus",
      }),
  ],
  ["budgets.listBudgets", budgetOwner("budgets.listBudgets")],
  ["budgets.getBudget", budgetOwner("budgets.getBudget")],
  ["budgets.getBudgetStatus", budgetOwner("budgets.getBudgetStatus")],
  ["transactions.listTransactions", historyOwner("transactions.listTransactions")],
  ["transactions.searchTransactions", historyOwner("transactions.searchTransactions")],
  ["transactions.getTransaction", historyOwner("transactions.getTransaction")],
  ...(["dashboard.getDashboard", "dashboard.getDashboardView"] as const).map(
    (operation): readonly [string, QueryOwner] =>
      [
        operation,
        ({ db, subject, request }: QueryWork) =>
          browseDashboard({ db, subject, request, operation }),
      ] as const
  ),
  [
    "dashboard.listDashboardCatalog",
    ({ db, subject, request }): Effect.Effect<Response, Cause.UnknownError> =>
      browseDashboard({ db, subject, request, operation: "dashboard.listDashboardCatalog" }),
  ],
  [
    "memory.recall",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      recallMemories({ db, subject }),
  ],
  [
    "recurring.listRecurringSeries",
    ({ db, subject, request }): Effect.Effect<Response, Cause.UnknownError> =>
      listRecurringSeries({ db, subject, request }),
  ],
  [
    "insights.getRecurringDigestReport",
    ({ db, subject, request }): Effect.Effect<Response> =>
      readCanonicalRecurringDigestReport({
        db,
        subject,
        current: transactionNow(),
        id: new URL(request.url).pathname.split("/").at(-1) ?? "",
      }),
  ],
  [
    "insights.getReminderSchedule",
    ({ db, subject }): Effect.Effect<Response> =>
      readCanonicalReminderSchedule({ db, subject, current: transactionNow() }),
  ],
  [
    "insights.listPendingInsights",
    ({ db, subject, request }): Effect.Effect<Response, Cause.UnknownError> =>
      listPendingInsights({ db, subject, request }),
  ],
  [
    "ingestion.getEmailForwarding",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      forwardingAddressResponse({
        db,
        subject,
        operation: "ingestion.getEmailForwarding",
      }),
  ],
  [
    "ingestion.getStatementSubmission",
    ({ db, subject, request, bucket }): Effect.Effect<Response, Cause.UnknownError> =>
      readStatementSubmission({
        request,
        subject,
        environment: {
          DB: db,
          ...(Option.isSome(bucket) ? { STATEMENT_STAGING_BUCKET: bucket.value } : {}),
        },
      }),
  ],
  [
    "ingestion.listNeedsReviewItems",
    ({ db, subject, request }): Effect.Effect<Response, Cause.UnknownError> =>
      listNeedsReviewItems({
        database: db,
        environment: { DB: db },
        subject,
        url: new URL(request.url),
      }),
  ],
]);

/** Look up an installed query adapter only inside canonical dispatch. */
export const canonicalQueryOwner = (id: string): Option.Option<QueryOwner> =>
  Option.fromUndefinedOr(queryOwners.get(id));

/** The same installed statement queries also accept Agent's held conversation authority. */
export const canonicalHostedStatementQueryOwner = (
  id: string
): Option.Option<(work: StatementDecisionWork) => Effect.Effect<Response>> => {
  if (Option.isNone(canonicalQueryOwner(id))) return Option.none();
  if (id === "pats.getPATActivity") {
    return Option.some((work) => {
      const selected = Schema.decodeUnknownOption(Schema.Struct({ params: PATActivityParams }))(
        work.input
      );
      return Option.isSome(selected) && work.authority.table === "hosted_turns"
        ? getHeldPATActivity({
            db: work.db,
            userId: work.userId,
            authority: work.authority,
            current: work.current,
            shortId: selected.value.params.shortId,
          })
        : Effect.succeed(transactionUnavailable());
    });
  }
  if (id === "insights.getRecurringDigestReport") {
    return Option.some((work) => {
      const input = Schema.decodeUnknownOption(
        Schema.Struct({ params: RecurringDigestReportParams })
      )(work.input);
      return Option.isSome(input)
        ? readHeldRecurringDigestReport({ ...work, id: input.value.params.id })
        : Effect.succeed(transactionUnavailable());
    });
  }
  if (id === "insights.getReminderSchedule") {
    return Option.some((work) => readHeldReminderSchedule(work));
  }
  if (id === "ingestion.listNeedsReviewItems" || id === "ingestion.getStatementSubmission") {
    return Option.some((work) => readHeldStatementQuery({ operation: id, work }));
  }
  return Option.none();
};

/** An installed query adapter may implement only an existing canonical query declaration. */
const assertCanonicalQueryOwners = (): void => {
  for (const id of queryOwners.keys()) {
    const declaration = operationCatalog.operations.find((operation) => operation.id === id);
    if (declaration?.policy.kind !== "query") {
      throw new Error(`Canonical query adapter is not a declared query: ${id}`);
    }
  }
};

assertCanonicalQueryOwners();
