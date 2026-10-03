import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type CanonicalPreparationWork,
  type CommittedMutationValue,
} from "../contract";
import { Effect, Option, Schema } from "effect";
import {
  ApplyDashboardEditCanonicalInput,
  GetDashboardCanonicalInput,
  GetDashboardViewCanonicalInput,
  InitializeDashboardCanonicalInput,
} from "../../../src/shell/dashboard/contract";
import { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import { getAtomicBatchChildIds } from "../../../src/shell/operations/contract";
import { getCanonicalOperationInput } from "../../../src/shell/canonical-operations/operations";
import { TransactionId } from "../../../src/core/transactions/contract";
import type { MemoryOperationId } from "../../../src/shell/memory/contract";
import type { HostedInference } from "../../../src/shell/hosted-inference/operations";
import { DeliveryEvidenceInput, InsightEventId } from "../../../src/core/insights/contract";
import { insightRefusal, prepareInsightTransition } from "../../insights/operations";
import { dashboardRefusal, prepareDashboard, presentDashboard } from "../../dashboard/operations";
import {
  budgetRefusal,
  prepareCreateBudget,
  prepareDeleteBudget,
  prepareUpdateBudget,
} from "../../budgets/operations";
import {
  invalidForwardingAddress,
  invalidStatementSubmission,
  prepareForwardingAddress,
  prepareStatementSubmission,
  presentForwardingAddress,
  presentStatementSubmission,
} from "../../ingestion/operations";
import {
  prepareCapture,
  prepareCorrection,
  prepareLink,
  prepareUnlink,
  transactionRefusal,
} from "../../transactions/operations";
import {
  type TransactionMutationOperation,
  failedPreparation,
  missingTransactionMessage,
  transactionUnavailable,
} from "../../canonical-work/operations";
import {
  keywordRuleInvalidInput,
  prepareCreateKeywordRule,
  prepareDeleteKeywordRule,
  prepareUpdateKeywordRule,
} from "../../categories/operations";
import {
  invalidMemoryInput,
  prepareForget,
  prepareRemember,
  prepareRevise,
} from "../../memory/operations";
import { committedJsonResponse } from "./mutation-unit";

/**
 * One owner's canonical mutation adapter: it decides a child without committing, presents a
 * committed child's canonical individual response, and answers for a child whose callId or
 * canonical input failed its published schema.
 */
export type CanonicalMutationAdapter = Readonly<{
  prepare: (
    work: CanonicalPreparationWork
  ) => Effect.Effect<CanonicalMutationPreparation, never, HostedInference>;
  present: (value: CommittedMutationValue) => Effect.Effect<Response>;
  invalidRefusal: (work: CanonicalPreparationWork) => CanonicalMutationRefusal;
}>;

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const invalidChildMessage = "Invalid input for this child mutation.";

const present =
  (status: number) =>
  (value: CommittedMutationValue): Effect.Effect<Response> =>
    committedJsonResponse({ value, status });

/** The owner's validation refusal for a child whose published call schema did not decode. */
const transactionInvalidRefusal =
  (operation: TransactionMutationOperation) =>
  (work: CanonicalPreparationWork): CanonicalMutationRefusal =>
    transactionRefusal({
      db: work.db,
      subject: work.subject,
      operation,
      refusal: { outcome: "validation_failed", message: invalidChildMessage },
      current: work.current,
    });

/**
 * The correction owner answers an unstable retained id as absent rather than as malformed input,
 * exactly as its own prepare seam does. A caller-supplied input that carries no textual id at all
 * stays the ordinary validation refusal.
 */
const correctionInvalidRefusal = (work: CanonicalPreparationWork): CanonicalMutationRefusal => {
  const unstable = Option.flatMap(
    Schema.decodeUnknownOption(Schema.Struct({ params: Schema.Struct({ id: Schema.String }) }))(
      work.input
    ),
    (input) =>
      Option.isNone(Schema.decodeOption(TransactionId)(input.params.id))
        ? Option.some(input.params.id)
        : Option.none()
  );
  return Option.isSome(unstable)
    ? transactionRefusal({
        db: work.db,
        subject: work.subject,
        operation: "transactions.updateTransaction",
        refusal: { outcome: "not_found", message: missingTransactionMessage },
        current: work.current,
      })
    : transactionInvalidRefusal("transactions.updateTransaction")(work);
};

/** The keyword-rule owner records no refusal Audit and renders the declared validation failure. */
const keywordRuleInvalidRefusal = (_work: CanonicalPreparationWork): CanonicalMutationRefusal => ({
  code: "validation_failed",
  message: invalidChildMessage,
  record: () => Effect.succeed("recorded" as const),
  respond: () => Effect.succeed(keywordRuleInvalidInput()),
});

/** The Memory owner records its own validation refusal, like the individual entry point. */
const memoryInvalidRefusal =
  (operation: MemoryOperationId) =>
  (work: CanonicalPreparationWork): CanonicalMutationRefusal =>
    invalidMemoryInput({
      db: work.db,
      subject: work.subject,
      operation,
      current: work.current,
    });

/** Recover one owner's typed payload from an input the catalog call schema already validated. */
const decodeAndPrepare =
  <Decoded>(
    schema: Schema.Codec<Decoded, unknown, never, never>,
    decide: (
      decoded: Decoded,
      work: CanonicalPreparationWork
    ) => Effect.Effect<CanonicalMutationPreparation, never, HostedInference>
  ): CanonicalMutationAdapter["prepare"] =>
  (work) =>
    Option.match(Schema.decodeUnknownOption(Schema.toType(schema))(work.input), {
      onNone: () => Effect.succeed(failedPreparation()),
      onSome: (decoded) => decide(decoded, work),
    });

const InsightParams = Schema.Struct({ id: InsightEventId });
const ReadInsight = Schema.Struct({ params: InsightParams });
const DeliverInsight = Schema.Struct({ params: InsightParams, payload: DeliveryEvidenceInput });
const insightAdapter = (
  operation: "insights.markInsightRead" | "insights.dismissInsight"
): CanonicalMutationAdapter => ({
  prepare: decodeAndPrepare(ReadInsight, ({ params }, work) =>
    prepareInsightTransition({
      db: work.db,
      subject: work.subject,
      operation,
      id: params.id,
      current: work.current,
    })
  ),
  present: present(HTTP_OK),
  invalidRefusal: (work) =>
    insightRefusal({
      db: work.db,
      subject: work.subject,
      operation,
      current: work.current,
      code: "not_found",
    }),
});

const adapters: ReadonlyMap<CanonicalOperationId, CanonicalMutationAdapter> = new Map<
  CanonicalOperationId,
  CanonicalMutationAdapter
>([
  ...(
    [
      [
        "dashboard.initializeDashboard",
        decodeAndPrepare(InitializeDashboardCanonicalInput, (_input, work) =>
          prepareDashboard({
            work,
            operation: "dashboard.initializeDashboard",
            edit: Option.none(),
          })
        ),
      ],
      [
        "dashboard.getDashboard",
        decodeAndPrepare(GetDashboardCanonicalInput, (_input, work) =>
          prepareDashboard({ work, operation: "dashboard.getDashboard", edit: Option.none() })
        ),
      ],
      [
        "dashboard.getDashboardView",
        decodeAndPrepare(GetDashboardViewCanonicalInput, (_input, work) =>
          prepareDashboard({ work, operation: "dashboard.getDashboardView", edit: Option.none() })
        ),
      ],
      [
        "dashboard.applyDashboardEdit",
        decodeAndPrepare(ApplyDashboardEditCanonicalInput, ({ payload }, work) =>
          prepareDashboard({
            work,
            operation: "dashboard.applyDashboardEdit",
            edit: Option.some(payload),
          })
        ),
      ],
    ] as const
  ).map(
    ([operation, prepare]) =>
      [
        CanonicalOperationId.make(operation),
        {
          prepare,
          present: (value: CommittedMutationValue) =>
            value._tag === "Owner"
              ? presentDashboard(value)
              : Effect.succeed(transactionUnavailable()),
          invalidRefusal: (work: CanonicalPreparationWork) =>
            dashboardRefusal({ work, operation, code: "validation_failed" }),
        },
      ] as const
  ),
  [
    CanonicalOperationId.make("insights.markInsightDelivered"),
    {
      prepare: decodeAndPrepare(DeliverInsight, ({ params, payload }, work) =>
        prepareInsightTransition({
          db: work.db,
          subject: work.subject,
          operation: "insights.markInsightDelivered",
          id: params.id,
          evidence: payload,
          current: work.current,
        })
      ),
      present: present(HTTP_OK),
      invalidRefusal: (work) =>
        insightRefusal({
          db: work.db,
          subject: work.subject,
          operation: "insights.markInsightDelivered",
          current: work.current,
          code: "validation_failed",
        }),
    },
  ],
  [
    CanonicalOperationId.make("insights.markInsightRead"),
    insightAdapter("insights.markInsightRead"),
  ],
  [CanonicalOperationId.make("insights.dismissInsight"), insightAdapter("insights.dismissInsight")],
  [
    CanonicalOperationId.make("budgets.createBudget"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("budgets.createBudget"),
        ({ payload }, work) =>
          prepareCreateBudget({
            db: work.db,
            subject: work.subject,
            payload,
            current: work.current,
          })
      ),
      present: present(HTTP_CREATED),
      invalidRefusal: (work) =>
        budgetRefusal({
          db: work.db,
          subject: work.subject,
          current: work.current,
          operation: "budgets.createBudget",
          code: "validation_failed",
        }),
    },
  ],
  [
    CanonicalOperationId.make("budgets.updateBudget"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("budgets.updateBudget"),
        ({ params, payload }, work) =>
          prepareUpdateBudget({
            db: work.db,
            subject: work.subject,
            id: params.id,
            payload,
            current: work.current,
          })
      ),
      present: present(HTTP_OK),
      invalidRefusal: (work) =>
        budgetRefusal({
          db: work.db,
          subject: work.subject,
          current: work.current,
          operation: "budgets.updateBudget",
          code: "validation_failed",
        }),
    },
  ],
  [
    CanonicalOperationId.make("budgets.deleteBudget"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("budgets.deleteBudget"),
        ({ params }, work) =>
          prepareDeleteBudget({
            db: work.db,
            subject: work.subject,
            id: params.id,
            current: work.current,
          })
      ),
      present: present(HTTP_OK),
      invalidRefusal: (work) =>
        budgetRefusal({
          db: work.db,
          subject: work.subject,
          current: work.current,
          operation: "budgets.deleteBudget",
          code: "not_found",
        }),
    },
  ],
  [
    CanonicalOperationId.make("ingestion.submitForExtraction"),
    {
      prepare: prepareStatementSubmission,
      present: presentStatementSubmission,
      invalidRefusal: invalidStatementSubmission,
    },
  ],
  [
    CanonicalOperationId.make("ingestion.enableEmailForwarding"),
    {
      prepare: prepareForwardingAddress,
      present: presentForwardingAddress,
      invalidRefusal: invalidForwardingAddress,
    },
  ],
  [
    CanonicalOperationId.make("transactions.createTransaction"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("transactions.createTransaction"),
        ({ payload }, work) =>
          prepareCapture({
            db: work.db,
            subject: work.subject,
            input: payload,
            current: work.current,
          })
      ),
      present: present(HTTP_CREATED),
      invalidRefusal: transactionInvalidRefusal("transactions.createTransaction"),
    },
  ],
  [
    CanonicalOperationId.make("transactions.updateTransaction"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("transactions.updateTransaction"),
        ({ params, payload }, work) =>
          prepareCorrection({
            db: work.db,
            subject: work.subject,
            id: params.id,
            input: payload,
            current: work.current,
          })
      ),
      present: present(HTTP_OK),
      invalidRefusal: correctionInvalidRefusal,
    },
  ],
  [
    CanonicalOperationId.make("transactions.linkTransactions"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("transactions.linkTransactions"),
        ({ payload }, work) =>
          prepareLink({
            db: work.db,
            subject: work.subject,
            pair: payload,
            current: work.current,
          })
      ),
      present: present(HTTP_OK),
      invalidRefusal: transactionInvalidRefusal("transactions.linkTransactions"),
    },
  ],
  [
    CanonicalOperationId.make("transactions.unlinkTransactions"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("transactions.unlinkTransactions"),
        ({ payload }, work) =>
          prepareUnlink({
            db: work.db,
            subject: work.subject,
            pair: payload,
            current: work.current,
          })
      ),
      present: present(HTTP_OK),
      invalidRefusal: transactionInvalidRefusal("transactions.unlinkTransactions"),
    },
  ],
  [
    CanonicalOperationId.make("categories.createKeywordRule"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("categories.createKeywordRule"),
        ({ payload }, work) =>
          prepareCreateKeywordRule({
            db: work.db,
            subject: work.subject,
            payload,
            current: work.current,
          })
      ),
      present: present(HTTP_CREATED),
      invalidRefusal: keywordRuleInvalidRefusal,
    },
  ],
  [
    CanonicalOperationId.make("categories.updateKeywordRule"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("categories.updateKeywordRule"),
        ({ params, payload }, work) =>
          prepareUpdateKeywordRule({
            db: work.db,
            subject: work.subject,
            ruleId: params.id,
            payload,
            current: work.current,
          })
      ),
      present: present(HTTP_OK),
      invalidRefusal: keywordRuleInvalidRefusal,
    },
  ],
  [
    CanonicalOperationId.make("categories.deleteKeywordRule"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("categories.deleteKeywordRule"),
        ({ params }, work) =>
          prepareDeleteKeywordRule({
            db: work.db,
            subject: work.subject,
            ruleId: params.id,
            current: work.current,
          })
      ),
      present: present(HTTP_OK),
      invalidRefusal: keywordRuleInvalidRefusal,
    },
  ],
  [
    CanonicalOperationId.make("memory.remember"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("memory.remember"),
        ({ payload }, work) =>
          prepareRemember({
            db: work.db,
            subject: work.subject,
            payload,
            current: work.current,
          })
      ),
      present: present(HTTP_CREATED),
      invalidRefusal: memoryInvalidRefusal("memory.remember"),
    },
  ],
  [
    CanonicalOperationId.make("memory.revise"),
    {
      prepare: decodeAndPrepare(
        getCanonicalOperationInput("memory.revise"),
        ({ params, payload }, work) =>
          prepareRevise({
            db: work.db,
            subject: work.subject,
            id: params.id,
            payload,
            current: work.current,
          })
      ),
      present: present(HTTP_OK),
      invalidRefusal: memoryInvalidRefusal("memory.revise"),
    },
  ],
  [
    CanonicalOperationId.make("memory.forget"),
    {
      prepare: decodeAndPrepare(getCanonicalOperationInput("memory.forget"), ({ params }, work) =>
        prepareForget({
          db: work.db,
          subject: work.subject,
          id: params.id,
          current: work.current,
        })
      ),
      present: present(HTTP_OK),
      invalidRefusal: memoryInvalidRefusal("memory.forget"),
    },
  ],
]);

/** The owner adapter for one canonical mutation, or None when no owner composes it yet. */
export const canonicalMutationAdapter = (
  operation: CanonicalOperationId
): Option.Option<CanonicalMutationAdapter> => Option.fromUndefinedOr(adapters.get(operation));

/** An installed owner adapter must name a published composable mutation. Missing adapters fail closed. */
const assertCanonicalMutationAdapters = (): void => {
  const published = new Set(getAtomicBatchChildIds());
  for (const operation of adapters.keys()) {
    if (!published.has(operation)) {
      throw new Error(`Canonical mutation adapter is not a composable child: ${operation}`);
    }
  }
};

assertCanonicalMutationAdapters();
