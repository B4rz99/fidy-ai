import { listCategoriesPath } from "@fidy/server/categories-path";
import type { TelemetryService } from "@fidy/server/telemetry";
import { Effect, Option } from "effect";
import {
  type WorkerTelemetryEnvironment,
  cloudflareWorkerTelemetry,
  observeWorkerRequest,
} from "./telemetry";
import { browserOrigins } from "./topology";

type PublicEnvironment = WorkerTelemetryEnvironment & {
  readonly BROWSER_ORIGIN: string;
  readonly CORE: Pick<Fetcher, "fetch">;
  readonly LOCAL_CANONICAL_READ_BEARER: string;
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
  const method = allowedMethod(new URL(request.url).pathname);
  if (!Option.contains(requestedMethod, method) || !isAllowedPreflightHeaders(requestedHeaders)) {
    return forbiddenOrigin();
  }

  const headers = new Headers({
    "access-control-allow-headers": Option.match(requestedHeaders, {
      onNone: () => "",
      onSome: (value) => value.toLowerCase(),
    }),
    "access-control-allow-methods": method,
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
    environment.LOCAL_CANONICAL_READ_BEARER.length > 0 &&
    request.headers.get("authorization") === `Bearer ${environment.LOCAL_CANONICAL_READ_BEARER}`
  ) {
    return Option.none();
  }
  return Option.some(unauthenticated());
};

const callbackPath = "/providers/kapso/callback";
const verificationPath = "/web/onboarding/email/verify";
const pairingPaths = ["/web/pairings", "/web/pairings/redeem", "/web/session/logout"] as const;
const userPath = "/user";
const rotateRecoveryPath = "/recovery/backup-code/rotate";
const supportRecoveryPath = "/internal/support-recovery";
const emailAuthenticationPaths = [
  "/web/email/authentication/start",
  "/web/email/authentication/complete",
] as const;
const postPaths = new Set<string>([
  callbackPath,
  verificationPath,
  rotateRecoveryPath,
  supportRecoveryPath,
  ...emailAuthenticationPaths,
  ...pairingPaths,
]);
const browserMutationPaths = new Set<string>([
  rotateRecoveryPath,
  ...emailAuthenticationPaths,
  ...pairingPaths,
]);
const sessionPaths = new Set<string>([userPath, ...browserMutationPaths]);
const preflightPaths = new Set<string>([
  listCategoriesPath,
  verificationPath,
  userPath,
  ...browserMutationPaths,
]);
const ownedPaths = new Set<string>(["/health", listCategoriesPath, userPath, ...postPaths]);
const ownedPath = (path: string): boolean => ownedPaths.has(path);
const allowedMethod = (path: string): "GET" | "POST" => (postPaths.has(path) ? "POST" : "GET");
const callbackHeaders = (request: Request): Headers =>
  new Headers([
    ["x-webhook-signature", request.headers.get("x-webhook-signature") ?? ""],
    ["x-webhook-event", request.headers.get("x-webhook-event") ?? ""],
    ["x-idempotency-key", request.headers.get("x-idempotency-key") ?? ""],
  ]);
const browserHeaders = (request: Request, path: string): Headers => {
  const headers = new Headers({ "content-type": request.headers.get("content-type") ?? "" });
  if (path === "/web/session/logout" || path === rotateRecoveryPath) {
    headers.set("cookie", request.headers.get("cookie") ?? "");
  }
  return headers;
};
const supportHeaders = (request: Request): Headers =>
  new Headers({
    "content-type": request.headers.get("content-type") ?? "",
    "cf-access-jwt-assertion": request.headers.get("cf-access-jwt-assertion") ?? "",
  });
const forwardedHeaders = (request: Request, path: string): Headers => {
  if (path === callbackPath) return callbackHeaders(request);
  if (path === supportRecoveryPath) return supportHeaders(request);
  if (path === verificationPath || isBrowserMutation(path)) return browserHeaders(request, path);
  return path === userPath
    ? new Headers({ cookie: request.headers.get("cookie") ?? "" })
    : request.headers;
};
const coreRequest = (request: Request, signal: AbortSignal): Request => {
  const path = new URL(request.url).pathname;
  return new Request(`https://core.internal${path}`, {
    headers: forwardedHeaders(request, path),
    method: allowedMethod(path),
    body: allowedMethod(path) === "POST" ? request.body : undefined,
    signal,
  });
};

const hasPreflight = (path: string): boolean => preflightPaths.has(path);
const isBrowserMutation = (path: string): boolean => browserMutationPaths.has(path);

const isPreflight = (request: Request, path: string, origin: Option.Option<string>): boolean =>
  request.method === "OPTIONS" && hasPreflight(path) && Option.isSome(origin);

const disallowedSupportOrigin = (path: string, origin: Option.Option<string>): boolean =>
  path === supportRecoveryPath && Option.isSome(origin);

const routeOwnedRequest = (
  request: Request,
  environment: PublicEnvironment,
  origin: Option.Option<string>
): Promise<Response> => {
  const url = new URL(request.url);
  if (!ownedPath(url.pathname)) {
    return Promise.resolve(
      applyApiPolicy(Response.json({}, { status: 404 }), environment.BROWSER_ORIGIN, origin)
    );
  }
  if (disallowedSupportOrigin(url.pathname, origin)) {
    return Promise.resolve(
      applyApiPolicy(forbiddenOrigin(), environment.BROWSER_ORIGIN, Option.none())
    );
  }
  if (isPreflight(request, url.pathname, origin)) {
    return Promise.resolve(preflightResponse(request, environment.BROWSER_ORIGIN));
  }
  if (request.method !== allowedMethod(url.pathname)) {
    return Promise.resolve(
      applyApiPolicy(
        Response.json(
          { status: "method_not_allowed" },
          { headers: { allow: allowedMethod(url.pathname) }, status: 405 }
        ),
        environment.BROWSER_ORIGIN,
        origin
      )
    );
  }
  if (sessionPaths.has(url.pathname) && !Option.contains(origin, environment.BROWSER_ORIGIN)) {
    return Promise.resolve(applyApiPolicy(forbiddenOrigin(), environment.BROWSER_ORIGIN, origin));
  }
  const authorizationFailure = categoryAuthorizationFailure(request, environment);
  if (Option.isSome(authorizationFailure)) {
    return Promise.resolve(
      applyApiPolicy(authorizationFailure.value, environment.BROWSER_ORIGIN, origin)
    );
  }

  return Effect.tryPromise({
    try: (signal) => environment.CORE.fetch(coreRequest(request, signal)),
    catch: () => undefined,
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
