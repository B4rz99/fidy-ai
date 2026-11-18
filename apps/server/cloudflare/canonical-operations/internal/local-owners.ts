import { prepareLocalPreferences } from "../../identity/operations";
import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import type { OperationId } from "../../../src/shell/api";
import type { UserId } from "../../../src/core/identity/contract";
import { getCanonicalOperationInput } from "../../../src/shell/canonical-operations/operations";
import type { CanonicalInput } from "../../../src/shell/canonical-operations/contract";
import {
  prepareLocalCapture,
  prepareLocalCorrection,
  prepareLocalDeletion,
  prepareLocalPair,
} from "../../transactions/operations";
import { prepareLocalBudget, prepareLocalBudgetDeletion } from "../../budgets/operations";
import { prepareLocalRecurringEdit } from "../../recurring-plans/operations";
import { prepareLocalDashboard } from "../../dashboard/operations";
import { newKeywordRuleId, prepareLocalKeywordRule } from "../../categories/operations";
import { cancelLocalSubscription } from "../../subscription/operations";
import {
  CanonicalAdmissionUnavailable,
  type LocalMutationPlan,
  type LocalMutationPreparation,
} from "../../canonical-admission/contract";
import { prepareLocalWrite } from "../../canonical-admission/operations";

const firstFailureStatus = 400;
type Context = { user: UserId; current: number; storage: DurableObjectStorage };
type Prepare = (
  input: unknown,
  context: Context
) => Effect.Effect<LocalMutationPreparation, CanonicalAdmissionUnavailable, SqliteClient>;
const owner = <Id extends OperationId, E>(
  id: Id,
  prepare: (
    input: CanonicalInput<Id>,
    context: Context
  ) => Effect.Effect<LocalMutationPreparation, E, SqliteClient>
): readonly [string, Prepare] => [
  id,
  (input, context) =>
    Schema.decodeUnknownEffect(getCanonicalOperationInput(id), { onExcessProperty: "error" })(
      input
    ).pipe(
      Effect.flatMap((decoded) => prepare(decoded, context)),
      Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
    ),
];
/** Only local, transaction-composable commands. Catalog policy controls eligibility and disclosure. */
export const localBatchOwners = new Map<string, Prepare>([
  owner("identity.updateUserPreferences", ({ payload }, { user }) =>
    Effect.succeed(prepareLocalPreferences({ user, preferences: payload }))
  ),
  owner("transactions.createTransaction", ({ payload }, { user, current }) =>
    prepareLocalCapture(payload, user, current)
  ),
  owner("transactions.updateTransaction", ({ params, payload }, { user, current }) =>
    prepareLocalCorrection({ id: params.id, input: payload }, user, current)
  ),
  owner("transactions.deleteTransaction", ({ params }, { user, current }) =>
    prepareLocalDeletion(params.id, user, current)
  ),
  owner("transactions.linkTransactions", ({ payload }, { user, current }) =>
    prepareLocalPair({ input: payload, link: true }, user, current)
  ),
  owner("transactions.unlinkTransactions", ({ payload }, { user, current }) =>
    prepareLocalPair({ input: payload, link: false }, user, current)
  ),
  owner("transactions.updateTransactions", ({ payload }, { user, current }) =>
    Effect.gen(function* () {
      const plans: LocalMutationPlan[] = [];
      for (const { id, expectedRevision } of payload.transactions) {
        const plan = yield* prepareLocalCorrection(
          { id, input: { expectedRevision, changes: payload.changes } },
          user,
          current
        );
        if (!("commit" in plan)) return plan;
        plans.push(plan);
      }
      return prepareLocalWrite({
        targets: plans.flatMap((plan) => plan.targets),
        commit: Effect.gen(function* () {
          for (const plan of plans) {
            const value = yield* plan.commit;
            if (value.status >= firstFailureStatus) return value;
          }
          return {
            status: 200,
            outcome: "success",
            body: { data: { updated: plans.length }, next: [] },
          };
        }),
      });
    })
  ),
  owner("budgets.createBudget", ({ payload }, { user, current }) =>
    prepareLocalBudget({ input: payload, id: Option.none() }, user, current)
  ),
  owner("budgets.updateBudget", ({ params, payload }, { user, current }) =>
    prepareLocalBudget({ input: payload, id: Option.some(params.id) }, user, current)
  ),
  owner("budgets.deleteBudget", ({ params }, { user }) =>
    prepareLocalBudgetDeletion(params.id, user)
  ),
  owner("recurringPlans.applyRecurringEdit", ({ payload }, { user, current }) =>
    prepareLocalRecurringEdit(payload, user, current)
  ),
  owner("dashboard.initializeDashboard", (_input, { user }) =>
    prepareLocalDashboard(user, Option.none())
  ),
  owner("dashboard.applyDashboardEdit", ({ payload }, { user }) =>
    prepareLocalDashboard(user, Option.some(payload))
  ),
  owner("categories.createKeywordRule", ({ payload }, { user, current }) =>
    prepareLocalKeywordRule(
      { operation: "categories.createKeywordRule", ruleId: newKeywordRuleId(), payload },
      user,
      current
    )
  ),
  owner("categories.updateKeywordRule", ({ params, payload }, { user, current }) =>
    prepareLocalKeywordRule(
      { operation: "categories.updateKeywordRule", ruleId: params.id, payload },
      user,
      current
    )
  ),
  owner("categories.deleteKeywordRule", ({ params }, { user, current }) =>
    prepareLocalKeywordRule(
      { operation: "categories.deleteKeywordRule", ruleId: params.id },
      user,
      current
    )
  ),
  owner("subscription.cancelSubscription", (_input, { user, current, storage }) =>
    Effect.succeed(
      prepareLocalWrite({
        targets: ["subscription"],
        commit: cancelLocalSubscription({ userId: user, current, storage }),
      })
    )
  ),
]);
