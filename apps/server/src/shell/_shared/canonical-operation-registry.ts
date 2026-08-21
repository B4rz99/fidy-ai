import { Effect, Option } from "effect";
import type { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { ResolvedCaller as ResolvedCallerTag } from "./authz";
import type {
  CanonicalImplementationCaller,
  CanonicalImplementationRequirements,
  CanonicalOperationImplementations,
} from "./canonical-implementation";
import { canonicalMutationImplementations } from "./canonical-mutation-registry";
import { makeFreeSuggestedOperationCaller } from "./suggested-operations";
import { getCurrentUser } from "~/shell/identity/queries";
import { listCategories, listKeywordRules } from "~/shell/categories/queries";
import { getBudget, getBudgetStatus, listBudgets } from "~/shell/budgets/queries";
import { listDashboardCatalog } from "~/shell/dashboard/queries";
import {
  getTransaction,
  listSourceAttestations,
  listTransactions,
} from "~/shell/transactions/queries";
import { getStatementSubmission, listNeedsReviewItems } from "~/shell/ingestion/queries";
import { listPendingInsights } from "~/shell/insights/queries";
import { recall } from "~/shell/memory/queries";
import { getUpgradeUrl } from "~/shell/subscription/queries";
import { executeAtomicBatch } from "~/shell/operations/handlers";

export type { CanonicalImplementationCaller } from "./canonical-implementation";

/**
 * One canonical implementation with its input type erased, so the executor can dispatch on a
 * runtime operation id. Declaring `execute` as a method and indexing it out is what makes the
 * erasure a checked assignment rather than a guard claiming more than it verifies: parameter
 * bivariance accepts the widening, while the output, failure, and requirement channels stay
 * checked. This is the one place the input type is given up, after the map above has fixed it.
 */
type ErasedCanonicalImplementation = {
  execute(
    input: unknown,
    caller: CanonicalImplementationCaller
  ): Effect.Effect<unknown, object, CanonicalImplementationRequirements>;
}["execute"];

const suggestedCaller = ({
  resolved,
}: CanonicalImplementationCaller): ReturnType<typeof makeFreeSuggestedOperationCaller> =>
  makeFreeSuggestedOperationCaller(resolved.capabilities);

/**
 * Every canonical implementation behind both HTTP handlers and hosted Turn authority. Catalog
 * assertions make additions fail closed; this object is not an authorization or eligibility list.
 */
export const canonicalOperationImplementations: CanonicalOperationImplementations = {
  ...canonicalMutationImplementations,

  "identity.getCurrentUser": (_input, { resolved }) =>
    getCurrentUser({ userId: resolved.subjectUserId }),

  "categories.listCategories": (_input, _caller) => listCategories(),
  "categories.listKeywordRules": (_input, { resolved }) =>
    listKeywordRules({ userId: resolved.subjectUserId }),

  "budgets.listBudgets": (_input, { resolved }) => listBudgets({ userId: resolved.subjectUserId }),
  "budgets.getBudget": (input, caller) =>
    getBudget({
      userId: caller.resolved.subjectUserId,
      budgetId: input.params.id,
      caller: suggestedCaller(caller),
    }),
  "budgets.getBudgetStatus": (input, { resolved }) =>
    getBudgetStatus({
      userId: resolved.subjectUserId,
      categoryId: Option.fromUndefinedOr(input.query.categoryId),
      currency: Option.fromUndefinedOr(input.query.currency),
      timeZone: input.query.timeZone,
    }),

  "dashboard.listDashboardCatalog": (_input, _caller) => listDashboardCatalog,

  "transactions.listTransactions": (input, caller) =>
    listTransactions({
      userId: caller.resolved.subjectUserId,
      filters: input.query,
      caller: suggestedCaller(caller),
    }),
  "transactions.getTransaction": (input, caller) =>
    getTransaction({
      userId: caller.resolved.subjectUserId,
      transactionId: input.params.id,
      caller: suggestedCaller(caller),
    }),
  "transactions.listSourceAttestations": (input, caller) =>
    listSourceAttestations({
      userId: caller.resolved.subjectUserId,
      transactionId: input.params.id,
      caller: suggestedCaller(caller),
    }),

  "ingestion.getStatementSubmission": (input, { resolved }) =>
    getStatementSubmission({
      userId: resolved.subjectUserId,
      submissionId: input.params.id,
    }),
  "ingestion.listNeedsReviewItems": (input, { resolved }) =>
    listNeedsReviewItems({ userId: resolved.subjectUserId, page: input.query }),

  "insights.listPendingInsights": (_input, caller) =>
    listPendingInsights({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
    }),

  "memory.recall": (_input, { resolved }) => recall({ userId: resolved.subjectUserId }),

  "subscription.getUpgradeUrl": (_input, _caller) => getUpgradeUrl(),

  "operations.executeAtomicBatch": (input, { resolved }) =>
    executeAtomicBatch(input.payload).pipe(Effect.provideService(ResolvedCallerTag, resolved)),
} as const;

const implementationsById: ReadonlyMap<string, ErasedCanonicalImplementation> = new Map(
  Object.entries(canonicalOperationImplementations)
);

/** Selects one correlated implementation; only the executor should use this erased dispatch seam. */
export const findCanonicalOperationImplementation = (
  operation: CanonicalOperationId
): Option.Option<ErasedCanonicalImplementation> =>
  Option.fromNullishOr(implementationsById.get(operation));

/** Fails the toolkit derivation test when the reflected declaration and implementation sets drift. */
export const assertCanonicalOperationRegistry = (operationIds: ReadonlyArray<string>): void => {
  const reflected = [...operationIds].sort();
  const registered = Object.keys(canonicalOperationImplementations).sort();
  if (JSON.stringify(reflected) !== JSON.stringify(registered)) {
    throw new Error(
      `Canonical operation registry drift: reflected=${reflected.join(",")} registered=${registered.join(",")}`
    );
  }
};
