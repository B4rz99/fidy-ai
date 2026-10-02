import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { CatalogOperation } from "../../src/shell/_shared/operation-catalog";
import type { TransactionSubject } from "../canonical-work/operations";
import { executeProtectedCategories, listOwnKeywordRules } from "../categories/operations";
import { executeProtectedSubscriptionQuery } from "../subscription/operations";
import { browseBudgets } from "../budgets/budget-queries";
import { reconcileBudgetLatches } from "../budgets/budget-latches";
import { browseTransactions } from "../transactions/operations";
import { browseDashboard } from "../dashboard/dashboard";
import { recallMemories } from "../memory/memory";
import { listPendingInsights } from "../insights/insight-store";
import { forwardingAddressResponse } from "../ingestion/forwarding-address";
import { readStatementSubmission } from "../ingestion/statement-ingestion";
import { listNeedsReviewItems } from "../ingestion/statement-review";

const requestParts = Schema.Struct({
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]))
  ),
});

/** Build only a catalog-owned route from validated canonical arguments, never an arbitrary destination. */
const requestFor = (operation: CatalogOperation, input: Schema.Json): Option.Option<Request> => {
  const parts = Schema.decodeUnknownOption(requestParts)(input);
  if (Option.isNone(parts)) return Option.none();
  let route = operation.route;
  for (const [key, value] of Object.entries(parts.value.params ?? {})) {
    route = route.replace(`:${key}`, encodeURIComponent(value));
  }
  if (route.includes(":")) return Option.none();
  const url = new URL(route, "https://canonical.internal");
  for (const [key, value] of Object.entries(parts.value.query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return Option.some(new Request(url, { method: operation.method }));
};

type QueryWork = Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  request: Request;
  bucket: Option.Option<R2Bucket>;
}>;
type QueryOwner = (work: QueryWork) => Effect.Effect<Response, Cause.UnknownError>;

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
        reconcile: () => reconcileBudgetLatches({ db, userId: subject.userId }),
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

/** Whether the catalog query has a real installed owner for this runtime. */
export const isInstalledHostedQuery = (id: string): boolean => queryOwners.has(id);

/** Call a canonical owner with a live User subject and catalog-owned route; its domain/Audit
 * effects are the owner's effects. Returns None for an uninstalled owner, invalid route arguments,
 * or an owner defect. A canonical refusal remains Some(response), so the caller can retain it.
 */
export const executeHostedQuery = ({
  db,
  subject,
  operation,
  input,
  bucket,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  operation: CatalogOperation;
  input: Schema.Json;
  bucket: Option.Option<R2Bucket>;
}>): Effect.Effect<Option.Option<Response>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const owner = queryOwners.get(operation.id);
    const request = requestFor(operation, input);
    if (owner === undefined || Option.isNone(request)) return Option.none();
    const result = yield* Effect.exit(
      Effect.suspend(() =>
        owner({
          db,
          subject,
          request: request.value,
          bucket,
        })
      )
    );
    // The caller's deadline must not be swallowed as a canonical owner defect.
    if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) {
      return yield* Effect.failCause(result.cause);
    }
    return Exit.isSuccess(result) ? Option.some(result.value) : Option.none();
  });
