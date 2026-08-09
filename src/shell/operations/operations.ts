import * as Arr from "effect/Array";
import { type Effect, Option, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { ErrorCode, FieldIssue } from "~/shell/_shared/errors";
import type { CatalogOperation, OperationCatalog } from "~/shell/_shared/operation-catalog";
import { childScopeOperationPolicy } from "~/shell/_shared/operation-policy";
import { NextOperations, OperationResponse } from "~/shell/_shared/response";

const operationsGroupName = "operations";
const atomicBatchEndpointName = "executeAtomicBatch";

/** Identity of the canonical mutation that executes one ordered atomic batch. */
export const atomicBatchOperation = CanonicalOperationId.make(
  `${operationsGroupName}.${atomicBatchEndpointName}`
);

/** Maximum child mutations accepted by one atomic batch request. */
export const maximumAtomicBatchCalls = 12;

/** Stable caller-chosen correlation id for one child mutation and its result. */
export const AtomicBatchCallId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("AtomicBatchCallId"))
  .annotate({ identifier: "AtomicBatchCallId" });
export type AtomicBatchCallId = typeof AtomicBatchCallId.Type;

export type AtomicBatchCall = Readonly<{
  callId: AtomicBatchCallId;
  operation: string;
  input: unknown;
}>;
type NonEmptyMutationCalls = readonly [AtomicBatchCall, ...ReadonlyArray<AtomicBatchCall>];

/** Non-empty ordered canonical mutation calls accepted by the atomic batch operation. */
export type AtomicBatchInput = Readonly<{ calls: NonEmptyMutationCalls }>;

export type AtomicBatchResult = Readonly<{
  callId: AtomicBatchCallId;
  operation: string;
  output: unknown;
}>;
type NonEmptyMutationResults = readonly [AtomicBatchResult, ...ReadonlyArray<AtomicBatchResult>];

/** Ordered child results, each correlated to the submitted id and canonical mutation. */
export type AtomicBatchOutput = Readonly<{ results: NonEmptyMutationResults }>;

/**
 * Actionable failure of one child mutation. The whole batch has rolled back; `failedCallIndex` and
 * `operation` identify the correction target without retaining any request or response body.
 */
export class AtomicBatchRejected extends Schema.ErrorClass<AtomicBatchRejected>(
  "AtomicBatchRejected"
)(
  {
    error: Schema.Struct({
      code: ErrorCode,
      message: Schema.NonEmptyString.check(Schema.isTrimmed()),
      failedCallIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      operation: CanonicalOperationId,
      fields: Schema.Array(FieldIssue),
    }),
    next: NextOperations,
  },
  { httpApiStatus: 400 }
) {}

let boundAtomicBatchCall = Option.none<Schema.Codec<AtomicBatchCall, Schema.Json>>();
let boundAtomicBatchInput = Option.none<AtomicBatchInputSchema>();
let boundAtomicBatchResult = Option.none<Schema.Codec<AtomicBatchResult, Schema.Json>>();

/** The catalog-derived call schema used to recover exact registry correlation after HTTP decoding. */
export const getAtomicBatchCallSchema = (): Schema.Codec<AtomicBatchCall, Schema.Json> =>
  Option.getOrThrowWith(
    boundAtomicBatchCall,
    () => new Error("Atomic batch call schema has not been derived")
  );

/** The canonical operation input schema for one ordered atomic mutation batch. */
export const getAtomicBatchInputSchema = (): AtomicBatchInputSchema =>
  Option.getOrThrowWith(
    boundAtomicBatchInput,
    () => new Error("Atomic batch input schema has not been derived")
  );

/** Revalidates the runtime registry output against the catalog-derived correlated result union. */
export const decodeAtomicBatchResult = (
  value: unknown
): Effect.Effect<AtomicBatchResult, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(
    Schema.toType(
      Option.getOrThrowWith(
        boundAtomicBatchResult,
        () => new Error("Atomic batch result schema has not been derived")
      )
    )
  )(value);

const mutationOperations = (catalog: OperationCatalog): ReadonlyArray<CatalogOperation> =>
  catalog.operations.filter((operation) => operation.policy.kind === "mutation");

const mutationCallMember = (operation: CatalogOperation): Schema.Top =>
  Schema.Struct({
    callId: AtomicBatchCallId,
    operation: Schema.Literal(operation.id),
    input: operation.input,
  });

const mutationResultMember = (operation: CatalogOperation): Schema.Top =>
  Schema.Struct({
    callId: AtomicBatchCallId,
    operation: Schema.Literal(operation.id),
    output: operation.success,
  });

const catalogUnion = (
  operations: ReadonlyArray<CatalogOperation>,
  member: (operation: CatalogOperation) => Schema.Top
): Schema.Top => {
  const members = operations.map(member);
  if (!Arr.isReadonlyArrayNonEmpty(members)) {
    throw new Error("Atomic batch derivation requires at least one canonical mutation");
  }
  return Schema.Union(members);
};

type AtomicBatchCallSchema = Schema.Codec<AtomicBatchCall, Schema.Json>;
type AtomicBatchResultSchema = Schema.Codec<AtomicBatchResult, Schema.Json>;
type AtomicBatchInputSchema = Schema.Struct<{
  readonly calls: Schema.NonEmptyArray<AtomicBatchCallSchema>;
}>;
type AtomicBatchOutputSchema = Schema.Struct<{
  readonly results: Schema.NonEmptyArray<AtomicBatchResultSchema>;
}>;
type AtomicBatchResponseSchema = ReturnType<typeof OperationResponse<AtomicBatchOutputSchema>>;
type AtomicBatchEndpoint = HttpApiEndpoint.HttpApiEndpoint<
  "executeAtomicBatch",
  "POST",
  "/operations/atomic-batch",
  never,
  never,
  Schema.toCodecJson<AtomicBatchInputSchema>,
  never,
  Schema.toCodecJson<AtomicBatchResponseSchema>,
  Schema.toCodecJson<typeof AtomicBatchRejected>
>;
type OperationsGroup = HttpApiGroup.HttpApiGroup<"operations", AtomicBatchEndpoint>;

/**
 * Derives the visible batch operation from the ordinary catalog. Because that catalog is assembled
 * before this group exists, canonical queries and the batch operation itself cannot enter either
 * the child-call or correlated-result tagged union.
 */
export const makeOperationsGroup = (ordinaryCatalog: OperationCatalog): OperationsGroup => {
  const mutations = mutationOperations(ordinaryCatalog);
  const call = Schema.make<Schema.Codec<AtomicBatchCall, Schema.Json>>(
    catalogUnion(mutations, mutationCallMember).ast
  );
  const result = Schema.make<Schema.Codec<AtomicBatchResult, Schema.Json>>(
    catalogUnion(mutations, mutationResultMember).ast
  );
  boundAtomicBatchCall = Option.some(call);
  boundAtomicBatchResult = Option.some(result);
  const input = Schema.Struct({
    calls: Schema.NonEmptyArray(call).check(Schema.isMaxLength(maximumAtomicBatchCalls)),
  });
  boundAtomicBatchInput = Option.some(input);
  const output = Schema.Struct({
    results: Schema.NonEmptyArray(result).check(Schema.isMaxLength(maximumAtomicBatchCalls)),
  });

  return HttpApiGroup.make(operationsGroupName).add(
    HttpApiEndpoint.post(atomicBatchEndpointName, "/operations/atomic-batch", {
      payload: input,
      success: OperationResponse(output),
      error: AtomicBatchRejected,
    })
      .annotate(
        OpenApi.Description,
        "Execute a non-empty ordered set of canonical mutations in one User-scoped PostgreSQL transaction. Use this when several state changes must commit together; each child keeps its own scope, Subscription tier, cost class, confirmation policy, validation, and canonical failure. Queries and nested batches are not valid children."
      )
      .annotateMerge(
        childScopeOperationPolicy({
          requiredScope: "write",
          requiredTier: "free",
          costClass: "expensive",
          agentConfirmation: "required",
          kind: "mutation",
        })
      )
  );
};
