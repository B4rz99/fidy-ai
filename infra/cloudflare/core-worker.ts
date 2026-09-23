import * as D1Client from "@effect/sql-d1/D1Client";
import {
  ScopeMissing,
  UserActionRequired,
  categoryUnavailable,
  listCategoriesPath,
  listCategoriesResponse,
} from "@fidy/server/categories";
import { HostedInference } from "@fidy/server/hosted-inference";
import { emailReplacementOperations } from "@fidy/server/email-replacement";
import type { TelemetryService } from "@fidy/server/telemetry";
import { Context, Effect, Exit, Layer, Option, Schema } from "effect";
import { CreateTransactionInput } from "@fidy/server/transactions-runtime";
import { ownsTransactionPath as transactionPath } from "@fidy/server/transaction-routes";
import { browsePATTransactions, browseTransactions } from "./transaction-history";
import { SqlClient } from "effect/unstable/sql";
import { receiveConsentWebhook, sweepExpiredConsent } from "./consent-ingress";
import {
  rejectManualTransaction,
  transactionInput,
  transactionSession,
  unauthenticatedTransaction,
} from "./transactions";
import { completeBrowserPairingEmail, startBrowserPairingEmail } from "./browser-pairing-email";
import {
  type BrowserPairingEmailEnvironment,
  dispatchBrowserPairingEmail,
  isBrowserPairingEmailWork,
  receiveBrowserPairingEmail,
  reconcileBrowserPairingEmail,
} from "./browser-pairing-email-delivery";
import { handleSupportRecovery } from "./support-recovery";
import { handleCardEnrollment } from "./card-enrollment";
import { completeEmailReplacement, requestEmailReplacement } from "./email-replacement";
import {
  type EmailReplacementEnvironment,
  dispatchEmailReplacement,
  isEmailReplacementWork,
  receiveEmailReplacement,
  reconcileEmailReplacement,
} from "./email-replacement-delivery";
import { handlePATRequest, patRoute } from "./pat-routes";
import { canonicalOperation, canonicalRoute } from "./canonical-routes";
import type { CatalogOperation } from "@fidy/server/canonical-runtime";
import { sweepExpiredPATPairings } from "./pat-pairing";
import {
  type AuthorizedPAT,
  authorizeCanonicalPAT,
  authorizeCategoryPAT,
} from "./pat-authorization";
import {
  currentUser,
  logoutBrowser,
  redeemBrowserPairing,
  rotateBackupRecoveryCode,
  startBrowserPairing,
} from "./browser-login";
import {
  type OnboardingEmailEnvironment,
  dispatchOnboardingEmail,
  receiveOnboardingEmail,
  reconcileOnboardingEmail,
} from "./onboarding-email";
import { contractDigestPattern, gitRevisionPattern } from "./release-identity";
import { verifyOnboarding } from "./verified-onboarding";
import {
  type WorkerTelemetryEnvironment,
  cloudflareWorkerTelemetry,
  observeWorkerRequest,
} from "./telemetry";
import { type WorkersAiEnvironment, cloudflareHostedInferenceLive } from "./workers-ai";

export { UserTransactionCoordinator } from "./transaction-coordinator";
export { OnboardingEmailWorkflowV1 } from "./onboarding-email";
export { BrowserPairingEmailWorkflowV1 } from "./browser-pairing-email-delivery";
export { EmailReplacementWorkflowV1 } from "./email-replacement-delivery";

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
    readonly BROWSER_ORIGIN?: string;
    readonly WOMPI_ENVIRONMENT?: string;
    readonly WOMPI_PUBLIC_KEY?: string;
    readonly WOMPI_PRIVATE_KEY?: string;
    readonly WOMPI_INTEGRITY_SECRET?: string;
  } & Partial<Omit<OnboardingEmailEnvironment, "DB">> &
  Partial<Omit<BrowserPairingEmailEnvironment, "DB" | "RESEND_API_KEY">> &
  Partial<Omit<EmailReplacementEnvironment, "DB" | "RESEND_API_KEY">>;

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

const categoriesResponse = (environment: CoreEnvironment): Effect.Effect<Response> =>
  Effect.scoped(
    Effect.gen(function* () {
      const clients = yield* Layer.build(D1Client.layer({ db: environment.DB }));
      return yield* listCategoriesResponse.pipe(
        // Effect SQL span attributes contain query text, which must not enter exported telemetry.
        Effect.withTracerEnabled(false),
        Effect.provideService(SqlClient.SqlClient, Context.get(clients, SqlClient.SqlClient)),
        Effect.mapError(categoryUnavailable),
        Effect.withSpan("categories.listCategories"),
        Effect.match({
          onFailure: (failure) =>
            jsonResponse(
              JSON.stringify({ error: failure.error, next: failure.next }),
              HTTP_SERVICE_UNAVAILABLE
            ),
          onSuccess: (response) => jsonResponse(JSON.stringify(response), HTTP_OK),
        })
      );
    })
  ).pipe(Effect.catchCause(() => Effect.succeed(unavailable())));

const callbackEffect = (request: Request, environment: CoreEnvironment): Effect.Effect<Response> =>
  request.method === "POST"
    ? receiveConsentWebhook(environment)(request)
    : Effect.succeed(methodNotAllowed());

const verificationEffect = (request: Request, db: D1Database): Effect.Effect<Response> =>
  request.method === "POST"
    ? Effect.tryPromise({ try: () => verifyOnboarding(request, db), catch: () => undefined }).pipe(
        Effect.orElseSucceed(unavailable)
      )
    : Effect.succeed(methodNotAllowed());

const enrollmentCorePath = (path: string): boolean =>
  path === "/web/subscription/card-enrollments/prepare" ||
  path === "/web/subscription/card-enrollments/submit" ||
  /^\/web\/subscription\/(?:card-enrollments|billing-attempts)\/[0-9a-f-]{36}$/u.test(path);

const transactionsResponse = (
  request: Request,
  environment: CoreEnvironment,
  operation: CatalogOperation
): Effect.Effect<Response> =>
  Effect.tryPromise({
    // @effect-diagnostics-next-line asyncFunction:off
    try: async () => {
      const subject = await transactionSession(request, environment.DB);
      if (Option.isNone(subject)) return unauthenticatedTransaction();
      if (operation.id !== "transactions.createTransaction") {
        return browseTransactions(environment.DB, {
          request,
          subject: subject.value,
          id:
            operation.id === "transactions.listTransactions"
              ? Option.none()
              : Option.some(new URL(request.url).pathname.split("/").at(-1) ?? ""),
        });
      }
      const input = await transactionInput(request);
      if (Option.isNone(input)) {
        return rejectManualTransaction(environment.DB, subject.value, "validation_failed");
      }
      // The existing worker.core.fetch and worker.public.fetch Work spans bound latency and
      // status for this D1/DO workflow. Do not add per-Transaction spans: they would count
      // failures twice and risk exporting opaque record ids or captured Money.
      const stub = environment.USER_TRANSACTION_COORDINATOR.getByName(subject.value.userId);
      const encoded = await Effect.runPromise(
        Schema.encodeEffect(Schema.toCodecJson(CreateTransactionInput))(input.value)
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const body = JSON.stringify({
        _tag: "WebSession",
        sessionId: subject.value.id,
        userId: subject.value.userId,
        digest: Array.from(subject.value.digest),
        input: encoded,
      });
      return stub.fetch(
        new Request("https://coordinator.internal/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      );
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(unavailable));

const ownedCorePath = (path: string): boolean =>
  enrollmentCorePath(path) ||
  [
    "/health",
    listCategoriesPath,
    "/providers/kapso/callback",
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
  ].includes(path) ||
  transactionPath(path) ||
  patRoute(path) ||
  canonicalRoute(path);

const browserResponse = (
  request: Request,
  environment: CoreEnvironment
): Effect.Effect<Response> => {
  const db = environment.DB;
  const path = new URL(request.url).pathname;
  const routes: Readonly<
    Record<string, Readonly<{ method: string; handle: () => Promise<Response> }>>
  > = {
    "/web/pairings": { method: "POST", handle: () => startBrowserPairing(db) },
    "/web/pairings/redeem": { method: "POST", handle: () => redeemBrowserPairing(request, db) },
    "/web/session/logout": { method: "POST", handle: () => logoutBrowser(request, db) },
    "/recovery/backup-code/rotate": {
      method: "POST",
      handle: () => rotateBackupRecoveryCode(request, db),
    },
    "/web/email/authentication/start": {
      method: "POST",
      handle: () => startBrowserPairingEmail(request, db),
    },
    "/web/email/authentication/complete": {
      method: "POST",
      handle: () => completeBrowserPairingEmail(request, db),
    },
    [emailReplacementOperations.request.path]: {
      method: emailReplacementOperations.request.method,
      handle: () => requestEmailReplacement(request, db),
    },
    [emailReplacementOperations.complete.path]: {
      method: emailReplacementOperations.complete.method,
      handle: () => completeEmailReplacement(request, db),
    },
    "/internal/support-recovery": {
      method: "POST",
      handle: () => handleSupportRecovery(request, db, environment),
    },
    "/user": { method: "GET", handle: () => currentUser(request, db) },
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

// @effect-diagnostics-next-line asyncFunction:off
const dispatchPATCapture = async (
  request: Request,
  environment: CoreEnvironment,
  pat: AuthorizedPAT
): Promise<Response> => {
  const input = await transactionInput(request);
  if (Option.isNone(input)) {
    return rejectManualTransaction(environment.DB, pat, "validation_failed");
  }
  const stub = environment.USER_TRANSACTION_COORDINATOR.getByName(pat.userId);
  const encoded = await Effect.runPromise(
    Schema.encodeEffect(Schema.toCodecJson(CreateTransactionInput))(input.value)
  );
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  const body = JSON.stringify({
    _tag: "PAT",
    patId: pat.patId,
    userId: pat.userId,
    digest: Array.from(pat.digest),
    input: encoded,
  });
  return stub.fetch(
    new Request("https://coordinator.internal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  );
};

const admittedPATResponse = (
  request: Request,
  environment: CoreEnvironment,
  input: Readonly<{ operation: CatalogOperation; pat: AuthorizedPAT | undefined }>
): Effect.Effect<Response> => {
  const { operation, pat } = input;
  if (pat !== undefined && operation.id === "transactions.createTransaction") {
    return Effect.tryPromise({
      try: () => dispatchPATCapture(request, environment, pat),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(unavailable));
  }
  if (
    pat !== undefined &&
    (operation.id === "transactions.listTransactions" ||
      operation.id === "transactions.getTransaction")
  ) {
    return Effect.tryPromise({
      try: () =>
        browsePATTransactions(environment.DB, {
          request,
          subject: pat,
          id:
            operation.id === "transactions.getTransaction"
              ? Option.some(new URL(request.url).pathname.split("/").at(-1) ?? "")
              : Option.none(),
        }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(unavailable));
  }
  if (operation.id === "categories.listCategories") return categoriesResponse(environment);
  return Effect.succeed(
    jsonResponse(
      '{"error":{"code":"unavailable","message":"Canonical operation is temporarily unavailable."},"next":[]}',
      HTTP_SERVICE_UNAVAILABLE
    )
  );
};

const authorizedCanonicalResponse = (
  request: Request,
  environment: CoreEnvironment,
  operation: CatalogOperation
): Effect.Effect<Response> => {
  if (transactionPath(new URL(request.url).pathname) && !request.headers.has("authorization")) {
    return transactionsResponse(request, environment, operation);
  }
  if (operation.id === "categories.listCategories" && request.headers.has("cookie")) {
    return Effect.tryPromise({
      try: () => transactionSession(request, environment.DB),
      catch: () => undefined,
    }).pipe(
      Effect.flatMap((session) =>
        Option.isSome(session)
          ? categoriesResponse(environment)
          : Effect.succeed(unauthenticatedTransaction())
      ),
      Effect.orElseSucceed(unavailable)
    );
  }
  return Effect.tryPromise({
    try: async (): Promise<
      AuthorizedPAT | "accepted" | "unauthenticated" | "scope_missing" | "user_action_required"
    > =>
      operation.id === "categories.listCategories"
        ? authorizeCategoryPAT(request, environment.DB)
        : authorizeCanonicalPAT(request, environment.DB, operation),
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
        if (authorized === "accepted") return undefined;
        if (authorized === "user_action_required") return consentRevokedResponse();
        if (authorized === "scope_missing") return scopeMissingResponse();
        return jsonResponse(
          '{"error":{"code":"unauthenticated","message":"Present a valid credential and retry."},"next":[]}',
          HTTP_UNAUTHORIZED
        );
      },
    }),
    Effect.flatMap((result) =>
      result instanceof Response
        ? Effect.succeed(result)
        : admittedPATResponse(request, environment, { operation, pat: result })
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
  const operation = canonicalOperation(request.method, path);
  if (Option.isSome(operation)) {
    return authorizedCanonicalResponse(request, environment, operation.value);
  }
  if (canonicalRoute(path) || request.method !== "GET") return Effect.succeed(methodNotAllowed());
  return Effect.succeed(healthResponse(environment));
};

const fetchEffect = (request: Request, environment: CoreEnvironment): Effect.Effect<Response> => {
  const url = new URL(request.url);
  if (!ownedCorePath(url.pathname)) {
    return Effect.succeed(jsonResponse('{"status":"not_found"}', HTTP_NOT_FOUND));
  }
  if (url.pathname === "/providers/kapso/callback") return callbackEffect(request, environment);
  if (enrollmentCorePath(url.pathname)) {
    return Effect.tryPromise({
      try: () => handleCardEnrollment(request, environment),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(unavailable), Effect.withSpan("subscription.card-enrollment"));
  }
  if (url.pathname === "/web/onboarding/email/verify") {
    return verificationEffect(request, environment.DB);
  }
  if (patRoute(url.pathname)) {
    return Effect.tryPromise({
      try: () => handlePATRequest(request, environment.DB),
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
    return browserResponse(request, environment);
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

/** Builds the private Core target with one telemetry service for each request Work span. */
export const makeCoreWorker = (telemetry: TelemetryService): CoreWorker => ({
  fetch: (request, environment) =>
    Effect.scoped(
      Effect.gen(function* () {
        const inference = yield* Layer.build(cloudflareHostedInferenceLive(environment));
        return yield* fetchEffect(request, environment).pipe(
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
      yield* sweepExpiredConsent(environment.DB)();
      yield* Effect.tryPromise({
        try: () => sweepExpiredPATPairings(environment.DB),
        catch: () => undefined,
      });
      if (Exit.isFailure(dispatched)) return yield* Effect.fail(undefined);
    }).pipe(Effect.withSpan("onboarding.email.dispatch"), Effect.runPromise),
  queue: receiveEmailQueue,
});

/** Private service-binding target for canonical execution and bounded topology health evidence. */
export default makeCoreWorker(cloudflareWorkerTelemetry);
