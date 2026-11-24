import { betaProPath } from "../src/shell/pro-grants/contract";
import {
  browserSessionBindingHeader,
  browserSessionBindingPath,
  telemetryTraceHeader,
} from "~/shell/browser-transport/contract";

import { cliDistributionResponse } from "./cli-distribution/runtime";
import {
  microsoftProviderPaths,
  providerPaths,
} from "../src/shell/provider-authentication/contract";
import { oauthPaths } from "../src/shell/oauth-agents/contract";
import { processingConsentTransport } from "../src/shell/processing-consent/runtime";
import { connectionBrowserTransport } from "../src/shell/connections/runtime";
import {
  pricePublicationPath,
  refundSupportBasePath,
  refundSupportReadPath,
} from "./subscription/contract";
import { deriveAnonymousSource } from "./anonymous-admission/operations";
import { keywordRulePath, listCategoriesPath } from "../src/shell/categories/contract";
import { atomicBatchOperation } from "../src/shell/operations/contract";
import { emailReplacementOperations } from "../src/shell/email-authentication/operations";
import { statementStagingPath } from "../src/shell/ingestion/contract";
import { paymentEnrollmentTransport } from "../src/shell/subscription/runtime";
import {
  transactionMethods,
  ownsTransactionPath as transactionPath,
} from "../src/shell/transactions/runtime";
import { ownsMemoryPath as memoryPath } from "../src/shell/memory/runtime";
import type { TelemetryService } from "../src/shell/observability/contract";

import { encodeTraceParent } from "../src/shell/observability/operations";
import {
  type WorkerTelemetryEnvironment,
  workerInternalTraceHeader,
} from "./runtime/telemetry/contract";
import { Cause, Effect, Option } from "effect";
import { cloudflareWorkerTelemetry, observeWorkerRequest } from "./runtime/telemetry/operations";
import { browserOrigins, productionTopology } from "./runtime/contract";
import { patBrowserRoute, patDirectRoute, patMethods, patRoute } from "./tokens/operations";
import { canonicalMethods, canonicalOperation, canonicalRoute } from "./routing/operations";
import { bancolombiaSandboxResponse } from "./bancolombia-sandbox/operations";
import { connectionCallbackPath } from "./connections/contract";

type PublicEnvironment = WorkerTelemetryEnvironment & {
  readonly BROWSER_ORIGIN: string;
  readonly CORE: Pick<Fetcher, "fetch">;
  readonly LOCAL_CANONICAL_READ_BEARER: string;
  readonly PAT_ADMISSION_KEY: string;
};

type PublicWorker = Readonly<{
  fetch: (request: Request, environment: PublicEnvironment) => Promise<Response>;
}>;

const apiSecurityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-site",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "DENY",
} as const;

const resolveBrowserOrigin = (configuredOrigin: string): Option.Option<string> => {
  if (configuredOrigin === browserOrigins.local) return Option.some(browserOrigins.local);

  if (configuredOrigin === browserOrigins.acceptance) return Option.some(browserOrigins.acceptance);

  if (configuredOrigin === browserOrigins.production) return Option.some(browserOrigins.production);

  return Option.none();
};

const appendVary = (headers: Headers, field: string): void => {
  const fields = (headers.get("vary") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (!fields.some((value) => value.toLowerCase() === field.toLowerCase())) fields.push(field);
  headers.set("vary", fields.join(", "));
};

const applyApiPolicy = (
  response: Response,
  browserOrigin: string,
  origin: Option.Option<string>
): Response => {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(apiSecurityHeaders)) headers.set(name, value);
  appendVary(headers, "Origin");
  headers.set(
    "access-control-expose-headers",
    `Server-Timing, Fidy-Canonical-Allowance, Fidy-Canonical-Limit, Fidy-Canonical-Remaining, Fidy-Canonical-Reset, Retry-After, ${telemetryTraceHeader}`
  );

  if (Option.contains(origin, browserOrigin)) {
    headers.set("access-control-allow-credentials", "true");
    headers.set("access-control-allow-origin", browserOrigin);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const unauthenticated = (): Response =>
  Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    {
      headers: { "www-authenticate": "Bearer" },
      status: 401,
    }
  );

const forbiddenOrigin = (): Response =>
  Response.json({ status: "forbidden_origin" }, { status: 403 });

const serviceUnavailableStatus = 503;

const unavailable = (): Response =>
  Response.json({ status: "unavailable" }, { status: serviceUnavailableStatus });

const isAllowedPreflightHeaders = (value: Option.Option<string>): boolean =>
  Option.isNone(value) ||
  value.value.trim().length === 0 ||
  value.value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .every(
      (header) =>
        header === "authorization" ||
        header === "content-type" ||
        header === "fidy-retry-key" ||
        header === browserSessionBindingHeader.toLowerCase()
    );

const preflightResponse = (request: Request, browserOrigin: string): Response => {
  const requestedMethod = Option.fromNullishOr(
    request.headers.get("access-control-request-method")
  );

  const requestedHeaders = Option.fromNullishOr(
    request.headers.get("access-control-request-headers")
  );

  const path = new URL(request.url).pathname;
  const methods = allowedMethods(path);

  if (
    !Option.exists(requestedMethod, (method) => methods.includes(method)) ||
    !isAllowedPreflightHeaders(requestedHeaders)
  ) {
    return forbiddenOrigin();
  }

  const headers = new Headers({
    "access-control-allow-headers": Option.match(requestedHeaders, {
      onNone: () => "",
      onSome: (value) => value.toLowerCase(),
    }),
    "access-control-allow-methods": methods.join(", "),
    "access-control-max-age": "600",
  });

  return applyApiPolicy(
    new Response(null, { headers, status: 204 }),
    browserOrigin,
    Option.some(browserOrigin)
  );
};

const categoryAuthorizationFailure = (
  request: Request,
  environment: PublicEnvironment
): Option.Option<Response> => {
  if (new URL(request.url).pathname !== listCategoriesPath) return Option.none();

  if (
    request.headers.has("cookie") &&
    request.headers.get("origin") === environment.BROWSER_ORIGIN
  ) {
    return Option.none();
  }

  if (request.headers.get("authorization")?.startsWith("Bearer ") === true) {
    return Option.none();
  }

  return Option.some(unauthenticated());
};

const callbackPath = "/providers/kapso/callback";

const wompiBillingEventPath = "/providers/wompi/billing-events";

const pairingPaths = ["/web/pairings", "/web/pairings/redeem", "/web/session/logout"] as const;

const userPath = "/user";

const hostedBrowserPaths = new Set<string>([
  "/web/hosted-turns",
  "/web/hosted-turns/delivery",
  "/web/hosted-turns/progress",
]);

const enrollmentPath = (path: string): boolean => Option.isSome(paymentEnrollmentTransport(path));

const rotateRecoveryPath = "/recovery/backup-code/rotate";

const replacementPaths = [
  emailReplacementOperations.request.path,
  emailReplacementOperations.complete.path,
] as const;

const sampleReviewPath = "/internal/sample-review";

const erasureSupportPath = "/internal/titular-erasure";

const supportRecoveryPath = "/internal/support-recovery";

const refundMethods = (path: string): ReadonlyArray<string> =>
  path === refundSupportBasePath ? ["POST"] : ["GET"];

const refundSupportPath = (path: string): boolean =>
  path === refundSupportBasePath || refundSupportReadPath.test(path);

const emailAuthenticationPaths = [
  "/web/email/authentication/start",
  "/web/email/authentication/complete",
] as const;

const postPaths = new Set<string>([
  callbackPath,
  wompiBillingEventPath,
  rotateRecoveryPath,
  ...replacementPaths,
  supportRecoveryPath,
  erasureSupportPath,
  sampleReviewPath,
  betaProPath,
  pricePublicationPath,
  "/web/privacy/erasure",
  microsoftProviderPaths.start,
  microsoftProviderPaths.status,
  microsoftProviderPaths.complete,
  providerPaths.start,
  providerPaths.status,
  providerPaths.complete,
  ...emailAuthenticationPaths,
  ...pairingPaths,
  statementStagingPath,
  ...hostedBrowserPaths,
]);

const browserMutationPaths = new Set<string>([
  rotateRecoveryPath,
  ...replacementPaths,
  microsoftProviderPaths.start,
  microsoftProviderPaths.status,
  microsoftProviderPaths.complete,
  providerPaths.start,
  providerPaths.status,
  providerPaths.complete,
  ...emailAuthenticationPaths,
  ...pairingPaths,
  statementStagingPath,
  ...hostedBrowserPaths,
]);

const sessionPaths = new Set<string>([
  userPath,
  browserSessionBindingPath,
  ...browserMutationPaths,
]);

const preflightPaths = new Set<string>([
  browserSessionBindingPath,
  providerPaths.disclosure,
  listCategoriesPath,
  userPath,
  ...browserMutationPaths,
]);

const ownedPaths = new Set<string>([
  connectionCallbackPath,
  browserSessionBindingPath,
  providerPaths.disclosure,
  microsoftProviderPaths.callback,
  providerPaths.callback,
  "/health",
  listCategoriesPath,
  userPath,
  ...postPaths,
]);

const oauthPath = (path: string): boolean =>
  Object.values(oauthPaths).some((owned) => owned === path);

const dedicatedBrowserPath = (path: string): boolean =>
  Option.isSome(connectionBrowserTransport(path)) ||
  Option.isSome(processingConsentTransport(path));

const ownedPath = (path: string): boolean =>
  dedicatedBrowserPath(path) ||
  oauthPath(path) ||
  ownedPaths.has(path) ||
  refundSupportPath(path) ||
  enrollmentPath(path) ||
  transactionPath(path) ||
  patRoute(path) ||
  canonicalRoute(path);

const oauthMethods = (path: string): ReadonlyArray<string> => {
  if (path === oauthPaths.mcp) return ["GET", "POST"];

  return [
    oauthPaths.register,
    oauthPaths.token,
    oauthPaths.cancel,
    oauthPaths.connect,
    oauthPaths.revoke,
    oauthPaths.revokeAll,
  ].some((owned) => owned === path)
    ? ["POST"]
    : ["GET"];
};

const specialMethods = (path: string): Option.Option<ReadonlyArray<string>> => {
  const browserTransport = connectionBrowserTransport(path).pipe(
    Option.orElse(() => processingConsentTransport(path))
  );

  if (Option.isSome(browserTransport)) return Option.some([browserTransport.value.method]);

  if (oauthPath(path)) return Option.some(oauthMethods(path));

  if (refundSupportPath(path)) return Option.some(refundMethods(path));

  return paymentEnrollmentTransport(path).pipe(Option.map((transport) => [transport.method]));
};

const allowedMethods = (path: string): ReadonlyArray<string> => {
  const special = specialMethods(path);

  if (Option.isSome(special)) return special.value;

  if (transactionPath(path)) return transactionMethods(path);

  if (patRoute(path)) return patMethods(path);

  if (ownedPaths.has(path)) return [postPaths.has(path) ? "POST" : "GET"];

  return canonicalMethods(path);
};

const callbackHeaders = (request: Request): Headers =>
  new Headers([
    ["x-webhook-signature", request.headers.get("x-webhook-signature") ?? ""],
    ["x-webhook-event", request.headers.get("x-webhook-event") ?? ""],
    ["x-idempotency-key", request.headers.get("x-idempotency-key") ?? ""],
  ]);

const wompiEventHeaders = (request: Request): Headers => {
  const headers = new Headers({ "content-type": request.headers.get("content-type") ?? "" });
  const checksum = request.headers.get("x-event-checksum");

  if (checksum !== null) headers.set("x-event-checksum", checksum);

  return headers;
};

const providerHeaders = (request: Request, path: string): Headers =>
  path === callbackPath ? callbackHeaders(request) : wompiEventHeaders(request);

const cookieForwardPaths = new Set<string>([
  "/web/session/logout",
  rotateRecoveryPath,
  statementStagingPath,
  ...hostedBrowserPaths,
]);

const browserHeaders = (request: Request, path: string): Headers => {
  const headers = new Headers({ "content-type": request.headers.get("content-type") ?? "" });

  if (
    cookieForwardPaths.has(path) ||
    replacementPaths.some((owned) => owned === path) ||
    patBrowserRoute(path)
  ) {
    headers.set("cookie", request.headers.get("cookie") ?? "");
  }

  return headers;
};

const supportHeaders = (request: Request): Headers =>
  new Headers({
    "content-type": request.headers.get("content-type") ?? "",
    "cf-access-jwt-assertion": request.headers.get("cf-access-jwt-assertion") ?? "",
  });

const forwardsSession = (request: Request, path: string): boolean =>
  path === browserSessionBindingPath ||
  path === userPath ||
  hostedBrowserPaths.has(path) ||
  transactionPath(path) ||
  memoryPath(path) ||
  (path === listCategoriesPath && request.headers.has("cookie"));

const credentialPath = (path: string): boolean =>
  path === userPath || transactionPath(path) || memoryPath(path);

const credentialBearerHeaders = (request: Request, path: string): Option.Option<Headers> =>
  credentialPath(path) && !request.headers.has("cookie") && request.headers.has("authorization")
    ? Option.some(
        new Headers({
          authorization: request.headers.get("authorization") ?? "",
          "content-type": request.headers.get("content-type") ?? "",
        })
      )
    : Option.none();

const directHeaders = (request: Request, path: string): Option.Option<Headers> => {
  if (patDirectRoute(path)) {
    return Option.some(new Headers({ "content-type": request.headers.get("content-type") ?? "" }));
  }

  if (patBrowserRoute(path)) return Option.some(browserHeaders(request, path));

  if (path === callbackPath || path === wompiBillingEventPath) {
    return Option.some(providerHeaders(request, path));
  }

  if (
    [
      supportRecoveryPath,
      erasureSupportPath,
      pricePublicationPath,
      sampleReviewPath,
      betaProPath,
    ].includes(path) ||
    refundSupportPath(path)
  ) {
    return Option.some(supportHeaders(request));
  }

  return Option.none();
};

const fallbackHeaders = (request: Request, path: string): Headers => {
  if (forwardsSession(request, path)) {
    const headers = new Headers({
      cookie: request.headers.get("cookie") ?? "",
      "content-type": request.headers.get("content-type") ?? "",
    });

    if (path === browserSessionBindingPath) {
      headers.set("origin", request.headers.get("origin") ?? "");
      const binding = request.headers.get(browserSessionBindingHeader);

      if (binding !== null) headers.set(browserSessionBindingHeader, binding);
    }

    return headers;
  }

  return new Headers(request.headers);
};

const oauthHeaders = (request: Request, path: string): Headers => {
  const headers = new Headers({ "content-type": request.headers.get("content-type") ?? "" });

  if (oauthBrowserPath(path)) {
    headers.set("origin", request.headers.get("origin") ?? "");
    headers.set("cookie", request.headers.get("cookie") ?? "");
  }

  if (path === oauthPaths.mcp) {
    for (const name of [
      "authorization",
      "accept",
      "origin",
      "mcp-protocol-version",
      "mcp-session-id",
      "mcp-method",
      "mcp-name",
    ]) {
      const value = request.headers.get(name);

      if (value !== null) headers.set(name, value);
    }
  }

  return headers;
};

const specialForwardedHeaders = (request: Request, path: string): Option.Option<Headers> => {
  if (path === connectionCallbackPath) {
    return Option.some(new Headers({ cookie: request.headers.get("cookie") ?? "" }));
  }

  const browserTransport = connectionBrowserTransport(path).pipe(
    Option.orElse(() => processingConsentTransport(path))
  );

  if (Option.isSome(browserTransport)) {
    return Option.some(
      new Headers(
        browserTransport.value.forwardedHeaders.map((name) => [
          name,
          request.headers.get(name) ?? "",
        ])
      )
    );
  }

  if (oauthPath(path)) return Option.some(oauthHeaders(request, path));

  return paymentEnrollmentTransport(path).pipe(
    Option.map(
      (transport) =>
        new Headers(
          transport.forwardedHeaders.map((name) => [name, request.headers.get(name) ?? ""])
        )
    )
  );
};

const forwardedHeaders = (request: Request, path: string): Headers => {
  const special = specialForwardedHeaders(request, path);

  if (Option.isSome(special)) return special.value;

  const direct = directHeaders(request, path);

  if (Option.isSome(direct)) return direct.value;
  const bearerHeaders = credentialBearerHeaders(request, path);

  if (Option.isSome(bearerHeaders)) return bearerHeaders.value;

  if (isBrowserMutation(path)) return browserHeaders(request, path);

  return fallbackHeaders(request, path);
};

const canonicalAdmissionHeaders = (
  request: Request,
  environment: PublicEnvironment,
  headers: Headers
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    headers.delete("x-canonical-source");

    if (!canonicalRoute(new URL(request.url).pathname)) return;

    if (request.headers.has("fidy-retry-key")) {
      headers.set("Fidy-Retry-Key", request.headers.get("fidy-retry-key") ?? "");
    }

    if (!request.headers.has("authorization")) return;
    headers.set(
      "x-canonical-source",
      yield* deriveAnonymousSource({
        request,
        browserOrigin: environment.BROWSER_ORIGIN,
        admissionKey: environment.PAT_ADMISSION_KEY,
      })
    );
  });

const preservesCoreQuery = (path: string): boolean =>
  path === browserSessionBindingPath ||
  path === connectionCallbackPath ||
  transactionPath(path) ||
  canonicalRoute(path) ||
  dedicatedBrowserPath(path) ||
  path === providerPaths.callback ||
  path === microsoftProviderPaths.callback;

const patSourcePath = (path: string): boolean =>
  path === "/pat-pairings" || path === "/pat-pairings/claim";

const anonymousSourcePath = (path: string): boolean => patSourcePath(path) || oauthPath(path);

const anonymousSourceHeader = (path: string): string =>
  oauthPath(path) ? "x-oauth-source" : "x-pat-source";

const needsProviderSource = (path: string): boolean =>
  [
    "/web/pairings",
    "/web/pairings/redeem",
    ...Object.values(providerPaths),
    ...Object.values(microsoftProviderPaths),
  ].some((owned) => owned === path);

const coreRequest = (
  request: Request,
  environment: PublicEnvironment
): Effect.Effect<Request, void> =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname;
    const headers = forwardedHeaders(request, path);
    const binding = request.headers.get(browserSessionBindingHeader);

    if (binding !== null) headers.set(browserSessionBindingHeader, binding);
    yield* canonicalAdmissionHeaders(request, environment, headers);
    headers.delete("x-provider-source");

    if (needsProviderSource(path)) {
      headers.set(
        "x-provider-source",
        yield* deriveAnonymousSource({
          request,
          browserOrigin: environment.BROWSER_ORIGIN,
          admissionKey: environment.PAT_ADMISSION_KEY,
        })
      );
    }

    if (anonymousSourcePath(path)) {
      headers.set(
        anonymousSourceHeader(path),
        yield* deriveAnonymousSource({
          request,
          browserOrigin: environment.BROWSER_ORIGIN,
          admissionKey: environment.PAT_ADMISSION_KEY,
        })
      );
    }

    if (oauthPath(path)) {
      return new Request(`https://core.internal${path}${new URL(request.url).search}`, {
        redirect: "manual",
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        duplex: "half",
      });
    }

    return new Request(
      new Request(
        `https://core.internal${path}${preservesCoreQuery(path) ? new URL(request.url).search : ""}`,
        request
      ),
      { headers }
    );
  });

const hasPreflight = (path: string): boolean =>
  dedicatedBrowserPath(path) ||
  oauthBrowserPath(path) ||
  preflightPaths.has(path) ||
  enrollmentPath(path) ||
  transactionPath(path) ||
  patRoute(path) ||
  canonicalRoute(path);

const isBrowserMutation = (path: string): boolean => browserMutationPaths.has(path);

const isPreflight = (request: Request, path: string, origin: Option.Option<string>): boolean =>
  request.method === "OPTIONS" && hasPreflight(path) && Option.isSome(origin);

const disallowedSupportOrigin = (path: string, origin: Option.Option<string>): boolean =>
  Option.isSome(origin) &&
  ([
    supportRecoveryPath,
    erasureSupportPath,
    pricePublicationPath,
    sampleReviewPath,
    betaProPath,
  ].includes(path) ||
    refundSupportPath(path));

const isAllowedMethod = (request: Request, path: string): boolean =>
  allowedMethods(path).includes(request.method);

const atomicBatchPath = (path: string): boolean =>
  Option.exists(
    canonicalOperation({ method: "POST", path }),
    (operation) => operation.id === atomicBatchOperation
  );

const cookieAdmittedPath = (path: string): boolean =>
  transactionPath(path) ||
  atomicBatchPath(path) ||
  memoryPath(path) ||
  path === listCategoriesPath ||
  keywordRulePath(path);

const oauthBrowserPath = (path: string): boolean =>
  [
    oauthPaths.review,
    oauthPaths.cancel,
    oauthPaths.connect,
    oauthPaths.connections,
    oauthPaths.revoke,
    oauthPaths.revokeAll,
  ].some((owned) => owned === path);

const bearerUserRead = (request: Request, path: string): boolean =>
  path === userPath && request.headers.has("authorization") && !request.headers.has("cookie");

const requiresBrowserOrigin = (request: Request, path: string): boolean =>
  dedicatedBrowserPath(path) ||
  oauthBrowserPath(path) ||
  (sessionPaths.has(path) && !bearerUserRead(request, path)) ||
  enrollmentPath(path) ||
  (cookieAdmittedPath(path) && request.headers.has("cookie")) ||
  patBrowserRoute(path);

const mixedConsentCredentials = (request: Request, path: string): boolean =>
  Option.isSome(processingConsentTransport(path)) &&
  request.headers.has("authorization") &&
  request.headers.has("cookie");

const rejectsMcpIngress = (request: Request, browserOrigin: string): boolean => {
  const url = new URL(request.url);

  if (url.pathname !== oauthPaths.mcp) return false;

  if (request.headers.has("origin")) return true;
  let apiOrigin = `https://${productionTopology.ingress.hostname}`;

  if (browserOrigin === browserOrigins.local) {
    apiOrigin = `http://127.0.0.1:${productionTopology.ingress.localPort}`;
  } else if (browserOrigin === browserOrigins.acceptance) {
    apiOrigin = "https://127.0.0.1:4174";
  }

  const host = request.headers.get("host");

  return url.origin !== apiOrigin || (host !== null && host.toLowerCase() !== url.host);
};

const rejectedBrowserProof = (
  request: Request,
  environment: PublicEnvironment,
  origin: Option.Option<string>
): boolean => {
  const path = new URL(request.url).pathname;

  return (
    mixedConsentCredentials(request, path) ||
    (requiresBrowserOrigin(request, path) && !Option.contains(origin, environment.BROWSER_ORIGIN))
  );
};

const gateOwnedRequest = (
  request: Request,
  environment: PublicEnvironment,
  origin: Option.Option<string>
): Option.Option<Response> => {
  const path = new URL(request.url).pathname;

  const policy = (response: Response): Option.Option<Response> =>
    Option.some(applyApiPolicy(response, environment.BROWSER_ORIGIN, origin));

  if (!ownedPath(path)) {
    return policy(Response.json({}, { status: 404 }));
  }

  if (disallowedSupportOrigin(path, origin)) {
    return Option.some(
      applyApiPolicy(forbiddenOrigin(), environment.BROWSER_ORIGIN, Option.none())
    );
  }

  if (isPreflight(request, path, origin)) {
    return Option.some(preflightResponse(request, environment.BROWSER_ORIGIN));
  }

  if (!isAllowedMethod(request, path)) {
    return policy(
      Response.json(
        { status: "method_not_allowed" },
        {
          headers: {
            allow: allowedMethods(path).join(", "),
          },
          status: 405,
        }
      )
    );
  }

  if (rejectedBrowserProof(request, environment, origin)) {
    return policy(forbiddenOrigin());
  }

  return Option.map(categoryAuthorizationFailure(request, environment), (response) =>
    applyApiPolicy(response, environment.BROWSER_ORIGIN, origin)
  );
};

const hasMixedQueryCredentials = (request: Request): boolean =>
  request.method === "GET" &&
  request.headers.has("authorization") &&
  request.headers.has("cookie") &&
  canonicalRoute(new URL(request.url).pathname);

type OwnedRouting = {
  origin: Option.Option<string>;
  telemetry: TelemetryService;
};

const routeOwnedRequest = (
  request: Request,
  environment: PublicEnvironment,
  { origin, telemetry }: OwnedRouting
): Effect.Effect<Response> => {
  if (hasMixedQueryCredentials(request)) {
    return Effect.succeed(applyApiPolicy(unauthenticated(), environment.BROWSER_ORIGIN, origin));
  }

  if (rejectsMcpIngress(request, environment.BROWSER_ORIGIN)) {
    return Effect.succeed(
      applyApiPolicy(
        Response.json({ status: "forbidden" }, { status: 403 }),
        environment.BROWSER_ORIGIN,
        origin
      )
    );
  }

  const rejection = gateOwnedRequest(request, environment, origin);

  if (Option.isSome(rejection)) {
    return Effect.succeed(rejection.value);
  }

  return Effect.gen(function* () {
    const forwarded = yield* coreRequest(request, environment);
    forwarded.headers.delete(workerInternalTraceHeader);
    const trace = yield* telemetry.captureDurableContext;

    if (Option.isSome(trace)) {
      forwarded.headers.set(workerInternalTraceHeader, encodeTraceParent(trace.value));
    }

    return yield* Effect.tryPromise({
      try: (signal) =>
        environment.CORE.fetch(forwarded, { signal: AbortSignal.any([request.signal, signal]) }),
      catch: () => undefined,
    });
  }).pipe(
    Effect.match({
      onFailure: unavailable,
      onSuccess: (response) => response,
    }),
    Effect.map((response) =>
      applyApiPolicy(
        new URL(request.url).pathname === connectionCallbackPath && request.method === "GET"
          ? new Response(null, {
              status: 303,
              headers: {
                location: `${environment.BROWSER_ORIGIN}/connections/result`,
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
              },
            })
          : response,
        environment.BROWSER_ORIGIN,
        origin
      )
    )
  );
};

const fetchEffect = (
  request: Request,
  environment: PublicEnvironment,
  telemetry: TelemetryService
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.signal.aborted) return yield* Effect.interrupt;
    const browserOrigin = resolveBrowserOrigin(environment.BROWSER_ORIGIN);

    if (Option.isNone(browserOrigin)) {
      return applyApiPolicy(unavailable(), browserOrigins.production, Option.none());
    }

    const origin = Option.fromNullishOr(request.headers.get("origin"));

    if (Option.exists(origin, (value) => value !== browserOrigin.value)) {
      return applyApiPolicy(forbiddenOrigin(), browserOrigin.value, origin);
    }

    const distributionResponse = yield* cliDistributionResponse(request);

    if (Option.isSome(distributionResponse)) {
      return applyApiPolicy(distributionResponse.value, browserOrigin.value, origin);
    }

    const sandboxResponse = bancolombiaSandboxResponse(request);

    if (Option.isSome(sandboxResponse)) {
      return applyApiPolicy(sandboxResponse.value, browserOrigin.value, origin);
    }

    return yield* routeOwnedRequest(
      request,
      { ...environment, BROWSER_ORIGIN: browserOrigin.value },
      { origin, telemetry }
    );
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      () => Effect.succeed(applyApiPolicy(unavailable(), browserOrigins.production, Option.none()))
    )
  );

export const makePublicWorker = (telemetry: TelemetryService): PublicWorker => ({
  fetch: (request, environment) =>
    Effect.runPromise(
      fetchEffect(request, environment, telemetry).pipe(
        Effect.flatMap((response) =>
          Effect.map(telemetry.captureDurableContext, (trace) => {
            const headers = new Headers(response.headers);
            headers.delete(telemetryTraceHeader);

            if (Option.isSome(trace)) headers.set(telemetryTraceHeader, trace.value.traceId);

            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          })
        ),
        observeWorkerRequest({
          environment,
          telemetry,
          operation: "worker.public.fetch",
        })
      ),
      { signal: request.signal }
    ),
});

export default makePublicWorker(cloudflareWorkerTelemetry);
