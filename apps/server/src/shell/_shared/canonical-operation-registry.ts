import { Effect, Option } from "effect";
import type { OperationId } from "~/shell/api";
import type {
  CanonicalImplementationCaller,
  CanonicalImplementationRequirements,
  CanonicalOperationImplementations,
} from "./canonical-implementation";
import type { CanonicalInput } from "./canonical-input";
import type { CanonicalSuccess } from "./canonical-success";
import { listCategoriesResponse } from "~/shell/categories/list-categories";
import { getCurrentUser } from "~/shell/identity/current-user";
import { listPATsResponse } from "~/shell/tokens/list-pats";
import { canonicalMutationImplementations } from "./canonical-mutation-registry";

/**
 * The Cloudflare Worker owns canonical execution. This package retains the reflected operation
 * registry and deliberately exposes no database, process queue, or local-runtime fallback.
 */
const unavailableOperation = <Id extends OperationId>(
  _input: CanonicalInput<Id>,
  _caller: CanonicalImplementationCaller
): Effect.Effect<CanonicalSuccess<Id>, never> =>
  Effect.die("Cloudflare canonical operation boundary is not configured");

/** Every canonical operation is present; operations without a Cloudflare adapter fail closed. */
export const canonicalOperationImplementations = {
  ...canonicalMutationImplementations,
  "identity.getCurrentUser": (_input, caller) => getCurrentUser(caller.resolved.subjectUserId),
  "categories.listCategories": () => listCategoriesResponse,
  "categories.listKeywordRules": unavailableOperation,
  "budgets.listBudgets": unavailableOperation,
  "budgets.getBudget": unavailableOperation,
  "budgets.getBudgetStatus": unavailableOperation,
  "dashboard.listDashboardCatalog": unavailableOperation,
  "transactions.listTransactions": unavailableOperation,
  "transactions.searchTransactions": unavailableOperation,
  "transactions.getTransaction": unavailableOperation,
  "transactions.listSourceAttestations": unavailableOperation,
  "ingestion.getEmailForwarding": unavailableOperation,
  "ingestion.getStatementSubmission": unavailableOperation,
  "ingestion.listNeedsReviewItems": unavailableOperation,
  "insights.listPendingInsights": unavailableOperation,
  "memory.recall": unavailableOperation,
  "subscription.getUpgradeUrl": unavailableOperation,
  "subscription.listSubscriptionOffers": unavailableOperation,
  "pats.listPATs": (_input, caller) => listPATsResponse(caller.resolved.subjectUserId),
  "operations.executeAtomicBatch": unavailableOperation,
} as const satisfies CanonicalOperationImplementations;

export type { CanonicalImplementationCaller } from "./canonical-implementation";

type ErasedCanonicalImplementation = (
  input: never,
  caller: CanonicalImplementationCaller
) => Effect.Effect<unknown, object, CanonicalImplementationRequirements>;

const implementationsById: ReadonlyMap<string, ErasedCanonicalImplementation> = new Map(
  Object.entries(canonicalOperationImplementations)
);

/** Selects one correlated canonical implementation without widening the public operation set. */
export const findCanonicalOperationImplementation = (
  operation: OperationId
): Option.Option<ErasedCanonicalImplementation> =>
  Option.fromNullishOr(implementationsById.get(operation));

/** Fails closed when reflected declarations and implementation keys drift. */
export const assertCanonicalOperationRegistry = (operationIds: ReadonlyArray<string>): void => {
  const reflected = [...operationIds].sort();
  const registered = Object.keys(canonicalOperationImplementations).sort();
  if (JSON.stringify(reflected) !== JSON.stringify(registered)) {
    throw new Error(
      `Canonical operation registry drift: reflected=${reflected.join(",")} registered=${registered.join(",")}`
    );
  }
};
