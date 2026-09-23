import { Effect } from "effect";
import type { OperationId } from "~/shell/api";
import {
  completeEmailReplacement,
  requestEmailReplacement,
} from "~/shell/email-authentication/mutation";
import type { OperationCatalog } from "./operation-catalog";
import type {
  CanonicalFailure,
  CanonicalImplementationCaller,
  CanonicalImplementationRequirements,
  CanonicalOperationImplementations,
} from "./canonical-implementation";
import type { CanonicalInput } from "./canonical-input";
import type { CanonicalSuccess } from "./canonical-success";

/** Caller facts supplied to every canonical mutation adapter. */
export type CanonicalMutationCaller = CanonicalImplementationCaller;

type MutationId =
  | "browserLogin.approvePairing"
  | "identity.updateUserPreferences"
  | "categories.createKeywordRule"
  | "categories.updateKeywordRule"
  | "categories.deleteKeywordRule"
  | "budgets.createBudget"
  | "budgets.updateBudget"
  | "budgets.deleteBudget"
  | "dashboard.getDashboard"
  | "dashboard.getDashboardView"
  | "dashboard.applyDashboardEdit"
  | "emailAuthentication.requestEmailReplacement"
  | "emailAuthentication.completeEmailReplacement"
  | "transactions.createTransaction"
  | "transactions.linkTransactions"
  | "transactions.unlinkTransactions"
  | "transactions.updateTransaction"
  | "transactions.deleteTransaction"
  | "memory.remember"
  | "memory.revise"
  | "memory.forget"
  | "ingestion.enableEmailForwarding"
  | "ingestion.submitForExtraction"
  | "ingestion.resolveNeedsReviewItem"
  | "insights.markInsightDelivered"
  | "insights.markInsightRead"
  | "insights.dismissInsight"
  | "pats.inspectPATPairing"
  | "pats.revokePAT"
  | "pats.revokeAllPATs"
  | "pats.createManualPAT"
  | "pats.approvePATPairing"
  | "recovery.rotateBackupRecoveryCode";

/**
 * Cloudflare Worker/D1/DO adapters are not assembled in this application package. Every removed
 * process-local mutation owner therefore fails closed instead of silently reintroducing SQL or an
 * in-memory substitute.
 */
const unavailableMutation = <Id extends OperationId>(
  _input: CanonicalInput<Id>,
  _caller: CanonicalImplementationCaller
): Effect.Effect<CanonicalSuccess<Id>, CanonicalFailure<Id>, CanonicalImplementationRequirements> =>
  Effect.die("Cloudflare canonical mutation boundary is not configured");

/** The complete ordinary mutation set, retained as a contract-correlated fail-closed registry. */
export const canonicalMutationImplementations = {
  "browserLogin.approvePairing": unavailableMutation,
  "identity.updateUserPreferences": unavailableMutation,
  "categories.createKeywordRule": unavailableMutation,
  "categories.updateKeywordRule": unavailableMutation,
  "categories.deleteKeywordRule": unavailableMutation,
  "budgets.createBudget": unavailableMutation,
  "budgets.updateBudget": unavailableMutation,
  "budgets.deleteBudget": unavailableMutation,
  "dashboard.getDashboard": unavailableMutation,
  "dashboard.getDashboardView": unavailableMutation,
  "dashboard.applyDashboardEdit": unavailableMutation,
  "emailAuthentication.requestEmailReplacement": requestEmailReplacement,
  "emailAuthentication.completeEmailReplacement": completeEmailReplacement,
  "transactions.createTransaction": unavailableMutation,
  "transactions.linkTransactions": unavailableMutation,
  "transactions.unlinkTransactions": unavailableMutation,
  "transactions.updateTransaction": unavailableMutation,
  "transactions.deleteTransaction": unavailableMutation,
  "memory.remember": unavailableMutation,
  "memory.revise": unavailableMutation,
  "memory.forget": unavailableMutation,
  "ingestion.enableEmailForwarding": unavailableMutation,
  "ingestion.submitForExtraction": unavailableMutation,
  "ingestion.resolveNeedsReviewItem": unavailableMutation,
  "insights.markInsightDelivered": unavailableMutation,
  "insights.markInsightRead": unavailableMutation,
  "insights.dismissInsight": unavailableMutation,
  "pats.inspectPATPairing": unavailableMutation,
  "pats.revokePAT": unavailableMutation,
  "pats.revokeAllPATs": unavailableMutation,
  "pats.createManualPAT": unavailableMutation,
  "pats.approvePATPairing": unavailableMutation,
  "recovery.rotateBackupRecoveryCode": unavailableMutation,
} as const satisfies Partial<CanonicalOperationImplementations>;

/** Ordinary mutation ids are derived from the registry rather than duplicated in a policy list. */
export type CanonicalMutationId = keyof typeof canonicalMutationImplementations;

/** Proves that the reflected ordinary mutation set and this fail-closed registry stay aligned. */
export const assertCanonicalMutationRegistry = (catalog: OperationCatalog): void => {
  const reflected = catalog.operations
    .filter((operation) => operation.policy.kind === "mutation")
    .map((operation) => operation.id)
    .sort();
  const registered = Object.keys(canonicalMutationImplementations).sort();
  if (JSON.stringify(reflected) !== JSON.stringify(registered)) {
    throw new Error(
      `Canonical mutation registry drift: reflected=${reflected.join(",")} registered=${registered.join(",")}`
    );
  }
};

export type { MutationId };
