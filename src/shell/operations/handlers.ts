import { DateTime, Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import type { ResolvedAgentToken } from "~/core/tokens/model";
import {
  ChildOperationAudit,
  type ChildOperationAuditService,
  ResolvedCaller,
} from "~/shell/_shared/authz";
import {
  type CanonicalMutationCall,
  type CanonicalMutationFailure,
  assertCanonicalMutationRegistry,
  dispatchCanonicalMutation,
} from "~/shell/_shared/canonical-mutation-registry";
import { FidyApi, operationCatalog } from "~/shell/api";
import {
  type AtomicBatchCall,
  type AtomicBatchInput,
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
  resolved: ResolvedAgentToken;
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

const executeChild = Effect.fn("executeAtomicBatchChild")(function* ({
  call,
  childAudit,
  index,
  resolved,
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
  if (!resolved.scopes.includes(catalogOperation.policy.requiredScope)) {
    return yield* rejectChild(childAudit, {
      index,
      operation: call.operation,
      code: "scope_missing",
      message:
        "This AgentToken does not grant the scope declared by this child mutation. Broaden the token before retrying the whole batch.",
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
  const output = yield* dispatchCanonicalMutation(mutationCall, { resolved }).pipe(
    Effect.tap(() => recordChild(childAudit, call.operation, "succeeded")),
    Effect.tapError(() => recordChild(childAudit, call.operation, "failed")),
    Effect.mapError((failure) => rejected(index, call.operation, failure)),
    Effect.withSpan(`fidy.batch.${call.operation}`, {
      attributes: {
        "fidy.batch.call_index": index,
        "fidy.operation.required_scope": catalogOperation.policy.requiredScope,
        "fidy.operation.required_tier": catalogOperation.policy.requiredTier,
        "fidy.operation.cost_class": catalogOperation.policy.costClass,
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

const executeAtomicBatch = Effect.fn("executeAtomicBatch")(function* (payload: AtomicBatchInput) {
  const resolved = yield* ResolvedCaller;
  const childAudit = yield* ChildOperationAudit;
  const results: Array<AtomicBatchResult> = [];
  for (const [index, call] of payload.calls.entries()) {
    results.push(yield* executeChild({ call, childAudit, index, resolved }));
  }
  const [first, ...rest] = results;
  if (first === undefined) return yield* Effect.die("Non-empty batch produced no results");
  return { data: { results: [first, ...rest] as const }, next: [] };
});

/** Visible canonical batch handler; the authorization middleware owns its User transaction. */
export const OperationsLive = HttpApiBuilder.group(FidyApi, "operations", (handlers) =>
  handlers.handle("executeAtomicBatch", ({ payload }) => executeAtomicBatch(payload))
);
