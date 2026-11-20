import { Effect } from "effect";
import ingress from "./public-worker";
import { isPerformanceReceipt } from "./release-isolation/operations";
import { isStorageCompatibility } from "./storage-bootstrap/contract";

export default {
  fetch: (request, environment): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (isPerformanceReceipt(request)) return new Response(null, { status: 404 });
        const response = yield* Effect.tryPromise({
          try: () => ingress.fetch(request, environment),
          catch: () => Error("Recovery Ingress unavailable"),
        });
        if (!response.ok || !isStorageCompatibility(request)) return response;
        const headers = new Headers(response.headers);
        headers.set("x-fidy-fixture-fallback-ingress", environment.CF_VERSION_METADATA?.id ?? "");
        return new Response(response.body, { status: response.status, headers });
      })
    ),
} satisfies typeof ingress;
