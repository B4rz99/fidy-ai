import { type Crypto, Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ResolvedAgentToken } from "~/core/tokens/model";
import {
  createKeywordRule,
  deleteKeywordRule,
  updateKeywordRule,
} from "~/shell/categories/mutations";
import { applyDashboardEdit, loadOrCreateDashboard } from "~/shell/dashboard/mutations";
import { withDashboardLockInScope } from "~/shell/dashboard/repo";
import { updateUserPreferences } from "~/shell/identity/mutations";
import type { HostedInference } from "~/shell/agent/hosted-inference";
import {
  resolveNeedsReviewItemMutation,
  submitForExtractionInScope,
} from "~/shell/ingestion/mutations";
import { rememberMemory } from "~/shell/memory/mutations";
import type { Telemetry } from "~/shell/observability/telemetry";
import { dismissInsight, markInsightDelivered, markInsightRead } from "~/shell/insights/mutations";
import {
  correctTransaction,
  createTransaction,
  deleteTransaction,
} from "~/shell/transactions/mutations";
import type { CanonicalInput } from "./canonical-input";
import type { OperationCatalog } from "./operation-catalog";

/** Caller facts supplied to every registered canonical mutation adapter. */
export type CanonicalMutationCaller = Readonly<{ resolved: ResolvedAgentToken }>;

type MutationAdapter<Input, Output, Failure> = {
  execute(
    input: Input,
    caller: CanonicalMutationCaller
  ): Effect.Effect<
    Output,
    Failure,
    SqlClient.SqlClient | Telemetry | Crypto.Crypto | HostedInference
  >;
}["execute"];

const mutationAdapter = <Input, Output, Failure>(
  execute: MutationAdapter<Input, Output, Failure>
): MutationAdapter<Input, Output, Failure> => execute;

const suggestedCaller = ({
  resolved,
}: CanonicalMutationCaller): Readonly<{ scopes: ResolvedAgentToken["scopes"]; tier: "free" }> => ({
  scopes: resolved.scopes,
  tier: "free" as const,
});

/**
 * Reusable transaction-aware adapters behind atomic dispatch. This is an implementation registry,
 * not an eligibility list: `assertCanonicalMutationRegistry` derives the required keys from the
 * reflected canonical catalog and rejects missing or extra ordinary mutations.
 */
export const canonicalMutationImplementations = {
  "identity.updateUserPreferences": mutationAdapter(
    (input: CanonicalInput<"identity.updateUserPreferences">, { resolved }) =>
      updateUserPreferences({ userId: resolved.subjectUserId, payload: input.payload })
  ),
  "categories.createKeywordRule": mutationAdapter(
    (input: CanonicalInput<"categories.createKeywordRule">, caller) =>
      createKeywordRule({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        payload: input.payload,
      })
  ),
  "categories.updateKeywordRule": mutationAdapter(
    (input: CanonicalInput<"categories.updateKeywordRule">, caller) =>
      updateKeywordRule({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        keywordRuleId: input.params.id,
        payload: input.payload,
      })
  ),
  "categories.deleteKeywordRule": mutationAdapter(
    (input: CanonicalInput<"categories.deleteKeywordRule">, caller) =>
      deleteKeywordRule({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        keywordRuleId: input.params.id,
      })
  ),
  "dashboard.getDashboard": mutationAdapter(
    (_input: CanonicalInput<"dashboard.getDashboard">, caller) =>
      withDashboardLockInScope(
        caller.resolved.subjectUserId,
        loadOrCreateDashboard(caller.resolved.subjectUserId)
      ).pipe(Effect.map((data) => ({ data, next: [] })))
  ),
  "dashboard.applyDashboardEdit": mutationAdapter(
    (input: CanonicalInput<"dashboard.applyDashboardEdit">, caller) =>
      applyDashboardEdit({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        edit: input.payload,
      })
  ),
  "transactions.createTransaction": mutationAdapter(
    (input: CanonicalInput<"transactions.createTransaction">, caller) =>
      createTransaction({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        payload: input.payload,
      })
  ),
  "transactions.updateTransaction": mutationAdapter(
    (input: CanonicalInput<"transactions.updateTransaction">, caller) =>
      correctTransaction({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        transactionId: input.params.id,
        payload: input.payload,
      })
  ),
  "transactions.deleteTransaction": mutationAdapter(
    (input: CanonicalInput<"transactions.deleteTransaction">, caller) =>
      deleteTransaction({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        transactionId: input.params.id,
      })
  ),
  "memory.remember": mutationAdapter((input: CanonicalInput<"memory.remember">, caller) =>
    rememberMemory({
      userId: caller.resolved.subjectUserId,
      payload: input.payload,
    })
  ),
  "ingestion.submitForExtraction": mutationAdapter(
    (input: CanonicalInput<"ingestion.submitForExtraction">, caller) =>
      submitForExtractionInScope({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        payload: input.payload,
      })
  ),
  "ingestion.resolveNeedsReviewItem": mutationAdapter(
    (input: CanonicalInput<"ingestion.resolveNeedsReviewItem">, caller) =>
      resolveNeedsReviewItemMutation({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        id: input.params.id,
        extraction: input.payload.extraction,
      })
  ),
  "insights.markInsightDelivered": mutationAdapter(
    (input: CanonicalInput<"insights.markInsightDelivered">, caller) =>
      markInsightDelivered({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        insightEventId: input.params.id,
        payload: input.payload,
      })
  ),
  "insights.markInsightRead": mutationAdapter(
    (input: CanonicalInput<"insights.markInsightRead">, caller) =>
      markInsightRead({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        insightEventId: input.params.id,
      })
  ),
  "insights.dismissInsight": mutationAdapter(
    (input: CanonicalInput<"insights.dismissInsight">, caller) =>
      dismissInsight({
        userId: caller.resolved.subjectUserId,
        caller: suggestedCaller(caller),
        insightEventId: input.params.id,
      })
  ),
} as const;

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

/** Dispatches a schema-decoded child through its operation-correlated implementation. */
export const dispatchCanonicalMutation = Effect.fn("dispatchCanonicalMutation")(function* (
  call: CanonicalMutationCall,
  caller: CanonicalMutationCaller
) {
  // The reflected tagged-union decoder establishes the operation/input correlation before this
  // boundary; the registry's mapped types preserve the same relation for callers.
  const execute: MutationAdapter<
    CanonicalMutationCall["input"],
    CanonicalMutationResult["output"],
    CanonicalMutationFailure
  > = canonicalMutationImplementations[call.operation];
  return yield* execute(call.input, caller);
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
