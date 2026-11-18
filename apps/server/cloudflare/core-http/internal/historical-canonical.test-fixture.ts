import {
  prepareBoundReviewItem,
  prepareBoundReviewMaterial,
  prepareBoundReviewPageContext,
  prepareBoundReviewWorkspace,
  validationFailed,
} from "../../ingestion/operations";

import { executeCanonicalHttpQuery } from "../../canonical-operations/operations";

import { UpdateTransactionsInput } from "../../../src/shell/transactions/contract";

import { prepareBoundRecurringWorkspace } from "../../recurring-plans/operations";

import {
  browseDashboard,
  prepareBoundDashboardCatalog,
  prepareBoundDashboardView,
} from "../../dashboard/operations";

import {
  type CanonicalBrowserRead,
  type CanonicalBrowserSnapshotOperation,
  type CanonicalBrowserSourceRead,
  type CanonicalReadCompletion,
} from "../../canonical-admission/contract";

import { ReviewCommand } from "../../../src/core/ingestion/contract";

import { RecurringCommand } from "../../../src/core/recurring-plans/contract";

import { captureTraceHeaders } from "../../runtime/telemetry/operations";

import { ConnectInstitutionInput } from "../../../src/core/connections/contract";

import { type MemoryOperationId, memoryOperationIds } from "../../../src/shell/memory/contract";

import {
  protectCanonicalBrowserRequest,
  protectCanonicalBrowserSnapshot,
  protectCanonicalBrowserSource,
} from "../../canonical-admission/operations";

import { MemoryId, RememberInput, ReviseInput } from "../../../src/core/memory/contract";

import { observeCanonicalResponse } from "../../runtime/application-observation/operations";

import { type Cause, Clock, Duration, Effect, Option, Schema } from "effect";

import {
  correctionInput,
  transactionInput,
  transactionPairInput,
} from "../../transactions/operations";

import { BudgetId, CreateBudgetInput, UpdateBudgetInput } from "../../../src/core/budgets/contract";

import { DeliveryEvidenceInput, InsightEventId } from "../../../src/core/insights/contract";

import { budgetRefusal, prepareBoundBudgetWorkspace } from "../../budgets/operations";

import {
  type TransactionCaller as CanonicalCaller,
  isPATCaller,
  maximumTransactionGroupInputBytes,
  maximumTransactionInputBytes,
  rejectBatchEnvelope,
  rejectInvalidTransactionInput,
} from "../../canonical-work/operations";

import { RequestBodyPolicy } from "../../http/contract";

import { boundedJsonBody, pathId, rawPathId } from "../../http/operations";

import { prepareBoundSubscriptionRead } from "../../subscription/operations";

import { prepareBoundPATList } from "../../tokens/operations";

import { rejectMemoryMutation } from "../../memory/operations";

import {
  BatchInput,
  type CanonicalWork,
  CanonicalWorkAdmission,
  type PATAuthority,
  type WebSessionAuthority,
} from "../../canonical-operations/contract";

import { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";

import { type CatalogOperation } from "../../../src/shell/canonical-catalog/contract";

import {
  atomicBatchOperation,
  maximumAtomicBatchCalls,
} from "../../../src/shell/operations/contract";

import { operationCatalog } from "../../../src/shell/api";

import {
  keywordRuleIdFromPath,
  keywordRuleInput,
  keywordRuleInvalidInput,
  keywordRuleUnknownId,
  prepareBoundCategoryRead,
} from "../../categories/operations";

import { ResolveNeedsReviewItemInput } from "../../../src/shell/ingestion/contract";

import type { CoreHttpEnvironment as NativeHttpEnvironment } from "../contract";

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

const HTTP_FORBIDDEN = 403;

const HTTP_METHOD_NOT_ALLOWED = 405;

const HTTP_SERVICE_UNAVAILABLE = 503;

const jsonResponse = (body: string, status: number): Response =>
  new Response(body, { headers: jsonHeaders, status });

const unavailable = (): Response =>
  jsonResponse('{"status":"unavailable"}', HTTP_SERVICE_UNAVAILABLE);

const methodNotAllowed = (): Response =>
  new Response('{"status":"method_not_allowed"}', {
    headers: { ...jsonHeaders, allow: "GET" },
    status: HTTP_METHOD_NOT_ALLOWED,
  });

const patAdmission = (authority: PATAuthority, work: CanonicalWork): CanonicalWorkAdmission => ({
  _tag: "PATWork",
  ...authority,
  work,
});

const sessionAdmission = (
  authority: WebSessionAuthority,
  work: CanonicalWork
): CanonicalWorkAdmission => ({ _tag: "WebSessionWork", ...authority, work });

/**
 * Bind one admitted caller to the exact admission variant for this canonical work. The
 * coordinator's own published schema types every field here, so the Worker cannot drift from it.
 */
type TransactionCaller = Exclude<
  CanonicalCaller,
  { oauthConnectionId: string } | { _tag: "HostedCanonical" }
>;

const coordinatorAdmission = (
  subject: TransactionCaller,
  work: CanonicalWork
): CanonicalWorkAdmission =>
  isPATCaller(subject)
    ? patAdmission(
        {
          patId: subject.patId,
          userId: subject.userId,
          digest: Array.from(subject.digest),
          requiredScope: Option.getOrNull(subject.requiredScope),
        },
        work
      )
    : sessionAdmission(
        {
          sessionId: subject.id,
          userId: subject.userId,
          digest: Array.from(subject.digest),
        },
        work
      );

/** Inert per-admission URL suffix; the coordinator decodes the admission from the body alone. */
const coordinatorRoutes = {
  Query: "canonical",
  Call: "call",
  Batch: "batch",
} as const;

/**
 * One canonical call for an individual mutation: the operation id plus its input encoded by that
 * operation's own published codec, so the coordinator decodes exactly the JSON shape the catalog
 * publishes. An input the codec cannot encode is sent as it stands, and the owner adapter classifies
 * it (an unstable retained id, for example, stays the owner's not_found answer).
 */
const canonicalCall = (operation: CanonicalOperationId, input: unknown): CanonicalWork => {
  const catalogOperation = operationCatalog.byId.get(operation);
  const encoded =
    catalogOperation === undefined
      ? Option.none()
      : Schema.encodeUnknownOption(catalogOperation.input)(input);
  return {
    _tag: "Call",
    operation,
    input: Option.getOrElse(encoded, () => input),
  };
};

/** Encode one work admission and deliver it to the caller's User coordinator. */
const dashboardSuccessStatus = 200;

const sendToCoordinator = ({
  environment,
  subject,
  work,
  completion,
}: Readonly<{
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
  work: CanonicalWork;
  completion: Option.Option<CanonicalReadCompletion>;
}>): Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    const traceHeaders = yield* captureTraceHeaders;
    const stub = environment.USER_TRANSACTION_COORDINATOR.getByName(subject.userId);
    const admission = coordinatorAdmission(subject, work);
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalWorkAdmission))(
      Option.isSome(completion) &&
        work._tag === "Query" &&
        ["dashboard.getDashboardView", "recurringPlans.getRecurringWorkspace"].includes(
          work.operation
        ) &&
        admission._tag === "WebSessionWork"
        ? { ...admission, _tag: "WebSessionQueryWork", leaseId: completion.value.leaseId }
        : coordinatorAdmission(subject, work)
    );
    const [duration, response] = yield* Effect.timed(
      Effect.tryPromise(() =>
        stub.fetch(
          new Request(`https://coordinator.internal/${coordinatorRoutes[work._tag]}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...traceHeaders },
            body,
          })
        )
      )
    );
    if (
      work._tag === "Batch" ||
      work.operation !== "dashboard.getDashboardView" ||
      response.status !== dashboardSuccessStatus
    ) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.append("server-timing", `dashboard-hop;dur=${Duration.toMillis(duration).toFixed(3)}`);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });

const groupCorrectionPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumTransactionGroupInputBytes,
  deadlineMilliseconds: 2000,
});

const maximumBatchBytes = maximumAtomicBatchCalls * maximumTransactionInputBytes;

const batchPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumBatchBytes,
  deadlineMilliseconds: 2000,
});

const dispatchCanonicalBatch = (
  request: Request,
  environment: CoreHttpEnvironment,
  subject: TransactionCaller
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const parsed = yield* boundedJsonBody({ request, policy: batchPolicy, schema: BatchInput });
    if (Option.isNone(parsed)) {
      const current = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise(() =>
        rejectBatchEnvelope({ db: environment.DB, subject, current })
      );
    }
    return yield* sendToCoordinator({
      completion: Option.none(),
      environment,
      subject,
      work: { _tag: "Batch", calls: parsed.value.calls },
    });
  });

const dispatchCanonicalCapture = (
  request: Request,
  environment: CoreHttpEnvironment,
  subject: TransactionCaller
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const input = yield* transactionInput(request);
    if (Option.isNone(input)) {
      const current = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise(() =>
        rejectInvalidTransactionInput({
          db: environment.DB,
          subject,
          operation: "transactions.createTransaction",
          current,
        })
      );
    }
    return yield* sendToCoordinator({
      completion: Option.none(),
      environment,
      subject,
      work: canonicalCall(CanonicalOperationId.make("transactions.createTransaction"), {
        payload: input.value,
      }),
    });
  });

const dispatchCanonicalCorrection = (
  request: Request,
  environment: CoreHttpEnvironment,
  subject: TransactionCaller
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const input = yield* correctionInput(request);
    if (Option.isNone(input)) {
      const current = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise(() =>
        rejectInvalidTransactionInput({
          db: environment.DB,
          subject,
          operation: "transactions.updateTransaction",
          current,
        })
      );
    }
    return yield* sendToCoordinator({
      completion: Option.none(),
      environment,
      subject,
      work: canonicalCall(CanonicalOperationId.make("transactions.updateTransaction"), {
        params: { id: rawPathId({ request }) },
        payload: input.value,
      }),
    });
  });

const dispatchCanonicalPair = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    subject: TransactionCaller;
    operation: "transactions.linkTransactions" | "transactions.unlinkTransactions";
  }>
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> => {
  const { request, environment, subject, operation } = input;
  return Effect.gen(function* () {
    const pair = yield* transactionPairInput(request);
    if (Option.isNone(pair)) {
      const current = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise(() =>
        rejectInvalidTransactionInput({ db: environment.DB, subject, operation, current })
      );
    }
    return yield* sendToCoordinator({
      completion: Option.none(),
      environment,
      subject,
      work: canonicalCall(CanonicalOperationId.make(operation), { payload: pair.value }),
    });
  });
};

/** The Reconciliation mutation an admitted operation names, when it names one. */
const reconciliationOperation = (
  operation: CatalogOperation
): Option.Option<"transactions.linkTransactions" | "transactions.unlinkTransactions"> => {
  if (operation.id === "transactions.linkTransactions") {
    return Option.some("transactions.linkTransactions");
  }
  if (operation.id === "transactions.unlinkTransactions") {
    return Option.some("transactions.unlinkTransactions");
  }
  return Option.none();
};

const unavailableCanonicalAdapter = (): Response =>
  jsonResponse(
    '{"error":{"code":"unavailable","message":"Canonical operation is temporarily unavailable."},"next":[]}',
    HTTP_SERVICE_UNAVAILABLE
  );

/** One canonical call for an admitted owner operation, without restating its published id. */
const ownerCall = (
  operation: CanonicalOperationId | MemoryMutationId,
  input: unknown
): CanonicalWork => canonicalCall(CanonicalOperationId.make(operation), input);

const keywordRuleMutationResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    subject: TransactionCaller;
    operation: CanonicalOperationId;
  }>
): Effect.Effect<Response> => {
  const { request, environment, subject, operation } = input;
  return Effect.gen(function* () {
    if (operation === "categories.createKeywordRule") {
      const payload = yield* Effect.tryPromise(() => keywordRuleInput({ request, update: false }));
      return Option.isNone(payload)
        ? keywordRuleInvalidInput()
        : yield* sendToCoordinator({
            completion: Option.none(),
            environment,
            subject,
            work: ownerCall(operation, { payload: payload.value }),
          });
    }
    const id = keywordRuleIdFromPath(request);
    if (Option.isNone(id)) return keywordRuleUnknownId();
    if (operation === "categories.deleteKeywordRule") {
      return yield* sendToCoordinator({
        completion: Option.none(),
        environment,
        subject,
        work: ownerCall(operation, { params: { id: id.value } }),
      });
    }
    if (operation !== "categories.updateKeywordRule") return unavailable();
    const payload = yield* Effect.tryPromise(() => keywordRuleInput({ request, update: true }));
    return Option.isNone(payload)
      ? keywordRuleInvalidInput()
      : yield* sendToCoordinator({
          completion: Option.none(),
          environment,
          subject,
          work: ownerCall(operation, {
            params: { id: id.value },
            payload: payload.value,
          }),
        });
  }).pipe(Effect.orElseSucceed(unavailable));
};

/** The keyword-rule work this dispatch owns, or None when another slice owns the operation. */
const keywordRuleResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
  }>
): Option.Option<Effect.Effect<Response>> => {
  const { request, environment, operation, subject } = input;
  if (
    operation.id !== "categories.createKeywordRule" &&
    operation.id !== "categories.updateKeywordRule" &&
    operation.id !== "categories.deleteKeywordRule"
  ) {
    return Option.none();
  }
  return Option.some(
    keywordRuleMutationResponse({ request, environment, subject, operation: operation.id }).pipe(
      Effect.withSpan(operation.id)
    )
  );
};

/** The Memory id one retained-route path addresses, or None when it is not a stable identity. */
const memoryIdFromPath = (request: Request): Option.Option<MemoryId> =>
  pathId({ schema: MemoryId, request });

const rejectInvalidMemory = ({
  environment,
  subject,
  operation,
}: Readonly<{
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
  operation: MemoryMutationId;
}>): Effect.Effect<Response> =>
  rejectMemoryMutation({
    db: environment.DB,
    subject,
    operation,
    outcome: "validation_failed",
  });

/**
 * Decode one Memory mutation's route and body, answer the owner's validation refusal when either
 * fails the published schema, and dispatch the admitted call to the caller's coordinator. The
 * remember, revise, and forget entry points differ only in what they decode.
 */
const dispatchMemoryMutation = <Input>({
  environment,
  subject,
  operation,
  decode,
}: Readonly<{
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
  operation: MemoryMutationId;
  decode: Effect.Effect<Option.Option<Input>>;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const decoded = yield* decode;
    if (Option.isNone(decoded)) {
      return yield* rejectInvalidMemory({ environment, subject, operation });
    }
    return yield* sendToCoordinator({
      completion: Option.none(),
      environment,
      subject,
      work: ownerCall(operation, decoded.value),
    });
  }).pipe(Effect.orElseSucceed(unavailable));

const rememberMemoryResponse = ({
  request,
  environment,
  subject,
}: Readonly<{
  request: Request;
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
}>): Effect.Effect<Response> =>
  dispatchMemoryMutation({
    environment,
    subject,
    operation: "memory.remember",
    decode: boundedJsonBody({ request, policy: memoryBodyPolicy, schema: RememberInput }).pipe(
      Effect.map(Option.map((payload) => ({ payload }))),
      Effect.orElseSucceed(() => Option.none<{ payload: RememberInput }>())
    ),
  });

const reviseMemoryResponse = ({
  request,
  environment,
  subject,
}: Readonly<{
  request: Request;
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
}>): Effect.Effect<Response> =>
  dispatchMemoryMutation({
    environment,
    subject,
    operation: "memory.revise",
    decode: Effect.gen(function* () {
      const payload = yield* boundedJsonBody({
        request,
        policy: memoryBodyPolicy,
        schema: ReviseInput,
      }).pipe(Effect.orElseSucceed(() => Option.none<ReviseInput>()));
      return Option.zipWith(memoryIdFromPath(request), payload, (id, value) => ({
        params: { id },
        payload: value,
      }));
    }),
  });

const forgetMemoryResponse = ({
  request,
  environment,
  subject,
}: Readonly<{
  request: Request;
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
}>): Effect.Effect<Response> =>
  dispatchMemoryMutation({
    environment,
    subject,
    operation: "memory.forget",
    decode: Effect.succeed(Option.map(memoryIdFromPath(request), (id) => ({ params: { id } }))),
  });

const memoryMutationResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    operation: MemoryMutationId;
    subject: TransactionCaller;
    completion: Option.Option<CanonicalReadCompletion>;
  }>
): Effect.Effect<Response> => {
  const { request, environment, operation, subject } = input;
  if (operation === "memory.remember") {
    return rememberMemoryResponse({ request, environment, subject });
  }
  if (operation === "memory.revise") {
    return reviseMemoryResponse({ request, environment, subject });
  }
  return forgetMemoryResponse({ request, environment, subject });
};

const insightBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});

const budgetBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});

const invalidBudgetInput = (id: Option.Option<BudgetId>): unknown =>
  Option.isSome(id) ? { params: { id: id.value }, payload: {} } : { payload: {} };

const budgetCanonicalInput = (
  operation: "budgets.createBudget" | "budgets.updateBudget" | "budgets.deleteBudget",
  id: Option.Option<BudgetId>,
  payload: Option.Option<CreateBudgetInput>
): unknown => {
  switch (operation) {
    case "budgets.createBudget":
      return { payload: Option.getOrThrow(payload) };
    case "budgets.deleteBudget":
      return { params: { id: Option.getOrThrow(id) } };
    case "budgets.updateBudget":
      return { params: { id: Option.getOrThrow(id) }, payload: Option.getOrThrow(payload) };
  }
};

/** Route a decoded Budget mutation to the same User-coordinated canonical D1 unit as batches. */
const budgetMutationResponse = ({
  request,
  environment,
  subject,
  operation,
}: Readonly<{
  request: Request;
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
  operation: "budgets.createBudget" | "budgets.updateBudget" | "budgets.deleteBudget";
}>): Effect.Effect<Response> => {
  const bodySchema =
    operation === "budgets.createBudget"
      ? Schema.toCodecJson(CreateBudgetInput)
      : Schema.toCodecJson(UpdateBudgetInput);
  return Effect.gen(function* () {
    const id =
      operation === "budgets.createBudget"
        ? Option.none<BudgetId>()
        : pathId({ schema: BudgetId, request });
    if (operation !== "budgets.createBudget" && Option.isNone(id)) {
      const refusal = budgetRefusal({
        db: environment.DB,
        subject,
        operation,
        current: yield* Clock.currentTimeMillis,
        code: "not_found",
      });
      const disposition = yield* refusal.record();
      return disposition === "recorded" ? yield* refusal.respond(disposition) : unavailable();
    }
    const payload =
      operation === "budgets.deleteBudget"
        ? Option.none<CreateBudgetInput>()
        : yield* boundedJsonBody({
            request,
            policy: budgetBodyPolicy,
            schema: bodySchema,
          }).pipe(Effect.orElseSucceed(() => Option.none<CreateBudgetInput>()));
    if (operation !== "budgets.deleteBudget" && Option.isNone(payload)) {
      return yield* sendToCoordinator({
        completion: Option.none(),
        environment,
        subject,
        work: ownerCall(CanonicalOperationId.make(operation), invalidBudgetInput(id)),
      });
    }
    return yield* sendToCoordinator({
      completion: Option.none(),
      environment,
      subject,
      work: ownerCall(
        CanonicalOperationId.make(operation),
        budgetCanonicalInput(operation, id, payload)
      ),
    });
  }).pipe(Effect.orElseSucceed(unavailable));
};

const BudgetOperation = Schema.Literals([
  "budgets.createBudget",
  "budgets.updateBudget",
  "budgets.deleteBudget",
]);

const budgetResponse = ({
  request,
  environment,
  subject,
  operation,
}: Readonly<{
  request: Request;
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
  operation: CatalogOperation;
}>): Option.Option<Effect.Effect<Response>> => {
  const selected = Schema.decodeUnknownOption(BudgetOperation)(operation.id);
  if (Option.isNone(selected)) return Option.none();
  const selectedId = selected.value;
  switch (selectedId) {
    case "budgets.createBudget":
    case "budgets.updateBudget":
    case "budgets.deleteBudget":
      return Option.some(
        budgetMutationResponse({ request, environment, subject, operation: selectedId }).pipe(
          Effect.withSpan(operation.id)
        )
      );
    default:
      return Option.none();
  }
};

const memoryBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16_384,
  deadlineMilliseconds: 2_000,
});

type MemoryMutationId = Exclude<MemoryOperationId, "memory.recall">;

/** The Memory mutation this dispatch owns, and None for any other canonical operation. */
const memoryMutationOperation = (id: string): Option.Option<MemoryMutationId> => {
  const declared = memoryOperationIds.find((operation) => operation === id);
  return declared === undefined || declared === "memory.recall"
    ? Option.none()
    : Option.some(declared);
};

/** The Memory work this dispatch owns, or None when another slice owns the operation. */
const memoryResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
  }>
): Option.Option<Effect.Effect<Response>> => {
  const { request, environment, operation, subject } = input;
  return Option.map(memoryMutationOperation(operation.id), (owned) =>
    memoryMutationResponse({
      completion: Option.none(),
      request,
      environment,
      subject,
      operation: owned,
    }).pipe(Effect.withSpan(owned))
  );
};

/** Statement bytes enter only through verified WhatsApp document admission. */
const statementUploadResponse = (request: Request): Effect.Effect<Response> =>
  Effect.succeed(
    request.method === "POST"
      ? Response.json(
          {
            error: {
              code: "user_action_required",
              message: "Attach a CSV or XLSX statement directly in WhatsApp.",
            },
            next: [],
          },
          { status: HTTP_FORBIDDEN, headers: { "cache-control": "no-store" } }
        )
      : methodNotAllowed()
  );

type IngestionResponseInput = Readonly<{
  operation: CatalogOperation;
  request: Request;
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
}>;

const forwardingCanonicalResponse = ({
  operation,
  environment,
  subject,
}: IngestionResponseInput): Option.Option<Effect.Effect<Response>> => {
  if (operation.id === "ingestion.enableEmailForwarding") {
    return Option.some(
      sendToCoordinator({
        completion: Option.none(),
        environment,
        subject,
        work: canonicalCall(operation.id, {}),
      }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan(operation.id))
    );
  }
  return Option.none();
};

const clarificationIdPosition = -2;

const clarificationBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 4096,
  deadlineMilliseconds: 2000,
});

const clarificationCanonicalResponse = ({
  operation,
  request,
  environment,
  subject,
}: IngestionResponseInput): Option.Option<Effect.Effect<Response>> => {
  if (
    operation.id !== "ingestion.resolveNeedsReviewItem" &&
    operation.id !== "ingestion.skipNeedsReviewItem" &&
    operation.id !== "ingestion.abandonStatementSubmission"
  ) {
    return Option.none();
  }
  return Option.some(
    Effect.gen(function* () {
      const id = new URL(request.url).pathname.split("/").at(clarificationIdPosition) ?? "";
      if (operation.id === "ingestion.resolveNeedsReviewItem") {
        const payload = yield* boundedJsonBody({
          request,
          policy: clarificationBodyPolicy,
          schema: Schema.toCodecJson(ResolveNeedsReviewItemInput),
        });
        if (Option.isNone(payload)) {
          return validationFailed("Invalid statement clarification input.");
        }
        return yield* sendToCoordinator({
          completion: Option.none(),
          environment,
          subject,
          work: ownerCall(operation.id, { params: { id }, payload: payload.value }),
        });
      }
      return yield* sendToCoordinator({
        completion: Option.none(),
        environment,
        subject,
        work: ownerCall(operation.id, { params: { id } }),
      });
    }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan(operation.id))
  );
};

const ingestionCanonicalResponse = (
  input: IngestionResponseInput
): Option.Option<Effect.Effect<Response>> => {
  const forwarding = forwardingCanonicalResponse(input);
  if (Option.isSome(forwarding)) return forwarding;
  const clarification = clarificationCanonicalResponse(input);
  if (Option.isSome(clarification)) return clarification;
  const { operation, request } = input;
  if (operation.id === "ingestion.submitForExtraction") {
    return Option.some(statementUploadResponse(request));
  }
  return Option.none();
};

const dispatchGroupCorrection = ({
  request,
  environment,
  subject,
  operation,
}: Parameters<typeof transactionResponse>[0]): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const payload = yield* boundedJsonBody({
      request,
      policy: groupCorrectionPolicy,
      schema: Schema.toCodecJson(UpdateTransactionsInput),
    });
    if (Option.isNone(payload)) {
      const current = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise(() =>
        rejectInvalidTransactionInput({
          db: environment.DB,
          subject,
          operation: "transactions.updateTransactions",
          current,
        })
      );
    }
    return yield* sendToCoordinator({
      completion: Option.none(),
      environment,
      subject,
      work: canonicalCall(operation.id, { payload: payload.value }),
    });
  }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan(operation.id));

/**
 * The Transaction work this dispatch owns, or None when another slice owns the operation.
 */
const transactionResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
  }>
): Option.Option<Effect.Effect<Response>> => {
  const { request, environment, operation, subject } = input;
  if (operation.id === "transactions.createTransaction") {
    return Option.some(
      dispatchCanonicalCapture(request, environment, subject).pipe(
        Effect.orElseSucceed(unavailable),
        Effect.withSpan("transactions.createTransaction")
      )
    );
  }
  if (operation.id === "transactions.updateTransactions") {
    return Option.some(dispatchGroupCorrection(input));
  }
  if (operation.id === "transactions.updateTransaction") {
    return Option.some(
      dispatchCanonicalCorrection(request, environment, subject).pipe(
        Effect.orElseSucceed(unavailable),
        Effect.withSpan("transactions.updateTransaction")
      )
    );
  }
  if (operation.id === "transactions.deleteTransaction") {
    return Option.some(
      sendToCoordinator({
        completion: Option.none(),
        environment,
        subject,
        work: canonicalCall(operation.id, { params: { id: rawPathId({ request }) } }),
      }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan(operation.id))
    );
  }
  const reconciliation = reconciliationOperation(operation);
  if (Option.isSome(reconciliation)) {
    return Option.some(
      dispatchCanonicalPair({
        request,
        environment,
        subject,
        operation: reconciliation.value,
      }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan(reconciliation.value))
    );
  }
  if (operation.id === atomicBatchOperation) {
    return Option.some(
      dispatchCanonicalBatch(request, environment, subject).pipe(
        Effect.orElseSucceed(unavailable),
        Effect.withSpan(atomicBatchOperation)
      )
    );
  }
  return Option.none();
};

const insightRoutePosition = -2;

const insightResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    subject: TransactionCaller;
    operation: CatalogOperation;
  }>
): Option.Option<Effect.Effect<Response>> => {
  const { request, environment, operation, subject } = input;
  if (
    operation.id !== "insights.markInsightDelivered" &&
    operation.id !== "insights.markInsightRead" &&
    operation.id !== "insights.dismissInsight"
  ) {
    return Option.none();
  }
  return Option.some(
    Effect.gen(function* () {
      const insightPathId = new URL(request.url).pathname.split("/").at(insightRoutePosition) ?? "";
      const id = Schema.decodeOption(InsightEventId)(insightPathId);
      if (Option.isNone(id)) {
        return yield* sendToCoordinator({
          completion: Option.none(),
          environment,
          subject,
          work: ownerCall(operation.id, { params: { id: insightPathId } }),
        });
      }
      if (operation.id === "insights.markInsightDelivered") {
        const payload = yield* boundedJsonBody({
          request,
          policy: insightBodyPolicy,
          schema: Schema.toCodecJson(DeliveryEvidenceInput),
        });
        return yield* sendToCoordinator({
          completion: Option.none(),
          environment,
          subject,
          work: ownerCall(operation.id, {
            params: { id: id.value },
            payload: Option.getOrElse(payload, () => ({})),
          }),
        });
      }
      return yield* sendToCoordinator({
        completion: Option.none(),
        environment,
        subject,
        work: ownerCall(operation.id, { params: { id: id.value } }),
      });
    }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan(operation.id))
  );
};

const DashboardOperation = Schema.Literals([
  "dashboard.initializeDashboard",
  "dashboard.applyDashboardEdit",
]);

const dashboardResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
  }>
): Option.Option<Effect.Effect<Response>> =>
  Option.map(Schema.decodeUnknownOption(DashboardOperation)(input.operation.id), (operation) => {
    const request = { db: input.environment.DB, subject: input.subject, request: input.request };
    return browseDashboard({
      completion: Option.none(),
      ...request,
      operation,
      runMutation: (call) =>
        sendToCoordinator({
          completion: Option.none(),
          environment: input.environment,
          subject: input.subject,
          work: ownerCall(CanonicalOperationId.make(call.operation), Option.getOrNull(call.input)),
        }).pipe(Effect.orElseSucceed(unavailable)),
    });
  });

const connectionBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});

const connectInstitutionResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    subject: TransactionCaller;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const payload = yield* boundedJsonBody({
      request: input.request,
      policy: connectionBodyPolicy,
      schema: Schema.toCodecJson(ConnectInstitutionInput),
    }).pipe(Effect.orElseSucceed(() => Option.none()));
    return yield* sendToCoordinator({
      completion: Option.none(),
      environment: input.environment,
      subject: input.subject,
      work: ownerCall(CanonicalOperationId.make("connections.connectInstitution"), {
        payload: Option.getOrElse(payload, () => ({})),
      }),
    });
  }).pipe(Effect.orElseSucceed(unavailable));

const recurringBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16384,
  deadlineMilliseconds: 2000,
});

const recurringEditResponse = (
  input: Parameters<typeof connectInstitutionResponse>[0]
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const payload = yield* boundedJsonBody({
      request: input.request,
      policy: recurringBodyPolicy,
      schema: Schema.toCodecJson(RecurringCommand),
    }).pipe(Effect.orElseSucceed(() => Option.none()));
    const wire = Option.isSome(payload)
      ? yield* Schema.encodeEffect(Schema.toCodecJson(RecurringCommand))(payload.value)
      : {};
    return yield* sendToCoordinator({
      completion: Option.none(),
      environment: input.environment,
      subject: input.subject,
      work: ownerCall(CanonicalOperationId.make("recurringPlans.applyRecurringEdit"), {
        payload: wire,
      }),
    });
  }).pipe(Effect.orElseSucceed(unavailable));

const reviewEditResponse = (
  input: Parameters<typeof connectInstitutionResponse>[0]
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const payload = yield* boundedJsonBody({
      request: input.request,
      policy: recurringBodyPolicy,
      schema: Schema.toCodecJson(ReviewCommand),
    }).pipe(Effect.orElseSucceed(() => Option.none()));
    const wire = Option.isSome(payload)
      ? yield* Schema.encodeEffect(Schema.toCodecJson(ReviewCommand))(payload.value)
      : {};
    return yield* sendToCoordinator({
      completion: Option.none(),
      environment: input.environment,
      subject: input.subject,
      work: ownerCall(CanonicalOperationId.make("ingestion.applyReviewEdit"), { payload: wire }),
    });
  }).pipe(Effect.orElseSucceed(unavailable));

const workspaceEditResponse = (
  input: Parameters<typeof reviewEditResponse>[0] & Readonly<{ operation: CatalogOperation }>
): Option.Option<Effect.Effect<Response>> => {
  if (input.operation.id === "ingestion.applyReviewEdit") {
    return Option.some(reviewEditResponse(input));
  }
  return input.operation.id === "recurringPlans.applyRecurringEdit"
    ? Option.some(recurringEditResponse(input))
    : Option.none();
};

const reviewQueryBucket = (
  environment: CoreHttpEnvironment,
  operation: string
): Option.Option<R2Bucket> =>
  Option.fromUndefinedOr(
    operation === "ingestion.getReviewMaterial"
      ? environment.EMAIL_BUCKET
      : environment.STATEMENT_STAGING_BUCKET
  );

export const executeCanonicalWork = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
    completion: Option.Option<CanonicalReadCompletion>;
  }>
): Effect.Effect<Response> => {
  const { request, environment, operation, subject } = input;
  if (operation.policy.kind === "query") {
    return executeCanonicalHttpQuery({
      completion: input.completion,
      db: environment.DB,
      subject,
      operation: operation.id,
      request,
      bucket: reviewQueryBucket(environment, operation.id),
      browserOrigin: environment.BROWSER_ORIGIN,
      coordinate: (work) =>
        sendToCoordinator({ environment, subject, work, completion: input.completion }).pipe(
          Effect.orElseSucceed(unavailable)
        ),
    });
  }
  const workspaceEdit = workspaceEditResponse(input);
  if (Option.isSome(workspaceEdit)) return workspaceEdit.value;
  if (operation.id === "connections.connectInstitution") return connectInstitutionResponse(input);
  if (operation.id === "subscription.cancelSubscription") {
    return sendToCoordinator({
      completion: Option.none(),
      environment,
      subject,
      work: canonicalCall(operation.id, {}),
    }).pipe(Effect.orElseSucceed(unavailable));
  }
  const primaryOwner = Option.orElse(insightResponse(input), () => dashboardResponse(input));
  const otherOwner = Option.orElse(budgetResponse(input), () =>
    Option.orElse(keywordRuleResponse(input), () => memoryResponse(input))
  );
  const ownerResponse = Option.orElse(primaryOwner, () => otherOwner);
  if (Option.isSome(ownerResponse)) return ownerResponse.value;
  const transaction = transactionResponse(input);
  if (Option.isSome(transaction)) return transaction.value;
  const ingestion = ingestionCanonicalResponse({ environment, operation, request, subject });
  if (Option.isSome(ingestion)) return ingestion.value;
  return Effect.succeed(unavailableCanonicalAdapter());
};

const browserSnapshotReads: ReadonlyArray<
  Readonly<{
    operation: CanonicalBrowserSnapshotOperation;
    prepare: (request: Request) => CanonicalBrowserRead;
  }>
> = [
  { operation: "pats.listPATs", prepare: (): CanonicalBrowserRead => prepareBoundPATList },
  {
    operation: "subscription.listSubscriptionOffers",
    prepare: (): CanonicalBrowserRead =>
      prepareBoundSubscriptionRead("subscription.listSubscriptionOffers"),
  },
  {
    operation: "subscription.getSubscriptionStatus",
    prepare: (): CanonicalBrowserRead =>
      prepareBoundSubscriptionRead("subscription.getSubscriptionStatus"),
  },
  { operation: "recurringPlans.getRecurringWorkspace", prepare: prepareBoundRecurringWorkspace },
  {
    operation: "dashboard.listDashboardCatalog",
    prepare: (): CanonicalBrowserRead => prepareBoundDashboardCatalog,
  },
  { operation: "budgets.getBudgetStatus", prepare: prepareBoundBudgetWorkspace },
  { operation: "ingestion.getReviewWorkspace", prepare: prepareBoundReviewWorkspace },
  { operation: "ingestion.getReviewItem", prepare: prepareBoundReviewItem },
  { operation: "ingestion.getReviewPageContext", prepare: prepareBoundReviewPageContext },
  {
    operation: "categories.listCategories",
    prepare: (): CanonicalBrowserRead => prepareBoundCategoryRead,
  },
];

const browserReadAccess = (
  operation: CanonicalBrowserSnapshotOperation
): "WebOrHosted" | "WebSessionOnly" | "UserOwnedAgentScoped" => {
  if (operation === "pats.listPATs") return "WebOrHosted";
  return operation === "ingestion.getReviewPageContext" ? "WebSessionOnly" : "UserOwnedAgentScoped";
};

const preparedBrowserRead = (
  operation: CatalogOperation,
  request: Request
): Option.Option<
  Readonly<{
    operation: CanonicalBrowserSnapshotOperation;
    read: CanonicalBrowserRead;
  }>
> => {
  if (
    request.method !== "GET" ||
    operation.policy.kind !== "query" ||
    operation.policy.requiredTier !== "free"
  ) {
    return Option.none();
  }
  if (
    [
      "categories.listCategories",
      "dashboard.listDashboardCatalog",
      "pats.listPATs",
      "subscription.listSubscriptionOffers",
      "subscription.getSubscriptionStatus",
    ].includes(operation.id) &&
    new URL(request.url).search !== ""
  ) {
    return Option.none();
  }
  return Option.map(
    Option.fromUndefinedOr(
      browserSnapshotReads.find((entry) => entry.operation === operation.id)
    ).pipe(
      Option.filter((entry) => operation.policy.access._tag === browserReadAccess(entry.operation))
    ),
    (entry) => ({ operation: entry.operation, read: entry.prepare(request) })
  );
};

const isDashboardViewSource = (operation: CatalogOperation, request: Request): boolean =>
  operation.id === "dashboard.getDashboardView" &&
  operation.policy.access._tag === "UserOwnedAgentScoped" &&
  new URL(request.url).search === "";

const preparedBrowserSource = (
  operation: CatalogOperation,
  request: Request,
  environment: CoreHttpEnvironment
): Option.Option<CanonicalBrowserSourceRead> => {
  if (
    request.method !== "GET" ||
    operation.policy.requiredTier !== "free" ||
    operation.policy.kind !== "query"
  ) {
    return Option.none();
  }
  if (isDashboardViewSource(operation, request)) {
    return Option.some(prepareBoundDashboardView);
  }
  return operation.id === "ingestion.getReviewMaterial" &&
    operation.policy.access._tag === "WebSessionOnly"
    ? Option.some(
        prepareBoundReviewMaterial({
          request,
          bucket: reviewQueryBucket(environment, operation.id),
        })
      )
    : Option.none();
};

export const browserCanonicalResponse = ({
  request,
  environment,
  operation,
}: {
  request: Request;
  environment: CoreHttpEnvironment;
  operation: CatalogOperation;
}): Effect.Effect<Response> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((current) => {
      const source = preparedBrowserSource(operation, request, environment);
      if (Option.isSome(source)) {
        return protectCanonicalBrowserSource({
          request,
          db: environment.DB,
          current,
          operation,
          read: source.value,
        }).pipe(observeCanonicalResponse(operation.id));
      }
      const prepared = preparedBrowserRead(operation, request);
      if (Option.isSome(prepared)) {
        return protectCanonicalBrowserSnapshot({
          request,
          db: environment.DB,
          current,
          ...prepared.value,
        }).pipe(observeCanonicalResponse(operation.id));
      }
      return protectCanonicalBrowserRequest({
        request,
        db: environment.DB,
        operation,
        current,
        work: (subject, completion) =>
          executeCanonicalWork({
            request,
            environment,
            operation,
            subject,
            completion: Option.some(completion),
          }),
      });
    })
  );

export type HistoricalHttpEnvironment = NativeHttpEnvironment &
  Readonly<{
    DB: D1Database;
    USER_TRANSACTION_COORDINATOR: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
  }>;
type CoreHttpEnvironment = HistoricalHttpEnvironment;
