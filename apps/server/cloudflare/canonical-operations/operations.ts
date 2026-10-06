import {
  executeHostedStatementCall as heldStatementCall,
  executeHostedStatementQuery as heldStatementQuery,
} from "./internal/hosted-statement";
import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";
import type { OAuthCaller } from "../../src/shell/oauth-agents/contract";
import { HostedInference } from "../../src/shell/hosted-inference/operations";
import { type HostedInferenceService } from "../../src/shell/hosted-inference/contract";
import { type CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { AtomicBatchAdmission, atomicBatchOperation } from "../../src/shell/operations/contract";
import { operationCatalog } from "../../src/shell/api";
import { decideOperationAccess } from "../../src/shell/canonical-policy/operations";
import {
  type SuggestedOperationCaller,
  grantsRequiredTier,
} from "../../src/shell/canonical-operations/operations";
import { userOwnedAgentCapability } from "../../src/shell/canonical-policy/contract";
import type { HostedCommitFence } from "../agent/contract";
import type { CanonicalMutationPreparation, CanonicalWork } from "./contract";
import { executeCanonicalBatch, executeHostedCanonicalBatch, rawOperation } from "./internal/batch";
import {
  type CanonicalMutationAdapter,
  canonicalHostedStatementAdapter,
  canonicalMutationAdapter,
} from "./internal/mutation-registry";
import { executeSingleCanonicalMutation } from "./internal/mutation-unit";
import { checkpointOAuthResponse, recordOAuthRefusal } from "./internal/oauth-response";
import { oauthConfirmationRefusal, requiresOAuthConfirmation } from "./internal/oauth-confirmation";
import { withCanonicalLifetime } from "./internal/canonical-lifetime";
import { canonicalOperationRequiresInference } from "./internal/inference-requirement";
import { resolveOAuthQueryCaller } from "../oauth-agents/operations";
import { canonicalHostedStatementQueryOwner, canonicalQueryOwner } from "./internal/query-registry";
import { matchesRoute } from "../routing/operations";
import { evaluateBudgetAlerts } from "../budgets/operations";
import { unavailableStatement } from "../ingestion/operations";
import {
  type QueryCaller,
  type TransactionCaller,
  childCaller,
  isOAuthCaller,
  refusedCredentialResponse,
  refusedPreparation,
  rejectBatchEnvelope,
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
const refuseOAuthCall = (
  input: Readonly<{
    db: D1Database;
    subject: OAuthCaller;
    current: number;
    operation: CatalogOperation;
    response: Response;
  }>
): Effect.Effect<Response> =>
  recordOAuthRefusal({ ...input, operation: input.operation.id }).pipe(
    Effect.map((disposition) =>
      disposition === "recorded" ? input.response : transactionUnavailable()
    )
  );

const refuseOAuthInvalidInput = (
  input: Parameters<typeof refuseOAuthCall>[0]
): Effect.Effect<Response> =>
  input.operation.id === atomicBatchOperation
    ? Effect.tryPromise(() => rejectBatchEnvelope(input)).pipe(
        Effect.orElseSucceed(transactionUnavailable)
      )
    : refuseOAuthCall(input);

const operationRefusal = (code: string, message: string, status: number): Response =>
  Response.json(
    { error: { code, message }, next: [] },
    { status, headers: { "cache-control": "no-store" } }
  );
const operationPolicyRefusal = (
  operation: CatalogOperation,
  caller: SuggestedOperationCaller
): Option.Option<Response> => {
  if (decideOperationAccess(operation.policy.access, caller.accessCaller)._tag === "Denied") {
    return Option.some(
      operationRefusal(
        "scope_missing",
        "The credential does not grant this operation's scope.",
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
        operationRefusal(
          "paywall_required",
          "This operation requires Pro access.",
          paywallRequiredStatus
        )
      );
};

const operationValidationRefusal = (
  operation: CatalogOperation,
  input: Schema.Json
): Option.Option<Response> => {
  // Mutation owners classify their own invalid material; only the batch envelope is admitted here.
  if (operation.policy.kind === "mutation" && operation.id !== atomicBatchOperation) {
    return Option.none();
  }
  return Option.isSome(
    Schema.decodeOption(
      operation.id === atomicBatchOperation ? AtomicBatchAdmission : operation.input,
      { onExcessProperty: "error" }
    )(input)
  )
    ? Option.none()
    : Option.some(
        Response.json(
          {
            error: {
              code: "validation_failed",
              message: "Invalid canonical operation input.",
              fields: [],
            },
            next: [],
          },
          { status: 400, headers: { "cache-control": "no-store" } }
        )
      );
};

type OAuthCanonicalWork = Readonly<{
  bucket: Option.Option<R2Bucket>;
  inference: Option.Option<HostedInferenceService>;
  db: D1Database;
  subject: OAuthCaller;
  operation: string;
  input: Schema.Json;
  signal: AbortSignal;
  deadlineMilliseconds: number;
}>;

/** Execute an installed canonical operation under live OAuth authority and the bounded User coordination turn. */
export const executeOAuthCanonicalWork = (input: OAuthCanonicalWork): Effect.Effect<Response> =>
  withCanonicalLifetime({ ...input, execute: (db) => executeOAuthWork({ ...input, db }) });

const oauthMutationWork = (
  operation: CatalogOperation,
  input: Schema.Json
): Effect.Effect<CanonicalWork, Schema.SchemaError> =>
  operation.id === atomicBatchOperation
    ? Schema.decodeUnknownEffect(AtomicBatchAdmission)(input).pipe(
        Effect.map(({ payload }) => ({ _tag: "Batch" as const, calls: payload.calls }))
      )
    : Effect.succeed({ _tag: "Call", operation: operation.id, input });
const executeOAuthMutation = ({
  input,
  operation,
  caller,
  subject,
  current,
}: Readonly<{
  input: OAuthCanonicalWork;
  operation: CatalogOperation;
  caller: SuggestedOperationCaller;
  subject: OAuthCaller;
  current: number;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const work = yield* oauthMutationWork(operation, input.input);
    const response = yield* executeCanonicalWork({
      db: input.db,
      subject,
      current,
      work,
      bucket: input.bucket,
      inference: input.inference,
      hostedFence: Option.none(),
    });
    return yield* checkpointOAuthResponse({ response, caller });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const executeOAuthWork = (input: OAuthCanonicalWork): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const installed = Option.fromUndefinedOr(
      installedCanonicalOperations().find(
        ({ id, policy }) => id === input.operation && policy.access._tag === "UserOwnedAgentScoped"
      )
    );
    if (Option.isNone(installed)) return transactionUnavailable();
    const operation = installed.value;
    const scope = userOwnedAgentCapability(operation.policy.access);
    const current = yield* Clock.currentTimeMillis;
    const admission = { ...input.subject, requiredScope: Option.none() };
    const caller = yield* resolveOAuthQueryCaller({ db: input.db, subject: admission, current });
    if (input.signal.aborted || (yield* Clock.currentTimeMillis) >= input.deadlineMilliseconds) {
      return transactionUnavailable();
    }
    if (Option.isNone(caller)) {
      return yield* refusedCredentialResponse({ db: input.db, subject: admission });
    }
    const refusal = { db: input.db, subject: admission, current, operation };
    const policyRefusal = operationPolicyRefusal(operation, caller.value);
    if (Option.isSome(policyRefusal)) {
      return yield* refuseOAuthCall({ ...refusal, response: policyRefusal.value });
    }
    const subject = { ...input.subject, requiredScope: scope };
    const validationRefusal = operationValidationRefusal(operation, input.input);
    if (Option.isSome(validationRefusal)) {
      return yield* refuseOAuthInvalidInput({ ...refusal, response: validationRefusal.value });
    }
    if (operation.policy.kind === "mutation") {
      return yield* executeOAuthMutation({
        input,
        operation,
        caller: caller.value,
        subject,
        current,
      });
    }
    const response = yield* executeCanonicalQuery({
      db: input.db,
      subject,
      operation: operation.id,
      input: input.input,
      bucket: input.bucket,
    }).pipe(
      Effect.map((response) => Option.getOrElse(response, transactionUnavailable)),
      Effect.orElseSucceed(transactionUnavailable)
    );
    return yield* checkpointOAuthResponse({ response, caller: caller.value });
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

const executeWork = (
  input: WorkInput & Readonly<{ inference: Option.Option<HostedInferenceService> }>
): Effect.Effect<Response, never, HostedInference> =>
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
              inference: input.inference,
            }),
          onSome: (hostedFence) =>
            executeHostedCanonicalBatch({
              db: input.db,
              subject: input.subject,
              calls: work.calls,
              current: input.current,
              bucket: input.bucket,
              hostedFence,
              inference: input.inference,
            }),
        })
      : executeCall({ ...input, work });
    if (result.ok && budgetWork) {
      // Atomic D1 triggers retain versioned work even when this best-effort drain is interrupted.
      yield* evaluateBudgetAlerts({ db: input.db, userId: input.subject.userId });
    }
    return result;
  });

/**
 * True when the work can reach the Memory capacity policy, the only consumer of hosted
 * inference. Every other owner decides without it, so a missing AI binding must not deny
 * their work.
 */
export const canonicalWorkRequiresInference = (work: CanonicalWork): boolean => {
  if (work._tag === "Query") return false;
  if (work._tag === "Batch") {
    return work.calls.some((call) =>
      Option.exists(rawOperation(call), canonicalOperationRequiresInference)
    );
  }
  return canonicalOperationRequiresInference(work.operation);
};

const canonicalWorkSubject = (input: WorkInput): TransactionCaller => {
  if (input.work._tag === "Batch") return input.subject;
  const operation = operationCatalog.byId.get(input.work.operation);
  return operation === undefined
    ? input.subject
    : childCaller({
        subject: input.subject,
        requiredScope: userOwnedAgentCapability(operation.policy.access),
      });
};

const oauthWorkRefusal = (input: WorkInput): Option.Option<Effect.Effect<Response>> => {
  if (!isOAuthCaller(input.subject)) return Option.none();
  const operation = operationCatalog.byId.get(
    input.work._tag === "Batch" ? atomicBatchOperation : input.work.operation
  );
  if (operation?.policy.access._tag !== "UserOwnedAgentScoped") {
    return Option.some(Effect.succeed(transactionUnavailable()));
  }
  if (input.work._tag === "Batch" || !requiresOAuthConfirmation(operation)) return Option.none();
  const refusal = oauthConfirmationRefusal({ ...input, subject: input.subject, operation });
  return Option.some(refusal.record().pipe(Effect.flatMap(refusal.respond)));
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
  const refusal = oauthWorkRefusal(input);
  if (Option.isSome(refusal)) return refusal.value;
  if (
    input.work._tag !== "Batch" &&
    canonicalWorkRequiresInference(input.work) &&
    Option.isNone(input.inference)
  ) {
    return Effect.succeed(transactionUnavailable());
  }
  return executeWork({ ...input, subject: canonicalWorkSubject(input) }).pipe(
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
