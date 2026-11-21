import { AcceptanceProofUnavailable } from "./release-isolation/contract";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import core, { UserStore as ApplicationUserStore } from "./core-worker";
import { isPerformanceEvidence } from "./release-isolation/operations";
import { SharedStoreMarkers, isStorageCompatibility } from "./storage-bootstrap/contract";
import { SmokeIdentity } from "./runtime/release-smoke/contract";

export * from "./core-worker";

export class UserStore extends ApplicationUserStore {
  constructor(...[state, environment]: ConstructorParameters<typeof ApplicationUserStore>) {
    const { NATIVE_FIXTURE_SIGNING_KEY: _unused, ...ordinary } = environment;
    super(state, ordinary);
  }
}

const compatibility = Schema.Struct({ core: SmokeIdentity, markers: SharedStoreMarkers });

const fallbackRuntime = ManagedRuntime.make(Layer.empty);

export default {
  ...core,
  fetch: (request, environment, context): Promise<Response> =>
    fallbackRuntime.runPromise(
      Effect.gen(function* () {
        if (isPerformanceEvidence(request)) return new Response(null, { status: 404 });

        const response = yield* Effect.tryPromise({
          try: () => core.fetch(request, environment, context),
          catch: () => new AcceptanceProofUnavailable(),
        });

        if (!response.ok || !isStorageCompatibility(request)) return response;

        const evidence = yield* Schema.decodeUnknownEffect(compatibility)(
          yield* Effect.tryPromise({
            try: () => response.json(),
            catch: () => new AcceptanceProofUnavailable(),
          })
        );

        return Response.json(
          { ...evidence, fixtureFallbackCoreVersion: evidence.core.workerVersionId },
          { headers: { "cache-control": "no-store" } }
        );
      }).pipe(Effect.orElseSucceed(() => new Response(null, { status: 503 })))
    ),
} satisfies typeof core;
