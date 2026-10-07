import { oauthPaths } from "../src/shell/oauth-agents/contract";
import { refundSupportBasePath, refundSupportReadPath } from "./subscription/contract";
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
import { Cause, Effect, Option, Schema } from "effect";
import { type WorkerTelemetryEnvironment } from "./runtime/telemetry/contract";
import { cloudflareWorkerTelemetry, observeWorkerRequest } from "./runtime/telemetry/operations";
import { browserOrigins } from "./runtime/contract";
import {
  SmokeFailureStage,
  SmokeIdentity,
  SmokeIdentityEquality,
  SmokeResponse,
  smokeCoreVersionHeader,
  smokeFailureHeader,
  smokeIdentityHeader,
  smokeManifest,
  smokePath,
  smokeProofHeader,
  smokeVersionHeader,
} from "./runtime/release-smoke/contract";
import { smokeProofAccepted } from "./runtime/release-smoke/operations";
import { patBrowserRoute, patDirectRoute, patMethods, patRoute } from "./tokens/operations";
import { canonicalMethods, canonicalOperation, canonicalRoute } from "./routing/operations";

type PublicEnvironment = WorkerTelemetryEnvironment & {
  readonly BROWSER_ORIGIN: string;
  readonly CORE: Pick<Fetcher, "fetch">;
  readonly LOCAL_CANONICAL_READ_BEARER: string;
  readonly PAT_ADMISSION_KEY: string;
} & Partial<
    Readonly<{
      SMOKE_PROOF: string;
      CONTRACT_DIGEST: string;
      CF_VERSION_METADATA: { readonly id: string };
    }>
  >;

type PublicWorker = Readonly<{
  fetch: (request: Request, environment: PublicEnvironment) => Promise<Response>;
}>;

const apiSecurityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-site",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
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
    "Fidy-Canonical-Allowance, Fidy-Canonical-Limit, Fidy-Canonical-Remaining, Fidy-Canonical-Reset, Retry-After"
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

const smokeUnavailable = (
  request: Request,
  environment: PublicEnvironment,
  stage: SmokeFailureStage
): Response => {
  const response = unavailable();
  if (
    new URL(request.url).pathname !== smokePath ||
    !smokeProofAccepted({ request, secret: environment.SMOKE_PROOF ?? "" })
  ) {
    return response;
  }
  response.headers.set(smokeFailureHeader, stage);
  return response;
};

const isAllowedPreflightHeaders = (value: Option.Option<string>): boolean =>
  Option.isNone(value) ||
  value.value.trim().length === 0 ||
  value.value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .every(
      (header) =>
        header === "authorization" || header === "content-type" || header === "fidy-retry-key"
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
  if (
    request.headers.get("authorization")?.startsWith("Bearer ") === true ||
    (environment.LOCAL_CANONICAL_READ_BEARER.length > 0 &&
      request.headers.get("authorization") === `Bearer ${environment.LOCAL_CANONICAL_READ_BEARER}`)
  ) {
    return Option.none();
  }
  return Option.some(unauthenticated());
};

const callbackPath = "/providers/kapso/callback";
const wompiBillingEventPath = "/providers/wompi/billing-events";
const verificationPath = "/web/onboarding/email/verify";
const pairingPaths = ["/web/pairings", "/web/pairings/redeem", "/web/session/logout"] as const;
const userPath = "/user";
const hostedTurnPath = "/web/hosted-turns";
const hostedReceiptPath = "/web/hosted-turns/delivery";
const enrollmentPath = (path: string): boolean => Option.isSome(paymentEnrollmentTransport(path));
const rotateRecoveryPath = "/recovery/backup-code/rotate";
const replacementPaths = [
  emailReplacementOperations.request.path,
  emailReplacementOperations.complete.path,
] as const;
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
  verificationPath,
  rotateRecoveryPath,
  ...replacementPaths,
  supportRecoveryPath,
  ...emailAuthenticationPaths,
  ...pairingPaths,
  statementStagingPath,
  smokePath,
  hostedTurnPath,
  hostedReceiptPath,
]);
const browserMutationPaths = new Set<string>([
  rotateRecoveryPath,
  ...replacementPaths,
  ...emailAuthenticationPaths,
  ...pairingPaths,
  statementStagingPath,
  hostedTurnPath,
  hostedReceiptPath,
]);
const sessionPaths = new Set<string>([userPath, ...browserMutationPaths]);
const preflightPaths = new Set<string>([
  listCategoriesPath,
  verificationPath,
  userPath,
  ...browserMutationPaths,
]);
const ownedPaths = new Set<string>(["/health", listCategoriesPath, userPath, ...postPaths]);
const oauthPath = (path: string): boolean =>
  Object.values(oauthPaths).some((owned) => owned === path);
const ownedPath = (path: string): boolean =>
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
  if (oauthPath(path)) return Option.some(oauthMethods(path));
  if (refundSupportPath(path)) return Option.some(refundMethods(path));
  return paymentEnrollmentTransport(path).pipe(Option.map((transport) => [transport.method]));
};
const allowedMethods = (path: string): ReadonlyArray<string> => {
  const special = specialMethods(path);
  if (Option.isSome(special)) return special.value;
  if (transactionPath(path)) return transactionMethods(path);
  if (patRoute(path)) return patMethods(path);
  if (path === smokePath) return ["GET", "POST"];
  if (ownedPaths.has(path)) return [postPaths.has(path) ? "POST" : "GET"];
  return canonicalMethods(path);
};
const callbackHeaders = (request: Request): Headers =>
  new Headers([
    ["x-webhook-signature", request.headers.get("x-webhook-signature") ?? ""],
    ["x-webhook-event", request.headers.get("x-webhook-event") ?? ""],
    ["x-idempotency-key", request.headers.get("x-idempotency-key") ?? ""],
  ]);
const wompiEventHeaders = (request: Request): Headers =>
  new Headers({
    "content-type": request.headers.get("content-type") ?? "",
    "x-event-checksum": request.headers.get("x-event-checksum") ?? "",
  });
const providerHeaders = (request: Request, path: string): Headers =>
  path === callbackPath ? callbackHeaders(request) : wompiEventHeaders(request);
const cookieForwardPaths = new Set<string>([
  "/web/session/logout",
  rotateRecoveryPath,
  statementStagingPath,
  hostedTurnPath,
  hostedReceiptPath,
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
  path === userPath ||
  path === hostedTurnPath ||
  path === hostedReceiptPath ||
  transactionPath(path) ||
  memoryPath(path) ||
  (path === listCategoriesPath && request.headers.has("cookie"));

/** Declared canonical paths that accept either the browser cookie or a PAT bearer. */
const credentialPath = (path: string): boolean => transactionPath(path) || memoryPath(path);
const credentialBearerHeaders = (request: Request, path: string): Option.Option<Headers> =>
  credentialPath(path) && !request.headers.has("cookie") && request.headers.has("authorization")
    ? Option.some(
        new Headers({
          authorization: request.headers.get("authorization") ?? "",
          "content-type": request.headers.get("content-type") ?? "",
        })
      )
    : Option.none();
const browserForwardPath = (path: string): boolean =>
  path === verificationPath || isBrowserMutation(path);
const directHeaders = (request: Request, path: string): Option.Option<Headers> => {
  if (patDirectRoute(path)) {
    return Option.some(new Headers({ "content-type": request.headers.get("content-type") ?? "" }));
  }
  if (patBrowserRoute(path)) return Option.some(browserHeaders(request, path));
  if (path === callbackPath || path === wompiBillingEventPath) {
    return Option.some(providerHeaders(request, path));
  }
  if (path === supportRecoveryPath || refundSupportPath(path)) {
    return Option.some(supportHeaders(request));
  }
  return Option.none();
};

const fallbackHeaders = (request: Request, path: string): Headers => {
  if (forwardsSession(request, path)) {
    return new Headers({
      cookie: request.headers.get("cookie") ?? "",
      "content-type": request.headers.get("content-type") ?? "",
    });
  }
  const headers = new Headers(request.headers);
  headers.delete(smokeProofHeader);
  return headers;
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
  if (path === smokePath) {
    return new Headers({
      [smokeProofHeader]: request.headers.get(smokeProofHeader) ?? "",
      [smokeVersionHeader]: request.headers.get(smokeVersionHeader) ?? "",
      "content-type": "application/json",
    });
  }
  const direct = directHeaders(request, path);
  if (Option.isSome(direct)) return direct.value;
  const bearerHeaders = credentialBearerHeaders(request, path);
  if (Option.isSome(bearerHeaders)) return bearerHeaders.value;
  if (browserForwardPath(path)) return browserHeaders(request, path);
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
const coreRequest = (
  request: Request,
  environment: PublicEnvironment
): Effect.Effect<Request, void> =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname;
    const headers = forwardedHeaders(request, path);
    yield* canonicalAdmissionHeaders(request, environment, headers);
    if (path === "/pat-pairings" || oauthPath(path)) {
      headers.set(
        oauthPath(path) ? "x-oauth-source" : "x-pat-source",
        yield* deriveAnonymousSource({
          request,
          browserOrigin: environment.BROWSER_ORIGIN,
          admissionKey: environment.PAT_ADMISSION_KEY,
        })
      );
    }
    if (oauthPath(path)) {
      // Transfer this body directly: cloning an unfinished stream would leave an unread tee branch
      // and prevent Core's bounded-body cancellation from closing the ingress source.
      return new Request(`https://core.internal${path}${new URL(request.url).search}`, {
        redirect: "manual",
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        duplex: "half",
      });
    }
    // Clone the streamed request before replacing its URL and admitted headers.
    // Rebuilding a Request from the raw body requires runtime-specific duplex options.
    return new Request(
      new Request(
        `https://core.internal${path}${transactionPath(path) || canonicalRoute(path) || path === smokePath ? new URL(request.url).search : ""}`,
        request
      ),
      { headers }
    );
  });

const hasPreflight = (path: string): boolean =>
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
  path === supportRecoveryPath && Option.isSome(origin);

const isAllowedMethod = (request: Request, path: string): boolean =>
  allowedMethods(path).includes(request.method);
/** The cookie-admitted atomic-batch route, recognized through the canonical catalog. */
const atomicBatchPath = (path: string): boolean =>
  Option.exists(
    canonicalOperation({ method: "POST", path }),
    (operation) => operation.id === atomicBatchOperation
  );
/** Declared paths that may be admitted by the browser session cookie instead of a PAT. */
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
const requiresBrowserOrigin = (request: Request, path: string): boolean =>
  oauthBrowserPath(path) ||
  sessionPaths.has(path) ||
  enrollmentPath(path) ||
  (cookieAdmittedPath(path) && request.headers.has("cookie")) ||
  patBrowserRoute(path);

const rejectsSmokeIngress = (
  request: Request,
  origin: Option.Option<string>,
  environment: PublicEnvironment
): boolean =>
  new URL(request.url).pathname === smokePath &&
  (Option.isSome(origin) ||
    !smokeProofAccepted({ request, secret: environment.SMOKE_PROOF ?? "" }));

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
  if (rejectsSmokeIngress(request, origin, environment)) {
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
  if (
    requiresBrowserOrigin(request, path) &&
    !Option.contains(origin, environment.BROWSER_ORIGIN)
  ) {
    return policy(forbiddenOrigin());
  }
  return Option.map(categoryAuthorizationFailure(request, environment), (response) =>
    applyApiPolicy(response, environment.BROWSER_ORIGIN, origin)
  );
};

const coreSmokeFailure = (
  request: Request,
  environment: PublicEnvironment,
  response: Response
): Response => {
  const stage = Schema.decodeUnknownOption(SmokeFailureStage)(
    response.headers.get(smokeFailureHeader)
  );
  const unavailableResponse = smokeUnavailable(
    request,
    environment,
    Option.getOrElse(stage, () => "core_response")
  );
  const equality = Schema.decodeUnknownOption(SmokeIdentityEquality)(
    response.headers.get(smokeIdentityHeader)
  );
  if (Option.contains(stage, "identity") && Option.isSome(equality)) {
    unavailableResponse.headers.set(smokeIdentityHeader, equality.value);
  }
  const version = Schema.decodeUnknownOption(SmokeIdentity.fields.workerVersionId)(
    response.headers.get(smokeCoreVersionHeader)
  );
  if (Option.contains(stage, "identity") && Option.isSome(version)) {
    unavailableResponse.headers.set(smokeCoreVersionHeader, version.value);
  }
  return unavailableResponse;
};

const routeOwnedRequest = (
  request: Request,
  environment: PublicEnvironment,
  origin: Option.Option<string>
): Effect.Effect<Response> => {
  const rejection = gateOwnedRequest(request, environment, origin);
  if (Option.isSome(rejection)) {
    return Effect.succeed(rejection.value);
  }
  return Effect.gen(function* () {
    const forwarded = yield* coreRequest(request, environment);
    const response = yield* Effect.tryPromise({
      try: (signal) => environment.CORE.fetch(forwarded, { signal }),
      catch: () => undefined,
    });
    if (new URL(request.url).pathname !== smokePath) return response;
    if (response.status === serviceUnavailableStatus) {
      return coreSmokeFailure(request, environment, response);
    }
    if (!response.ok) return response;
    const version = environment.CF_VERSION_METADATA?.id;
    if (version === undefined || environment.CONTRACT_DIGEST === undefined) {
      return smokeUnavailable(request, environment, "configuration");
    }
    const decoded = yield* Effect.tryPromise({
      try: () => response.json().then(Schema.decodeUnknownOption(SmokeResponse)),
      catch: () => undefined,
    });
    if (Option.isNone(decoded)) {
      return smokeUnavailable(request, environment, "public_response");
    }
    return Response.json(
      {
        ...decoded.value,
        manifest: smokeManifest,
        public: {
          workerVersionId: version,
          gitRevision: environment.RELEASE_GIT_SHA,
          contractDigest: environment.CONTRACT_DIGEST,
        },
      },
      { status: response.status }
    );
  }).pipe(
    Effect.match({
      onFailure: () => smokeUnavailable(request, environment, "public_forwarding"),
      onSuccess: (response) => response,
    }),
    Effect.map((response) => applyApiPolicy(response, environment.BROWSER_ORIGIN, origin))
  );
};

const fetchEffect = (request: Request, environment: PublicEnvironment): Effect.Effect<Response> =>
  Effect.gen(function* () {
    // The pinned runner evaluates synchronously before registering its external abort signal.
    if (request.signal.aborted) return yield* Effect.interrupt;
    const browserOrigin = resolveBrowserOrigin(environment.BROWSER_ORIGIN);
    if (Option.isNone(browserOrigin)) {
      return applyApiPolicy(
        smokeUnavailable(request, environment, "configuration"),
        browserOrigins.production,
        Option.none()
      );
    }
    const origin = Option.fromNullishOr(request.headers.get("origin"));
    if (Option.exists(origin, (value) => value !== browserOrigin.value)) {
      return applyApiPolicy(forbiddenOrigin(), browserOrigin.value, origin);
    }
    return yield* routeOwnedRequest(
      request,
      { ...environment, BROWSER_ORIGIN: browserOrigin.value },
      origin
    );
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      () =>
        Effect.succeed(
          applyApiPolicy(
            smokeUnavailable(request, environment, "public_forwarding"),
            browserOrigins.production,
            Option.none()
          )
        )
    ),
    Effect.map((response) => {
      if (!smokeProofAccepted({ request, secret: environment.SMOKE_PROOF ?? "" })) return response;
      const version = environment.CF_VERSION_METADATA?.id;
      if (version === undefined) return response;
      const headers = new Headers(response.headers);
      headers.set("x-fidy-smoke-worker-version", version);
      return new Response(response.body, { status: response.status, headers });
    })
  );

/** Builds the internet-facing ingress with one telemetry service for each request Work span. */
export const makePublicWorker = (telemetry: TelemetryService): PublicWorker => ({
  fetch: (request, environment) =>
    Effect.runPromise(
      fetchEffect(request, environment).pipe(
        observeWorkerRequest({
          environment,
          telemetry,
          operation: "worker.public.fetch",
        })
      ),
      { signal: request.signal }
    ),
});

/**
 * Internet-facing ingress for published API routes. Originless machine callers remain eligible;
 * browser requests and Categories preflight must use `BROWSER_ORIGIN`. Every response is no-store,
 * receives the API security projection, and is observed once. Unknown routes, methods, origins,
 * credentials, and Core failures produce bounded responses; accepted requests are delegated once.
 */
export default makePublicWorker(cloudflareWorkerTelemetry);
