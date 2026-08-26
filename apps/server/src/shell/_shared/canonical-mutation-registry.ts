import { Effect } from "effect";
import { toAccessCaller } from "./authz";
import {
  type SuggestedOperationCaller,
  makeFreeSuggestedOperationCaller,
} from "./suggested-operations";
import { createBudget, deleteBudget, updateBudget } from "~/shell/budgets/mutations";
import { approveBrowserLoginPairing } from "~/shell/browser-login/mutations";
import {
  createKeywordRule,
  deleteKeywordRule,
  updateKeywordRule,
} from "~/shell/categories/mutations";
import { applyDashboardEdit, getDashboard } from "~/shell/dashboard/mutations";
import { requestEmailReplacement } from "~/shell/email-authentication/replacement-mutations";
import { getDashboardView } from "~/shell/dashboard/view";
import { updateUserPreferences } from "~/shell/identity/mutations";
import {
  resolveNeedsReviewItemMutation,
  submitForExtractionInScope,
} from "~/shell/ingestion/mutations";
import { forgetMemory, rememberMemory, reviseMemory } from "~/shell/memory/mutations";
import { dismissInsight, markInsightDelivered, markInsightRead } from "~/shell/insights/mutations";
import {
  correctTransaction,
  createTransaction,
  deleteTransaction,
} from "~/shell/transactions/mutations";
import { createManualPAT } from "~/shell/tokens/mutations";
import { approvePATPairing, inspectPATPairing } from "~/shell/tokens/pat-pairing";
import type {
  CanonicalExecutionRequirements,
  CanonicalImplementationCaller,
  CanonicalOperationImplementations,
} from "./canonical-implementation";
import type { OperationCatalog } from "./operation-catalog";

/** Caller facts supplied to every registered canonical mutation adapter. */
export type CanonicalMutationCaller = CanonicalImplementationCaller;

const suggestedCaller = ({ resolved }: CanonicalMutationCaller): SuggestedOperationCaller =>
  makeFreeSuggestedOperationCaller(toAccessCaller(resolved));

/**
 * Reusable transaction-aware adapters behind atomic dispatch. This is an implementation registry,
 * not an eligibility list: `assertCanonicalMutationRegistry` derives the required keys from the
 * reflected canonical catalog and rejects missing or extra ordinary mutations.
 */
export const canonicalMutationImplementations = {
  "browserLogin.approvePairing": (input, { resolved }) =>
    approveBrowserLoginPairing({
      userId: resolved.subjectUserId,
      publicCode: input.payload.publicCode,
    }),
  "identity.updateUserPreferences": (input, { resolved }) =>
    updateUserPreferences({ userId: resolved.subjectUserId, payload: input.payload }),
  "categories.createKeywordRule": (input, caller) =>
    createKeywordRule({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      payload: input.payload,
    }),
  "categories.updateKeywordRule": (input, caller) =>
    updateKeywordRule({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      keywordRuleId: input.params.id,
      payload: input.payload,
    }),
  "categories.deleteKeywordRule": (input, caller) =>
    deleteKeywordRule({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      keywordRuleId: input.params.id,
    }),
  "budgets.createBudget": (input, caller) =>
    createBudget({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      payload: input.payload,
    }),
  "budgets.updateBudget": (input, caller) =>
    updateBudget({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      budgetId: input.params.id,
      payload: input.payload,
    }),
  "budgets.deleteBudget": (input, caller) =>
    deleteBudget({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      budgetId: input.params.id,
    }),
  "dashboard.getDashboard": (_input, caller) =>
    getDashboard({ userId: caller.resolved.subjectUserId }),
  "dashboard.getDashboardView": (_input, caller) =>
    getDashboardView({ userId: caller.resolved.subjectUserId }),
  "dashboard.applyDashboardEdit": (input, caller) =>
    applyDashboardEdit({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      edit: input.payload,
    }),
  "emailAuthentication.requestEmailReplacement": (input, { resolved }) =>
    requestEmailReplacement({
      userId: resolved.subjectUserId,
      payload: input.payload,
    }),
  "transactions.createTransaction": (input, caller) =>
    createTransaction({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      payload: input.payload,
    }),
  "transactions.updateTransaction": (input, caller) =>
    correctTransaction({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      transactionId: input.params.id,
      payload: input.payload,
    }),
  "transactions.deleteTransaction": (input, caller) =>
    deleteTransaction({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      transactionId: input.params.id,
    }),
  "memory.remember": (input, caller) =>
    rememberMemory({
      userId: caller.resolved.subjectUserId,
      payload: input.payload,
    }),
  "memory.revise": (input, caller) =>
    reviseMemory({
      userId: caller.resolved.subjectUserId,
      memoryId: input.params.id,
      payload: input.payload,
    }),
  "memory.forget": (input, caller) =>
    forgetMemory({
      userId: caller.resolved.subjectUserId,
      memoryId: input.params.id,
    }),
  "ingestion.submitForExtraction": (input, caller) =>
    submitForExtractionInScope({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      payload: input.payload,
    }),
  "ingestion.resolveNeedsReviewItem": (input, caller) =>
    resolveNeedsReviewItemMutation({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      id: input.params.id,
      extraction: input.payload.extraction,
    }),
  "insights.markInsightDelivered": (input, caller) =>
    markInsightDelivered({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      insightEventId: input.params.id,
      payload: input.payload,
    }),
  "insights.markInsightRead": (input, caller) =>
    markInsightRead({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      insightEventId: input.params.id,
    }),
  "insights.dismissInsight": (input, caller) =>
    dismissInsight({
      userId: caller.resolved.subjectUserId,
      caller: suggestedCaller(caller),
      insightEventId: input.params.id,
    }),
  "pats.inspectPATPairing": (input, { resolved }) =>
    inspectPATPairing({
      userId: resolved.subjectUserId,
      publicCode: input.payload.publicCode,
    }),
  "pats.createManualPAT": (input, { resolved }) =>
    createManualPAT({
      userId: resolved.subjectUserId,
      caller: resolved,
      payload: input.payload,
    }),
  "pats.approvePATPairing": (input, { resolved }) =>
    approvePATPairing({
      userId: resolved.subjectUserId,
      caller: resolved,
      payload: input.payload,
    }),
} as const satisfies Partial<CanonicalOperationImplementations>;

/** Every ordinary canonical mutation id, derived from the reusable implementation registry. */
export type CanonicalMutationId = keyof typeof canonicalMutationImplementations;

type MutationImplementation<Id extends CanonicalMutationId> =
  (typeof canonicalMutationImplementations)[Id];

/** Catalog-correlated decoded input for one canonical mutation child. */
export type CanonicalMutationCall = {
  readonly [Id in CanonicalMutationId]: Readonly<{
    operation: Id;
    input: Parameters<MutationImplementation<Id>>[0];
  }>;
}[CanonicalMutationId];

/** Catalog-correlated decoded output for one canonical mutation child. */
export type CanonicalMutationResult = {
  readonly [Id in CanonicalMutationId]: Readonly<{
    operation: Id;
    output: Effect.Success<ReturnType<MutationImplementation<Id>>>;
  }>;
}[CanonicalMutationId];

type AnyMutationImplementation = MutationImplementation<CanonicalMutationId>;
export type CanonicalMutationFailure = Effect.Error<ReturnType<AnyMutationImplementation>>;

/**
 * One mutation implementation with its input erased for runtime dispatch. Declaring `execute` as a
 * method and indexing it out keeps the widening a checked assignment; the registry above has
 * already fixed every declaration's input to its own operation.
 */
type ErasedMutationImplementation = {
  execute(
    input: CanonicalMutationCall["input"],
    caller: CanonicalMutationCaller
  ): Effect.Effect<
    CanonicalMutationResult["output"],
    CanonicalMutationFailure,
    CanonicalExecutionRequirements
  >;
}["execute"];

/** Exact child Effect construction used by dispatch and outer canonical preparation. */
export const CanonicalMutationEffects = {
  make(
    call: CanonicalMutationCall,
    caller: CanonicalMutationCaller
  ): ReturnType<ErasedMutationImplementation> {
    // The reflected tagged-union decoder establishes the operation/input correlation before this
    // boundary; the registry's mapped types preserve the same relation for callers.
    const execute: ErasedMutationImplementation = canonicalMutationImplementations[call.operation];
    return execute(call.input, caller);
  },
} as const;

/** Dispatches a schema-decoded child through its operation-correlated implementation. */
export const dispatchCanonicalMutation = Effect.fn("dispatchCanonicalMutation")(function* (
  call: CanonicalMutationCall,
  caller: CanonicalMutationCaller
) {
  return yield* CanonicalMutationEffects.make(call, caller);
});

/**
 * Proves that reflected ordinary mutations and transaction-aware dispatch implementations are the
 * same set. Queries and the structurally excluded batch operation cannot satisfy this guard.
 */
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
