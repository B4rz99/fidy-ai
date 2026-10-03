import { Cause, Effect, Exit, Option, Schema } from "effect";
import { HostedInference } from "../../src/shell/hosted-inference/operations";
import { type HostedInferenceService } from "../../src/shell/hosted-inference/contract";
import { type CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { atomicBatchOperation } from "../../src/shell/operations/contract";
import { operationCatalog } from "../../src/shell/api";
import { patScopeCapability } from "../../src/shell/canonical-policy/contract";
import { memoryOperationIds } from "../../src/shell/memory/contract";
import type { HostedCommitFence } from "../agent/contract";
import type { CanonicalMutationPreparation, CanonicalWork } from "./contract";
import { executeCanonicalBatch, executeHostedCanonicalBatch, rawOperation } from "./internal/batch";
import {
  type CanonicalMutationAdapter,
  canonicalMutationAdapter,
} from "./internal/mutation-registry";
import { executeSingleCanonicalMutation } from "./internal/mutation-unit";
import { canonicalQueryOwner } from "./internal/query-registry";
import { evaluateBudgetAlerts } from "../budgets/operations";
import { unavailableStatement } from "../ingestion/operations";
import {
  type TransactionCaller,
  childCaller,
  refusedPreparation,
  transactionUnavailable,
} from "../canonical-work/operations";

const httpServiceUnavailable = 503;

/**
 * The hosted-inference service non-Memory work runs under: every method dies. Only the Memory
 * capacity policy consumes hosted inference, and it provisions the real service itself, so a
 * consumer appearing anywhere else fails closed instead of deciding without inference.
 */
const unreachableHostedInference = HostedInference.of({
  countText: () => Effect.die("Hosted inference reached without Memory work"),
  countTranscript: () => Effect.die("Hosted inference reached without Memory work"),
  prepareText: () => Effect.die("Hosted inference reached without Memory work"),
  validateText: () => Effect.die("Hosted inference reached without Memory work"),
  prepareStructured: () => Effect.die("Hosted inference reached without Memory work"),
});

type WorkInput = Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  work: CanonicalWork;
  subject: TransactionCaller;
  current: number;
  hostedFence: Option.Option<HostedCommitFence>;
}>;

/** Reprepare only the statement whose identical material won a concurrent publication race. */
const retryStatementPreparation = (
  adapter: CanonicalMutationAdapter,
  input: Parameters<CanonicalMutationAdapter["prepare"]>[0]
): Effect.Effect<CanonicalMutationPreparation> =>
  adapter.prepare(input).pipe(Effect.provideService(HostedInference, unreachableHostedInference));

/** Execute one catalog call through its owner adapter and the shared mutation unit. */
const executeCall = ({
  db,
  work,
  subject,
  current,
  bucket,
  hostedFence,
}: WorkInput & Readonly<{ work: Extract<CanonicalWork, { _tag: "Call" }> }>): Effect.Effect<
  Response,
  never,
  HostedInference
> => {
  if (operationCatalog.byId.get(work.operation)?.policy.kind === "query") {
    return executeQueryCall({ db, work, subject, current, bucket, hostedFence }, work);
  }
  return Effect.gen(function* () {
    const adapter = canonicalMutationAdapter(work.operation);
    if (Option.isNone(adapter)) return transactionUnavailable();
    const catalogOperation = operationCatalog.byId.get(work.operation);
    if (catalogOperation === undefined) return transactionUnavailable();
    const input = Schema.decodeUnknownOption(catalogOperation.input)(work.input);
    if (Option.isNone(input)) {
      // The call cannot be decoded against the operation it names, so the owner adapter answers for
      // it under its own input classification and no write is attempted.
      return yield* executeSingleCanonicalMutation({
        db,
        subject,
        current,
        preparation: refusedPreparation(
          adapter.value.invalidRefusal({ db, subject, current, input: work.input, bucket })
        ),
        present: adapter.value.present,
        retryStatement: Option.none(),
        hostedFence,
      });
    }
    const ownerWork = { db, subject, current, input: input.value, bucket };
    const preparation = yield* adapter.value.prepare(ownerWork);
    const retryStatement = (): Effect.Effect<CanonicalMutationPreparation> =>
      retryStatementPreparation(adapter.value, ownerWork);
    const response = yield* executeSingleCanonicalMutation({
      db,
      subject,
      current,
      preparation,
      present: adapter.value.present,
      retryStatement:
        work.operation === "ingestion.submitForExtraction"
          ? Option.some(retryStatement)
          : Option.none(),
      hostedFence,
    });
    return work.operation === "ingestion.submitForExtraction" &&
      response.status === httpServiceUnavailable
      ? unavailableStatement()
      : response;
  });
};

/** Dispatch a bounded batch or an individual catalog call within one User coordination turn. */
const affectsBudget = (operation: CanonicalOperationId): boolean =>
  operation.startsWith("budgets.") || operation.startsWith("transactions.");

const executeQueryCall = (
  input: WorkInput,
  work: Extract<CanonicalWork, { _tag: "Call" }>
): Effect.Effect<Response> => {
  const decoded = Schema.decodeUnknownOption(Schema.Json)(work.input);
  if (Option.isNone(decoded)) return Effect.succeed(transactionUnavailable());
  return executeCanonicalQuery({
    db: input.db,
    subject: input.subject,
    operation: work.operation,
    input: decoded.value,
    bucket: input.bucket,
  }).pipe(
    Effect.map((response) => Option.getOrElse(response, transactionUnavailable)),
    Effect.orElseSucceed(transactionUnavailable)
  );
};

const executeWork = (input: WorkInput): Effect.Effect<Response, never, HostedInference> =>
  Effect.gen(function* () {
    const budgetWork =
      input.work._tag === "Call"
        ? affectsBudget(input.work.operation)
        : input.work.calls.some((child) => Option.exists(rawOperation(child), affectsBudget));
    // Drain committed work before a later correction can lower spending below a reached mark.
    if (
      budgetWork &&
      !(yield* evaluateBudgetAlerts({ db: input.db, userId: input.subject.userId }))
    ) {
      return transactionUnavailable();
    }
    const work = input.work;
    const result = yield* work._tag === "Batch"
      ? Option.match(input.hostedFence, {
          onNone: () =>
            executeCanonicalBatch({
              db: input.db,
              subject: input.subject,
              calls: work.calls,
              current: input.current,
              bucket: input.bucket,
            }),
          onSome: (hostedFence) =>
            executeHostedCanonicalBatch({
              db: input.db,
              subject: input.subject,
              calls: work.calls,
              current: input.current,
              bucket: input.bucket,
              hostedFence,
            }),
        })
      : executeCall({ ...input, work });
    if (result.ok && budgetWork) {
      // Atomic D1 triggers retain versioned work even when this best-effort drain is interrupted.
      yield* evaluateBudgetAlerts({ db: input.db, userId: input.subject.userId });
    }
    return result;
  });

/** True for an operation id the Memory group declares, so a new one needs no second derivation. */
const isMemoryOperation = (operation: CanonicalOperationId): boolean =>
  memoryOperationIds.some((declared) => declared === operation);

/**
 * True when the work can reach the Memory capacity policy, the only consumer of hosted
 * inference. Every other owner decides without it, so a missing AI binding must not deny
 * their work.
 */
export const canonicalWorkRequiresInference = (work: CanonicalWork): boolean => {
  if (work._tag === "Batch") {
    return work.calls.some((call) => Option.exists(rawOperation(call), isMemoryOperation));
  }
  return isMemoryOperation(work.operation);
};

/**
 * Execute one named call or ordered batch inside the caller's existing User coordination turn.
 * Owner preparation, live authority, refusal Audit, atomic commit and canonical presentation stay
 * together. Memory work requires its explicitly constructed counting service; a missing binding
 * refuses only that work. No provider or storage authority is acquired here.
 */
export const executeCanonicalWork = (
  input: WorkInput & Readonly<{ inference: Option.Option<HostedInferenceService> }>
): Effect.Effect<Response> => {
  if (canonicalWorkRequiresInference(input.work) && Option.isNone(input.inference)) {
    return Effect.succeed(transactionUnavailable());
  }
  return executeWork(input).pipe(
    Effect.provideService(
      HostedInference,
      Option.getOrElse(input.inference, () => unreachableHostedInference)
    )
  );
};

/** Installed canonical operations retain their declaration identity, policy and codecs. */
export const installedCanonicalOperations = (): ReadonlyArray<CatalogOperation> =>
  operationCatalog.operations.filter(({ id, policy }) =>
    policy.kind === "query"
      ? Option.isSome(canonicalQueryOwner(id))
      : id === atomicBatchOperation || Option.isSome(canonicalMutationAdapter(id))
  );

const requestParts = Schema.Struct({
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]))
  ),
});

/** Build only a catalog-owned route from validated canonical arguments, never an arbitrary destination. */
const requestFor = (operation: CatalogOperation, input: Schema.Json): Option.Option<Request> => {
  const parts = Schema.decodeUnknownOption(requestParts)(input);
  if (Option.isNone(parts)) return Option.none();
  let route = operation.route;
  for (const [key, value] of Object.entries(parts.value.params ?? {})) {
    route = route.replace(`:${key}`, encodeURIComponent(value));
  }
  if (route.includes(":")) return Option.none();
  const url = new URL(route, "https://canonical.internal");
  for (const [key, value] of Object.entries(parts.value.query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return Option.some(new Request(url, { method: operation.method }));
};

/** Only a declared query with valid canonical input may reach native query dispatch. */
const queryDeclaration = (
  operation: CanonicalOperationId,
  input: Schema.Json
): Option.Option<CatalogOperation> =>
  Option.fromUndefinedOr(operationCatalog.byId.get(operation)).pipe(
    Option.filter((declared) => declared.policy.kind === "query"),
    Option.filter((declared) => Option.isSome(Schema.decodeOption(declared.input)(input)))
  );

/** Call a canonical owner with a live User subject and catalog-owned route; its domain/Audit
 * effects are the owner's effects. Returns None for an uninstalled owner, invalid route arguments,
 * or an owner defect. A canonical refusal remains Some(response), so the caller can retain it.
 */
export const executeCanonicalQuery = ({
  db,
  subject,
  operation: operationId,
  input,
  bucket,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: CanonicalOperationId;
  input: Schema.Json;
  bucket: Option.Option<R2Bucket>;
}>): Effect.Effect<Option.Option<Response>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const operation = queryDeclaration(operationId, input);
    if (Option.isNone(operation)) return Option.none();
    const owner = canonicalQueryOwner(operation.value.id);
    const request = requestFor(operation.value, input);
    if (Option.isNone(owner) || Option.isNone(request)) return Option.none();
    const result = yield* Effect.exit(
      Effect.suspend(() =>
        owner.value({
          db,
          subject: childCaller({
            subject,
            requiredScope: patScopeCapability(operation.value.policy.access),
          }),
          request: request.value,
          bucket,
        })
      )
    );
    // The caller's deadline must not be swallowed as a canonical owner defect.
    if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) {
      return yield* Effect.failCause(result.cause);
    }
    return Exit.isSuccess(result) ? Option.some(result.value) : Option.none();
  });
