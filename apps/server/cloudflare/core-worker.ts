import {
  type KeywordRuleOperation,
  ScopeMissing,
  UserActionRequired,
  categoryUnavailable,
  listCategoriesPath,
} from "@fidy/server/categories";
import { HostedInference } from "@fidy/server/hosted-inference";
import { emailReplacementOperations } from "@fidy/server/email-replacement";
import type { TelemetryService } from "@fidy/server/telemetry";
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import type {
  CreateTransactionInput,
  TransactionPairInput,
  UpdateTransactionInput,
} from "@fidy/server/transactions-runtime";
import { correctionInput } from "./transactions/transaction-corrections";
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
} from "./transactions/transaction-boundary";
import { RequestBodyPolicy, boundedJsonBody } from "./http/request-body";
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
import { executeMemoryOperation, isMemoryOperationId } from "./memory/memory";
import { canonicalOperation, canonicalRoute } from "./routing/canonical-routes";
import {
  type BatchCalls,
  BatchInput,
  TransactionCommand,
} from "./transactions/transaction-coordinator";
import {
  type CatalogOperation,
  atomicBatchOperation,
  maximumAtomicBatchCalls,
} from "@fidy/server/canonical-runtime";
import { sweepExpiredPATPairings } from "./pats/pat-pairing";
import { authorizeCanonicalPAT } from "./pats/pat-authorization";
import { executeProtectedCategories } from "./categories/canonical-category";
import {
  handleOwnKeywordRuleMutation,
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
import { type WorkersAiEnvironment, cloudflareHostedInferenceLive } from "./ai/workers-ai";
import { statementStagingPath } from "@fidy/server/statement-path";
import {
  readStatementSubmission,
  submitStagedStatement,
  uploadStagedStatement,
} from "./ingestion/statement-ingestion";
import { StatementStaging } from "./ingestion/statement-staging";

export { UserTransactionCoordinator } from "./transactions/transaction-coordinator";
export { OnboardingEmailWorkflowV1 } from "./onboarding/onboarding-email";
export { BillingCollectionWorkflowV1 } from "./billing/billing-collection";
export { BrowserPairingEmailWorkflowV1 } from "./identity/browser-pairing-email-delivery";
export { EmailReplacementWorkflowV1 } from "./identity/email-replacement-delivery";

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
  Partial<Readonly<{ STATEMENT_STAGING_BUCKET: R2Bucket }>> &
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

type ForwardWork =
  | Readonly<{ _tag: "Capture"; input: CreateTransactionInput }>
  | Readonly<{ _tag: "Correction"; id: string; input: UpdateTransactionInput }>
  | Readonly<{ _tag: "Link"; pair: TransactionPairInput }>
  | Readonly<{ _tag: "Unlink"; pair: TransactionPairInput }>;

type CoordinatorWork = ForwardWork | Readonly<{ _tag: "Batch"; calls: BatchCalls }>;

type PATAuthority = Omit<Extract<TransactionCommand, { _tag: "PATCapture" }>, "_tag" | "input">;
type SessionAuthority = Omit<
  Extract<TransactionCommand, { _tag: "WebSessionCapture" }>,
  "_tag" | "input"
>;

/** The PAT command variant for one admitted piece of Transaction work. */
const patCommand = (authority: PATAuthority, work: CoordinatorWork): TransactionCommand => {
  if (work._tag === "Capture") return { _tag: "PATCapture", ...authority, input: work.input };
  if (work._tag === "Correction") {
    return {
      _tag: "PATCorrection",
      ...authority,
      correction: { id: work.id, input: work.input },
    };
  }
  if (work._tag === "Link") return { _tag: "PATLink", ...authority, pair: work.pair };
  if (work._tag === "Unlink") return { _tag: "PATUnlink", ...authority, pair: work.pair };
  return { _tag: "PATBatch", ...authority, calls: work.calls };
};

/** The WebSession command variant for one admitted piece of Transaction work. */
const sessionCommand = (authority: SessionAuthority, work: CoordinatorWork): TransactionCommand => {
  if (work._tag === "Capture") {
    return { _tag: "WebSessionCapture", ...authority, input: work.input };
  }
  if (work._tag === "Correction") {
    return {
      _tag: "WebSessionCorrection",
      ...authority,
      correction: { id: work.id, input: work.input },
    };
  }
  if (work._tag === "Link") return { _tag: "WebSessionLink", ...authority, pair: work.pair };
  if (work._tag === "Unlink") return { _tag: "WebSessionUnlink", ...authority, pair: work.pair };
  return { _tag: "WebSessionBatch", ...authority, calls: work.calls };
};

/**
 * Bind one admitted caller to the exact coordinator command variant for this Transaction work. The
 * coordinator's own published schema types every field here, so the Worker cannot drift from it.
 */
const coordinatorCommand = (
  subject: TransactionCaller,
  work: CoordinatorWork
): TransactionCommand =>
  isPATCaller(subject)
    ? patCommand(
        {
          patId: subject.patId,
          userId: subject.userId,
          digest: Array.from(subject.digest),
          requiredScope: Option.getOrNull(subject.requiredScope),
        },
        work
      )
    : sessionCommand(
        {
          sessionId: subject.id,
          userId: subject.userId,
          digest: Array.from(subject.digest),
        },
        work
      );

/** Inert per-command URL suffix; the coordinator decodes the command from the body alone. */
const coordinatorRoutes = {
  Capture: "create",
  Correction: "correct",
  Batch: "batch",
  Link: "link",
  Unlink: "unlink",
} as const;

/** Encode one admitted command and deliver it to the caller's User coordinator. */
const sendToCoordinator = ({
  environment,
  subject,
  work,
}: Readonly<{
  environment: CoreEnvironment;
  subject: TransactionCaller;
  work: CoordinatorWork;
}>): Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    // Work spans bound latency and status. Keep opaque ids and Money out of trace attributes.
    const stub = environment.USER_TRANSACTION_COORDINATOR.getByName(subject.userId);
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(TransactionCommand))(
      coordinatorCommand(subject, work)
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
        work: { _tag: "Capture", input: input.value },
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
        work: {
          _tag: "Correction",
          id: new URL(request.url).pathname.split("/").at(-1) ?? "",
          input: input.value,
        },
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
        work:
          operation === "transactions.linkTransactions"
            ? { _tag: "Link", pair: pair.value }
            : { _tag: "Unlink", pair: pair.value },
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

/** One canonical keyword-rule mutation through the adapter that owns its declared contract. */
const keywordRuleMutationResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreEnvironment;
    subject: TransactionCaller;
    operation: KeywordRuleOperation;
  }>
): Effect.Effect<Response> => {
  const { request, environment, subject, operation } = input;
  return Effect.tryPromise({
    try: () => handleOwnKeywordRuleMutation({ request, db: environment.DB, subject, operation }),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(unavailable));
};

/** The keyword-rule mutation ids, and None for any other canonical operation. */
const keywordRuleOperation = (id: string): Option.Option<KeywordRuleOperation> => {
  if (id === "categories.createKeywordRule") return Option.some(id);
  if (id === "categories.updateKeywordRule") return Option.some(id);
  if (id === "categories.deleteKeywordRule") return Option.some(id);
  return Option.none();
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
  return Option.map(keywordRuleOperation(operation.id), (owned) =>
    keywordRuleMutationResponse({ request, environment, subject, operation: owned })
  );
};

/** The Memory work this dispatch owns, or None when another slice owns the operation. */
const memoryResponse = (
  input: Readonly<{
    request: Request;
    environment: CoreEnvironment;
    operation: CatalogOperation;
    subject: TransactionCaller;
  }>
): Option.Option<Effect.Effect<Response, never, HostedInference>> =>
  isMemoryOperationId(input.operation.id)
    ? Option.some(
        executeMemoryOperation({
          request: input.request,
          db: input.environment.DB,
          subject: input.subject,
          operation: input.operation.id,
        }).pipe(Effect.withSpan(input.operation.id))
      )
    : Option.none();
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

/** Ingestion canonical work: the one adapter whose response is a staged-material projection. */
const ingestionCanonicalResponse = (
  input: Readonly<{
    operation: CatalogOperation;
    request: Request;
    environment: CoreEnvironment;
    subject: TransactionCaller;
  }>
): Option.Option<Effect.Effect<Response>> => {
  const { operation, request, environment, subject } = input;
  if (operation.id === "ingestion.submitForExtraction") {
    return Option.some(
      Effect.tryPromise({
        try: () => submitStagedStatement({ environment, request, subject }),
        catch: () => undefined,
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
): Effect.Effect<Response, never, HostedInference> => {
  const { request, environment, operation, subject } = input;
  if (operation.id === "categories.listCategories") return categoriesResponse(environment, subject);
  const ownerResponse = Option.orElse(keywordRuleResponse(input), () => memoryResponse(input));
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
): Effect.Effect<Response, never, HostedInference> => {
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
): Effect.Effect<Response, never, HostedInference> => {
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
): Effect.Effect<Response, never, HostedInference> => {
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
  });

/** Builds the private Core target with one telemetry service for each request Work span. */
export const makeCoreWorker = (telemetry: TelemetryService): CoreWorker => ({
  fetch: (request, environment) =>
    Effect.scoped(
      Effect.gen(function* () {
        const inference = yield* Layer.build(cloudflareHostedInferenceLive(environment));
        return yield* fetchEffect(request, environment, telemetry).pipe(
          Effect.provideService(HostedInference, Context.get(inference, HostedInference))
        );
      })
    ).pipe(
      Effect.catchTag("HostedInferenceError", () => Effect.succeed(unavailable())),
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
      if (Exit.isFailure(dispatched)) return yield* Effect.fail(undefined);
    }).pipe(Effect.withSpan("onboarding.email.dispatch"), Effect.runPromise),
  queue: receiveWorkQueue,
});

/** Private service-binding target for canonical execution and bounded topology health evidence. */
export default makeCoreWorker(cloudflareWorkerTelemetry);
