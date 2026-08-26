import { DateTime, Effect, Option, Schema } from "effect";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import {
  type CanonicalCaller,
  ChildOperationAudit,
  type ChildOperationAuditService,
  toAccessCaller,
} from "~/shell/_shared/authz";
import { type OperationPolicyValue, decideOperationAccess } from "~/shell/_shared/operation-policy";
import {
  type CanonicalMutationCall,
  CanonicalMutationEffects,
  type CanonicalMutationFailure,
  assertCanonicalMutationRegistry,
  dispatchCanonicalMutation,
} from "~/shell/_shared/canonical-mutation-registry";
import type { CanonicalImplementationRequirements } from "~/shell/_shared/canonical-implementation";
import {
  CanonicalPreTransactions,
  withCanonicalPreTransaction,
} from "~/shell/_shared/canonical-pre-transaction";
import { operationCatalog } from "~/shell/api";
import {
  type AtomicBatchCall,
  type AtomicBatchInput,
  type AtomicBatchOutput,
  AtomicBatchRejected,
  type AtomicBatchResult,
  decodeAtomicBatchResult,
  getAtomicBatchCallSchema,
} from "./operations";

const ordinaryOperations = operationCatalog.operations.filter(
  ({ id }) => id !== "operations.executeAtomicBatch"
);
assertCanonicalMutationRegistry({
  operations: ordinaryOperations,
  byId: new Map(ordinaryOperations.map((operation) => [operation.id, operation])),
});

const operationById = new Map(
  operationCatalog.operations.map((operation) => [operation.id, operation] as const)
);

const rejected = (
  index: number,
  operation: AtomicBatchCall["operation"],
  failure: CanonicalMutationFailure
): AtomicBatchRejected =>
  AtomicBatchRejected.make({
    error: {
      code: failure.error.code,
      message: failure.error.message,
      failedCallIndex: index,
      operation: CanonicalOperationId.make(operation),
      fields: "fields" in failure.error ? failure.error.fields : [],
    },
    next: failure.next,
  });

type PolicyRejection = Readonly<{
  index: number;
  operation: AtomicBatchCall["operation"];
  code: "scope_missing" | "paywall_required";
  message: string;
}>;

const rejectPolicy = ({ code, index, message, operation }: PolicyRejection): AtomicBatchRejected =>
  AtomicBatchRejected.make({
    error: {
      code,
      message,
      failedCallIndex: index,
      operation: CanonicalOperationId.make(operation),
      fields: [],
    },
    next: [],
  });

const recordChild = (
  childAudit: ChildOperationAuditService,
  operation: AtomicBatchCall["operation"],
  outcome: "succeeded" | "failed" | "rejected"
): Effect.Effect<void> =>
  DateTime.now.pipe(
    Effect.flatMap((occurredAt) =>
      childAudit.record({
        operation: CanonicalOperationId.make(operation),
        outcome,
        occurredAt,
      })
    )
  );

const rejectChild = (
  childAudit: ChildOperationAuditService,
  rejection: PolicyRejection
): Effect.Effect<never, AtomicBatchRejected> =>
  recordChild(childAudit, rejection.operation, "rejected").pipe(
    Effect.andThen(Effect.fail(rejectPolicy(rejection)))
  );

type ExecuteChild = Readonly<{
  call: AtomicBatchInput["calls"][number];
  index: number;
  caller: CanonicalCaller;
  childAudit: ChildOperationAuditService;
}>;

const decodeCanonicalMutationCall = (
  value: unknown
): Effect.Effect<CanonicalMutationCall, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(
    Schema.toType(
      Schema.make<Schema.Codec<CanonicalMutationCall, Schema.Json>>(getAtomicBatchCallSchema().ast)
    )
  )(value);

const hasChildAccess = (operation: OperationPolicyValue, caller: CanonicalCaller): boolean =>
  decideOperationAccess(operation.access, toAccessCaller(caller))._tag === "Allowed";

const executeChild = Effect.fn("executeAtomicBatchChild")(function* ({
  call,
  childAudit,
  index,
  caller,
}: ExecuteChild) {
  const catalogOperation = operationById.get(CanonicalOperationId.make(call.operation));
  if (catalogOperation?.policy.kind !== "mutation") {
    return yield* rejectChild(childAudit, {
      index,
      operation: call.operation,
      code: "scope_missing",
      message:
        "The child is not an executable canonical mutation. Correct the operation and retry the whole batch.",
    });
  }
  if (!hasChildAccess(catalogOperation.policy, caller)) {
    return yield* rejectChild(childAudit, {
      index,
      operation: call.operation,
      code: "scope_missing",
      message:
        "The caller does not grant the access declared by this child mutation. Correct authority before retrying the whole batch.",
    });
  }
  if (catalogOperation.policy.requiredTier !== "free") {
    return yield* rejectChild(childAudit, {
      index,
      operation: call.operation,
      code: "paywall_required",
      message:
        "The User's Subscription tier does not grant this child mutation. Upgrade before retrying the whole batch.",
    });
  }

  // Recover the operation/input correlation established by the catalog-derived HTTP decoder before
  // crossing into the implementation registry's exact dispatch interface.
  const mutationCall = yield* decodeCanonicalMutationCall(call).pipe(Effect.orDie);
  const output = yield* dispatchCanonicalMutation(mutationCall, { resolved: caller }).pipe(
    Effect.tap(() => recordChild(childAudit, call.operation, "succeeded")),
    Effect.tapError(() => recordChild(childAudit, call.operation, "failed")),
    Effect.mapError((failure) => rejected(index, call.operation, failure)),
    Effect.withSpan(`fidy.batch.${call.operation}`, {
      attributes: {
        "fidy.batch.call_index": index,
        "fidy.operation.access": catalogOperation.policy.access._tag,
        "fidy.operation.required_tier": catalogOperation.policy.requiredTier,
        "fidy.operation.agent_confirmation": catalogOperation.policy.agentConfirmation,
      },
    })
  );
  return yield* decodeAtomicBatchResult({
    callId: call.callId,
    operation: call.operation,
    output,
  }).pipe(Effect.orDie);
});

/** Facts supplied after canonical decoding and caller authorization for atomic batch execution. */
export type AtomicBatchExecutionInput = Readonly<{
  payload: AtomicBatchInput;
  caller: CanonicalCaller;
}>;

const prepareAtomicBatch = Effect.fn("prepareAtomicBatch")(function* ({
  payload,
  caller,
}: AtomicBatchExecutionInput) {
  const preparedStates: Array<Schema.Json> = [];
  for (const call of payload.calls) {
    const catalogOperation = operationById.get(CanonicalOperationId.make(call.operation));
    if (
      catalogOperation?.policy.kind !== "mutation" ||
      !hasChildAccess(catalogOperation.policy, caller) ||
      catalogOperation.policy.requiredTier !== "free"
    ) {
      continue;
    }
    const mutationCall = yield* decodeCanonicalMutationCall(call).pipe(Effect.orDie);
    const preparation = CanonicalPreTransactions.find(
      CanonicalMutationEffects.make(mutationCall, { resolved: caller }),
      caller,
      catalogOperation.id
    );
    if (Option.isSome(preparation)) preparedStates.push(...(yield* preparation.value));
  }
  return preparedStates;
});

/**
 * Executes child canonical mutations in order without owning their data or transaction. This named
 * shell coordination module is deliberately neither queries.ts nor mutations.ts: HTTP and hosted
 * adapters supply the resolved caller, while the canonical executor owns commit or rollback.
 */
export const executeAtomicBatch = (
  input: AtomicBatchExecutionInput
): Effect.Effect<
  Readonly<{ data: AtomicBatchOutput; next: readonly [] }>,
  AtomicBatchRejected,
  ChildOperationAudit | CanonicalImplementationRequirements
> => {
  const execute = Effect.gen(function* () {
    const childAudit = yield* ChildOperationAudit;
    const results: Array<AtomicBatchResult> = [];
    for (const [index, call] of input.payload.calls.entries()) {
      results.push(yield* executeChild({ call, childAudit, index, caller: input.caller }));
    }
    const [first, ...rest] = results;
    if (first === undefined) return yield* Effect.die("Non-empty batch produced no results");
    const next: readonly [] = [];
    return { data: { results: [first, ...rest] as const }, next };
  });
  return withCanonicalPreTransaction(
    execute.pipe(Effect.withSpan("executeAtomicBatch")),
    prepareAtomicBatch(input)
  );
};
