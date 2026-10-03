import { operationCatalog } from "../../../src/shell/api";
import { type Cause, Effect, Option } from "effect";
import type { TransactionSubject } from "../../canonical-work/operations";
import { executeProtectedCategories, listOwnKeywordRules } from "../../categories/operations";
import { executeProtectedSubscriptionQuery } from "../../subscription/operations";
import { browseBudgets, evaluateBudgetAlerts } from "../../budgets/operations";
import { browseTransactions } from "../../transactions/operations";
import { browseDashboard } from "../../dashboard/operations";
import { recallMemories } from "../../memory/operations";
import { listPendingInsights } from "../../insights/operations";
import {
  forwardingAddressResponse,
  listNeedsReviewItems,
  readStatementSubmission,
} from "../../ingestion/operations";

export type QueryWork = Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  request: Request;
  bucket: Option.Option<R2Bucket>;
}>;
export type QueryOwner = (work: QueryWork) => Effect.Effect<Response, Cause.UnknownError>;

const budgetOwner =
  (
    operation: "budgets.listBudgets" | "budgets.getBudget" | "budgets.getBudgetStatus"
  ): QueryOwner =>
  ({ db, subject, request }) =>
    Effect.tryPromise(() =>
      browseBudgets({
        db,
        subject,
        request,
        operation,
        reconcile: () => evaluateBudgetAlerts({ db, userId: subject.userId }),
      })
    );
const historyOwner =
  (
    operation:
      | "transactions.listTransactions"
      | "transactions.searchTransactions"
      | "transactions.getTransaction"
  ): QueryOwner =>
  ({ db, subject, request }) =>
    Effect.tryPromise(() =>
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
      })
    );

// This installed-owner registry selects only canonical catalog entries; it declares no private tool.
const queryOwners = new Map<string, QueryOwner>([
  [
    "categories.listCategories",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      Effect.tryPromise(() => executeProtectedCategories({ db, subject })),
  ],
  [
    "categories.listKeywordRules",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      Effect.tryPromise(() => listOwnKeywordRules({ db, subject })),
  ],
  [
    "subscription.listSubscriptionOffers",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      Effect.tryPromise(() =>
        executeProtectedSubscriptionQuery({
          db,
          subject,
          operation: "subscription.listSubscriptionOffers",
        })
      ),
  ],
  [
    "subscription.getSubscriptionStatus",
    ({ db, subject }): Effect.Effect<Response, Cause.UnknownError> =>
      Effect.tryPromise(() =>
        executeProtectedSubscriptionQuery({
          db,
          subject,
          operation: "subscription.getSubscriptionStatus",
        })
      ),
  ],
  ["budgets.listBudgets", budgetOwner("budgets.listBudgets")],
  ["budgets.getBudget", budgetOwner("budgets.getBudget")],
  ["budgets.getBudgetStatus", budgetOwner("budgets.getBudgetStatus")],
  ["transactions.listTransactions", historyOwner("transactions.listTransactions")],
  ["transactions.searchTransactions", historyOwner("transactions.searchTransactions")],
  ["transactions.getTransaction", historyOwner("transactions.getTransaction")],
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
      Effect.tryPromise(() =>
        readStatementSubmission({
          request,
          subject,
          environment: {
            DB: db,
            ...(Option.isSome(bucket) ? { STATEMENT_STAGING_BUCKET: bucket.value } : {}),
          },
        })
      ),
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
