import type { CanonicalInput, CanonicalSuccess } from "~/shell/canonical-operations/contract";
import { Effect } from "effect";
import type { OperationId } from "~/shell/api";
import {
  completeEmailReplacement,
  requestEmailReplacement,
} from "~/shell/email-authentication/operations";
import type { OperationCatalog } from "~/shell/canonical-catalog/contract";
import type {
  CanonicalFailure,
  CanonicalImplementationCaller,
  CanonicalImplementationRequirements,
  CanonicalOperationImplementations,
} from "./implementation";

/** Caller facts supplied to every canonical mutation adapter. */
export type CanonicalMutationCaller = CanonicalImplementationCaller;

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
  "dashboard.initializeDashboard": unavailableMutation,
  "dashboard.getDashboardView": unavailableMutation,
  "dashboard.applyDashboardEdit": unavailableMutation,
  "emailAuthentication.requestEmailReplacement": (
    input: CanonicalInput<"emailAuthentication.requestEmailReplacement">,
    caller: CanonicalImplementationCaller
  ) => requestEmailReplacement({ input, caller }),
  "emailAuthentication.completeEmailReplacement": (
    input: CanonicalInput<"emailAuthentication.completeEmailReplacement">,
    caller: CanonicalImplementationCaller
  ) => completeEmailReplacement({ input, caller }),
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
