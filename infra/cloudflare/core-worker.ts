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
import {
  type OnboardingEmailEnvironment,
  dispatchOnboardingEmail,
  receiveOnboardingEmail,
  reconcileOnboardingEmail,
} from "./onboarding-email";
import { contractDigestPattern, gitRevisionPattern } from "./release-identity";
import {
  type WorkerTelemetryEnvironment,
  cloudflareWorkerTelemetry,
  observeWorkerRequest,
} from "./telemetry";
import { type WorkersAiEnvironment, cloudflareHostedInferenceLive } from "./workers-ai";

export { OnboardingEmailWorkflowV1 } from "./onboarding-email";

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
  } & Partial<Omit<OnboardingEmailEnvironment, "DB">>;

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

const fetchEffect = (request: Request, environment: CoreEnvironment): Effect.Effect<Response> => {
  const url = new URL(request.url);
  if (
    url.pathname !== "/health" &&
    url.pathname !== listCategoriesPath &&
    url.pathname !== "/providers/kapso/callback"
  ) {
    return Effect.succeed(jsonResponse('{"status":"not_found"}', HTTP_NOT_FOUND));
  }
  if (url.pathname === "/providers/kapso/callback") return callbackEffect(request, environment);
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
      yield* sweepExpiredConsent(environment.DB)();
      if (Exit.isFailure(dispatched)) return yield* Effect.fail(undefined);
    }).pipe(Effect.withSpan("onboarding.email.dispatch"), Effect.runPromise),
  queue: (batch, environment) => {
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
  },
});

/** Private service-binding target for canonical execution and bounded topology health evidence. */
export default makeCoreWorker(cloudflareWorkerTelemetry);
