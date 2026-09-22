import * as D1Client from "@effect/sql-d1/D1Client";
import {
  categoryUnavailable,
  listCategoriesPath,
  listCategoriesResponse,
} from "@fidy/server/categories";
import { Effect, Exit, Schema } from "effect";
import { contractDigestPattern, gitRevisionPattern } from "./release-identity";

const ReleaseConfiguration = Schema.Struct({
  CONTRACT_DIGEST: Schema.String.check(Schema.isPattern(contractDigestPattern)),
  RELEASE_GIT_SHA: Schema.String.check(Schema.isPattern(gitRevisionPattern)),
});

type CoreEnvironment = typeof ReleaseConfiguration.Type & {
  readonly DB: D1Database;
};

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

const categoriesResponse = (environment: CoreEnvironment): Promise<Response> =>
  listCategoriesResponse.pipe(
    // Effect SQL span attributes contain query text, which must not enter exported telemetry.
    Effect.withTracerEnabled(false),
    // The Worker request boundary owns the scoped D1 client lifetime.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(D1Client.layer({ db: environment.DB })),
    Effect.mapError(categoryUnavailable),
    Effect.withSpan("categories.listCategories"),
    Effect.match({
      onFailure: (failure) =>
        jsonResponse(
          JSON.stringify({ error: failure.error, next: failure.next }),
          HTTP_SERVICE_UNAVAILABLE
        ),
      onSuccess: (response) => jsonResponse(JSON.stringify(response), HTTP_OK),
    }),
    Effect.runPromise
  );

const fetch = (request: Request, environment: CoreEnvironment): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname !== "/health" && url.pathname !== listCategoriesPath) {
    return Promise.resolve(jsonResponse('{"status":"not_found"}', HTTP_NOT_FOUND));
  }
  if (request.method !== "GET") return Promise.resolve(methodNotAllowed());

  const configuration = Schema.decodeExit(ReleaseConfiguration)(environment);
  if (Exit.isFailure(configuration)) return Promise.resolve(unavailable());

  if (url.pathname === listCategoriesPath) return categoriesResponse(environment);

  return Promise.resolve(
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

/** Private service-binding target for canonical execution and bounded topology health evidence. */
export default { fetch } satisfies ExportedHandler<CoreEnvironment>;
