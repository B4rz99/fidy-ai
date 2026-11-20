import { Schema } from "effect";
import core, { UserStore as ApplicationUserStore } from "./core-worker";
import { isPerformanceReceipt } from "./release-isolation/operations";
import { SharedStoreMarkers, isStorageCompatibility } from "./storage-bootstrap/contract";
import { SmokeIdentity } from "./runtime/release-smoke/contract";

export * from "./core-worker";

/** The return target runs the ordinary application without giving its UserStore the receipt key. */
export class UserStore extends ApplicationUserStore {
  constructor(...[state, environment]: ConstructorParameters<typeof ApplicationUserStore>) {
    const { NATIVE_FIXTURE_SIGNING_KEY: _unused, ...ordinary } = environment;
    super(state, ordinary);
  }
}

const compatibility = Schema.Struct({ core: SmokeIdentity, markers: SharedStoreMarkers });
export default {
  ...core,
  async fetch(request, environment, context): Promise<Response> {
    if (isPerformanceReceipt(request)) return new Response(null, { status: 404 });
    const response = await core.fetch(request, environment, context);
    if (!response.ok || !isStorageCompatibility(request)) return response;
    const evidence = Schema.decodeUnknownSync(compatibility)(await response.json());
    return Response.json(
      { ...evidence, fixtureFallbackCoreVersion: evidence.core.workerVersionId },
      { headers: { "cache-control": "no-store" } }
    );
  },
} satisfies typeof core;
