import { Effect, Option, Redacted, Schema } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import { installedOrigins } from "@fidy/server/browser-transport";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import {
  SharedStoreMarkers,
  compatibilityQuery,
} from "../../apps/server/cloudflare/storage-bootstrap/contract";
import { admittedErasureLogins } from "./native-acceptance";
import { FallbackStage } from "./native-fallback-recovery";
import type { ReleaseSnapshot } from "./release-controller";
import { smokeHeaders } from "./smoke-exchange";
import { storageOwners } from "./storage-release";

type Coordinates = { revision: string; core: string; ingress: string; proof: string };
export const fallbackHeaders = (pair: Coordinates): Readonly<Record<string, string>> =>
  smokeHeaders({
    config: {
      SMOKE_PROOF: pair.proof,
      PUBLIC_WORKER_NAME: "fidy-native-storage-ingress",
      CORE_WORKER_NAME: "fidy-native-storage-core",
      CORE_VERSION_ID: pair.core,
    },
    publicVersion: Option.some(pair.ingress),
  });

/** Both independently compiled entrypoints must answer through the exact pinned candidate pair. */
export const observeDormantPair = Effect.fn(function* (
  client: HttpClient.HttpClient,
  pair: Coordinates,
  serving: boolean
) {
  const response = yield* client.execute(
    HttpClientRequest.get(
      installedOrigins.acceptance.api + "/internal/release-smoke" + compatibilityQuery,
      { headers: fallbackHeaders(pair) }
    )
  );
  const parsed = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      core: SmokeIdentity,
      fixtureFallbackCoreVersion: SmokeIdentity.fields.workerVersionId,
      markers: SharedStoreMarkers,
    })
  )(yield* response.json);
  const coreIdentity = [parsed.fixtureFallbackCoreVersion, parsed.core.workerVersionId];
  const ingressIdentity = [
    response.headers["x-fidy-fixture-fallback-ingress"],
    response.headers["x-fidy-smoke-worker-version"],
  ];
  const ok = 200;
  if (
    response.status !== ok ||
    !ingressIdentity.every((id) => id === pair.ingress) ||
    !coreIdentity.every((id) => id === pair.core) ||
    parsed.core.gitRevision !== pair.revision ||
    (serving && storageOwners.some((owner) => parsed.markers[owner].workerVersionId !== pair.core))
  ) {
    return yield* Effect.fail(
      Error("Dormant ingress, Core or serving owners differ from the attested pair")
    );
  }
});

export const controlsDigest = Effect.fn(function* (
  pair: Coordinates,
  send: Parameters<typeof admittedErasureLogins>[0]["send"]
) {
  const route = fallbackHeaders(pair);
  const ids = yield* admittedErasureLogins({
    revision: pair.revision,
    origins: installedOrigins.acceptance,
    proof: Redacted.make(pair.proof),
    send: (request) => {
      for (const [name, value] of Object.entries(route)) request.headers.set(name, value);
      return send(request);
    },
  }).logins();
  if (ids.length !== 2 || new Set(ids).size !== 2) {
    return yield* Effect.fail(Error("Original controls are not distinct"));
  }
  return new Bun.CryptoHasher("sha256").update(ids.toSorted().join("\n")).digest("hex");
});

/** Source artifact 14571027939 identifies the exact proven installation before its one-way repair. */
export const requireOriginalFallbackSource = (source: ReleaseSnapshot): void => {
  if (
    source.stableRevision !== "8dd3b0d47d655868c1ab4f16b6145a06d99bd721" ||
    source.core.stableVersionId !== "0b77e855-8813-4ff6-972f-63d2cc389b80" ||
    source.core.deploymentId !== "e89e4e83-045e-4a7a-aadf-26a9f6bba230" ||
    source.public.stableVersionId !== "d0058241-f258-4708-805c-ecba0cdd5d7c" ||
    source.public.deploymentId !== "769a52c1-9f26-4e51-97d4-de87ba999566"
  ) {
    throw Error("Original unsigned stable pair changed");
  }
};

export const fallbackNamespaces = (ids: readonly string[]): FallbackStage["namespaces"] =>
  Schema.decodeUnknownSync(FallbackStage.fields.namespaces)(
    Object.fromEntries(storageOwners.map((owner, index) => [owner, ids[index]]))
  );
