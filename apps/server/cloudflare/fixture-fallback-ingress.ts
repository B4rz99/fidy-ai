import { AcceptanceProofUnavailable } from "./release-isolation/contract";
import { Effect, Layer, ManagedRuntime } from "effect";
import ingress from "./public-worker";
import { isPerformanceEvidence } from "./release-isolation/operations";
import { isStorageCompatibility } from "./storage-bootstrap/contract";

export * from "./public-worker";

const fallbackRuntime = ManagedRuntime.make(Layer.empty);

export default {
  fetch: (request, environment): Promise<Response> =>
    fallbackRuntime.runPromise(
      Effect.gen(function* () {
        if (isPerformanceEvidence(request)) return new Response(null, { status: 404 });

        const response = yield* Effect.tryPromise({
          try: () => ingress.fetch(request, environment),
          catch: () => new AcceptanceProofUnavailable(),
        });

        if (!response.ok || !isStorageCompatibility(request)) return response;
        const headers = new Headers(response.headers);
        headers.set("x-fidy-fixture-fallback-ingress", environment.CF_VERSION_METADATA?.id ?? "");

        return new Response(response.body, { status: response.status, headers });
      }).pipe(
        Effect.tapError(() =>
          Effect.logWarning({
            component: "release-isolation",
            operation: "fixtureFallbackIngress",
            outcome: "unavailable",
          })
        ),
        Effect.orElseSucceed(() => new Response(null, { status: 503 }))
      )
    ),
} satisfies typeof ingress;
