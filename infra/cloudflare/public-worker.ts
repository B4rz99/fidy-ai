import { listCategoriesPath } from "@fidy/server/categories";
import { Effect } from "effect";

type PublicEnvironment = {
  readonly CORE: Pick<Fetcher, "fetch">;
  readonly LOCAL_CANONICAL_READ_BEARER: string;
};

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

const fetch = (request: Request, environment: PublicEnvironment): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname !== "/health" && url.pathname !== listCategoriesPath) {
    return Promise.resolve(Response.json({}, { status: 404 }));
  }
  if (request.method !== "GET") {
    return Promise.resolve(
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
      return Promise.resolve(unauthenticated());
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
  }).pipe(
    Effect.match({ onFailure: unavailable, onSuccess: (response) => response }),
    Effect.runPromise
  );
};

/** Internet-facing ingress that delegates only published routes to the private Core Worker. */
export default { fetch } satisfies ExportedHandler<PublicEnvironment>;
