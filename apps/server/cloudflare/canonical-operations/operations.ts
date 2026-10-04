import {
  executeHostedStatementCall as heldStatementCall,
  executeHostedStatementQuery as heldStatementQuery,
} from "./internal/hosted-statement";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { OAuthCaller } from "../../src/shell/oauth-agents/contract";
import { recordOAuthCall } from "../../src/shell/audit/operations";
import { liveOAuthAuthority } from "../../src/shell/oauth-agents/operations";
import { prepareOwnedStatement } from "../database/operations";
import { currentMillis } from "../runtime/operations";
import { newId } from "../secret-material/operations";
import { HostedInference } from "../../src/shell/hosted-inference/operations";
import { type HostedInferenceService } from "../../src/shell/hosted-inference/contract";
import { type CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { atomicBatchOperation } from "../../src/shell/operations/contract";
import { operationCatalog } from "../../src/shell/api";
import { decideOperationAccess } from "../../src/shell/canonical-policy/operations";
import {
  type SuggestedOperationCaller,
  grantsRequiredTier,
} from "../../src/shell/canonical-operations/operations";
import { userOwnedAgentCapability } from "../../src/shell/canonical-policy/contract";
import { memoryOperationIds } from "../../src/shell/memory/contract";
import type { HostedCommitFence } from "../agent/contract";
import type { CanonicalMutationPreparation, CanonicalWork } from "./contract";
import { executeCanonicalBatch, executeHostedCanonicalBatch, rawOperation } from "./internal/batch";
import {
  type CanonicalMutationAdapter,
  canonicalHostedStatementAdapter,
  canonicalMutationAdapter,
} from "./internal/mutation-registry";
import { executeSingleCanonicalMutation } from "./internal/mutation-unit";
import { checkpointQueryResponse } from "./internal/oauth-query";
import { withQueryLifetime } from "./internal/query-lifetime";
import { resolveOAuthQueryCaller } from "../oauth-agents/operations";
import { canonicalHostedStatementQueryOwner, canonicalQueryOwner } from "./internal/query-registry";
import { matchesRoute } from "../routing/operations";
import { evaluateBudgetAlerts } from "../budgets/operations";
import { unavailableStatement } from "../ingestion/operations";
import {
  type QueryCaller,
  type TransactionCaller,
  childCaller,
  refusedCredentialResponse,
  refusedPreparation,
  transactionUnavailable,
} from "../canonical-work/operations";
import { transactionNoStore } from "../canonical-work/contract";

/** Read only installed statement queries under Agent's current upload conversation authority. */
export const executeHostedStatementQuery: typeof heldStatementQuery = (input) =>
  heldStatementQuery(input);

/** Execute only installed statement work under Agent's verified live Turn and origin Session. */
export const executeHostedStatementCall: typeof heldStatementCall = (input) =>
  heldStatementCall(input);

const httpServiceUnavailable = 503;
const scopeMissingStatus = 403;
const paywallRequiredStatus = 402;
const refuseOAuthQuery = (
  input: Readonly<{
    db: D1Database;
    subject: OAuthCaller;
    current: number;
    operation: CatalogOperation;
    response: Response;
  }>
): Effect.Effect<Response> =>
  Effect.tryPromise(() =>
    prepareOwnedStatement({
      db: input.db,
      statement: recordOAuthCall({
        authority: liveOAuthAuthority(input),
        id: newId(),
        current: input.current,
        operation: input.operation.id,
        outcome: "rejected",
      }),
    }).run()
  ).pipe(
    Effect.map((recorded) =>
      recorded.meta.changes === 1 ? input.response : transactionUnavailable()
    ),
    Effect.orElseSucceed(transactionUnavailable)
  );

const installedOAuthQuery = (id: string): Option.Option<CatalogOperation> => {
  const operation = operationCatalog.byId.get(id);
  return operation?.policy.kind === "query" && Option.isSome(canonicalQueryOwner(operation.id))
    ? Option.some(operation)
    : Option.none();
};
const queryRefusal = (code: string, message: string, status: number): Response =>
  Response.json(
    { error: { code, message }, next: [] },
    { status, headers: { "cache-control": "no-store" } }
  );
const queryPolicyRefusal = (
  operation: CatalogOperation,
  caller: SuggestedOperationCaller
): Option.Option<Response> => {
  if (decideOperationAccess(operation.policy.access, caller.accessCaller)._tag === "Denied") {
    return Option.some(
      queryRefusal(
        "scope_missing",
        "The credential does not grant this query's scope.",
        scopeMissingStatus
      )
    );
  }
  return grantsRequiredTier({
    requiredTier: operation.policy.requiredTier,
    callerTier: caller.tier,
  })
    ? Option.none()
    : Option.some(
        queryRefusal("paywall_required", "This query requires Pro access.", paywallRequiredStatus)
      );
};

const queryValidationRefusal = (
  operation: CatalogOperation,
  input: Schema.Json
): Option.Option<Response> =>
  Option.isSome(Schema.decodeOption(operation.input, { onExcessProperty: "error" })(input))
    ? Option.none()
    : Option.some(
        Response.json(
          {
            error: {
              code: "validation_failed",
              message: "Invalid canonical query input.",
              fields: [],
            },
            next: [],
          },
          { status: 400, headers: { "cache-control": "no-store" } }
        )
      );

type OAuthQueryWork = Readonly<{
  db: D1Database;
  subject: OAuthCaller;
  operation: string;
  input: Schema.Json;
  signal: AbortSignal;
  deadlineMilliseconds: number;
}>;

/** Execute an installed query under its exact OAuth capability, bounded lifetime, and canonical owner. */
export const executeOAuthQuery = (input: OAuthQueryWork): Effect.Effect<Response> =>
  withQueryLifetime({ ...input, execute: (db) => executeOAuthQueryWork({ ...input, db }) });

const executeOAuthQueryWork = (input: OAuthQueryWork): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const installed = installedOAuthQuery(input.operation);
    if (Option.isNone(installed)) return transactionUnavailable();
    const operation = installed.value;
    const scope = userOwnedAgentCapability(operation.policy.access);
    if (Option.isNone(scope)) return transactionUnavailable();
    const current = currentMillis();
    const admission = { ...input.subject, requiredScope: Option.none() };
    const caller = yield* resolveOAuthQueryCaller({ db: input.db, subject: admission, current });
    if (input.signal.aborted || currentMillis() >= input.deadlineMilliseconds) {
      return transactionUnavailable();
    }
    if (Option.isNone(caller)) {
      return yield* refusedCredentialResponse({ db: input.db, subject: admission });
    }
    const refusal = { db: input.db, subject: admission, current, operation };
    const policyRefusal = queryPolicyRefusal(operation, caller.value);
    if (Option.isSome(policyRefusal)) {
      return yield* refuseOAuthQuery({ ...refusal, response: policyRefusal.value });
    }
    const subject = { ...input.subject, requiredScope: scope };
    const validationRefusal = queryValidationRefusal(operation, input.input);
    if (Option.isSome(validationRefusal)) {
      return yield* refuseOAuthQuery({ ...refusal, response: validationRefusal.value });
    }
    const response = yield* executeCanonicalQuery({
      db: input.db,
      subject,
      operation: operation.id,
      input: input.input,
      bucket: Option.none(),
    }).pipe(
      Effect.map((response) => Option.getOrElse(response, transactionUnavailable)),
      Effect.orElseSucceed(transactionUnavailable)
    );
    return yield* checkpointQueryResponse({ response, caller: caller.value });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

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
  operationCatalog.byId.get(operation)?.policy.kind === "mutation" &&
  (operation.startsWith("budgets.") || operation.startsWith("transactions."));

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

const executeRequestQuery = (
  input: WorkInput & Readonly<{ work: Extract<CanonicalWork, { _tag: "Query" }> }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const operation = queryDeclaration(input.work.operation);
    if (Option.isNone(operation)) return transactionUnavailable();
    const request = requestFromTarget(operation.value, input.work.target);
    if (Option.isNone(request)) return transactionUnavailable();
    return Option.getOrElse(
      yield* invokeQueryOwner({
        ...input,
        operation: operation.value,
        request: request.value,
        browserOrigin: Option.none(),
      }).pipe(Effect.orElseSucceed(() => Option.none())),
      transactionUnavailable
    );
  });

const executeWork = (input: WorkInput): Effect.Effect<Response, never, HostedInference> =>
  Effect.gen(function* () {
    if (input.work._tag === "Query") {
      return yield* executeRequestQuery({ ...input, work: input.work });
    }
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
  if (work._tag === "Query") return false;
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

/** The verified statement channel discovers only adapters installed for its native authority. */
export const installedHostedStatementOperations = (): ReadonlyArray<CatalogOperation> =>
  operationCatalog.operations.filter(
    ({ id }) =>
      Option.isSome(canonicalHostedStatementAdapter(id)) ||
      Option.isSome(canonicalHostedStatementQueryOwner(id))
  );

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

/** Only a declared query may reach dispatch; its owner classifies malformed route/query input. */
const queryDeclaration = (operation: CanonicalOperationId): Option.Option<CatalogOperation> =>
  Option.fromUndefinedOr(operationCatalog.byId.get(operation)).pipe(
    Option.filter((declared) => declared.policy.kind === "query")
  );

const queryOrigin = "https://canonical.internal";

/** Reconstruct only the named query's route, without forwarding transport credential material. */
const requestFromTarget = (operation: CatalogOperation, target: string): Option.Option<Request> =>
  Option.liftThrowable(() => new URL(target, queryOrigin))().pipe(
    Option.filter(
      (url) => url.origin === queryOrigin && matchesRoute(operation.route, url.pathname)
    ),
    Option.map((url) => new Request(url, { method: operation.method }))
  );

const invokeQueryOwner = ({
  db,
  subject,
  operation,
  request,
  bucket,
  browserOrigin,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  operation: CatalogOperation;
  request: Request;
  bucket: Option.Option<R2Bucket>;
  browserOrigin: Option.Option<string>;
}>): Effect.Effect<Option.Option<Response>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const owner = canonicalQueryOwner(operation.id);
    if (Option.isNone(owner)) return Option.none();
    const result = yield* Effect.exit(
      Effect.suspend(() =>
        owner.value({
          db,
          subject: childCaller({
            subject,
            requiredScope: userOwnedAgentCapability(operation.policy.access),
          }),
          request,
          bucket,
          browserOrigin,
        })
      )
    );
    // Caller deadlines remain interruptions, never owner defects or validation refusals.
    if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) {
      return yield* Effect.failCause(result.cause);
    }
    return Exit.isSuccess(result) ? Option.some(result.value) : Option.none();
  });

/**
 * Execute an admitted HTTP query through the installed owner dispatch. Document/view assembly
 * and accounting stay inside the same User coordinator, including rejected query strings. The
 * HTTP adapter retains transport admission; owners retain validation, live authority and Audit.
 * The coordinator receives a catalog-bound target only, never cookies or bearer plaintext.
 */
export const executeCanonicalHttpQuery = ({
  operation: operationId,
  coordinate,
  ...input
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: CanonicalOperationId;
  request: Request;
  bucket: Option.Option<R2Bucket>;
  browserOrigin: string;
  coordinate: (work: CanonicalWork) => Effect.Effect<Response>;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const operation = queryDeclaration(operationId);
    if (Option.isNone(operation) || Option.isNone(canonicalQueryOwner(operationId))) {
      return Response.json(
        {
          error: {
            code: "unavailable",
            message: "Canonical operation is temporarily unavailable.",
          },
          next: [],
        },
        { status: httpServiceUnavailable, headers: transactionNoStore }
      );
    }
    const url = new URL(input.request.url);
    if (
      input.request.method !== operation.value.method ||
      !matchesRoute(operation.value.route, url.pathname)
    ) {
      return transactionUnavailable();
    }
    if (operationId === "dashboard.getDashboard" || operationId === "dashboard.getDashboardView") {
      return yield* coordinate({
        _tag: "Query",
        operation: operationId,
        target: url.href.slice(url.origin.length),
      });
    }
    return Option.getOrElse(
      yield* invokeQueryOwner({
        ...input,
        operation: operation.value,
        browserOrigin: Option.some(input.browserOrigin),
      }),
      transactionUnavailable
    );
  }).pipe(Effect.orElseSucceed(transactionUnavailable), Effect.withSpan(operationId));

/** Call a query owner inside an already held User coordination turn. Canonical arguments build
 * only the catalog-owned route; owners classify malformed identities and filters exactly as for
 * HTTP. None means an uninstalled owner, unrepresentable arguments or an owner defect; canonical
 * refusals remain Some(response). Interruption reaches the caller unchanged.
 */
export const executeCanonicalQuery = ({
  db,
  subject,
  operation: operationId,
  input,
  bucket,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  operation: CanonicalOperationId;
  input: Schema.Json;
  bucket: Option.Option<R2Bucket>;
}>): Effect.Effect<Option.Option<Response>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const operation = queryDeclaration(operationId);
    if (Option.isNone(operation)) return Option.none();
    const request = requestFor(operation.value, input);
    if (Option.isNone(request)) return Option.none();
    return yield* invokeQueryOwner({
      db,
      subject,
      operation: operation.value,
      request: request.value,
      bucket,
      browserOrigin: Option.none(),
    });
  });
