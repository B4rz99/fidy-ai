import { Effect, Option, Schema } from "effect";
import {
  CanonicalOperationId,
  getAtomicBatchChildIds,
  getCanonicalOperationInput,
} from "@fidy/server/canonical-runtime";
import { TransactionId } from "@fidy/server/transactions-runtime";
import { type MemoryOperationId } from "@fidy/server/memory-runtime";
import { type HostedInference } from "@fidy/server/hosted-inference";
import { statementMutationAdapter } from "./statement-mutation";
import { forwardingAddressMutationAdapter } from "./forwarding-address-mutation";
import { prepareCreateBudget, prepareDeleteBudget, prepareUpdateBudget } from "../budgets/budgets";
import { budgetRefusal } from "../budgets/budget-outcome";
import { transactionRefusal } from "./transaction-outcome";
import { memoryRefusal } from "./memory-outcome";
import {
  type TransactionCaller,
  type TransactionMutationOperation,
  missingTransactionMessage,
} from "../transactions/transaction-boundary";
import { prepareCapture } from "../transactions/transactions";
import { prepareCorrection } from "../transactions/transaction-corrections";
import { prepareLink, prepareUnlink } from "../transactions/transaction-reconciliation";
import {
  keywordRuleInvalidInput,
  prepareCreateKeywordRule,
  prepareDeleteKeywordRule,
  prepareUpdateKeywordRule,
} from "../categories/canonical-keyword-rules";
import { prepareForget, prepareRemember, prepareRevise } from "../memory/memory";
import { committedJsonResponse } from "./canonical-mutation-unit";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type CommittedMutationValue,
  failedPreparation,
} from "./mutation-types";

/** One canonical child as the batch carries it, plus the caller the owner prepares it under. */
type CanonicalMutationWork = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  bucket: Option.Option<R2Bucket>;
  /**
   * The attempted input the catalog call schema already validated, which `prepare` decodes once
   * more through the owner's own codec only to recover that codec's typed payload: a failure
   * there is schema drift and answers `failedPreparation()`, never a caller validation failure.
   * `invalidRefusal` receives the raw attempted input instead, so an owner that classifies
   * undecoded input answers as its individual entry point does.
   */
  input: unknown;
}>;

/**
 * One owner's canonical mutation adapter: it decides a child without committing, presents a
 * committed child's canonical individual response, and answers for a child whose callId or
 * canonical input failed its published schema.
 */
export type CanonicalMutationAdapter = Readonly<{
  prepare: (
    work: CanonicalMutationWork
  ) => Effect.Effect<CanonicalMutationPreparation, never, HostedInference>;
  present: (value: CommittedMutationValue) => Effect.Effect<Response>;
  invalidRefusal: (work: CanonicalMutationWork) => CanonicalMutationRefusal;
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
  (work: CanonicalMutationWork): CanonicalMutationRefusal =>
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
const correctionInvalidRefusal = (work: CanonicalMutationWork): CanonicalMutationRefusal => {
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
const keywordRuleInvalidRefusal = (_work: CanonicalMutationWork): CanonicalMutationRefusal => ({
  code: "validation_failed",
  message: invalidChildMessage,
  record: () => Effect.succeed("recorded" as const),
  respond: () => Effect.succeed(keywordRuleInvalidInput()),
});

/** The Memory owner records its own validation refusal, like the individual entry point. */
const memoryInvalidRefusal =
  (operation: MemoryOperationId) =>
  (work: CanonicalMutationWork): CanonicalMutationRefusal =>
    memoryRefusal({
      db: work.db,
      subject: work.subject,
      operation,
      outcome: "validation_failed",
      current: work.current,
    });

/** Recover one owner's typed payload from an input the catalog call schema already validated. */
const decodeAndPrepare =
  <Decoded>(
    schema: Schema.Codec<Decoded, unknown, never, never>,
    decide: (
      decoded: Decoded,
      work: CanonicalMutationWork
    ) => Effect.Effect<CanonicalMutationPreparation, never, HostedInference>
  ): CanonicalMutationAdapter["prepare"] =>
  (work) =>
    Option.match(Schema.decodeUnknownOption(Schema.toType(schema))(work.input), {
      onNone: () => Effect.succeed(failedPreparation()),
      onSome: (decoded) => decide(decoded, work),
    });

const adapters: ReadonlyMap<CanonicalOperationId, CanonicalMutationAdapter> = new Map<
  CanonicalOperationId,
  CanonicalMutationAdapter
>([
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
  [CanonicalOperationId.make("ingestion.submitForExtraction"), statementMutationAdapter],
  [CanonicalOperationId.make("ingestion.enableEmailForwarding"), forwardingAddressMutationAdapter],
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
