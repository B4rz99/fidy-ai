import * as D1Client from "@effect/sql-d1/D1Client";
import {
  categoryUnavailable,
  listCategoriesPath,
  listCategoriesResponse,
} from "@fidy/server/categories";
import { HostedInference } from "@fidy/server/hosted-inference";
import type { TelemetryService } from "@fidy/server/telemetry";
import { Context, Effect, Exit, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { receiveConsentWebhook, sweepExpiredConsent } from "./consent-ingress";
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

export { OnboardingEmailWorkflowV1 } from "./onboarding-email";
export { BrowserPairingEmailWorkflowV1 } from "./browser-pairing-email-delivery";

const ReleaseConfiguration = Schema.Struct({
  CONTRACT_DIGEST: Schema.String.check(Schema.isPattern(contractDigestPattern)),
  RELEASE_GIT_SHA: Schema.String.check(Schema.isPattern(gitRevisionPattern)),
});

type CoreEnvironment = WorkerTelemetryEnvironment &
  typeof ReleaseConfiguration.Type & {
    readonly AI: WorkersAiEnvironment["AI"];
    readonly DB: D1Database;
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
  Partial<Omit<BrowserPairingEmailEnvironment, "DB" | "RESEND_API_KEY">>;

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
    "/internal/support-recovery",
    "/user",
  ].includes(path);

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
  return Effect.tryPromise({ try: route.handle, catch: () => undefined }).pipe(
    Effect.orElseSucceed(unavailable)
  );
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
  if (
    [
      "/web/pairings",
      "/web/pairings/redeem",
      "/web/session/logout",
      "/recovery/backup-code/rotate",
      "/web/email/authentication/start",
      "/web/email/authentication/complete",
      "/internal/support-recovery",
      "/user",
    ].includes(url.pathname)
  ) {
    return browserResponse(request, environment);
  }
  if (request.method !== "GET") return Effect.succeed(methodNotAllowed());

  const configuration = Schema.decodeExit(ReleaseConfiguration)(environment);
  if (Exit.isFailure(configuration)) return Effect.succeed(unavailable());

  if (url.pathname === listCategoriesPath) return categoriesResponse(environment);

  return Effect.succeed(
    jsonResponse(
      JSON.stringify({
        contractDigest: configuration.value.CONTRACT_DIGEST,
        gitRevision: configuration.value.RELEASE_GIT_SHA,
        status: "available",
      }),
      HTTP_OK
    )
  );
};

const receiveEmailQueue: CoreWorker["queue"] = (batch, environment) => {
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
      yield* sweepExpiredConsent(environment.DB)();
      if (Exit.isFailure(dispatched)) return yield* Effect.fail(undefined);
    }).pipe(Effect.withSpan("onboarding.email.dispatch"), Effect.runPromise),
  queue: receiveEmailQueue,
});

/** Private service-binding target for canonical execution and bounded topology health evidence. */
export default makeCoreWorker(cloudflareWorkerTelemetry);
