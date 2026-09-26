import {
  ScopeMissing,
  UserActionRequired,
  categoryUnavailable,
  listCategoriesPath,
} from "@fidy/server/categories";
import {
  MemoryId,
  type MemoryOperationId,
  RememberInput,
  ReviseInput,
  memoryOperationIds,
} from "@fidy/server/memory-runtime";
import { emailReplacementOperations } from "@fidy/server/email-replacement";
import type { TelemetryService } from "@fidy/server/telemetry";
import { Cause, Clock, Data, Effect, Exit, Option, Schema } from "effect";

import { correctionInput } from "./transactions/transaction-corrections";
import { BudgetId, CreateBudgetInput, UpdateBudgetInput } from "@fidy/server/budgets-runtime";
import { browseBudgets } from "./budgets/budget-queries";
import { transactionPairInput } from "./transactions/transaction-reconciliation";
import { ownsTransactionPath as transactionPath } from "@fidy/server/transaction-routes";
import { browseTransactions } from "./transactions/transaction-history";
import { receiveConsentWebhook, sweepExpiredConsent } from "./onboarding/consent-ingress";
import {
  transactionInput,
  transactionSession,
  unauthenticatedTransaction,
} from "./transactions/transactions";
import {
  type TransactionCaller,
  isPATCaller,
  maximumTransactionInputBytes,
  rejectInvalidBatchInput,
  rejectInvalidTransactionInput,
  transactionFailure,
} from "./transactions/transaction-boundary";
import { RequestBodyPolicy, boundedJsonBody } from "./http/request-body";
import { pathId, rawPathId } from "./http/path";
import {
  completeBrowserPairingEmail,
  startBrowserPairingEmail,
} from "./identity/browser-pairing-email";
import {
  type BrowserPairingEmailEnvironment,
  dispatchBrowserPairingEmail,
  isBrowserPairingEmailWork,
  receiveBrowserPairingEmail,
  reconcileBrowserPairingEmail,
} from "./identity/browser-pairing-email-delivery";
import { handleSupportRecovery } from "./identity/support-recovery";
import { handleCardEnrollment } from "./card-enrollment/card-enrollment";
import {
  type BillingCollectionEnvironment,
  dispatchBillingCollection,
  isBillingCollectionWork,
  receiveBillingCollection,
  receiveWompiBillingEvent,
  reconcileBillingCandidates,
} from "./billing/billing-collection";
import { completeEmailReplacement, requestEmailReplacement } from "./identity/email-replacement";
import {
  type EmailReplacementEnvironment,
  dispatchEmailReplacement,
  isEmailReplacementWork,
  receiveEmailReplacement,
  reconcileEmailReplacement,
} from "./identity/email-replacement-delivery";
import { handlePATRequest, patRoute } from "./pats/pat-routes";
import { listPATs } from "./pats/pat-management";
import { recallMemories, rejectMemoryMutation } from "./memory/memory";
import { canonicalOperation, canonicalRoute } from "./routing/canonical-routes";
import {
  BatchInput,
  type CanonicalWork,
  CanonicalWorkAdmission,
  type PATAuthority,
  type WebSessionAuthority,
} from "./transactions/transaction-coordinator";
import {
  CanonicalOperationId,
  type CatalogOperation,
  atomicBatchOperation,
  maximumAtomicBatchCalls,
  operationCatalog,
} from "@fidy/server/canonical-runtime";
import { sweepExpiredPATPairings } from "./pats/pat-pairing";
import { authorizeCanonicalPAT } from "./pats/pat-authorization";
import { executeProtectedCategories } from "./categories/canonical-category";
import { executeProtectedSubscriptionQuery } from "./billing/subscription-queries";
import {
  keywordRuleIdFromPath,
  keywordRuleInput,
  keywordRuleInvalidInput,
  keywordRuleUnknownId,
  listOwnKeywordRules,
} from "./categories/canonical-keyword-rules";
import {
  currentUser,
  logoutBrowser,
  redeemBrowserPairing,
  rotateBackupRecoveryCode,
  startBrowserPairing,
} from "./identity/browser-login";
import {
  type OnboardingEmailEnvironment,
  dispatchOnboardingEmail,
  receiveOnboardingEmail,
  reconcileOnboardingEmail,
} from "./onboarding/onboarding-email";
import { contractDigestPattern, gitRevisionPattern } from "./runtime/release-identity";
import { verifyOnboarding } from "./onboarding/verified-onboarding";
import {
  type WorkerTelemetryEnvironment,
  cloudflareWorkerTelemetry,
  observeWorkerRequest,
} from "./runtime/telemetry";
import type { WorkersAiEnvironment } from "./ai/workers-ai";
import { statementStagingPath } from "@fidy/server/statement-path";
import {
  readStatementSubmission,
  submitForExtractionInput,
  uploadStagedStatement,
  validationFailed,
} from "./ingestion/statement-ingestion";
import { StatementStaging } from "./ingestion/statement-staging";
import { forwardingAddressResponse } from "./ingestion/forwarding-address";
import { expireStatementReviewEvidence } from "./ingestion/statement-review-retention";
import { listStatementNeedsReviewItems } from "./ingestion/statement-review";
import {
  StatementExtractionWorkflowV1,
  dispatchStatementExtraction,
  isStatementExtractionWork,
  receiveStatementExtraction,
  reconcileStatementExtraction,
} from "./ingestion/statement-delivery";

export { UserTransactionCoordinator } from "./transactions/transaction-coordinator";
export { OnboardingEmailWorkflowV1 } from "./onboarding/onboarding-email";
export { BillingCollectionWorkflowV1 } from "./billing/billing-collection";
export { BrowserPairingEmailWorkflowV1 } from "./identity/browser-pairing-email-delivery";
export { EmailReplacementWorkflowV1 } from "./identity/email-replacement-delivery";
export { StatementExtractionWorkflowV1 };

class StatementReviewSweepUnavailable extends Data.TaggedError(
  "StatementReviewSweepUnavailable"
)<{}> {}

const ReleaseConfiguration = Schema.Struct({
  CONTRACT_DIGEST: Schema.String.check(Schema.isPattern(contractDigestPattern)),
  RELEASE_GIT_SHA: Schema.String.check(Schema.isPattern(gitRevisionPattern)),
});

type CoreEnvironment = WorkerTelemetryEnvironment &
  typeof ReleaseConfiguration.Type & {
    readonly AI: WorkersAiEnvironment["AI"];
    readonly DB: D1Database;
    readonly USER_TRANSACTION_COORDINATOR: Readonly<{
      getByName: (name: string) => Pick<Fetcher, "fetch">;
    }>;
    readonly HOSTED_AI_MODEL: string;
    readonly KAPSO_API_KEY: string;
    readonly KAPSO_WEBHOOK_SECRET: string;
    readonly WHATSAPP_BUSINESS_PORTFOLIO_ID: string;
    readonly CLOUDFLARE_ACCESS_ISSUER: string;
    readonly CLOUDFLARE_ACCESS_AUDIENCE: string;
    readonly BROWSER_ORIGIN: string;
    readonly WOMPI_ENVIRONMENT: string;
    readonly WOMPI_PUBLIC_KEY: string;
    readonly WOMPI_PRIVATE_KEY: string;
    readonly WOMPI_INTEGRITY_SECRET: string;
  } & Partial<Omit<OnboardingEmailEnvironment, "DB">> &
  Partial<Omit<BrowserPairingEmailEnvironment, "DB" | "RESEND_API_KEY">> &
  Partial<Omit<EmailReplacementEnvironment, "DB" | "RESEND_API_KEY">> &
  /** Private R2 binding for staged statement bytes; absent fails the transport closed. */
  Partial<
    Readonly<{
      STATEMENT_STAGING_BUCKET: R2Bucket;
      STATEMENT_EXTRACTION_QUEUE: Queue;
      STATEMENT_EXTRACTION_WORKFLOW: Workflow;
    }>
  > &
  Partial<
    Pick<
      BillingCollectionEnvironment,
      "BILLING_COLLECTION_QUEUE" | "BILLING_COLLECTION_WORKFLOW" | "WOMPI_EVENT_SECRET"
    >
  >;

type CoreWorker = Readonly<{
  fetch: (request: Request, environment: CoreEnvironment) => Promise<Response>;
  scheduled: (controller: ScheduledController, environment: CoreEnvironment) => Promise<void>;
  queue: (batch: MessageBatch<unknown>, environment: CoreEnvironment) => Promise<void>;
}>;

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

const HTTP_OK = 200;
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

const categoriesResponse = (
  environment: CoreEnvironment,
  subject: TransactionCaller
): Effect.Effect<Response> =>
  Effect.tryPromise({
    try: () => executeProtectedCategories({ db: environment.DB, subject }),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan("categories.listCategories"));

const callbackEffect = (request: Request, environment: CoreEnvironment): Effect.Effect<Response> =>
  request.method === "POST"
    ? receiveConsentWebhook(environment)(request)
    : Effect.succeed(methodNotAllowed());

const providerCallbackEffect = (
  request: Request,
  environment: CoreEnvironment,
  path: string
): Effect.Effect<Response> => {
  if (path === "/providers/kapso/callback") return callbackEffect(request, environment);
  if (request.method !== "POST") return Effect.succeed(methodNotAllowed());
  if (environment.WOMPI_EVENT_SECRET === undefined) return Effect.succeed(unavailable());
  return receiveWompiBillingEvent({
    request,
    environment: { ...environment, WOMPI_EVENT_SECRET: environment.WOMPI_EVENT_SECRET },
  }).pipe(Effect.withSpan("billing.collection.event"));
};

const verificationEffect = (request: Request, db: D1Database): Effect.Effect<Response> =>
  request.method === "POST"
    ? Effect.tryPromise({
        try: () => verifyOnboarding({ request, db }),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(unavailable))
    : Effect.succeed(methodNotAllowed());

const enrollmentCorePath = (path: string): boolean =>
  path === "/web/subscription/card-enrollments/prepare" ||
  path === "/web/subscription/card-enrollments/submit" ||
  /^\/web\/subscription\/(?:card-enrollments|billing-attempts)\/[0-9a-f-]{36}$/u.test(path);

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
  environment: CoreEnvironment;
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
  environment: CoreEnvironment,
  subject: TransactionCaller
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const parsed = yield* Effect.tryPromise(() =>
        boundedJsonBody(request, batchPolicy, BatchInput)
      );
      if (Option.isNone(parsed)) return rejectInvalidBatchInput();
      return yield* sendToCoordinator({
        environment,
        subject,
        work: { _tag: "Batch", calls: parsed.value.calls },
      });
    })
  );

const dispatchCanonicalCapture = (
  request: Request,
  environment: CoreEnvironment,
  subject: TransactionCaller
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(() => transactionInput(request));
      if (Option.isNone(input)) {
        return yield* Effect.tryPromise(() =>
          rejectInvalidTransactionInput({
            db: environment.DB,
            subject,
            operation: "transactions.createTransaction",
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
    })
  );

const dispatchCanonicalCorrection = (
  request: Request,
  environment: CoreEnvironment,
  subject: TransactionCaller
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(() => correctionInput(request));
      if (Option.isNone(input)) {
        return yield* Effect.tryPromise(() =>
          rejectInvalidTransactionInput({
            db: environment.DB,
            subject,
            operation: "transactions.updateTransaction",
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
    })
  );

const dispatchCanonicalPair = (
  input: Readonly<{
    request: Request;
    environment: CoreEnvironment;
    subject: TransactionCaller;
    operation: "transactions.linkTransactions" | "transactions.unlinkTransactions";
  }>
): Promise<Response> => {
  const { request, environment, subject, operation } = input;
  return Effect.runPromise(
    Effect.gen(function* () {
      const pair = yield* Effect.tryPromise(() => transactionPairInput(request));
      if (Option.isNone(pair)) {
        return yield* Effect.tryPromise(() =>
          rejectInvalidTransactionInput({ db: environment.DB, subject, operation })
        );
      }
      return yield* sendToCoordinator({
        environment,
        subject,
        work: canonicalCall(CanonicalOperationId.make(operation), { payload: pair.value }),
      });
    })
  );
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
  enrollmentCorePath(path) ||
  [
    "/health",
    listCategoriesPath,
    "/providers/kapso/callback",
    "/providers/wompi/billing-events",
    "/web/onboarding/email/verify",
    "/web/pairings",
    "/web/pairings/redeem",
    "/web/session/logout",
    "/recovery/backup-code/rotate",
    "/web/email/authentication/start",
    "/web/email/authentication/complete",
    emailReplacementOperations.request.path,
    emailReplacementOperations.complete.path,
    "/internal/support-recovery",
    "/user",
    statementStagingPath,
  ].includes(path) ||
  transactionPath(path) ||
  patRoute(path) ||
  canonicalRoute(path);

const supportRecoveryResponse = (
  request: Request,
  environment: CoreEnvironment,
  telemetry: TelemetryService
): Effect.Effect<Response> => {
  if (request.method !== "POST") return Effect.succeed(methodNotAllowed());
  return telemetry.rootSpan(
    {
      component: "api",
      operation: "http.supportRecovery",
      trigger: "api",
      spanOperation: "http.server",
      workKind: "http_request",
      metadata: {
        _tag: "Http",
        method: "POST",
        route: "/internal/support-recovery",
        status: Option.none(),
      },
    },
    handleSupportRecovery({ request, db: environment.DB, config: environment }).pipe(
      Effect.catchCauseIf(Cause.hasDies, () =>
        telemetry
          .captureFailure({
            _tag: "Defect",
            component: "api",
            operation: "http.supportRecovery",
            error: "unexpected_defect",
            cause: undefined,
          })
          .pipe(Effect.as(unavailable()))
      )
    )
  );
};

const browserResponse = (
  request: Request,
  environment: CoreEnvironment,
  telemetry: TelemetryService
): Effect.Effect<Response> => {
  const db = environment.DB;
  const path = new URL(request.url).pathname;
  if (path === "/internal/support-recovery") {
    return supportRecoveryResponse(request, environment, telemetry);
  }
  const routes: Readonly<
    Record<string, Readonly<{ method: string; handle: () => Promise<Response> }>>
  > = {
    "/web/pairings": { method: "POST", handle: () => startBrowserPairing(db) },
    "/web/pairings/redeem": {
      method: "POST",
      handle: () => redeemBrowserPairing({ request, db }),
    },
    "/web/session/logout": {
      method: "POST",
      handle: () => logoutBrowser({ request, db }),
    },
    "/recovery/backup-code/rotate": {
      method: "POST",
      handle: () => rotateBackupRecoveryCode({ request, db }),
    },
    "/web/email/authentication/start": {
      method: "POST",
      handle: () => startBrowserPairingEmail({ request, db }),
    },
    "/web/email/authentication/complete": {
      method: "POST",
      handle: () => completeBrowserPairingEmail({ request, db }),
    },
    [emailReplacementOperations.request.path]: {
      method: emailReplacementOperations.request.method,
      handle: () => requestEmailReplacement({ request, db }),
    },
    [emailReplacementOperations.complete.path]: {
      method: emailReplacementOperations.complete.method,
      handle: () => completeEmailReplacement({ request, db }),
    },
    "/user": { method: "GET", handle: () => currentUser({ request, db }) },
  };
  const route = routes[path];
  if (route === undefined || request.method !== route.method) {
    return Effect.succeed(methodNotAllowed());
  }
  const work = Effect.tryPromise({ try: route.handle, catch: () => undefined }).pipe(
    Effect.orElseSucceed(unavailable)
  );
  return path === emailReplacementOperations.request.path ||
    path === emailReplacementOperations.complete.path
    ? work.pipe(Effect.withSpan("emailReplacement.browser"))
    : work;
};

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

const scopeMissingResponse = (): Response =>
  jsonResponse(
    JSON.stringify(
      Schema.encodeSync(Schema.toCodecJson(ScopeMissing))(
        ScopeMissing.make({
          error: {
            code: "scope_missing",
            message: "This PAT lacks the required operation scope.",
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

/** True for the admitted read operations Transaction history owns. */
const isTransactionHistoryRead = (operation: CatalogOperation): boolean =>
  operation.id === "transactions.listTransactions" ||
  operation.id === "transactions.searchTransactions" ||
  operation.id === "transactions.getTransaction";

/** Dispatch one admitted Transaction history read: search, one record, or the list. */
const dispatchCanonicalHistory = (
  input: Readonly<{
    request: Request;
    environment: CoreEnvironment;
    subject: TransactionCaller;
    operation: CatalogOperation;
  }>
): Promise<Response> => {
  const { request, environment, subject, operation } = input;
  return browseTransactions({
    db: environment.DB,
    selection:
      operation.id === "transactions.searchTransactions"
        ? { request, subject, search: true, id: Option.none() }
        : {
            request,
            subject,
            search: false,
            id:
              operation.id === "transactions.getTransaction"
                ? Option.some(new URL(request.url).pathname.split("/").at(-1) ?? "")
                : Option.none(),
          },
  });
};

/** One canonical call for an admitted owner operation, without restating its published id. */
const ownerCall = (
  operation: CanonicalOperationId | MemoryMutationId,
  input: unknown
): CanonicalWork => canonicalCall(CanonicalOperationId.make(operation), input);

/** One canonical keyword-rule mutation delivered to the caller's User coordinator. */
const keywordRuleMutationResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreEnvironment;
    subject: TransactionCaller;
    operation: CanonicalOperationId;
  }>
): Effect.Effect<Response> => {
  const { request, environment, subject, operation } = input;
  return Effect.gen(function* () {
    if (operation === "categories.createKeywordRule") {
      const payload = yield* Effect.tryPromise(() => keywordRuleInput(request, false));
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
    const payload = yield* Effect.tryPromise(() => keywordRuleInput(request, true));
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
    environment: CoreEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
  }>
): Option.Option<Effect.Effect<Response>> => {
  const { request, environment, operation, subject } = input;
  if (operation.id === "categories.listKeywordRules") {
    return Option.some(
      Effect.tryPromise({
        try: () => listOwnKeywordRules({ db: environment.DB, subject }),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(unavailable))
    );
  }
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
  environment: CoreEnvironment;
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
  environment: CoreEnvironment;
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
  environment: CoreEnvironment;
  subject: TransactionCaller;
}>): Effect.Effect<Response> =>
  dispatchMemoryMutation({
    environment,
    subject,
    operation: "memory.remember",
    decode: Effect.tryPromise(() => boundedJsonBody(request, memoryBodyPolicy, RememberInput)).pipe(
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
  environment: CoreEnvironment;
  subject: TransactionCaller;
}>): Effect.Effect<Response> =>
  dispatchMemoryMutation({
    environment,
    subject,
    operation: "memory.revise",
    decode: Effect.gen(function* () {
      const payload = yield* Effect.tryPromise(() =>
        boundedJsonBody(request, memoryBodyPolicy, ReviseInput)
      ).pipe(Effect.orElseSucceed(() => Option.none<ReviseInput>()));
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
  environment: CoreEnvironment;
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
    environment: CoreEnvironment;
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

const budgetBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});

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
  environment: CoreEnvironment;
  subject: TransactionCaller;
  operation: "budgets.createBudget" | "budgets.updateBudget" | "budgets.deleteBudget";
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const id =
      operation === "budgets.createBudget"
        ? Option.none<BudgetId>()
        : pathId({ schema: BudgetId, request });
    if (operation !== "budgets.createBudget" && Option.isNone(id)) {
      return transactionFailure({ code: "not_found", status: 404, message: "Budget unavailable." });
    }
    const payload =
      operation === "budgets.deleteBudget"
        ? Option.none<CreateBudgetInput>()
        : yield* Effect.tryPromise(() =>
            boundedJsonBody(
              request,
              budgetBodyPolicy,
              operation === "budgets.createBudget"
                ? Schema.toCodecJson(CreateBudgetInput)
                : Schema.toCodecJson(UpdateBudgetInput)
            )
          ).pipe(Effect.orElseSucceed(() => Option.none<CreateBudgetInput>()));
    if (operation !== "budgets.deleteBudget" && Option.isNone(payload)) {
      return transactionFailure({
        code: "validation_failed",
        status: 400,
        message: "Invalid Budget input.",
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

/** The Budget owner's canonical query or mutation, never a parallel path declaration. */
const BudgetOperation = Schema.Literals([
  "budgets.createBudget",
  "budgets.updateBudget",
  "budgets.deleteBudget",
  "budgets.listBudgets",
  "budgets.getBudget",
  "budgets.getBudgetStatus",
]);
const budgetResponse = ({
  request,
  environment,
  subject,
  operation,
}: Readonly<{
  request: Request;
  environment: CoreEnvironment;
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
    case "budgets.listBudgets":
    case "budgets.getBudget":
    case "budgets.getBudgetStatus":
      return Option.some(
        Effect.tryPromise(() =>
          browseBudgets({ db: environment.DB, request, subject, operation: selectedId })
        ).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan(operation.id))
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
    environment: CoreEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
  }>
): Option.Option<Effect.Effect<Response>> => {
  const { request, environment, operation, subject } = input;
  if (operation.id === "memory.recall") {
    return Option.some(
      recallMemories({ db: environment.DB, subject }).pipe(Effect.withSpan("memory.recall"))
    );
  }
  return Option.map(memoryMutationOperation(operation.id), (owned) =>
    memoryMutationResponse({ request, environment, subject, operation: owned }).pipe(
      Effect.withSpan(owned)
    )
  );
};
/** Session-authorized statement byte staging; neither a PAT nor an anonymous caller may stage. */
const statementUploadResponse = (
  request: Request,
  environment: CoreEnvironment
): Effect.Effect<Response> => {
  if (request.method !== "POST") return Effect.succeed(methodNotAllowed());
  return Effect.tryPromise({
    try: () => transactionSession({ request, db: environment.DB }),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((session) =>
      Option.isNone(session)
        ? Effect.succeed(unauthenticatedTransaction())
        : uploadStagedStatement({ environment, request, subject: session.value }).pipe(
            Effect.withSpan("ingestion.stageStatement")
          )
    ),
    Effect.orElseSucceed(unavailable)
  );
};

/** Direct Core paths that own their own admission and session resolution. */
const directPathResponse = (
  request: Request,
  environment: CoreEnvironment
): Option.Option<Effect.Effect<Response>> => {
  const path = new URL(request.url).pathname;
  if (path === "/web/onboarding/email/verify") {
    return Option.some(verificationEffect(request, environment.DB));
  }
  if (path === statementStagingPath) {
    return Option.some(statementUploadResponse(request, environment));
  }
  return Option.none();
};

type IngestionResponseInput = Readonly<{
  operation: CatalogOperation;
  request: Request;
  environment: CoreEnvironment;
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
  if (operation.id === "ingestion.getEmailForwarding") {
    return Option.some(
      forwardingAddressResponse({
        db: environment.DB,
        subject,
        operation: "ingestion.getEmailForwarding",
      }).pipe(Effect.withSpan(operation.id))
    );
  }
  return Option.none();
};

/** Ingestion canonical work: route forwarding and supported statement projections. */
const ingestionCanonicalResponse = (
  input: IngestionResponseInput
): Option.Option<Effect.Effect<Response>> => {
  const forwarding = forwardingCanonicalResponse(input);
  if (Option.isSome(forwarding)) return forwarding;
  const { operation, request, environment, subject } = input;
  if (operation.id === "ingestion.submitForExtraction") {
    return Option.some(
      Effect.gen(function* () {
        const input = yield* Effect.tryPromise(() => submitForExtractionInput(request));
        if (Option.isNone(input)) return validationFailed("Invalid statement submission input.");
        return yield* sendToCoordinator({
          environment,
          subject,
          work: canonicalCall(operation.id, { payload: input.value }),
        });
      }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan("ingestion.submitForExtraction"))
    );
  }
  if (operation.id === "ingestion.getStatementSubmission") {
    return Option.some(
      Effect.tryPromise({
        try: () => readStatementSubmission({ environment, request, subject }),
        catch: () => undefined,
      }).pipe(
        Effect.orElseSucceed(unavailable),
        Effect.withSpan("ingestion.getStatementSubmission")
      )
    );
  }
  if (operation.id === "ingestion.listNeedsReviewItems") {
    return Option.some(
      listStatementNeedsReviewItems({
        database: environment.DB,
        environment,
        subject,
        url: new URL(request.url),
      }).pipe(Effect.withSpan("ingestion.listNeedsReviewItems"))
    );
  }
  return Option.none();
};

/**
 * The Transaction work this dispatch owns, or None when another slice owns the operation.
 */
const transactionResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
  }>
): Option.Option<Effect.Effect<Response>> => {
  const { request, environment, operation, subject } = input;
  if (operation.id === "transactions.createTransaction") {
    return Option.some(
      Effect.tryPromise({
        try: () => dispatchCanonicalCapture(request, environment, subject),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan("transactions.createTransaction"))
    );
  }
  if (operation.id === "transactions.updateTransaction") {
    return Option.some(
      Effect.tryPromise({
        try: () => dispatchCanonicalCorrection(request, environment, subject),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan("transactions.updateTransaction"))
    );
  }
  const reconciliation = reconciliationOperation(operation);
  if (Option.isSome(reconciliation)) {
    return Option.some(
      Effect.tryPromise({
        try: () =>
          dispatchCanonicalPair({
            request,
            environment,
            subject,
            operation: reconciliation.value,
          }),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan(reconciliation.value))
    );
  }
  if (operation.id === atomicBatchOperation) {
    return Option.some(
      Effect.tryPromise({
        try: () => dispatchCanonicalBatch(request, environment, subject),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan(atomicBatchOperation))
    );
  }
  if (isTransactionHistoryRead(operation)) {
    return Option.some(
      Effect.tryPromise({
        try: () => dispatchCanonicalHistory({ request, environment, subject, operation }),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(unavailable))
    );
  }
  return Option.none();
};

/** Once admitted, every credential executes through the same canonical operation dispatch. */
const executeCanonicalWork = (
  input: Readonly<{
    request: Request;
    environment: CoreEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
  }>
): Effect.Effect<Response> => {
  const { request, environment, operation, subject } = input;
  if (operation.id === "categories.listCategories") return categoriesResponse(environment, subject);
  if (
    operation.id === "subscription.listSubscriptionOffers" ||
    operation.id === "subscription.getSubscriptionStatus"
  ) {
    return Effect.tryPromise({
      try: () =>
        executeProtectedSubscriptionQuery({
          db: environment.DB,
          subject,
          operation:
            operation.id === "subscription.listSubscriptionOffers"
              ? "subscription.listSubscriptionOffers"
              : "subscription.getSubscriptionStatus",
        }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(unavailable));
  }
  const ownerResponse = Option.orElse(budgetResponse(input), () =>
    Option.orElse(keywordRuleResponse(input), () => memoryResponse(input))
  );
  if (Option.isSome(ownerResponse)) return ownerResponse.value;
  const transaction = transactionResponse(input);
  if (Option.isSome(transaction)) return transaction.value;
  const ingestion = ingestionCanonicalResponse({ environment, operation, request, subject });
  if (Option.isSome(ingestion)) return ingestion.value;
  if (operation.id === "pats.listPATs") {
    return Effect.tryPromise({
      try: () => listPATs({ request, db: environment.DB }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(unavailable));
  }
  return Effect.succeed(unavailableCanonicalAdapter());
};

const authorizedCanonicalResponse = (
  request: Request,
  environment: CoreEnvironment,
  operation: CatalogOperation
): Effect.Effect<Response> => {
  if (!request.headers.has("authorization")) {
    return Effect.tryPromise({
      try: () => transactionSession({ request, db: environment.DB }),
      catch: () => undefined,
    }).pipe(
      Effect.flatMap((session) => {
        if (Option.isNone(session)) return Effect.succeed(unauthenticatedTransaction());
        return executeCanonicalWork({ request, environment, operation, subject: session.value });
      }),
      Effect.orElseSucceed(unavailable)
    );
  }
  return Effect.tryPromise({
    try: () => authorizeCanonicalPAT({ request, db: environment.DB, operation }),
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: () =>
        jsonResponse(
          JSON.stringify({ error: categoryUnavailable().error, next: [] }),
          HTTP_SERVICE_UNAVAILABLE
        ),
      onSuccess: (authorized) => {
        if (typeof authorized === "object") return authorized;
        if (authorized === "user_action_required") return consentRevokedResponse();
        if (authorized === "scope_missing") return scopeMissingResponse();
        return jsonResponse(
          '{"error":{"code":"unauthenticated","message":"Present a valid credential and retry."},"next":[]}',
          HTTP_UNAUTHORIZED
        );
      },
    }),
    Effect.filterOrElse(
      (result): result is Response => result instanceof Response,
      (subject) => executeCanonicalWork({ request, environment, operation, subject })
    )
  );
};

const healthResponse = (environment: CoreEnvironment): Response => {
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
  environment: CoreEnvironment,
  path: string
): Effect.Effect<Response> => {
  const operation = canonicalOperation({ method: request.method, path });
  if (Option.isSome(operation)) {
    return authorizedCanonicalResponse(request, environment, operation.value);
  }
  if (canonicalRoute(path) || request.method !== "GET") return Effect.succeed(methodNotAllowed());
  return Effect.succeed(healthResponse(environment));
};

const fetchEffect = (
  request: Request,
  environment: CoreEnvironment,
  telemetry: TelemetryService
): Effect.Effect<Response> => {
  const url = new URL(request.url);
  if (!ownedCorePath(url.pathname)) {
    return Effect.succeed(jsonResponse('{"status":"not_found"}', HTTP_NOT_FOUND));
  }
  if (["/providers/kapso/callback", "/providers/wompi/billing-events"].includes(url.pathname)) {
    return providerCallbackEffect(request, environment, url.pathname);
  }
  if (enrollmentCorePath(url.pathname)) {
    return Effect.tryPromise({
      try: () => handleCardEnrollment({ request, environment }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan("subscription.card-enrollment"));
  }
  const directPath = directPathResponse(request, environment);
  if (Option.isSome(directPath)) return directPath.value;
  const patListing = canonicalOperation({ method: request.method, path: url.pathname }).pipe(
    Option.filter((operation) => operation.id === "pats.listPATs")
  );
  if (Option.isSome(patListing)) {
    return authorizedCanonicalResponse(request, environment, patListing.value);
  }
  if (patRoute(url.pathname)) {
    return Effect.tryPromise({
      try: () => handlePATRequest({ request, db: environment.DB }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(unavailable));
  }
  if (
    [
      "/web/pairings",
      "/web/pairings/redeem",
      "/web/session/logout",
      "/recovery/backup-code/rotate",
      "/web/email/authentication/start",
      "/web/email/authentication/complete",
      emailReplacementOperations.request.path,
      emailReplacementOperations.complete.path,
      "/internal/support-recovery",
      "/user",
    ].includes(url.pathname)
  ) {
    return browserResponse(request, environment, telemetry);
  }
  return canonicalOrHealthResponse(request, environment, url.pathname);
};

const receiveEmailQueue: CoreWorker["queue"] = (batch, environment) => {
  if (batch.messages.some((message) => isEmailReplacementWork(message.body))) {
    if (environment.EMAIL_REPLACEMENT_WORKFLOW === undefined) {
      return Promise.reject(new Error("Email replacement unavailable"));
    }
    return receiveEmailReplacement({
      DB: environment.DB,
      EMAIL_REPLACEMENT_WORKFLOW: environment.EMAIL_REPLACEMENT_WORKFLOW,
    })(batch).pipe(Effect.withSpan("emailReplacement.receive"), Effect.runPromise);
  }
  if (batch.messages.some((message) => isBrowserPairingEmailWork(message.body))) {
    if (environment.BROWSER_PAIRING_EMAIL_WORKFLOW === undefined) {
      return Promise.reject(new Error("Browser pairing email unavailable"));
    }
    return receiveBrowserPairingEmail({
      DB: environment.DB,
      BROWSER_PAIRING_EMAIL_WORKFLOW: environment.BROWSER_PAIRING_EMAIL_WORKFLOW,
    })(batch).pipe(Effect.runPromise);
  }
  if (
    environment.ONBOARDING_EMAIL_QUEUE === undefined ||
    environment.ONBOARDING_EMAIL_WORKFLOW === undefined ||
    environment.RESEND_API_KEY === undefined
  ) {
    return Promise.reject(new Error("Onboarding email unavailable"));
  }
  return receiveOnboardingEmail({
    DB: environment.DB,
    ONBOARDING_EMAIL_WORKFLOW: environment.ONBOARDING_EMAIL_WORKFLOW,
  })(batch).pipe(Effect.runPromise);
};

const receiveWorkQueue: CoreWorker["queue"] = (batch, environment) => {
  if (batch.messages.some((message) => isStatementExtractionWork(message.body))) {
    if (environment.STATEMENT_EXTRACTION_WORKFLOW === undefined) {
      return Promise.reject(new Error("Statement extraction unavailable"));
    }
    return receiveStatementExtraction({
      environment: {
        DB: environment.DB,
        STATEMENT_EXTRACTION_WORKFLOW: environment.STATEMENT_EXTRACTION_WORKFLOW,
      },
      messages: batch.messages,
    }).pipe(Effect.runPromise);
  }
  if (!batch.messages.some((message) => isBillingCollectionWork(message.body))) {
    return receiveEmailQueue(batch, environment);
  }
  if (environment.BILLING_COLLECTION_WORKFLOW === undefined) {
    return Promise.reject(new Error("Billing collection unavailable"));
  }
  return receiveBillingCollection({
    environment: {
      DB: environment.DB,
      BILLING_COLLECTION_WORKFLOW: environment.BILLING_COLLECTION_WORKFLOW,
    },
    batch,
  }).pipe(Effect.withSpan("billing.collection.queue"), Effect.runPromise);
};

const billingScheduled = (environment: CoreEnvironment): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (
      environment.BILLING_COLLECTION_QUEUE === undefined ||
      environment.BILLING_COLLECTION_WORKFLOW === undefined
    ) {
      return;
    }
    const workflow = environment.BILLING_COLLECTION_WORKFLOW;
    const dispatched = yield* Effect.exit(
      dispatchBillingCollection({
        DB: environment.DB,
        BILLING_COLLECTION_QUEUE: environment.BILLING_COLLECTION_QUEUE,
      }).pipe(Effect.withSpan("billing.collection.dispatch"))
    );
    yield* reconcileBillingCandidates({
      DB: environment.DB,
      BILLING_COLLECTION_WORKFLOW: workflow,
    });
    if (Exit.isFailure(dispatched)) return yield* Effect.fail(undefined);
  }).pipe(Effect.orDie);

/**
 * Reclaims expired staged material and fails submissions past their retention bound. Both steps are
 * bounded, idempotent, and re-selectable from durable `deleting`/retention state, so a transient D1
 * or R2 failure is deliberately swallowed and retried by the next scheduled run instead of failing
 * the whole schedule; each step keeps its own span so that retry is visible.
 */
const statementIngestionScheduled = (environment: CoreEnvironment): Effect.Effect<void> =>
  Effect.gen(function* () {
    const bucket = environment.STATEMENT_STAGING_BUCKET;
    if (bucket === undefined) return;
    const nowEpochMs = yield* Clock.currentTimeMillis;
    const staging = StatementStaging.make({
      bucket,
      database: environment.DB,
      nowEpochMs: () => nowEpochMs,
    });
    yield* staging.expireStatementSubmissions.pipe(
      Effect.withSpan("ingestion.submissionRetention"),
      Effect.ignore
    );
    yield* staging.sweepExpiredStatementStaging.pipe(
      Effect.withSpan("ingestion.stagingSweep"),
      Effect.ignore
    );
    yield* Effect.tryPromise({
      try: () => expireStatementReviewEvidence({ DB: environment.DB }),
      catch: () => new StatementReviewSweepUnavailable(),
    }).pipe(Effect.withSpan("ingestion.reviewEvidenceExpiry"), Effect.ignore);
  });

/** Reconcile terminal Workflow failures, then offer any still-unpublished statement intents. */
const statementDeliveryScheduled = (environment: CoreEnvironment): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (environment.STATEMENT_EXTRACTION_WORKFLOW !== undefined) {
      yield* reconcileStatementExtraction({
        DB: environment.DB,
        STATEMENT_EXTRACTION_WORKFLOW: environment.STATEMENT_EXTRACTION_WORKFLOW,
        USER_TRANSACTION_COORDINATOR: environment.USER_TRANSACTION_COORDINATOR,
      });
    }
    if (environment.STATEMENT_EXTRACTION_QUEUE !== undefined) {
      yield* dispatchStatementExtraction({
        DB: environment.DB,
        STATEMENT_EXTRACTION_QUEUE: environment.STATEMENT_EXTRACTION_QUEUE,
      });
    }
  }).pipe(Effect.orDie);

/** Builds the private Core target with one telemetry service for each request Work span. */
export const makeCoreWorker = (telemetry: TelemetryService): CoreWorker => ({
  fetch: (request, environment) =>
    // The Core Worker runs no hosted inference: only the coordinator's Memory work builds the
    // binding, so a missing or unusable one cannot deny any route here.
    fetchEffect(request, environment, telemetry).pipe(
      observeWorkerRequest({
        environment,
        telemetry,
        operation: "worker.core.fetch",
      }),
      Effect.runPromise
    ),
  scheduled: (_controller, environment) =>
    Effect.gen(function* () {
      const dispatched = yield* Effect.exit(
        environment.ONBOARDING_EMAIL_QUEUE !== undefined
          ? dispatchOnboardingEmail({
              DB: environment.DB,
              ONBOARDING_EMAIL_QUEUE: environment.ONBOARDING_EMAIL_QUEUE,
            })
          : Effect.void
      );
      yield* reconcileOnboardingEmail(environment.DB);
      if (environment.BROWSER_PAIRING_EMAIL_QUEUE !== undefined) {
        yield* dispatchBrowserPairingEmail({
          DB: environment.DB,
          BROWSER_PAIRING_EMAIL_QUEUE: environment.BROWSER_PAIRING_EMAIL_QUEUE,
        });
      }
      yield* reconcileBrowserPairingEmail(environment.DB);
      if (environment.EMAIL_REPLACEMENT_QUEUE !== undefined) {
        yield* dispatchEmailReplacement({
          DB: environment.DB,
          EMAIL_REPLACEMENT_QUEUE: environment.EMAIL_REPLACEMENT_QUEUE,
        }).pipe(Effect.withSpan("emailReplacement.dispatch"));
      }
      yield* reconcileEmailReplacement(environment.DB).pipe(
        Effect.withSpan("emailReplacement.reconcile")
      );
      yield* billingScheduled(environment);
      yield* sweepExpiredConsent(environment.DB)();
      yield* Effect.tryPromise({
        try: () => sweepExpiredPATPairings(environment.DB),
        catch: () => undefined,
      });
      yield* statementIngestionScheduled(environment).pipe(
        Effect.withSpan("ingestion.statementSweep")
      );
      yield* statementDeliveryScheduled(environment);
      if (Exit.isFailure(dispatched)) return yield* Effect.fail(undefined);
    }).pipe(Effect.withSpan("onboarding.email.dispatch"), Effect.runPromise),
  queue: receiveWorkQueue,
});

/** Private service-binding target for canonical execution and bounded topology health evidence. */
export default makeCoreWorker(cloudflareWorkerTelemetry);
