import { Effect, Option, Schema } from "effect";
import {
  CanonicalOperationId,
  CreateTransactionCanonicalInput,
  LinkTransactionsCanonicalInput,
  UnlinkTransactionsCanonicalInput,
  UpdateTransactionCanonicalInput,
  atomicBatchChildOperations,
  getAtomicBatchChildIds,
  operationCatalog,
} from "@fidy/server/canonical-runtime";
import { TransactionId } from "@fidy/server/transactions-runtime";
import {
  CreateKeywordRuleCanonicalInput,
  DeleteKeywordRuleCanonicalInput,
  UpdateKeywordRuleCanonicalInput,
} from "@fidy/server/categories";
import {
  ForgetCanonicalInput,
  type MemoryOperationId,
  RememberCanonicalInput,
  ReviseCanonicalInput,
} from "@fidy/server/memory-runtime";
import { type HostedInference } from "@fidy/server/hosted-inference";
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
    CanonicalOperationId.make("transactions.createTransaction"),
    {
      prepare: decodeAndPrepare(CreateTransactionCanonicalInput, ({ payload }, work) =>
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
      prepare: decodeAndPrepare(UpdateTransactionCanonicalInput, ({ params, payload }, work) =>
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
      prepare: decodeAndPrepare(LinkTransactionsCanonicalInput, ({ payload }, work) =>
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
      prepare: decodeAndPrepare(UnlinkTransactionsCanonicalInput, ({ payload }, work) =>
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
      prepare: decodeAndPrepare(CreateKeywordRuleCanonicalInput, ({ payload }, work) =>
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
      prepare: decodeAndPrepare(UpdateKeywordRuleCanonicalInput, ({ params, payload }, work) =>
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
      prepare: decodeAndPrepare(DeleteKeywordRuleCanonicalInput, ({ params }, work) =>
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
      prepare: decodeAndPrepare(RememberCanonicalInput, ({ payload }, work) =>
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
      prepare: decodeAndPrepare(ReviseCanonicalInput, ({ params, payload }, work) =>
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
      prepare: decodeAndPrepare(ForgetCanonicalInput, ({ params }, work) =>
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

/**
 * The catalog-derived execution registry: every assembled composable canonical mutation maps to the
 * owner adapter that executes it, or to None so the caller fails closed. Queries, nested batches,
 * and ADR 0027 standalone account-security mutations are excluded by construction through the
 * reflected child set rather than by a readiness allowlist.
 */
export const canonicalMutationAdapters = (): ReadonlyMap<
  CanonicalOperationId,
  Option.Option<CanonicalMutationAdapter>
> => {
  const registry = new Map<CanonicalOperationId, Option.Option<CanonicalMutationAdapter>>();
  for (const operation of atomicBatchChildOperations(operationCatalog)) {
    registry.set(operation.id, canonicalMutationAdapter(operation.id));
  }
  return registry;
};

/**
 * Proves the published child-call union, the adapter registry, and the catalog-derived child set
 * coincide: every union child resolves to an adapter (or an explicit fail-closed None), no adapter
 * sits unreachable, and the registry holds no child the union cannot name. A drift in either
 * derivation fails here instead of silently dropping work.
 */
export const assertCanonicalMutationAdapters = (): void => {
  const published = new Set(getAtomicBatchChildIds());
  const registry = canonicalMutationAdapters();
  for (const child of published) {
    if (!registry.has(child)) {
      throw new Error(`Canonical mutation execution registry is missing a child: ${child}`);
    }
  }
  for (const child of registry.keys()) {
    if (!published.has(child)) {
      throw new Error(`Canonical mutation execution registry names an unpublished child: ${child}`);
    }
  }
  for (const operation of adapters.keys()) {
    if (!published.has(operation)) {
      throw new Error(`Canonical mutation adapter is not a composable child: ${operation}`);
    }
  }
};

// The live dispatch layer proves registry completeness at startup: importing this registry fails
// closed when the catalog and the owner adapters have drifted, instead of silently dropping work.
assertCanonicalMutationAdapters();
