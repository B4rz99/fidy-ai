import { listCategoriesPath } from "@fidy/server/categories";
import type { TelemetryService } from "@fidy/server/telemetry";
import { Effect } from "effect";
import {
  type WorkerTelemetryEnvironment,
  cloudflareWorkerTelemetry,
  observeWorkerRequest,
} from "./telemetry";

type PublicEnvironment = WorkerTelemetryEnvironment & {
  readonly CORE: Pick<Fetcher, "fetch">;
  readonly LOCAL_CANONICAL_READ_BEARER: string;
};

type PublicWorker = Readonly<{
  fetch: (request: Request, environment: PublicEnvironment) => Promise<Response>;
}>;

const unauthenticated = (): Response =>
  Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    {
      headers: { "cache-control": "no-store", "www-authenticate": "Bearer" },
      status: 401,
    }
  );

const unavailable = (): Response =>
  Response.json(
    { status: "unavailable" },
    {
      headers: { "cache-control": "no-store" },
      status: 503,
    }
  );

const fetchEffect = (request: Request, environment: PublicEnvironment): Effect.Effect<Response> => {
  const url = new URL(request.url);
  if (url.pathname !== "/health" && url.pathname !== listCategoriesPath) {
    return Effect.succeed(Response.json({}, { status: 404 }));
  }
  if (request.method !== "GET") {
    return Effect.succeed(
      Response.json(
        { status: "method_not_allowed" },
        { headers: { allow: "GET", "cache-control": "no-store" }, status: 405 }
      )
    );
  }
  if (url.pathname === listCategoriesPath) {
    const authorization = request.headers.get("authorization");
    if (
      environment.LOCAL_CANONICAL_READ_BEARER.length === 0 ||
      authorization !== `Bearer ${environment.LOCAL_CANONICAL_READ_BEARER}`
    ) {
      return Effect.succeed(unauthenticated());
    }
  }

  return Effect.tryPromise({
    try: (signal) =>
      environment.CORE.fetch(
        new Request(`https://core.internal${url.pathname}`, {
          headers: request.headers,
          method: "GET",
          signal,
        })
      ),
    catch: () => undefined,
  }).pipe(Effect.match({ onFailure: unavailable, onSuccess: (response) => response }));
};

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

/** Internet-facing ingress that delegates only published routes to the private Core Worker. */
export default makePublicWorker(cloudflareWorkerTelemetry);
