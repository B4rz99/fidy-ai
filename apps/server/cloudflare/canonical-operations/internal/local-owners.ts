import { preserveStoreAlarm } from "../../runtime/sqlite/operations";
import { recurringDiscoveryIntervalMs } from "../../recurring/contract";
import {
  prepareLocalInsight,
  prepareLocalReminder,
  readLocalDigestReport,
} from "../../insights/operations";
import { prepareLocalMemory } from "../../memory/operations";
import { prepareLocalConnection } from "../../connections/operations";
import { userOwnedAgentCapability } from "../../../src/shell/canonical-policy/contract";
import { getBoundOperationCatalog } from "../../../src/shell/canonical-catalog/contract";
import type { OAuthCanonicalAdmission } from "../../../src/shell/mcp/contract";
import {
  readLocalPATActivity,
  readLocalPATMetadata,
  repairLocalPATExpiry,
  stageLocalPATGrant,
} from "../../tokens/operations";
import { prepareLocalPreferences } from "../../identity/operations";
import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Array as Arr, Cause, Effect, Option, Predicate, Result, Schema } from "effect";
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
import {
  prepareLocalBudget,
  prepareLocalBudgetDeletion,
  readLocalBudget,
} from "../../budgets/operations";
import {
  prepareLocalRecurringEdit,
  readLocalRecurringWorkspace,
} from "../../recurring-plans/operations";
import { readLocalRecurringSeries } from "../../recurring/operations";
import { prepareLocalDashboard, readLocalDashboard } from "../../dashboard/operations";
import { newKeywordRuleId, prepareLocalKeywordRule } from "../../categories/operations";
import {
  localHostedStatementOrigin,
  prepareLocalForwardingEnable,
  prepareLocalReviewEdit,
  prepareLocalStatementAbandonment,
  prepareLocalStatementDecision,
  readLocalDocumentPublication,
  readLocalForwarding,
  readLocalReviewItem,
  readLocalReviewWorkspace,
} from "../../ingestion/operations";
import {
  cancelLocalSubscription,
  localCancellationReview,
  readLocalSubscriptionStatus,
  subscriptionReadResult,
  upgradeLocation,
} from "../../subscription/operations";
import {
  CanonicalAdmissionUnavailable,
  type LocalMutationPlan,
  type LocalMutationPreparation,
  type LocalMutationResult,
} from "../../canonical-admission/contract";
import { prepareLocalWrite } from "../../canonical-admission/operations";

const firstFailureStatus = 400;

type PreparedCorrections = Result.Result<ReadonlyArray<LocalMutationPlan>, LocalMutationResult>;

const acceptCorrection =
  (accepted: ReadonlyArray<LocalMutationPlan>) =>
  (plan: LocalMutationPreparation): PreparedCorrections =>
    "commit" in plan ? Result.succeed(Arr.append(accepted, plan)) : Result.fail(plan);

const refusal = (value: LocalMutationResult): Option.Option<LocalMutationResult> =>
  value.status >= firstFailureStatus ? Option.some(value) : Option.none();

const commitUntilRefused = (
  plans: ReadonlyArray<LocalMutationPlan>
): Effect.Effect<Option.Option<LocalMutationResult>, CanonicalAdmissionUnavailable, SqliteClient> =>
  Effect.reduce(
    plans,
    () => Option.none<LocalMutationResult>(),
    (prior, plan) =>
      Option.isSome(prior) ? Effect.succeed(prior) : plan.commit.pipe(Effect.map(refusal))
  );

type Context = { user: UserId; current: number; storage: DurableObjectStorage } & Partial<{
  hostedTurn: string;
  accountability: { turnId: string; sessionId: string };
  commercial: { origin: string; offers: Option.Option<Schema.Json> };
}>;

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

const groupReview = Effect.fn(function* (plans: ReadonlyArray<LocalMutationPlan>) {
  const facts = yield* Effect.forEach(plans, (plan) =>
    Option.match(plan.review, {
      onSome: (review) => review,
      onNone: () =>
        Effect.fail(new CanonicalAdmissionUnavailable({ cause: "unreviewed correction" })),
    })
  );

  return {
    effect: facts.map((fact) => fact.effect).join("\n"),
    revision: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
      facts.map((fact) => fact.revision)
    ),
  };
});

const decisionOwner = Effect.fn(function* (target: string, context: Context) {
  const origin =
    context.hostedTurn === undefined
      ? Option.none()
      : yield* localHostedStatementOrigin(context.hostedTurn, target, context.user);

  return { ...context, origin, requiresOrigin: context.hostedTurn !== undefined };
});

const wakeAfterCapture = (
  plan: LocalMutationPreparation,
  { current, storage }: Context
): LocalMutationPreparation =>
  "commit" in plan
    ? {
        ...plan,
        commit: plan.commit.pipe(
          Effect.tap((result) =>
            result.outcome === "success"
              ? preserveStoreAlarm(storage, current + recurringDiscoveryIntervalMs)
              : Effect.void
          ),
          Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
        ),
      }
    : plan;

const readOwner = <Id extends OperationId, E>(
  id: Id,
  read: (
    input: CanonicalInput<Id>,
    context: Context
  ) => Effect.Effect<LocalMutationResult, E, SqliteClient>
): readonly [string, Prepare] =>
  owner(id, (input, context) =>
    Effect.succeed(
      prepareLocalWrite({
        targets: [],
        commit: read(input, context),
      })
    )
  );

const credentialMetadata = Effect.fnUntraced(function* ({
  user,
  current,
  accountability,
}: Context) {
  if (accountability === undefined) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "missing hosted authority" });
  }

  return {
    userId: user,
    current,
    authority: {
      table: "hosted_turns" as const,
      predicate: "id=? AND user_id=? AND session_id=? AND state='running' AND deadline_ms>?",
      bindings: [accountability.turnId, user, accountability.sessionId, current],
    },
  };
});

export const hostedOwners = new Map<string, Prepare>([
  readOwner("ingestion.submitForExtraction", ({ payload }, { user, current, hostedTurn }) =>
    readLocalDocumentPublication(payload, {
      user,
      current,
      turn: Option.fromUndefinedOr(hostedTurn),
    })
  ),

  readOwner("subscription.getSubscriptionStatus", (_, { user }) =>
    readLocalSubscriptionStatus(user).pipe(Effect.map(subscriptionReadResult))
  ),
  readOwner("subscription.listSubscriptionOffers", (_, { commercial }) =>
    Effect.gen(function* () {
      if (commercial === undefined || Option.isNone(commercial.offers)) {
        return yield* new CanonicalAdmissionUnavailable({ cause: "pricing_unavailable" });
      }

      return subscriptionReadResult(commercial.offers.value);
    })
  ),
  readOwner("subscription.getUpgradeUrl", (_, { commercial }) =>
    Effect.gen(function* () {
      if (commercial === undefined) {
        return yield* new CanonicalAdmissionUnavailable({ cause: "browser_origin_unavailable" });
      }

      return subscriptionReadResult(upgradeLocation(commercial.origin));
    })
  ),

  readOwner("ingestion.getReviewWorkspace", ({ query }, { user, current, hostedTurn }) =>
    readLocalReviewWorkspace(query, user, {
      context: false,
      current,
      hostedTurn: Option.fromUndefinedOr(hostedTurn),
    })
  ),
  readOwner("ingestion.getReviewItem", ({ params }, { user, current, hostedTurn }) =>
    readLocalReviewItem(user, params.id, {
      current,
      hostedTurn: Option.fromUndefinedOr(hostedTurn),
    })
  ),
  readOwner("ingestion.getEmailForwarding", (_, { user, current }) =>
    readLocalForwarding(user, current)
  ),
  readOwner("insights.getRecurringDigestReport", ({ params }, { user }) =>
    readLocalDigestReport({ userId: user, id: params.id })
  ),
  readOwner("pats.listPATs", (_, context) =>
    credentialMetadata(context).pipe(Effect.flatMap(readLocalPATMetadata))
  ),
  readOwner("pats.getPATActivity", ({ params }, context) =>
    credentialMetadata(context).pipe(
      Effect.flatMap((proof) => readLocalPATActivity({ ...proof, shortId: params.shortId }))
    )
  ),

  readOwner("budgets.getBudget", ({ params }, { user, current }) =>
    readLocalBudget({ id: Option.some(params.id), query: Option.none() }, user, current)
  ),
  readOwner("budgets.listBudgets", (_, { user, current }) =>
    readLocalBudget({ id: Option.none(), query: Option.none() }, user, current)
  ),
  readOwner("budgets.getBudgetStatus", ({ query }, { user, current }) =>
    readLocalBudget({ id: Option.none(), query: Option.some(query) }, user, current)
  ),
  ...(
    [
      "dashboard.getDashboard",
      "dashboard.getDashboardView",
      "dashboard.listDashboardCatalog",
    ] as const
  ).map((id) => readOwner(id, (_, { user, current }) => readLocalDashboard(id, user, current))),
  readOwner("recurring.listRecurringSeries", ({ query }, { user }) =>
    readLocalRecurringSeries(Option.fromUndefinedOr(query.cursor), user)
  ),
  readOwner("recurringPlans.getRecurringWorkspace", ({ query }, { user, current }) =>
    readLocalRecurringWorkspace(query, user, current)
  ),
]);

export const localBatchOwners = new Map<string, Prepare>([
  owner("insights.markInsightDelivered", ({ params, payload }, { user }) =>
    prepareLocalInsight({ id: params.id, target: "delivered", evidence: payload }, user)
  ),
  owner("insights.markInsightRead", ({ params }, { user }) =>
    prepareLocalInsight({ id: params.id, target: "read" }, user)
  ),
  owner("insights.dismissInsight", ({ params }, { user }) =>
    prepareLocalInsight({ id: params.id, target: "dismissed" }, user)
  ),
  owner("insights.updateReminderSchedule", ({ payload }, { user, current, storage }) =>
    prepareLocalReminder(payload, { user, current, storage })
  ),
  owner("memory.remember", ({ payload }, { user, current }) =>
    prepareLocalMemory({ kind: "remember", text: payload.text }, user, current)
  ),
  owner("memory.revise", ({ payload, params }, { user, current }) =>
    prepareLocalMemory({ kind: "revise", id: params.id, text: payload.text }, user, current)
  ),
  owner("memory.forget", ({ params }, { user, current }) =>
    prepareLocalMemory({ kind: "forget", id: params.id }, user, current)
  ),
  owner("ingestion.enableEmailForwarding", (_input, { user }) =>
    prepareLocalForwardingEnable(user)
  ),
  owner("ingestion.skipNeedsReviewItem", ({ params }, context) =>
    Effect.gen(function* () {
      return yield* prepareLocalStatementDecision(
        params.id,
        Option.none(),
        yield* decisionOwner(params.id, context)
      );
    })
  ),
  owner("ingestion.resolveNeedsReviewItem", ({ params, payload }, context) =>
    Effect.gen(function* () {
      return yield* prepareLocalStatementDecision(
        params.id,
        Option.some(payload.extraction),
        yield* decisionOwner(params.id, context)
      ).pipe(Effect.map((plan) => wakeAfterCapture(plan, context)));
    })
  ),
  owner("ingestion.abandonStatementSubmission", ({ params }, context) =>
    Effect.gen(function* () {
      return yield* prepareLocalStatementAbandonment(
        params.id,
        yield* decisionOwner(params.id, context)
      );
    })
  ),
  owner("ingestion.applyReviewEdit", ({ payload }, context) =>
    prepareLocalReviewEdit(payload, context.user, context.current).pipe(
      Effect.map((plan) =>
        Predicate.isTagged(payload, "Create") ? wakeAfterCapture(plan, context) : plan
      )
    )
  ),
  owner("connections.connectInstitution", ({ payload }, { user, current, storage }) =>
    prepareLocalConnection(payload.institutionId, { user, current, storage })
  ),
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
      const prepared = yield* Effect.reduce(
        payload.transactions,
        (): PreparedCorrections => Result.succeed([]),
        (accepted, { id, expectedRevision }) =>
          Result.isFailure(accepted)
            ? Effect.succeed(accepted)
            : prepareLocalCorrection(
                { id, input: { expectedRevision, changes: payload.changes } },
                user,
                current
              ).pipe(Effect.map(acceptCorrection(accepted.success)))
      );

      if (Result.isFailure(prepared)) return prepared.failure;
      const plans = prepared.success;

      return prepareLocalWrite({
        targets: plans.flatMap((plan) => plan.targets),
        review: groupReview(plans),
        commit: Effect.gen(function* () {
          const refused = yield* commitUntilRefused(plans);

          if (Option.isSome(refused)) return refused.value;

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
        review: localCancellationReview(user),
        commit: cancelLocalSubscription({ userId: user, current, storage }),
      })
    )
  ),
]);

type GrantUnit = Pick<Parameters<typeof stageLocalPATGrant>[0], "request" | "directory" | "owns">;

const reserveGrant = Effect.fn(function* (unit: GrantUnit, operation: string, input: Schema.Json) {
  const { payload } = yield* Schema.decodeUnknownEffect(Schema.Struct({ payload: Schema.Json }))(
    input
  );

  const staged = yield* stageLocalPATGrant({ ...unit, operation, payload });

  const prepare: Prepare = (_input, { user, current, storage }) =>
    Effect.succeed(
      prepareLocalWrite({
        targets: staged.targets,
        commit: staged
          .commit(user, current)
          .pipe(
            Effect.tap((result) =>
              result.outcome === "success" ? repairLocalPATExpiry(current, storage) : Effect.void
            )
          ),
      })
    );

  return prepare;
});

type ReservedGrant = { reserve: (input: Schema.Json) => ReturnType<typeof reserveGrant> };

export const batchOwnersFor = (unit: GrantUnit): ReadonlyMap<string, Prepare | ReservedGrant> => {
  const owners = new Map<string, Prepare | ReservedGrant>(localBatchOwners);

  for (const id of ["pats.createManualPAT", "pats.approvePATPairing", "pats.inspectPATPairing"]) {
    owners.set(id, { reserve: (input) => reserveGrant(unit, id, input) });
  }

  return owners;
};

const reviewCalls = Effect.fn(function* (admission: OAuthCanonicalAdmission) {
  return admission.operation === "operations.executeAtomicBatch"
    ? (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          payload: Schema.Struct({
            calls: Schema.Array(Schema.Struct({ operation: Schema.String, input: Schema.Json })),
          }),
        })
      )(admission.input)).payload.calls
    : [{ operation: admission.operation, input: admission.input }];
});

const reviewEntry = Effect.fnUntraced(function* (
  child: Effect.Success<ReturnType<typeof reviewCalls>>[number],
  context: Context
) {
  const operation = yield* Effect.fromNullishOr(
    getBoundOperationCatalog().byId.get(child.operation)
  );

  const scope = Option.getOrNull(userOwnedAgentCapability(operation.policy.access));

  if (operation.policy.agentConfirmation !== "required") {
    return {
      binding: { operation: operation.id, scope, effect: "", revision: "" },
      sensitive: false,
    };
  }

  const prepare = yield* Effect.fromNullishOr(localBatchOwners.get(operation.id));
  const plan = yield* prepare(child.input, context);

  if (!("commit" in plan) || Option.isNone(plan.review)) {
    return yield* new Cause.NoSuchElementError();
  }

  return {
    binding: { operation: operation.id, scope, ...(yield* plan.review.value) },
    sensitive: true,
  };
});

export const localReviewBinding = Effect.fn(
  function* (admission: OAuthCanonicalAdmission, context: Context) {
    const entries = yield* Effect.forEach(yield* reviewCalls(admission), (child) =>
      reviewEntry(child, context)
    );

    return entries.some((entry) => entry.sensitive) ? entries.map((entry) => entry.binding) : [];
  },
  Effect.catchNoSuchElement,
  Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
);
