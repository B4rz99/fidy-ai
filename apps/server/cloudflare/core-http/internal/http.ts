import { betaProPath } from "../../../src/shell/pro-grants/contract";
import { handleBetaPro } from "../../beta-pro/runtime";
import { webAuthenticationEndpoints } from "../../../src/shell/web-authentication/contract";

import { supportRecoveryPath } from "../../recovery/contract";

import { handleSampleReview } from "../../ingestion/runtime";

import { nativeSupportRecovery } from "../../recovery/operations";

import {
  emailReplacementCompletionPath,
  emailReplacementPath,
} from "../../../src/shell/email-authentication/contract";

import {
  currentMountedBinding,
  routeBootstrapRequest,
  routeBrowserSession,
  routeConnectionCallback,
  routePATRequest,
  routeSessionRequest,
} from "../../directory/operations";

import type { BancolombiaAuthenticationFailed } from "../../bancolombia-authentication/contract";

import { sampleReviewPath } from "../../../src/core/ingestion/contract";

import { handleNativeErasureOperator } from "../../erasure/runtime";

import { captureTraceHeaders } from "../../runtime/telemetry/operations";

import { processingConsentTransport } from "../../../src/shell/processing-consent/runtime";

import { connectionBrowserTransport } from "../../../src/shell/connections/runtime";

import { connectionCallbackPath } from "../../connections/contract";

import type { HttpClient } from "effect/http";

import { ownsProviderAuthenticationPath } from "../../provider-authentication/operations";

import { oauthPaths } from "../../../src/shell/oauth-agents/contract";

import { isLocalHostedPath } from "../../agent/runtime";

import { listCategoriesPath } from "../../../src/shell/categories/contract";

import { type TelemetryService } from "../../../src/shell/observability/contract";

import { observeCanonicalResponse } from "../../runtime/application-observation/operations";

import { Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect";

import { ownsTransactionPath as transactionPath } from "../../../src/shell/transactions/runtime";

import { ownsWebAuthenticationPath, supportResponse } from "../../web-authentication/operations";

import { pricePublicationPath } from "../../subscription/contract";

import { refundSupportRoute } from "../../subscription/operations";

import { paymentEnrollmentTransport } from "../../../src/shell/subscription/runtime";

import {
  handlePricePublication,
  handleRefundSupport,
  receiveWompiBillingEvent,
} from "../../subscription/runtime";

import { isLocalPATGrant, isLocalPATManagement, patDirectRoute } from "../../tokens/operations";

import { canonicalOperation, canonicalRoute } from "../../routing/operations";

import { type CatalogOperation } from "../../../src/shell/canonical-catalog/contract";

import { contractDigestPattern, gitRevisionPattern } from "../../runtime/contract";

import {
  smokeFailureHeader,
  smokePath,
  smokeProofAccepted,
} from "../../runtime/release-smoke/contract";

import { handleSmoke, smokeReady } from "../../runtime/release-smoke/operations";

import { statementStagingPath } from "../../../src/shell/ingestion/contract";

import { WhatsAppInboundAdmission } from "../../whatsapp/contract";

import { receiveWhatsAppWebhook } from "../../whatsapp/runtime";

import type { CoreHttpEnvironment } from "../contract";

const ReleaseConfiguration = Schema.Struct({
  CONTRACT_DIGEST: Schema.String.check(Schema.isPattern(contractDigestPattern)),
  RELEASE_GIT_SHA: Schema.String.check(Schema.isPattern(gitRevisionPattern)),
});

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

const HTTP_OK = 200;

const HTTP_NOT_FOUND = 404;

const HTTP_FORBIDDEN = 403;

const HTTP_METHOD_NOT_ALLOWED = 405;

const HTTP_SERVICE_UNAVAILABLE = 503;

const jsonResponse = (body: string, status: number): Response =>
  new Response(body, { headers: jsonHeaders, status });

const callbackRuntime = ManagedRuntime.make(Layer.empty);

const unavailable = (): Response =>
  jsonResponse('{"status":"unavailable"}', HTTP_SERVICE_UNAVAILABLE);

const methodNotAllowed = (): Response =>
  new Response('{"status":"method_not_allowed"}', {
    headers: { ...jsonHeaders, allow: "GET" },
    status: HTTP_METHOD_NOT_ALLOWED,
  });

const callbackEffect = (
  request: Request,
  environment: CoreHttpEnvironment
): Effect.Effect<Response> =>
  request.method === "POST"
    ? Effect.flatMap(captureTraceHeaders, (traceHeaders) =>
        receiveWhatsAppWebhook({
          ...environment,
          onHostedText: (admission) =>
            callbackRuntime
              .runPromise(
                Schema.encodeEffect(Schema.fromJsonString(WhatsAppInboundAdmission))(admission)
              )
              .then(
                (body) =>
                  environment.USER_STORE?.getByName(admission.userId).fetch(
                    "https://user.invalid/hosted-turn/whatsapp",
                    {
                      method: "POST",
                      headers: { "content-type": "application/json", ...traceHeaders },
                      body,
                    }
                  ) ?? unavailable()
              ),
        })(request)
      )
    : Effect.succeed(methodNotAllowed());

const providerCallbackEffect = (
  request: Request,
  environment: CoreHttpEnvironment
): Effect.Effect<Response> => {
  const path = new URL(request.url).pathname;

  if (path === "/providers/kapso/callback") return callbackEffect(request, environment);

  if (request.method !== "POST") return Effect.succeed(methodNotAllowed());

  if (environment.WOMPI_EVENT_SECRET === undefined) return Effect.succeed(unavailable());

  return receiveWompiBillingEvent({
    request,
    environment: { ...environment, WOMPI_EVENT_SECRET: environment.WOMPI_EVENT_SECRET },
  }).pipe(Effect.withSpan("billing.collection.event"));
};

const enrollmentCorePath = (path: string): boolean =>
  Option.isSome(paymentEnrollmentTransport(path));

const privacyOrConnectionPath = (path: string): boolean =>
  path === connectionCallbackPath ||
  Option.isSome(processingConsentTransport(path)) ||
  Option.isSome(connectionBrowserTransport(path));

const ownedCorePath = (path: string): boolean =>
  privacyOrConnectionPath(path) ||
  ownsProviderAuthenticationPath(path) ||
  refundSupportRoute(path) ||
  enrollmentCorePath(path) ||
  [
    "/health",
    "/internal/titular-erasure",
    sampleReviewPath,
    betaProPath,
    pricePublicationPath,
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

const directPathResponse = (request: Request): Option.Option<Effect.Effect<Response>> => {
  const path = new URL(request.url).pathname;

  if (path === statementStagingPath) {
    return Option.some(statementUploadResponse(request));
  }

  return Option.none();
};

const authorizedCanonicalResponse = (
  request: Request,
  environment: CoreHttpEnvironment,
  operation: CatalogOperation
): Effect.Effect<Response> => {
  if (operation.id === "ingestion.submitForExtraction") return statementUploadResponse(request);

  if (request.headers.has("authorization")) {
    return routePATRequest({ request, environment }).pipe(observeCanonicalResponse(operation.id));
  }

  return routeSessionRequest({ request, environment }).pipe(observeCanonicalResponse(operation.id));
};

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

const mounted = <E, R>(
  request: Request,
  environment: CoreHttpEnvironment,
  work: Effect.Effect<Response, E, R>
): Effect.Effect<Response, E, R> =>
  currentMountedBinding(request, environment).pipe(
    Effect.flatMap(Option.match({ onNone: () => work, onSome: Effect.succeed }))
  );

const canonicalOrHealthResponse = (
  request: Request,
  environment: CoreHttpEnvironment,
  path: string
): Effect.Effect<Response> => {
  const operation = canonicalOperation({ method: request.method, path });

  if (Option.isSome(operation)) {
    return authorizedCanonicalResponse(request, environment, operation.value);
  }

  return mounted(
    request,
    environment,
    Effect.succeed(
      canonicalRoute(path) || request.method !== "GET"
        ? methodNotAllowed()
        : healthResponse(environment)
    )
  );
};

type RequestExecution = Readonly<{
  bankAuthentication: Effect.Effect<void, BancolombiaAuthenticationFailed>;
  request: Request;
  environment: CoreHttpEnvironment;
  telemetry: TelemetryService;
}>;

const smokeResponse = (
  request: Request,
  environment: CoreHttpEnvironment,
  bankAuthentication: RequestExecution["bankAuthentication"]
): Effect.Effect<Response> =>
  Effect.tryPromise({
    try: () =>
      smokeReady(environment)
        ? handleSmoke({ request, environment, bankAuthentication: Option.some(bankAuthentication) })
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
    Effect.tapError(() =>
      Effect.logWarning({
        component: "core-http",
        operation: "smokeResponse",
        outcome: "unavailable",
      })
    ),
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

const dedicatedBrowserResponse = (
  request: Request,
  environment: CoreHttpEnvironment,
  path: string
): Option.Option<Effect.Effect<Response>> => {
  if (path === connectionCallbackPath) {
    if (request.method !== "GET") {
      return Option.some(
        Effect.succeed(new Response(null, { status: 405, headers: { allow: "GET" } }))
      );
    }

    return Option.some(
      routeConnectionCallback({ request, environment }).pipe(
        Effect.as(
          new Response(null, {
            status: 303,
            headers: {
              location: environment.BROWSER_ORIGIN + "/connections/result",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          })
        )
      )
    );
  }

  if (Option.isSome(processingConsentTransport(path))) {
    return Option.some(routeSessionRequest({ request, environment }));
  }

  if (Option.isSome(connectionBrowserTransport(path))) {
    if (request.headers.get("origin") !== environment.BROWSER_ORIGIN) {
      return Option.some(
        Effect.succeed(
          Response.json(
            { error: { code: "continuation_unavailable" } },
            { status: 403, headers: { "cache-control": "no-store" } }
          )
        )
      );
    }

    return Option.some(routeSessionRequest({ request, environment }));
  }

  return Option.none();
};

const reservedCoreResponse = (
  {
    request,
    environment,
    bankAuthentication,
  }: Pick<RequestExecution, "request" | "environment" | "bankAuthentication">,
  path: string
): Option.Option<Effect.Effect<Response, never, HttpClient.HttpClient>> => {
  if (!ownedCorePath(path)) {
    return Option.some(Effect.succeed(jsonResponse('{"status":"not_found"}', HTTP_NOT_FOUND)));
  }

  const browser = dedicatedBrowserResponse(request, environment, path);

  if (Option.isSome(browser)) {
    return browser;
  }

  if (
    ownsProviderAuthenticationPath(path) ||
    isPairingRequest(request) ||
    (request.method === "POST" && patDirectRoute(path))
  ) {
    return Option.some(routeBootstrapRequest({ request, environment }));
  }

  if (path === smokePath) {
    return Option.some(smokeResponse(request, environment, bankAuthentication));
  }

  return supportCoreResponse(request, environment, path);
};

const supportCoreResponse = (
  request: Request,
  environment: CoreHttpEnvironment,
  path: string
): Option.Option<Effect.Effect<Response, never, HttpClient.HttpClient>> => {
  if (path === betaProPath) return Option.some(handleBetaPro(request, environment));

  if (path === sampleReviewPath) return Option.some(handleSampleReview(request, environment));

  if (path === "/internal/titular-erasure") {
    return Option.some(handleNativeErasureOperator(request, environment));
  }

  if (path === pricePublicationPath) {
    return Option.some(handlePricePublication({ request, environment }));
  }

  if (refundSupportRoute(path)) {
    return Option.some(
      Effect.tryPromise({
        try: () => handleRefundSupport({ request, environment }),
        catch: () => undefined,
      }).pipe(
        Effect.tapError(() =>
          Effect.logWarning({
            component: "core-http",
            operation: "refundSupport",
            outcome: "unavailable",
          })
        ),
        Effect.orElseSucceed(unavailable)
      )
    );
  }

  return Option.none();
};

const reservedBindingResponse = <E, R>(
  request: Request,
  environment: CoreHttpEnvironment,
  work: Effect.Effect<Response, E, R>
): Effect.Effect<Response, E, R> =>
  ownsProviderAuthenticationPath(new URL(request.url).pathname) ||
  isPairingRequest(request) ||
  Option.isSome(processingConsentTransport(new URL(request.url).pathname)) ||
  Option.isSome(connectionBrowserTransport(new URL(request.url).pathname)) ||
  new URL(request.url).pathname === connectionCallbackPath
    ? work
    : mounted(request, environment, work);

const isPairingRequest = (request: Request): boolean =>
  request.method === "POST" &&
  ["/web/pairings", "/web/pairings/redeem"].includes(new URL(request.url).pathname);

const dispatchCoreHttp = ({
  bankAuthentication,
  request,
  environment,
  telemetry,
}: RequestExecution): Effect.Effect<Response, never, HttpClient.HttpClient> => {
  const url = new URL(request.url);

  const bound = <R>(work: Effect.Effect<Response, never, R>): Effect.Effect<Response, never, R> =>
    mounted(request, environment, work);

  if (Object.values(oauthPaths).some((path) => path === url.pathname)) {
    const work = routeBootstrapRequest({ request, environment });

    return request.headers.has("fidy-session-binding") ? bound(work) : work;
  }

  const reserved = reservedCoreResponse({ request, environment, bankAuthentication }, url.pathname);

  if (Option.isSome(reserved)) return reservedBindingResponse(request, environment, reserved.value);

  if (["/providers/kapso/callback", "/providers/wompi/billing-events"].includes(url.pathname)) {
    return bound(providerCallbackEffect(request, environment));
  }

  if (enrollmentCorePath(url.pathname)) {
    return routeSessionRequest({ request, environment });
  }

  const directPath = directPathResponse(request);

  if (Option.isSome(directPath)) return directPath.value;

  return nativeAuthenticationOrCanonical(request, environment, telemetry);
};

const nativeAuthenticationOrCanonical = (
  request: Request,
  environment: CoreHttpEnvironment,
  telemetry: TelemetryService
): Effect.Effect<Response, never, HttpClient.HttpClient> => {
  const url = new URL(request.url);

  const patListing = canonicalOperation({ method: request.method, path: url.pathname }).pipe(
    Option.filter(
      (operation) => isLocalPATManagement(operation.id) || isLocalPATGrant(operation.id)
    )
  );

  if (Option.isSome(patListing)) {
    return authorizedCanonicalResponse(request, environment, patListing.value);
  }

  if (url.pathname === supportRecoveryPath) {
    return mounted(
      request,
      environment,
      supportResponse({
        request,
        telemetry,
        support: nativeSupportRecovery({
          request,
          config: environment,
          directory: Option.fromUndefinedOr(environment.DIRECTORY),
        }),
      })
    );
  }

  if (
    [
      webAuthenticationEndpoints.startEmail.path,
      webAuthenticationEndpoints.completeEmail.path,
    ].some((path) => path === url.pathname)
  ) {
    return request.method === "POST"
      ? routeBootstrapRequest({ request, environment })
      : Effect.succeed(methodNotAllowed());
  }

  if (ownsWebAuthenticationPath(url.pathname) && !canonicalRoute(url.pathname)) {
    return Effect.succeed(methodNotAllowed());
  }

  return canonicalOrHealthResponse(request, environment, url.pathname);
};

const nativeSessionWrite = (path: string, nativePrivacy: boolean): boolean =>
  (nativePrivacy && path === "/web/privacy/transactions") ||
  isLocalHostedPath(path) ||
  path === "/web/privacy/erasure" ||
  ["/recovery/backup-code/rotate", emailReplacementPath, emailReplacementCompletionPath].includes(
    path
  );

const nativeIdentityResponse = (
  input: RequestExecution
): Option.Option<Effect.Effect<Response>> => {
  const { request, environment } = input;
  const path = new URL(request.url).pathname;

  if (Option.isSome(paymentEnrollmentTransport(path))) {
    return Option.some(routeSessionRequest({ request, environment }));
  }

  if (request.method === "POST" && nativeSessionWrite(path, environment.USER_STORE !== undefined)) {
    return Option.some(routeSessionRequest({ request, environment }));
  }

  if (request.method === "GET" && path === "/user" && request.headers.has("authorization")) {
    return Option.some(routePATRequest({ request, environment }));
  }

  if (
    ["GET /user", "GET /web/session/binding", "POST /web/session/logout"].includes(
      request.method + " " + path
    )
  ) {
    return Option.some(routeBrowserSession(request, environment));
  }

  return Option.none();
};

export const executeCoreHttp = (
  input: RequestExecution
): Effect.Effect<Response, never, HttpClient.HttpClient> =>
  nativeIdentityResponse(input).pipe(Option.getOrElse(() => dispatchCoreHttp(input)));
