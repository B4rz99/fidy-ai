import { keywordRulePath, listCategoriesPath } from "@fidy/server/categories-path";
import { atomicBatchOperation } from "@fidy/server/canonical-runtime";
import { emailReplacementOperations } from "@fidy/server/email-replacement";
import { statementStagingPath } from "@fidy/server/statement-path";
import {
  transactionMethods,
  ownsTransactionPath as transactionPath,
} from "@fidy/server/transaction-routes";
import { ownsMemoryPath as memoryPath } from "@fidy/server/memory-routes";
import type { TelemetryService } from "@fidy/server/telemetry";
import { Effect, Encoding, Option } from "effect";
import {
  type WorkerTelemetryEnvironment,
  cloudflareWorkerTelemetry,
  observeWorkerRequest,
} from "./runtime/telemetry";
import { browserOrigins } from "./runtime/topology";
import { patBrowserRoute, patDirectRoute, patMethods, patRoute } from "./pats/pat-routes";
import { canonicalMethods, canonicalOperation, canonicalRoute } from "./routing/canonical-routes";

const minimumAdmissionKeyLength = 32;
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
  "x-frame-options": "DENY",
} as const;

const resolveBrowserOrigin = (configuredOrigin: string): Option.Option<string> => {
  if (configuredOrigin === browserOrigins.local) return Option.some(browserOrigins.local);
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

const unavailable = (): Response => Response.json({ status: "unavailable" }, { status: 503 });

const isAllowedPreflightHeaders = (value: Option.Option<string>): boolean =>
  Option.isNone(value) ||
  value.value.trim().length === 0 ||
  value.value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .every((header) => header === "authorization" || header === "content-type");

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
const enrollmentPreparePath = "/web/subscription/card-enrollments/prepare";
const enrollmentSubmitPath = "/web/subscription/card-enrollments/submit";
const enrollmentStatusPath =
  /^\/web\/subscription\/(?:card-enrollments|billing-attempts)\/[0-9a-f-]{36}$/u;
const enrollmentPath = (path: string): boolean =>
  path === enrollmentPreparePath ||
  path === enrollmentSubmitPath ||
  enrollmentStatusPath.test(path);
const rotateRecoveryPath = "/recovery/backup-code/rotate";
const replacementPaths = [
  emailReplacementOperations.request.path,
  emailReplacementOperations.complete.path,
] as const;
const supportRecoveryPath = "/internal/support-recovery";
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
  enrollmentPreparePath,
  enrollmentSubmitPath,
  statementStagingPath,
  hostedTurnPath,
]);
const browserMutationPaths = new Set<string>([
  rotateRecoveryPath,
  ...replacementPaths,
  ...emailAuthenticationPaths,
  ...pairingPaths,
  statementStagingPath,
  hostedTurnPath,
]);
const sessionPaths = new Set<string>([userPath, ...browserMutationPaths]);
const preflightPaths = new Set<string>([
  listCategoriesPath,
  verificationPath,
  userPath,
  ...browserMutationPaths,
]);
const ownedPaths = new Set<string>(["/health", listCategoriesPath, userPath, ...postPaths]);
const ownedPath = (path: string): boolean =>
  ownedPaths.has(path) ||
  enrollmentPath(path) ||
  transactionPath(path) ||
  patRoute(path) ||
  canonicalRoute(path);
const allowedMethods = (path: string): ReadonlyArray<string> => {
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
]);

const browserHeaders = (request: Request, path: string): Headers => {
  const headers = new Headers({ "content-type": request.headers.get("content-type") ?? "" });
  if (
    cookieForwardPaths.has(path) ||
    replacementPaths.some((owned) => owned === path) ||
    patBrowserRoute(path) ||
    enrollmentPath(path)
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
  path === verificationPath || isBrowserMutation(path) || enrollmentPath(path);
const directHeaders = (request: Request, path: string): Option.Option<Headers> => {
  if (patDirectRoute(path)) {
    return Option.some(new Headers({ "content-type": request.headers.get("content-type") ?? "" }));
  }
  if (patBrowserRoute(path)) return Option.some(browserHeaders(request, path));
  if (path === callbackPath || path === wompiBillingEventPath) {
    return Option.some(providerHeaders(request, path));
  }
  if (path === supportRecoveryPath) return Option.some(supportHeaders(request));
  return Option.none();
};
const browserForwardHeaders = (request: Request, path: string): Headers => {
  const headers = browserHeaders(request, path);
  if (enrollmentPath(path)) headers.set("origin", request.headers.get("origin") ?? "");
  return headers;
};
const forwardedHeaders = (request: Request, path: string): Headers => {
  const direct = directHeaders(request, path);
  if (Option.isSome(direct)) return direct.value;
  const bearerHeaders = credentialBearerHeaders(request, path);
  if (Option.isSome(bearerHeaders)) return bearerHeaders.value;
  if (browserForwardPath(path)) return browserForwardHeaders(request, path);
  return forwardsSession(request, path)
    ? new Headers({
        cookie: request.headers.get("cookie") ?? "",
        "content-type": request.headers.get("content-type") ?? "",
      })
    : request.headers;
};
const pairingSource = (
  request: Request,
  environment: PublicEnvironment
): Effect.Effect<string, void> =>
  Effect.gen(function* () {
    const visitor =
      request.headers.get("cf-connecting-ip") ??
      (environment.BROWSER_ORIGIN === browserOrigins.local ? "local-development" : "");
    if (visitor.length === 0 || environment.PAT_ADMISSION_KEY.length < minimumAdmissionKeyLength) {
      throw new Error("PAT admission unavailable");
    }
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(environment.PAT_ADMISSION_KEY),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        ),
      catch: () => undefined,
    });
    const signature = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(visitor)),
      catch: () => undefined,
    });
    return Encoding.encodeHex(new Uint8Array(signature));
  });
const coreRequest = (
  request: Request,
  environment: PublicEnvironment
): Effect.Effect<Request, void> =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname;
    const headers = forwardedHeaders(request, path);
    if (path === "/pat-pairings") {
      headers.set("x-pat-source", yield* pairingSource(request, environment));
    }
    return new Request(
      `https://core.internal${path}${transactionPath(path) || canonicalRoute(path) ? new URL(request.url).search : ""}`,
      {
        headers,
        method: request.method,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      }
    );
  });

const hasPreflight = (path: string): boolean =>
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
const requiresBrowserOrigin = (request: Request, path: string): boolean =>
  sessionPaths.has(path) ||
  enrollmentPath(path) ||
  (cookieAdmittedPath(path) && request.headers.has("cookie")) ||
  patBrowserRoute(path);

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

const routeOwnedRequest = (
  request: Request,
  environment: PublicEnvironment,
  origin: Option.Option<string>
): Promise<Response> => {
  const rejection = gateOwnedRequest(request, environment, origin);
  if (Option.isSome(rejection)) {
    return Promise.resolve(rejection.value);
  }
  return Effect.gen(function* () {
    const forwarded = yield* coreRequest(request, environment);
    return yield* Effect.tryPromise({
      try: (signal) => environment.CORE.fetch(forwarded, { signal }),
      catch: () => undefined,
    });
  }).pipe(
    Effect.match({ onFailure: unavailable, onSuccess: (response) => response }),
    Effect.map((response) => applyApiPolicy(response, environment.BROWSER_ORIGIN, origin)),
    Effect.runPromise
  );
};

const fetchEffect = (request: Request, environment: PublicEnvironment): Effect.Effect<Response> =>
  Effect.tryPromise({
    try: () => {
      const browserOrigin = resolveBrowserOrigin(environment.BROWSER_ORIGIN);
      if (Option.isNone(browserOrigin)) {
        return Promise.resolve(
          applyApiPolicy(unavailable(), browserOrigins.production, Option.none())
        );
      }

      const origin = Option.fromNullishOr(request.headers.get("origin"));
      if (Option.exists(origin, (value) => value !== browserOrigin.value)) {
        return Promise.resolve(applyApiPolicy(forbiddenOrigin(), browserOrigin.value, origin));
      }
      return routeOwnedRequest(
        request,
        { ...environment, BROWSER_ORIGIN: browserOrigin.value },
        origin
      );
    },
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: () => applyApiPolicy(unavailable(), browserOrigins.production, Option.none()),
      onSuccess: (response) => response,
    })
  );

/** Builds the internet-facing ingress with one telemetry service for each request Work span. */
export const makePublicWorker = (telemetry: TelemetryService): PublicWorker => ({
  fetch: (request, environment) =>
    fetchEffect(request, environment).pipe(
      observeWorkerRequest({
        environment,
        telemetry,
        operation: "worker.public.fetch",
      }),
      Effect.runPromise
    ),
});

/**
 * Internet-facing ingress for published API routes. Originless machine callers remain eligible;
 * browser requests and Categories preflight must use `BROWSER_ORIGIN`. Every response is no-store,
 * receives the API security projection, and is observed once. Unknown routes, methods, origins,
 * credentials, and Core failures produce bounded responses; accepted requests are delegated once.
 */
export default makePublicWorker(cloudflareWorkerTelemetry);
