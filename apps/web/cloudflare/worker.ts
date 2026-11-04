import { FidyApi, HostedTurnApi, SubscriptionEnrollmentApi, WebAuthApi } from "@fidy/server/client";
import { HttpApi, type HttpApiGroup } from "effect/http-api";
import { BrowserSessionBinding } from "@fidy/server/browser-bootstrap";
import {
  browserSessionBindingHeader,
  browserSessionBindingPath,
} from "@fidy/server/browser-transport";
import { Effect, Option, Schema } from "effect";

type Environment = Readonly<{
  ASSETS: Readonly<{ fetch: (request: Request) => Promise<Response> }>;
  API: Readonly<{ fetch: (request: Request) => Promise<Response> }>;
  BROWSER_ORIGIN: string;
}>;
const unavailable = (): Response =>
  new Response("No pudimos cargar tu tablero. Reintenta la carga.", {
    status: 503,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
const successfulStatus = 200;
const missingStatus = 404;
const applicationDocuments = new Set([
  "/",
  "/app",
  "/login",
  "/upgrade",
  "/connections/continue",
  "/connections/result",
]);
const applicationPrefixes = [
  "/app/",
  "/settings/",
  "/connect/",
  "/oauth/review/",
  "/auth/",
  "/assets/",
];
const isApplication = (path: string): boolean =>
  applicationDocuments.has(path) ||
  applicationPrefixes.some((prefix) => path.startsWith(prefix)) ||
  path.includes(".");
// Reflect the same public contracts used by the browser. No private routes or arbitrary
// destinations acquire app-host cookies merely because they share a path prefix.
const publicRoutes: Array<Readonly<{ method: string; segments: ReadonlyArray<string> }>> = [];
const addPublicRoutes = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>
): void => {
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      publicRoutes.push({ method: endpoint.method, segments: endpoint.path.split("/") });
    },
  });
};
addPublicRoutes(FidyApi);
addPublicRoutes(WebAuthApi);
addPublicRoutes(HostedTurnApi);
addPublicRoutes(SubscriptionEnrollmentApi);
const isPublicRequest = (request: Request, path: string): boolean => {
  const segments = path.split("/");
  return publicRoutes.some(
    (route) =>
      route.method === request.method &&
      route.segments.length === segments.length &&
      route.segments.every((part, index) =>
        part.startsWith(":") ? segments[index] !== "" : part === segments[index]
      )
  );
};
const apiRequest = (request: Request, path: string, origin: string): Request => {
  const target = new URL("https://api.fidyapp.com");
  const incoming = new URL(request.url);
  target.pathname = path;
  target.search = path === incoming.pathname ? incoming.search : "";
  const headers = new Headers(request.headers);
  for (const name of ["host", "forwarded", "x-forwarded-host", "x-forwarded-proto"]) {
    headers.delete(name);
  }
  if (!headers.has("origin")) headers.set("origin", origin);
  return new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    signal: request.signal,
  });
};
const initialMarkup = (status: number, html: string): string => {
  if (status === successfulStatus) return html;
  if (status === missingStatus) {
    return '<main data-dashboard-uninitialized><h1>Tu tablero</h1><p>Crea tu tablero para empezar.</p><button type="button" data-dashboard-initialize>Crear tablero</button></main>';
  }
  return '<main role="alert"><h1>No pudimos cargar tu tablero</h1><button type="button" data-dashboard-retry>Reintentar carga del tablero</button></main>';
};
const maximumPrivateBytes = 1_048_576;
const readFinancialBody = Effect.fnUntraced(function* (
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = yield* Effect.tryPromise(() => reader.read());
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximumPrivateBytes) return yield* Effect.fail(undefined);
    parts.push(decoder.decode(chunk.value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
});
const cancelBody = (reader: ReadableStreamDefaultReader<Uint8Array>): Effect.Effect<void> =>
  Effect.tryPromise(() => reader.cancel()).pipe(Effect.ignore);
const financialContent = Effect.fnUntraced(function* (response: Response) {
  if (!response.ok) return "";
  if (response.headers.get("content-type")?.startsWith("text/html") !== true) {
    return yield* Effect.fail(undefined);
  }
  const body = Option.fromNullishOr(response.body);
  if (Option.isNone(body)) return yield* Effect.fail(undefined);
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => body.value.getReader()),
    readFinancialBody,
    cancelBody
  );
});
const directDashboard = Effect.fnUntraced(function* (request: Request, environment: Environment) {
  const headers = new Headers(request.headers);
  headers.delete(browserSessionBindingHeader);
  headers.delete("authorization");
  const mountedRequest = new Request(request, { headers });
  const bootstrap = apiRequest(
    mountedRequest,
    browserSessionBindingPath,
    environment.BROWSER_ORIGIN
  );
  const bindingResponse = yield* Effect.tryPromise(() => environment.API.fetch(bootstrap));
  if (!bindingResponse.ok) return unavailable();
  const binding = yield* Schema.decodeUnknownEffect(BrowserSessionBinding)(
    yield* Effect.tryPromise(() => bindingResponse.json())
  );
  const session = Option.fromNullishOr(binding.binding);
  if (Option.isNone(session)) {
    return yield* Effect.tryPromise(() => environment.ASSETS.fetch(request));
  }
  const query = apiRequest(mountedRequest, "/dashboard/view", environment.BROWSER_ORIGIN);
  query.headers.set(browserSessionBindingHeader, session.value);
  query.headers.set("accept", "text/html");
  const financial = yield* Effect.tryPromise(() => environment.API.fetch(query));
  const content = yield* financialContent(financial);
  const asset = yield* Effect.tryPromise(() => environment.ASSETS.fetch(request));
  const document = yield* Effect.tryPromise(() => asset.text());
  const markup = `<div id="dashboard-initial" data-binding="${session.value}" data-status="${financial.status}">${initialMarkup(financial.status, content)}</div>`;
  if (!document.includes('<div id="root"></div>')) return unavailable();
  const output = document.replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
  const resultHeaders = new Headers(asset.headers);
  for (const name of ["content-length", "etag", "last-modified", "content-encoding"]) {
    resultHeaders.delete(name);
  }
  resultHeaders.set("fidy-dashboard-status", String(financial.status));
  resultHeaders.set("cache-control", "no-store");
  resultHeaders.set("content-type", "text/html; charset=utf-8");
  return new Response(output, { headers: resultHeaders });
});
export default {
  fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== environment.BROWSER_ORIGIN) {
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    if (
      request.method === "GET" &&
      url.pathname === "/app/dashboard" &&
      url.searchParams.get("customize") !== "1"
    ) {
      return Effect.runPromise(
        directDashboard(request, environment).pipe(Effect.orElseSucceed(unavailable))
      );
    }
    if (isApplication(url.pathname)) return environment.ASSETS.fetch(request);
    if (!isPublicRequest(request, url.pathname)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return environment.API.fetch(apiRequest(request, url.pathname, environment.BROWSER_ORIGIN));
  },
};
