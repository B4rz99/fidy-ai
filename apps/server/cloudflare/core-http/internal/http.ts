import { ConnectInstitutionInput } from "../../../src/core/connections/contract";
import { connectionBrowserPaths } from "../../../src/shell/connections/contract";
import { handleConnectionBrowserRequest } from "../../connections/runtime";
import type { HttpClient } from "effect/http";
import { completeGoogleOnboarding } from "../../onboarding/operations";
import { providerPaths } from "../../../src/shell/provider-authentication/contract";
import {
  handleProviderAuthentication,
  ownsProviderAuthenticationPath,
} from "../../provider-authentication/operations";
import { oauthPaths } from "../../../src/shell/oauth-agents/contract";
import { handleOAuthRequest } from "../../oauth-agents/runtime";
import { type MemoryOperationId, memoryOperationIds } from "../../../src/shell/memory/contract";

import {
  protectCanonicalRequest,
  protectCanonicalSource,
} from "../../canonical-admission/operations";
import { UserId } from "../../../src/core/identity/contract";
import { HostedTurnProgressRequest } from "../../../src/shell/agent/contract";
import {
  HostedDeliveryAdmission,
  HostedProgressAdmission,
  HostedTurnAdmission,
  hostedDeliveryReceipt,
  hostedTurnInput,
} from "../../agent/contract";

import {
  dispatchBrowserPairingEmail,
  dispatchEmailReplacement,
  dispatchOnboardingEmail,
} from "../../email-authentication/runtime";

import { UserActionRequired } from "../../../src/shell/public-http/contract";
import { categoryUnavailable } from "../../../src/shell/categories/operations";
import { listCategoriesPath } from "../../../src/shell/categories/contract";
import { MemoryId, RememberInput, ReviseInput } from "../../../src/core/memory/contract";
import { type TelemetryService } from "../../../src/shell/observability/contract";
import { type Cause, Clock, Effect, Exit, Option, Schema } from "effect";
import {
  correctionInput,
  transactionInput,
  transactionPairInput,
  transactionSession,
} from "../../transactions/operations";
import { BudgetId, CreateBudgetInput, UpdateBudgetInput } from "../../../src/core/budgets/contract";
import { DeliveryEvidenceInput, InsightEventId } from "../../../src/core/insights/contract";
import { budgetRefusal } from "../../budgets/operations";
import { browseDashboard } from "../../dashboard/operations";
import { ownsTransactionPath as transactionPath } from "../../../src/shell/transactions/runtime";
import {
  type TransactionCaller as CanonicalCaller,
  isPATCaller,
  maximumTransactionInputBytes,
  rejectBatchEnvelope,
  rejectInvalidTransactionInput,
  unauthenticatedTransaction,
} from "../../canonical-work/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody, pathId, rawPathId } from "../../http/operations";

import {
  handleWebAuthentication,
  ownsWebAuthenticationPath,
} from "../../web-authentication/operations";
import { refundSupportRoute } from "../../subscription/operations";
import { paymentEnrollmentTransport } from "../../../src/shell/subscription/runtime";
import {
  dispatchBillingCollection,
  handlePaymentEnrollment,
  handleRefundSupport,
  receiveWompiBillingEvent,
} from "../../subscription/runtime";

import { resolveCanonicalPATCredential } from "../../tokens/operations";
import { rejectMemoryMutation } from "../../memory/operations";
import { executeCanonicalHttpQuery } from "../../canonical-operations/operations";
import { canonicalOperation, canonicalRoute } from "../../routing/operations";
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
} from "../../categories/operations";
import { contractDigestPattern, gitRevisionPattern } from "../../runtime/contract";
import { smokeFailureHeader, smokePath } from "../../runtime/release-smoke/contract";
import {
  handleSmoke,
  smokeProofAccepted,
  smokeReady,
} from "../../runtime/release-smoke/operations";

import {
  ResolveNeedsReviewItemInput,
  statementStagingPath,
} from "../../../src/shell/ingestion/contract";
import { validationFailed } from "../../ingestion/operations";

import {
  type WhatsAppDocumentAdmission,
  WhatsAppInboundAdmission,
  WhatsAppStatusAdmission,
  type WhatsAppTurnAdmission,
} from "../../whatsapp/contract";
import { dispatchWhatsAppWork, receiveWhatsAppWebhook } from "../../whatsapp/runtime";

import type { CoreHttpEnvironment } from "../contract";

const ReleaseConfiguration = Schema.Struct({
  CONTRACT_DIGEST: Schema.String.check(Schema.isPattern(contractDigestPattern)),
  RELEASE_GIT_SHA: Schema.String.check(Schema.isPattern(gitRevisionPattern)),
});

type PublicationKind =
  | "onboarding"
  | "browserPairing"
  | "emailReplacement"
  | "billing"
  | "whatsapp";
type PublishAcceptedWork = (kind: PublicationKind, id: string) => void;

const publicationActivities = (
  environment: CoreHttpEnvironment,
  identity: Option.Option<string>
): Record<PublicationKind, () => Effect.Effect<void, void>> => {
  const publishers: Record<PublicationKind, () => Effect.Effect<void, void>> = {
    whatsapp: () =>
      environment.HOSTED_WHATSAPP_QUEUE === undefined
        ? Effect.void
        : dispatchWhatsAppWork({
            db: environment.DB,
            queue: environment.HOSTED_WHATSAPP_QUEUE,
            userId: Option.map(identity, (id) => UserId.make(id)),
          }).pipe(Effect.mapError(() => undefined)),
    onboarding: () =>
      environment.ONBOARDING_EMAIL_QUEUE === undefined
        ? Effect.void
        : dispatchOnboardingEmail({
            DB: environment.DB,
            ONBOARDING_EMAIL_QUEUE: environment.ONBOARDING_EMAIL_QUEUE,
            identity,
          }),
    browserPairing: () =>
      environment.BROWSER_PAIRING_EMAIL_QUEUE === undefined
        ? Effect.void
        : dispatchBrowserPairingEmail({
            DB: environment.DB,
            BROWSER_PAIRING_EMAIL_QUEUE: environment.BROWSER_PAIRING_EMAIL_QUEUE,
            identity,
          }),
    emailReplacement: () =>
      environment.EMAIL_REPLACEMENT_QUEUE === undefined
        ? Effect.void
        : dispatchEmailReplacement({
            DB: environment.DB,
            EMAIL_REPLACEMENT_QUEUE: environment.EMAIL_REPLACEMENT_QUEUE,
            identity,
          }),
    billing: () =>
      environment.BILLING_COLLECTION_QUEUE === undefined
        ? Effect.void
        : dispatchBillingCollection({
            DB: environment.DB,
            BILLING_COLLECTION_QUEUE: environment.BILLING_COLLECTION_QUEUE,
            identity,
          }).pipe(Effect.mapError(() => undefined)),
  };
  return publishers;
};

/** Publication is an acceleration only; committed D1 intent remains recoverable by cron. */
export const acceptedWorkPublisher =
  ({
    environment,
    context,
  }: Readonly<{
    environment: CoreHttpEnvironment;
    context: Option.Option<Pick<ExecutionContext, "waitUntil">>;
  }>): PublishAcceptedWork =>
  (kind, id) => {
    if (Option.isNone(context)) return;
    const identity = Option.some(id);
    const publishers = publicationActivities(environment, identity);
    // Neither Queue failure nor a missing execution lifetime can change an already committed answer.
    Effect.runSync(
      Effect.try(() =>
        context.value.waitUntil(
          Effect.suspend(publishers[kind]).pipe(
            Effect.timeout("2 seconds"),
            Effect.catchCause(() =>
              Effect.logWarning({
                component: "outbox-publication",
                operation: kind,
                outcome: "failed",
              })
            ),
            Effect.runPromise
          )
        )
      ).pipe(Effect.ignore)
    );
  };

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
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

const forwardHostedWhatsApp = (
  environment: CoreHttpEnvironment,
  path: "whatsapp" | "whatsapp/status",
  admission: WhatsAppTurnAdmission | WhatsAppDocumentAdmission | WhatsAppStatusAdmission
): Promise<Response> =>
  Effect.runPromise(
    Schema.encodeEffect(
      Schema.fromJsonString(Schema.Union([WhatsAppInboundAdmission, WhatsAppStatusAdmission]))
    )(admission)
  ).then((body) =>
    environment.USER_TRANSACTION_COORDINATOR.getByName(admission.userId).fetch(
      new Request(`https://coordinator.internal/hosted-turn/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    )
  );

const callbackEffect = (
  request: Request,
  environment: CoreHttpEnvironment,
  publish: PublishAcceptedWork
): Effect.Effect<Response> =>
  request.method === "POST"
    ? receiveWhatsAppWebhook({
        ...environment,
        onAccepted: (id) => publish("onboarding", id),
        onHostedText: (admission) =>
          forwardHostedWhatsApp(environment, "whatsapp", admission).then((response) => {
            if (response.status === HTTP_ACCEPTED) publish("whatsapp", admission.userId);
            return response;
          }),
        onHostedStatus: (admission) =>
          forwardHostedWhatsApp(environment, "whatsapp/status", admission),
      })(request)
    : Effect.succeed(methodNotAllowed());

const providerCallbackEffect = (
  request: Request,
  environment: CoreHttpEnvironment,
  publish: PublishAcceptedWork
): Effect.Effect<Response> => {
  const path = new URL(request.url).pathname;
  if (path === "/providers/kapso/callback") return callbackEffect(request, environment, publish);
  if (request.method !== "POST") return Effect.succeed(methodNotAllowed());
  if (environment.WOMPI_EVENT_SECRET === undefined) return Effect.succeed(unavailable());
  return receiveWompiBillingEvent({
    request,
    environment: { ...environment, WOMPI_EVENT_SECRET: environment.WOMPI_EVENT_SECRET },
  }).pipe(Effect.withSpan("billing.collection.event"));
};

const enrollmentCorePath = (path: string): boolean =>
  Option.isSome(paymentEnrollmentTransport(path));

/** The PAT admission variant for one piece of canonical work. */
const patAdmission = (authority: PATAuthority, work: CanonicalWork): CanonicalWorkAdmission => ({
  _tag: "PATWork",
  ...authority,
  work,
});

/** The WebSession admission variant for one piece of canonical work. */
const sessionAdmission = (
  authority: WebSessionAuthority,
  work: CanonicalWork
): CanonicalWorkAdmission => ({ _tag: "WebSessionWork", ...authority, work });

/**
 * Bind one admitted caller to the exact admission variant for this canonical work. The
 * coordinator's own published schema types every field here, so the Worker cannot drift from it.
 */
type TransactionCaller = Exclude<CanonicalCaller, { oauthConnectionId: string }>;
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
const sendToCoordinator = ({
  environment,
  subject,
  work,
}: Readonly<{
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
  work: CanonicalWork;
}>): Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    // Work spans bound latency and status. Keep opaque ids and Money out of trace attributes.
    const stub = environment.USER_TRANSACTION_COORDINATOR.getByName(subject.userId);
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalWorkAdmission))(
      coordinatorAdmission(subject, work)
    );
    return yield* Effect.tryPromise(() =>
      stub.fetch(
        new Request(`https://coordinator.internal/${coordinatorRoutes[work._tag]}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      )
    );
  });

// One canonical child input is bounded by its own operation policy; a batch carries at most one
// such input per declared child, and each child is decoded and attributed by the batch adapter.
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
      environment,
      subject,
      work: canonicalCall(CanonicalOperationId.make("transactions.updateTransaction"), {
        // The correction owner classifies the addressed Transaction, so an id that is not a
        // stable identity is forwarded verbatim instead of being answered here.
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

const ownedCorePath = (path: string): boolean =>
  Object.values(connectionBrowserPaths).some((owned) => owned === path) ||
  ownsProviderAuthenticationPath(path) ||
  refundSupportRoute(path) ||
  enrollmentCorePath(path) ||
  [
    "/health",
    smokePath,
    listCategoriesPath,
    "/providers/kapso/callback",
    "/providers/wompi/billing-events",
    statementStagingPath,
    "/web/hosted-turns",
    "/web/hosted-turns/delivery",
    "/web/hosted-turns/progress",
  ].includes(path) ||
  transactionPath(path) ||
  ownsWebAuthenticationPath(path) ||
  canonicalRoute(path);

const consentRevokedResponse = (): Response =>
  jsonResponse(
    JSON.stringify(
      Schema.encodeSync(Schema.toCodecJson(UserActionRequired))(
        UserActionRequired.make({
          error: {
            code: "user_action_required",
            message: "Return to Fidy to review your withdrawn Consent.",
          },
          next: [],
        })
      )
    ),
    HTTP_FORBIDDEN
  );

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

/** One canonical keyword-rule mutation delivered to the caller's User coordinator. */
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
            environment,
            subject,
            work: ownerCall(operation, { payload: payload.value }),
          });
    }
    const id = keywordRuleIdFromPath(request);
    if (Option.isNone(id)) return keywordRuleUnknownId();
    if (operation === "categories.deleteKeywordRule") {
      return yield* sendToCoordinator({
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

/** Refuse one Memory mutation whose route or retained prose failed its published schema. */
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
      environment,
      subject,
      work: ownerCall(operation, decoded.value),
    });
  }).pipe(Effect.orElseSucceed(unavailable));

/** Decode one `memory.remember` body and dispatch it to the caller's User coordinator. */
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

/** Decode one `memory.revise` path and body and dispatch it to the caller's User coordinator. */
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

/** Dispatch one `memory.forget` path to the caller's User coordinator. */
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

/** Decode and dispatch one canonical Memory mutation to the caller's User coordinator. */
const memoryMutationResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    operation: MemoryMutationId;
    subject: TransactionCaller;
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
        environment,
        subject,
        work: ownerCall(CanonicalOperationId.make(operation), invalidBudgetInput(id)),
      });
    }
    return yield* sendToCoordinator({
      environment,
      subject,
      work: ownerCall(
        CanonicalOperationId.make(operation),
        budgetCanonicalInput(operation, id, payload)
      ),
    });
  }).pipe(Effect.orElseSucceed(unavailable));
};

/** The Budget owner's canonical query or mutation, never a parallel path declaration. */
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

/** The Memory mutation ids this dispatch owns, derived from the declared Memory operations. */
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
    memoryMutationResponse({ request, environment, subject, operation: owned }).pipe(
      Effect.withSpan(owned)
    )
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

/** Direct Core paths that own their own admission and session resolution. */
const hostedTurnPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16_384,
  deadlineMilliseconds: 2_000,
});
const hostedReceiptPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 512,
  deadlineMilliseconds: 2_000,
});

/** A browser-authenticated Turn crosses the same per-User coordinator as canonical work. */
const hostedTurnResponse = (
  request: Request,
  environment: CoreHttpEnvironment
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return methodNotAllowed();
    const current = yield* Clock.currentTimeMillis;
    const subject = yield* Effect.tryPromise(() =>
      transactionSession({ request, db: environment.DB, current })
    );
    if (Option.isNone(subject)) return unauthenticatedTransaction();
    const input = yield* boundedJsonBody({
      request,
      policy: hostedTurnPolicy,
      schema: hostedTurnInput,
    });
    if (Option.isNone(input)) {
      return Response.json({ status: "validation_failed" }, { status: 400, headers: jsonHeaders });
    }
    const stub = environment.USER_TRANSACTION_COORDINATOR.getByName(subject.value.userId);
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(HostedTurnAdmission))({
      userId: UserId.make(subject.value.userId),
      sessionId: subject.value.id,
      digest: Array.from(subject.value.digest),
      text: input.value.text,
    });
    return yield* Effect.tryPromise(() =>
      stub.fetch(
        new Request("https://coordinator.internal/hosted-turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: request.signal,
        })
      )
    );
  }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan("agent.hostedTurn"));

const hostedProgressResponse = (
  request: Request,
  environment: CoreHttpEnvironment
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return methodNotAllowed();
    const current = yield* Clock.currentTimeMillis;
    const subject = yield* Effect.tryPromise(() =>
      transactionSession({ request, db: environment.DB, current })
    );
    if (Option.isNone(subject)) return unauthenticatedTransaction();
    const input = yield* boundedJsonBody({
      request,
      policy: hostedReceiptPolicy,
      schema: HostedTurnProgressRequest,
    });
    if (Option.isNone(input)) {
      return Response.json({ status: "validation_failed" }, { status: 400, headers: jsonHeaders });
    }
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(HostedProgressAdmission))({
      userId: UserId.make(subject.value.userId),
      sessionId: subject.value.id,
      digest: Array.from(subject.value.digest),
      ...input.value,
    });
    const stub = environment.USER_TRANSACTION_COORDINATOR.getByName(subject.value.userId);
    return yield* Effect.tryPromise(() =>
      stub.fetch(
        new Request("https://coordinator.internal/hosted-turn/progress", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: request.signal,
        })
      )
    );
  }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan("agent.hostedProgress"));

const hostedReceiptResponse = (
  request: Request,
  environment: CoreHttpEnvironment
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return methodNotAllowed();
    const current = yield* Clock.currentTimeMillis;
    const subject = yield* Effect.tryPromise(() =>
      transactionSession({ request, db: environment.DB, current })
    );
    if (Option.isNone(subject)) return unauthenticatedTransaction();
    const input = yield* boundedJsonBody({
      request,
      policy: hostedReceiptPolicy,
      schema: hostedDeliveryReceipt,
    });
    if (Option.isNone(input)) {
      return Response.json({ status: "validation_failed" }, { status: 400, headers: jsonHeaders });
    }
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(HostedDeliveryAdmission))({
      userId: UserId.make(subject.value.userId),
      sessionId: subject.value.id,
      digest: Array.from(subject.value.digest),
      ...input.value,
    });
    const stub = environment.USER_TRANSACTION_COORDINATOR.getByName(subject.value.userId);
    return yield* Effect.tryPromise(() =>
      stub.fetch(
        new Request("https://coordinator.internal/hosted-turn/receipt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: request.signal,
        })
      )
    );
  }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan("agent.hostedReceipt"));

const directPathResponse = (
  request: Request,
  environment: CoreHttpEnvironment
): Option.Option<Effect.Effect<Response>> => {
  const path = new URL(request.url).pathname;
  if (path === statementStagingPath) {
    return Option.some(statementUploadResponse(request));
  }
  if (path === "/web/hosted-turns") {
    return Option.some(hostedTurnResponse(request, environment));
  }
  if (path === "/web/hosted-turns/delivery") {
    return Option.some(hostedReceiptResponse(request, environment));
  }
  if (path === "/web/hosted-turns/progress") {
    return Option.some(hostedProgressResponse(request, environment));
  }
  return Option.none();
};

type IngestionResponseInput = Readonly<{
  operation: CatalogOperation;
  request: Request;
  environment: CoreHttpEnvironment;
  subject: TransactionCaller;
}>;

/** Canonical forwarding operations retain their own admission and read audit. */
const forwardingCanonicalResponse = ({
  operation,
  environment,
  subject,
}: IngestionResponseInput): Option.Option<Effect.Effect<Response>> => {
  if (operation.id === "ingestion.enableEmailForwarding") {
    return Option.some(
      sendToCoordinator({
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

/** Clarification mutations share canonical preparation, authority, confirmation and Audit. */
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
          environment,
          subject,
          work: ownerCall(operation.id, { params: { id }, payload: payload.value }),
        });
      }
      return yield* sendToCoordinator({
        environment,
        subject,
        work: ownerCall(operation.id, { params: { id } }),
      });
    }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan(operation.id))
  );
};

/** Ingestion canonical work: route forwarding and supported statement projections. */
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
  if (operation.id === "transactions.updateTransaction") {
    return Option.some(
      dispatchCanonicalCorrection(request, environment, subject).pipe(
        Effect.orElseSucceed(unavailable),
        Effect.withSpan("transactions.updateTransaction")
      )
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
/** Canonical Insight reads and User-coordinated lifecycle calls share the same D1 owner. */
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
          environment,
          subject,
          work: ownerCall(operation.id, {
            params: { id: id.value },
            payload: Option.getOrElse(payload, () => ({})),
          }),
        });
      }
      return yield* sendToCoordinator({
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

/** Select Dashboard work from the canonical catalog without an independent route declaration. */
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
      ...request,
      operation,
      runMutation: (call) =>
        sendToCoordinator({
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
      environment: input.environment,
      subject: input.subject,
      work: ownerCall(CanonicalOperationId.make("connections.connectInstitution"), {
        payload: Option.getOrElse(payload, () => ({})),
      }),
    });
  }).pipe(Effect.orElseSucceed(unavailable));

/** Once admitted, every credential executes through the same canonical operation dispatch. */
const executeCanonicalWork = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
  }>
): Effect.Effect<Response> => {
  const { request, environment, operation, subject } = input;
  if (operation.policy.kind === "query") {
    return executeCanonicalHttpQuery({
      db: environment.DB,
      subject,
      operation: operation.id,
      request,
      bucket: Option.fromUndefinedOr(environment.STATEMENT_STAGING_BUCKET),
      browserOrigin: environment.BROWSER_ORIGIN,
      coordinate: (work) =>
        sendToCoordinator({ environment, subject, work }).pipe(Effect.orElseSucceed(unavailable)),
    });
  }
  if (operation.id === "connections.connectInstitution") return connectInstitutionResponse(input);
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

const executeProtectedCanonicalWork = (
  input: Parameters<typeof executeCanonicalWork>[0] & Readonly<{ current: number }>
): Effect.Effect<Response> =>
  protectCanonicalRequest({
    db: input.environment.DB,
    request: input.request,
    operation: input.operation,
    current: input.current,
    caller: isPATCaller(input.subject)
      ? { _tag: "PAT", value: input.subject }
      : { _tag: "WebSession", value: input.subject },
    work: executeCanonicalWork(input),
  });

const authorizedCanonicalResponse = (
  request: Request,
  environment: CoreHttpEnvironment,
  operation: CatalogOperation
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (!request.headers.has("authorization")) {
      return yield* Effect.tryPromise({
        try: () => transactionSession({ request, db: environment.DB, current }),
        catch: () => undefined,
      }).pipe(
        Effect.flatMap((session) => {
          if (Option.isNone(session)) return Effect.succeed(unauthenticatedTransaction());
          return executeProtectedCanonicalWork({
            request,
            environment,
            operation,
            current,
            subject: session.value,
          });
        }),
        Effect.orElseSucceed(unavailable)
      );
    }
    return yield* resolveCanonicalPATCredential({ request, db: environment.DB, operation }).pipe(
      Effect.match({
        onFailure: () =>
          jsonResponse(
            JSON.stringify({ error: categoryUnavailable().error, next: [] }),
            HTTP_SERVICE_UNAVAILABLE
          ),
        onSuccess: (authorized) => {
          if (typeof authorized === "object") return authorized;
          if (authorized === "user_action_required") return consentRevokedResponse();
          return jsonResponse(
            '{"error":{"code":"unauthenticated","message":"Present a valid credential and retry."},"next":[]}',
            HTTP_UNAUTHORIZED
          );
        },
      }),
      Effect.filterOrElse(
        (result): result is Response => result instanceof Response,
        (subject) =>
          executeProtectedCanonicalWork({ request, environment, operation, current, subject })
      ),
      Effect.filterOrElse(
        (response) => response.status !== HTTP_UNAUTHORIZED,
        (response) =>
          protectCanonicalSource({ db: environment.DB, request, current }).pipe(
            Effect.map((failure) => (Option.isSome(failure) ? failure.value : response))
          )
      )
    );
  });

const healthResponse = (environment: CoreHttpEnvironment): Response => {
  const configuration = Schema.decodeExit(ReleaseConfiguration)(environment);
  if (Exit.isFailure(configuration)) return unavailable();
  return jsonResponse(
    JSON.stringify({
      contractDigest: configuration.value.CONTRACT_DIGEST,
      gitRevision: configuration.value.RELEASE_GIT_SHA,
      status: "available",
    }),
    HTTP_OK
  );
};

const canonicalOrHealthResponse = (
  request: Request,
  environment: CoreHttpEnvironment,
  path: string
): Effect.Effect<Response> => {
  const operation = canonicalOperation({ method: request.method, path });
  if (Option.isSome(operation)) {
    return authorizedCanonicalResponse(request, environment, operation.value);
  }
  if (canonicalRoute(path) || request.method !== "GET") return Effect.succeed(methodNotAllowed());
  return Effect.succeed(healthResponse(environment));
};

type RequestExecution = Readonly<{
  request: Request;
  environment: CoreHttpEnvironment;
  telemetry: TelemetryService;
  publish: PublishAcceptedWork;
}>;

const smokeResponse = (
  request: Request,
  environment: CoreHttpEnvironment
): Effect.Effect<Response> =>
  Effect.tryPromise({
    try: () =>
      smokeReady(environment)
        ? handleSmoke({ request, environment })
        : Promise.resolve(
            smokeProofAccepted({ request, secret: environment.SMOKE_PROOF ?? "" })
              ? Response.json(
                  { status: "unavailable" },
                  { status: 503, headers: { [smokeFailureHeader]: "configuration" } }
                )
              : unavailable()
          ),
    catch: () => undefined,
  }).pipe(
    Effect.orElseSucceed(() =>
      Response.json(
        { status: "unavailable" },
        {
          status: 503,
          headers: smokeProofAccepted({ request, secret: environment.SMOKE_PROOF ?? "" })
            ? { [smokeFailureHeader]: "platform" }
            : {},
        }
      )
    )
  );

const reservedCoreResponse = (
  request: Request,
  environment: CoreHttpEnvironment,
  path: string
): Option.Option<Effect.Effect<Response, never, HttpClient.HttpClient>> => {
  if (!ownedCorePath(path)) {
    return Option.some(Effect.succeed(jsonResponse('{"status":"not_found"}', HTTP_NOT_FOUND)));
  }
  if (Object.values(connectionBrowserPaths).some((owned) => owned === path)) {
    return Option.some(
      handleConnectionBrowserRequest({
        coordinator: environment.USER_TRANSACTION_COORDINATOR,
        request,
        db: environment.DB,
        browserOrigin: environment.BROWSER_ORIGIN,
      })
    );
  }
  if (path === providerPaths.complete && request.method === "POST") {
    return Option.some(
      Effect.tryPromise(() => completeGoogleOnboarding({ db: environment.DB, request })).pipe(
        Effect.orElseSucceed(unavailable)
      )
    );
  }
  if (ownsProviderAuthenticationPath(path)) {
    return Option.some(handleProviderAuthentication({ request, environment }));
  }
  if (path === smokePath) return Option.some(smokeResponse(request, environment));
  if (refundSupportRoute(path)) {
    return Option.some(
      Effect.tryPromise({
        try: () => handleRefundSupport({ request, environment }),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(unavailable))
    );
  }
  return Option.none();
};

export const executeCoreHttp = ({
  request,
  environment,
  telemetry,
  publish,
}: RequestExecution): Effect.Effect<Response, never, HttpClient.HttpClient> => {
  const url = new URL(request.url);
  if (Object.values(oauthPaths).some((path) => path === url.pathname)) {
    return handleOAuthRequest({
      request,
      db: environment.DB,
      browserOrigin: environment.BROWSER_ORIGIN,
      coordinator: environment.USER_TRANSACTION_COORDINATOR,
    });
  }
  const reserved = reservedCoreResponse(request, environment, url.pathname);
  if (Option.isSome(reserved)) return reserved.value;
  if (["/providers/kapso/callback", "/providers/wompi/billing-events"].includes(url.pathname)) {
    return providerCallbackEffect(request, environment, publish);
  }
  if (enrollmentCorePath(url.pathname)) {
    return Effect.tryPromise({
      try: () =>
        handlePaymentEnrollment({
          request,
          environment: { ...environment, onAccepted: (id) => publish("billing", id) },
        }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan("subscription.payment-enrollment"));
  }
  const directPath = directPathResponse(request, environment);
  if (Option.isSome(directPath)) return directPath.value;
  const patListing = canonicalOperation({ method: request.method, path: url.pathname }).pipe(
    Option.filter((operation) => operation.id === "pats.listPATs")
  );
  if (Option.isSome(patListing)) {
    return authorizedCanonicalResponse(request, environment, patListing.value);
  }
  if (ownsWebAuthenticationPath(url.pathname)) {
    return handleWebAuthentication({
      request,
      db: environment.DB,
      support: {
        CLOUDFLARE_ACCESS_ISSUER: environment.CLOUDFLARE_ACCESS_ISSUER,
        CLOUDFLARE_ACCESS_AUDIENCE: environment.CLOUDFLARE_ACCESS_AUDIENCE,
      },
      telemetry,
      publish,
    });
  }
  return canonicalOrHealthResponse(request, environment, url.pathname);
};
