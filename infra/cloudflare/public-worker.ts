import { Effect } from "effect";

type PublicEnvironment = {
  readonly CORE: Pick<Fetcher, "fetch">;
};

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
  if (url.pathname !== "/health") return Promise.resolve(Response.json({}, { status: 404 }));
  if (request.method !== "GET") {
    return Promise.resolve(
      Response.json(
        { status: "method_not_allowed" },
        { headers: { allow: "GET", "cache-control": "no-store" }, status: 405 }
      )
    );
  }

  return Effect.tryPromise({
    try: (signal) =>
      environment.CORE.fetch(
        new Request("https://core.internal/health", {
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

/** Internet-facing ingress that delegates the public health route to the private Core Worker. */
export default { fetch } satisfies ExportedHandler<PublicEnvironment>;
