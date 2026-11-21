import * as Arr from "effect/Array";
import { type Brand, Option, Predicate, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import {
  ErrorCode,
  FieldIssue,
  NextOperations,
  OperationResponse,
} from "~/shell/public-http/contract";
import type { CatalogOperation, OperationCatalog } from "~/shell/canonical-catalog/contract";
import {
  isUserOwnedAgentScoped,
  operationPolicy,
  userOwnedAgentScopedChildren,
} from "~/shell/canonical-policy/contract";

const operationsGroupName = "operations";

const atomicBatchEndpointName = "executeAtomicBatch";

export const atomicBatchOperation = Schema.Literal(
  `${operationsGroupName}.${atomicBatchEndpointName}`
)
  .pipe(Schema.brand("CanonicalOperationId"))
  .make(`${operationsGroupName}.${atomicBatchEndpointName}`);

export const maximumAtomicBatchCalls = 12;

export const AtomicBatchAdmission = Schema.Struct({
  payload: Schema.Struct({
    calls: Schema.NonEmptyArray(Schema.Unknown).check(Schema.isMaxLength(maximumAtomicBatchCalls)),
  }),
});

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

export type AtomicBatchInput = Readonly<{ calls: NonEmptyMutationCalls }>;

export type AtomicBatchResult = Readonly<{
  callId: AtomicBatchCallId;
  operation: string;
  output: unknown;
}>;

type NonEmptyMutationResults = readonly [AtomicBatchResult, ...ReadonlyArray<AtomicBatchResult>];

export type AtomicBatchOutput = Readonly<{ results: NonEmptyMutationResults }>;

export class AtomicBatchRejected extends Schema.Error<
  AtomicBatchRejected,
  Brand.Brand<"AtomicBatchRejected">
>("AtomicBatchRejected")(
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

export const getAtomicBatchCallSchema = (): Schema.Codec<AtomicBatchCall, Schema.Json> =>
  Option.getOrThrowWith(
    boundAtomicBatchCall,
    () => new Error("Atomic batch call schema has not been derived")
  );

export const getAtomicBatchInputSchema = (): AtomicBatchInputSchema =>
  Option.getOrThrowWith(
    boundAtomicBatchInput,
    () => new Error("Atomic batch input schema has not been derived")
  );

const mutationOperations = (catalog: OperationCatalog): ReadonlyArray<CatalogOperation> =>
  catalog.operations.filter(
    (operation) =>
      operation.atomicBatchEligible &&
      operation.policy.kind === "mutation" &&
      (isUserOwnedAgentScoped(operation.policy.access) ||
        Predicate.isTagged(operation.policy.access, "FreshWebSessionOnly") ||
        Predicate.isTagged(operation.policy.access, "WebSessionOnly"))
  );

export const atomicBatchChildOperations = (
  catalog: OperationCatalog
): ReadonlyArray<CatalogOperation> =>
  mutationOperations(catalog).filter((operation) => operation.id !== atomicBatchOperation);

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

type AtomicBatchSchemas = Readonly<{
  call: AtomicBatchCallSchema;
  result: AtomicBatchResultSchema;
  input: AtomicBatchInputSchema;
  output: AtomicBatchOutputSchema;
}>;

const makeAtomicBatchSchemas = (mutations: ReadonlyArray<CatalogOperation>): AtomicBatchSchemas => {
  const call = Schema.suspend(() =>
    Schema.make<Schema.Codec<AtomicBatchCall, Schema.Json>>(
      catalogUnion(mutations, mutationCallMember).ast
    )
  );

  const result = Schema.suspend(() =>
    Schema.make<Schema.Codec<AtomicBatchResult, Schema.Json>>(
      catalogUnion(mutations, mutationResultMember).ast
    )
  );

  const input = Schema.Struct({
    calls: Schema.NonEmptyArray(call).check(Schema.isMaxLength(maximumAtomicBatchCalls)),
  });

  const output = Schema.Struct({
    results: Schema.NonEmptyArray(result).check(Schema.isMaxLength(maximumAtomicBatchCalls)),
  });

  return { call, result, input, output };
};

export type ProjectedAtomicBatchSchemas = Readonly<{ input: Schema.Top; output: Schema.Top }>;

export const projectAtomicBatchSchemas = (
  options: Readonly<{
    catalog: OperationCatalog;
    includeChild: (operation: CatalogOperation) => boolean;
  }>
): ProjectedAtomicBatchSchemas => {
  const { input, output } = makeAtomicBatchSchemas(
    atomicBatchChildOperations(options.catalog).filter(options.includeChild)
  );

  return { input: Schema.Struct({ payload: input }), output: OperationResponse(output) };
};

export const makeOperationsGroup = (ordinaryCatalog: OperationCatalog): OperationsGroup => {
  const mutations = mutationOperations(ordinaryCatalog);
  const { call, input, output } = makeAtomicBatchSchemas(mutations);
  boundAtomicBatchCall = Option.some(call);
  boundAtomicBatchInput = Option.some(input);

  return HttpApiGroup.make(operationsGroupName).add(
    HttpApiEndpoint.post(atomicBatchEndpointName, "/operations/atomic-batch", {
      payload: input,
      success: OperationResponse(output),
      error: AtomicBatchRejected,
    })
      .annotate(
        OpenApi.Description,
        "Execute a non-empty ordered set of canonical mutations in one User-scoped atomic commit. Use this when several state changes must commit together; each child keeps its own scope, Subscription tier, confirmation policy, validation, and canonical failure. Queries and nested batches are not valid children."
      )
      .annotateMerge(
        operationPolicy({
          access: userOwnedAgentScopedChildren,
          requiredTier: "free",
          agentConfirmation: "required",
          kind: "mutation",
        })
      )
  );
};
