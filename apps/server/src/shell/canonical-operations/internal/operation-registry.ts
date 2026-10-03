import type { CanonicalInput, CanonicalSuccess } from "~/shell/canonical-operations/contract";
import { Effect, Option } from "effect";
import type { OperationId } from "~/shell/api";
import type {
  CanonicalImplementationCaller,
  CanonicalImplementationRequirements,
  CanonicalOperationImplementations,
} from "./implementation";

import {
  getSubscriptionStatus,
  listSubscriptionOffersResponse,
} from "~/shell/subscription/operations";
import { listCategoriesResponse } from "~/shell/categories/operations";
import { getCurrentUser } from "~/shell/identity/operations";
import { listPATsResponse } from "~/shell/tokens/operations";
import { canonicalMutationImplementations } from "./mutation-registry";

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
  "recurring.listRecurringSeries": unavailableOperation,
  "memory.recall": unavailableOperation,
  "subscription.getUpgradeUrl": unavailableOperation,
  "subscription.listSubscriptionOffers": () => listSubscriptionOffersResponse,
  "subscription.getSubscriptionStatus": (_input, caller) =>
    getSubscriptionStatus(caller.resolved.subjectUserId),
  "pats.listPATs": (_input, caller) => listPATsResponse(caller.resolved.subjectUserId),
  "operations.executeAtomicBatch": unavailableOperation,
} as const satisfies CanonicalOperationImplementations;

export type { CanonicalImplementationCaller } from "./implementation";

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
