import {
  readAddressedLocalTransaction,
  readLocalTransactionPage,
} from "../transactions/operations";
import type { CanonicalAuthorityRoot } from "../../src/shell/canonical-policy/contract";
import { readLocalPendingInsights, readLocalReminder } from "../insights/operations";
import { readLocalMemories } from "../memory/operations";
import type { UserId } from "../../src/core/identity/contract";
import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type { UserStoreBindings } from "../directory/contract";
import {
  readLocalReviewPage,
  readLocalSubmission,
  reserveBatchForwarding,
  unavailableStatement,
} from "../ingestion/operations";
import { queryLocalConnections } from "../connections/operations";
import { readLocalProfile } from "../identity/operations";
import { recurringDiscoveryIntervalMs } from "../recurring/contract";
import { batchOwnersFor, localBatchOwners, localReviewBinding } from "./internal/local-owners";
import { keywordRuleIdFromPath, localKeywordRules } from "../categories/operations";
import {
  admitCanonicalOperation,
  canonicalAdmissionUnavailable,
  commitLocalWrite,
  isNativeAccountQuery,
  localCanonicalArguments,
  prepareHostedBatch,
  prepareLocalWrite,
  readNativeAccountQuery,
  runLocalBatch,
  runLocalMutation,
} from "../canonical-admission/operations";
import { preserveStoreAlarm } from "../runtime/sqlite/operations";
import {
  CanonicalAdmissionUnavailable,
  type CanonicalReadCompletion,
} from "../canonical-admission/contract";
import { requestFor } from "./internal/canonical-request";
import { observeCanonicalResponse } from "../runtime/application-observation/operations";
import {
  executeHostedStatementCall as heldStatementCall,
  executeHostedStatementQuery as heldStatementQuery,
} from "./internal/hosted-statement";

import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";
import { type OAuthCaller } from "../../src/shell/oauth-agents/contract";
import { HostedInference } from "../../src/shell/hosted-inference/operations";
import { type HostedInferenceService } from "../../src/shell/hosted-inference/contract";
import { type CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { type CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import {
  AtomicBatchAdmission,
  atomicBatchOperation,
  getAtomicBatchInputSchema,
} from "../../src/shell/operations/contract";
import { operationCatalog } from "../../src/shell/api";
import { decideOperationAccess } from "../../src/shell/canonical-policy/operations";
import {
  type SuggestedOperationCaller,
  getCanonicalOperationInput,
  grantsRequiredTier,
} from "../../src/shell/canonical-operations/operations";
import { userOwnedAgentCapability } from "../../src/shell/canonical-policy/contract";
import { type HostedCommitFence } from "../agent/contract";
import { type OAuthConfirmationAttempt } from "../../src/shell/mcp/contract";
import { type OAuthConfirmationWork } from "../oauth-confirmation/contract";
import { type CanonicalWork } from "./contract";
import { executeCanonicalBatch, executeHostedCanonicalBatch, rawOperation } from "./internal/batch";
import {
  canonicalHostedStatementAdapter,
  canonicalMutationAdapter,
} from "./internal/mutation-registry";
import { executeSingleCanonicalMutation } from "./internal/mutation-unit";
import { checkpointOAuthResponse, recordOAuthRefusal } from "./internal/oauth-response";
import { oauthConfirmationRefusal, requiresOAuthConfirmation } from "./internal/oauth-confirmation";
import { withCanonicalLifetime } from "./internal/canonical-lifetime";
import {
  canonicalOperationRequiresInference,
  unreachableHostedInference,
} from "./internal/inference-requirement";
import { resolveOAuthQueryCaller } from "../oauth-agents/operations";
import { canonicalHostedStatementQueryOwner, canonicalQueryOwner } from "./internal/query-registry";
import { matchesRouteTemplate } from "../../src/shell/public-http/operations";
import { reconcileBudgetThresholds } from "../budgets/operations";

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
export const executeHostedStatementQuery: typeof heldStatementQuery = (input) => {
  const operation = operationCatalog.byId.get(input.operation);
  const work = heldStatementQuery(input);
  return operation === undefined ? work : observeCanonicalResponse(work, operation.id);
};

/** Execute only installed statement work under Agent's verified live Turn and origin Session. */
export const executeHostedStatementCall: typeof heldStatementCall = (input) => {
  const operation = operationCatalog.byId.get(input.operation);
  const work = heldStatementCall(input);
  return operation === undefined ? work : observeCanonicalResponse(work, operation.id);
};

const httpServiceUnavailable = 503;
const unauthenticatedStatus = 401;
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
  confirmation: Option.Option<OAuthConfirmationAttempt>;
  retryKey: Option.Option<Schema.Json>;
}>;

/** Execute an installed canonical operation under live OAuth authority and the bounded User coordination turn. */
export const executeOAuthCanonicalWork = (input: OAuthCanonicalWork): Effect.Effect<Response> =>
  withCanonicalLifetime({ ...input, execute: (db) => executeOAuthWork({ ...input, db }) });

const sensitiveOAuthWork = (input: OAuthCanonicalWork, operation: CatalogOperation): boolean => {
  if (operation.id !== atomicBatchOperation) {
    return operation.policy.agentConfirmation === "required";
  }
  const batch = Schema.decodeUnknownOption(
    Schema.Struct({ payload: Schema.toType(getAtomicBatchInputSchema()) })
  )(input.input);
  return (
    Option.isSome(batch) &&
    batch.value.payload.calls.some(
      ({ operation }) =>
        operationCatalog.byId.get(operation)?.policy.agentConfirmation === "required"
    )
  );
};
const confirmationReference = (
  input: OAuthCanonicalWork,
  sensitive: boolean
): Option.Option<string> =>
  sensitive && Option.isSome(input.confirmation) && input.confirmation.value._tag === "Decision"
    ? Option.some(`${input.subject.oauthConnectionId}:${input.confirmation.value.reference}`)
    : Option.none();
const executeOAuthWork = (input: OAuthCanonicalWork): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const operation = installedCanonicalOperations().find(
      ({ id, policy }) => id === input.operation && policy.access._tag === "UserOwnedAgentScoped"
    );
    if (operation === undefined) return transactionUnavailable();
    const sensitive = sensitiveOAuthWork(input, operation);
    const reference = confirmationReference(input, sensitive);
    const response = yield* admitCanonicalOperation({
      db: input.db,
      canonicalInput: input.input,
      retryKey: sensitive ? Option.none() : input.retryKey,
      confirmationReference: reference,
      caller: { _tag: "OAuth", value: input.subject },
      operation,
      current: yield* Clock.currentTimeMillis,
      work: executeOAuthOwnedWork(input),
    });
    return response.status === unauthenticatedStatus
      ? yield* refusedCredentialResponse({ db: input.db, subject: input.subject })
      : response;
  });

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
      completion: Option.none(),
      db: input.db,
      subject,
      current,
      work,
      bucket: input.bucket,
      inference: input.inference,
      hostedFence: Option.none(),
      oauthConfirmation: Option.map(input.confirmation, (attempt) => ({
        operation: operation.id,
        input: input.input,
        attempt,
      })),
    });
    return response.headers.get("fidy-oauth-review") === "1"
      ? response
      : yield* checkpointOAuthResponse({ response, caller });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const executeOAuthOwnedWork = (input: OAuthCanonicalWork): Effect.Effect<Response> =>
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

type WorkInput = Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  work: CanonicalWork;
  subject: TransactionCaller;
  current: number;
  hostedFence: Option.Option<HostedCommitFence>;
  oauthConfirmation: Option.Option<OAuthConfirmationWork>;
  completion: Option.Option<CanonicalReadCompletion>;
}>;

const executeCall = (
  input: WorkInput & Readonly<{ work: Extract<CanonicalWork, { _tag: "Call" }> }>
): Effect.Effect<Response, never, HostedInference> => {
  const { work } = input;
  if (operationCatalog.byId.get(work.operation)?.policy.kind === "query") {
    return executeQueryCall(input, work);
  }
  return Effect.gen(function* () {
    const { db, subject, current, bucket, hostedFence, oauthConfirmation } = input;
    const adapter = canonicalMutationAdapter(work.operation);
    if (Option.isNone(adapter)) return transactionUnavailable();
    const catalogOperation = operationCatalog.byId.get(work.operation);
    if (catalogOperation === undefined) return transactionUnavailable();
    const decodedInput = Schema.decodeUnknownOption(catalogOperation.input)(work.input);
    if (Option.isNone(decodedInput)) {
      return yield* executeSingleCanonicalMutation({
        db,
        subject,
        current,
        preparation: Effect.succeed(
          refusedPreparation(
            adapter.value.invalidRefusal({ db, subject, current, input: work.input, bucket })
          )
        ),
        present: adapter.value.present,
        hostedFence,
        oauthConfirmation,
      });
    }
    const ownerWork = { db, subject, current, input: decodedInput.value, bucket };
    const response = yield* executeSingleCanonicalMutation({
      db,
      subject,
      current,
      preparation: adapter.value.prepare(ownerWork),
      present: adapter.value.present,
      hostedFence,
      oauthConfirmation,
    });
    return work.operation === "ingestion.submitForExtraction" &&
      response.status === httpServiceUnavailable
      ? unavailableStatement()
      : response;
  }).pipe((effect) => observeCanonicalResponse(effect, work.operation));
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
    if (
      budgetWork &&
      (yield* reconcileBudgetThresholds({ db: input.db, userId: input.subject.userId })) !==
        "Drained"
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
              oauthConfirmation: input.oauthConfirmation,
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
              oauthConfirmation: Option.none(),
            }),
        })
      : executeCall({ ...input, work });
    if (result.ok && budgetWork) {
      yield* reconcileBudgetThresholds({ db: input.db, userId: input.subject.userId });
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
  if (
    input.work._tag === "Batch" ||
    !requiresOAuthConfirmation(operation) ||
    Option.isSome(input.oauthConfirmation)
  ) {
    return Option.none();
  }
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
    (effect) =>
      input.work._tag === "Batch" ? observeCanonicalResponse(effect, atomicBatchOperation) : effect,
    Effect.provideService(
      HostedInference,
      Option.getOrElse(input.inference, () => unreachableHostedInference)
    )
  );
};

/** The verified statement channel discovers only adapters installed for its native authority. */
export const installedHostedStatementOperations = (): ReadonlyArray<CatalogOperation> =>
  operationCatalog.operations.filter(
    ({ id, policy }) =>
      decideOperationAccess(policy.access, {
        _tag: "HostedAgentSession",
        authorityRoot: "verified-whatsapp",
      })._tag === "Allowed" &&
      (id === atomicBatchOperation ||
        Option.isSome(canonicalHostedStatementAdapter(id)) ||
        Option.isSome(canonicalHostedStatementQueryOwner(id)))
  );

export const installedCanonicalOperations = (): ReadonlyArray<CatalogOperation> =>
  operationCatalog.operations.filter(({ id, policy }) =>
    policy.kind === "query"
      ? Option.isSome(canonicalQueryOwner(id))
      : id === atomicBatchOperation || Option.isSome(canonicalMutationAdapter(id))
  );

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
      (url) =>
        url.origin === queryOrigin &&
        matchesRouteTemplate({ template: operation.route, path: url.pathname })
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
  completion,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  operation: CatalogOperation;
  request: Request;
  bucket: Option.Option<R2Bucket>;
  browserOrigin: Option.Option<string>;
  completion: Option.Option<CanonicalReadCompletion>;
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
          completion,
        })
      ).pipe((effect) => observeCanonicalResponse(effect, operation.id))
    );
    if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) {
      return yield* Effect.failCause(result.cause);
    }
    return Exit.isSuccess(result) ? Option.some(result.value) : Option.none();
  });

/**
 * Execute an admitted HTTP query through the installed owner dispatch. Document/view assembly
 * and accounting use the owner's native consistency guards. The HTTP adapter retains transport
 * admission; owners retain validation, live authority and Audit. Recurring's phased non-browser
 * reader still requires the same User's coordinator.
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
  completion: Option.Option<CanonicalReadCompletion>;
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
      !matchesRouteTemplate({ template: operation.value.route, path: url.pathname })
    ) {
      return transactionUnavailable();
    }
    if (operationId === "recurringPlans.getRecurringWorkspace") {
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
    const request = requestFor({ operation: operation.value, input });
    if (Option.isNone(request)) return Option.none();
    return yield* invokeQueryOwner({
      completion: Option.none(),
      db,
      subject,
      operation: operation.value,
      request: request.value,
      bucket,
      browserOrigin: Option.none(),
    });
  });

/** Native batch dispatch and the individual keyword and group-correction entry points. */
const successfulMutationStatus = 200;
export const isLocalBatchRoute = (id: string): boolean =>
  isNativeAccountQuery(id) ||
  id.startsWith("connections.") ||
  id === atomicBatchOperation ||
  id === "identity.updateUserPreferences" ||
  id === "identity.getCurrentUser" ||
  id === "transactions.updateTransactions" ||
  [
    "memory.remember",
    "memory.revise",
    "memory.forget",
    "memory.recall",
    "insights.listPendingInsights",
    "insights.getReminderSchedule",
    "insights.updateReminderSchedule",
    "insights.markInsightDelivered",
    "insights.markInsightRead",
    "insights.dismissInsight",
    "categories.createKeywordRule",
    "categories.updateKeywordRule",
    "categories.deleteKeywordRule",
    "categories.listKeywordRules",
    "ingestion.applyReviewEdit",
    "ingestion.abandonStatementSubmission",
    "ingestion.skipNeedsReviewItem",
    "ingestion.resolveNeedsReviewItem",
  ].includes(id);
type ReadOwner =
  | typeof readLocalMemories
  | typeof readLocalReminder
  | typeof readLocalProfile
  | typeof localKeywordRules;
type ReadEffect = ReturnType<ReadOwner>;
type NativeRead = (
  user: Parameters<ReadOwner>[0]
) => Effect.Effect<
  Effect.Success<ReadEffect>,
  Effect.Error<ReadEffect>,
  Effect.Services<ReadEffect>
>;
const localReads = new Map<string, NativeRead>([
  ["memory.recall", readLocalMemories],
  ["insights.getReminderSchedule", readLocalReminder],
  ["identity.getCurrentUser", readLocalProfile],
  ["categories.listKeywordRules", localKeywordRules],
]);
const reserveForwardingRoute =
  (directory: UserStoreBindings["DIRECTORY"]) =>
  (user: UserId): Effect.Effect<void, CanonicalAdmissionUnavailable, SqliteClient> =>
    reserveBatchForwarding(user, directory).pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
    );
type LocalBatchRoute = {
  directory: Pick<DurableObjectNamespace, "getByName">;
  operation: CatalogOperation;
  request: Request;
  storage: DurableObjectStorage;
  owns: (id: string) => boolean;
};
const pendingPageResponse = Effect.fn(function* (unit: LocalBatchRoute) {
  let continuation = Option.none<string>();
  const reply = yield* runLocalMutation({
    ...unit,
    input: Effect.succeedSome(true),
    work: (_input, user, current) =>
      readLocalPendingInsights(unit.request, user, current).pipe(
        Effect.map((page) => {
          continuation = page.next;
          return page.result;
        }),
        Effect.mapError((cause) => new Cause.UnknownError(cause))
      ),
  });
  if (reply.ok && Option.isSome(continuation)) {
    reply.headers.set("link", "<" + continuation.value + '>; rel="next"');
  }
  return reply;
});
const localBatchQuery = Effect.fn(function* (unit: LocalBatchRoute) {
  if (isNativeAccountQuery(unit.operation.id)) {
    return Option.some(
      yield* runLocalMutation({
        ...unit,
        input: Effect.succeedSome(true),
        work: (_input, user, current) => readNativeAccountQuery(unit.operation.id, user, current),
      })
    );
  }
  if (unit.operation.id.startsWith("connections.") && unit.operation.policy.kind === "query") {
    return Option.some(
      yield* runLocalMutation({
        ...unit,
        input: Effect.succeedSome(true),
        work: (_input, user) => queryLocalConnections(unit.operation.id, unit.request, user),
      })
    );
  }
  if (unit.operation.id === "insights.listPendingInsights") {
    return Option.some(yield* pendingPageResponse(unit));
  }
  const read = localReads.get(unit.operation.id);
  if (read === undefined) return Option.none<Response>();
  return Option.some(
    yield* runLocalMutation({
      ...unit,
      input: Effect.succeedSome(true),
      work: (_input, user) =>
        read(user).pipe(Effect.mapError((cause) => new Cause.UnknownError(cause))),
    })
  );
});
export const dispatchLocalBatchRoute = Effect.fn(
  function* (unit: LocalBatchRoute) {
    if (unit.operation.id === atomicBatchOperation) {
      return yield* runLocalBatch(
        {
          ...unit,
          reserveChildRoute: reserveForwardingRoute(unit.directory),
        },
        batchOwnersFor(unit)
      );
    }
    const query = yield* localBatchQuery(unit);
    if (Option.isSome(query)) return query.value;
    const prepare = localBatchOwners.get(unit.operation.id);
    if (prepare === undefined) return canonicalAdmissionUnavailable();
    return yield* runLocalMutation(
      {
        ...unit,
        input: localCanonicalArguments(unit.request, unit.operation),
        work: (input, user, current) =>
          prepare(input, { user, current, storage: unit.storage }).pipe(
            Effect.flatMap(commitLocalWrite),
            Effect.tap((result) =>
              unit.operation.id === "transactions.updateTransactions" &&
              result.status === successfulMutationStatus
                ? preserveStoreAlarm(unit.storage, current + recurringDiscoveryIntervalMs)
                : Effect.void
            )
          ),
      },
      (unit.operation.id === "categories.updateKeywordRule" ||
        unit.operation.id === "categories.deleteKeywordRule") &&
        Option.isNone(keywordRuleIdFromPath(unit.request))
        ? Option.some({
            status: 404,
            outcome: "not_found",
            body: {
              error: { code: "not_found", message: "No keyword rule with that id belongs to you." },
              next: [],
            },
          })
        : Option.none()
    );
  },
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const localOAuthReviewBinding: typeof localReviewBinding = (...args) =>
  localReviewBinding(...args);

/** The hosted channel may only project operations its independent canonical caller policy permits. */
const defaultReviewPageSize = 50;
const parameterizedReads = [
  "categories.listCategories",
  "quota.getQuota",
  "connections.listInstitutions",
  "connections.listConnections",
  "connections.getConnection",
  "connections.listAccounts",
  "insights.listPendingInsights",
  "transactions.listTransactions",
  "transactions.searchTransactions",
  "transactions.getTransaction",
  "ingestion.getStatementSubmission",
  "ingestion.listNeedsReviewItems",
];
export const localHostedCatalog = (
  authorityRoot: CanonicalAuthorityRoot
): ReadonlyArray<CatalogOperation> =>
  operationCatalog.operations.filter(
    (operation) =>
      (operation.id === atomicBatchOperation ||
        localBatchOwners.has(operation.id) ||
        localReads.has(operation.id) ||
        parameterizedReads.includes(operation.id)) &&
      decideOperationAccess(operation.policy.access, {
        _tag: "HostedAgentSession",
        authorityRoot,
      })._tag === "Allowed"
  );
const readParameter = Effect.fn(function* (
  operation: CatalogOperation,
  input: Schema.Json,
  context: Parameters<NonNullable<ReturnType<typeof localBatchOwners.get>>>[1]
) {
  const request = requestFor({ operation, input });
  if (Option.isNone(request)) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "invalid_route" });
  }
  if (operation.id.startsWith("connections.")) {
    return yield* queryLocalConnections(operation.id, request.value, context.user);
  }
  if (["transactions.listTransactions", "transactions.searchTransactions"].includes(operation.id)) {
    return yield* readLocalTransactionPage(request.value, context.user);
  }
  if (operation.id === "insights.listPendingInsights") {
    return (yield* readLocalPendingInsights(request.value, context.user, context.current)).result;
  }
  const url = new URL(request.value.url);
  if (operation.id === "ingestion.listNeedsReviewItems") {
    const args = yield* Schema.decodeEffect(
      getCanonicalOperationInput("ingestion.listNeedsReviewItems")
    )(input);
    return yield* readLocalReviewPage(
      {
        ...context,
        status: args.query.status,
        limit: Option.getOrElse(args.query.limit, () => defaultReviewPageSize),
        offset: Option.getOrElse(args.query.offset, () => 0),
      },
      context.user,
      context.current
    );
  }
  const id = url.pathname.split("/").at(-1);
  if (id === undefined) return yield* new CanonicalAdmissionUnavailable({ cause: "missing_id" });
  return operation.id === "transactions.getTransaction"
    ? yield* readAddressedLocalTransaction(id, context.user)
    : yield* readLocalSubmission(
        context.user,
        id,
        Option.map(Option.fromUndefinedOr(context.hostedTurn), (turn) => ({
          turn,
          current: context.current,
        }))
      );
});
export const prepareHostedBatchOwner = Effect.fnUntraced(function* (
  input: Schema.Json,
  context: Parameters<typeof prepareHostedBatch>[1]
) {
  return yield* prepareHostedBatch(input, context, localBatchOwners);
});
export const prepareHostedOwner = Effect.fn(function* (
  operation: CatalogOperation,
  input: Schema.Json,
  context: Parameters<NonNullable<ReturnType<typeof localBatchOwners.get>>>[1]
) {
  if (parameterizedReads.includes(operation.id)) {
    return Option.some(
      prepareLocalWrite({
        targets: [],
        commit: (isNativeAccountQuery(operation.id)
          ? readNativeAccountQuery(operation.id, context.user, context.current)
          : readParameter(operation, input, context)
        ).pipe(Effect.mapError((cause) => new Cause.UnknownError(cause))),
      })
    );
  }
  const read = localReads.get(operation.id);
  if (read !== undefined) {
    return Option.some(
      prepareLocalWrite({
        targets: [],
        commit: read(context.user).pipe(Effect.mapError((cause) => new Cause.UnknownError(cause))),
      })
    );
  }
  const owner = localBatchOwners.get(operation.id);
  if (owner === undefined) return Option.none();
  return Option.some(yield* owner(input, context));
});
