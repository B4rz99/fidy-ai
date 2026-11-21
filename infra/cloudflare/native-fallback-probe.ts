import { ReleaseFailure, releaseFailureFrom } from "./production-release";
import { Clock, Effect, Option, Redacted, Schema, Stream } from "effect";
import { type HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { installedOrigins } from "@fidy/server/browser-transport";
import { signAcceptanceRequest } from "../../apps/server/cloudflare/release-isolation/operations";
import {
  acceptanceLifetimeMs,
  acceptanceProofHeader,
} from "../../apps/server/cloudflare/release-isolation/contract";
import {
  SmokeIdentity,
  smokeProofHeader,
} from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import {
  SharedStoreMarkers,
  compatibilityQuery,
} from "../../apps/server/cloudflare/storage-bootstrap/contract";
import { retainedFinancialControls } from "./native-acceptance";
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

const ok = 200,
  clientError = 400;

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

  if (response.status !== ok) {
    return yield* new ReleaseFailure({
      message: "Dormant marker request returned HTTP " + response.status,
    });
  }

  const parsed = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      core: SmokeIdentity,
      fixtureFallbackCoreVersion: SmokeIdentity.fields.workerVersionId,
      markers: SharedStoreMarkers,
    })
  )(yield* response.json).pipe(
    Effect.mapError(releaseFailureFrom("Dormant Core marker document is incomplete"))
  );

  if (
    !["x-fidy-fixture-fallback-ingress", "x-fidy-smoke-worker-version"].every(
      (name) => response.headers[name] === pair.ingress
    )
  ) {
    return yield* new ReleaseFailure({
      message: "Dormant Ingress marker identifies a different version",
    });
  }

  if (
    parsed.fixtureFallbackCoreVersion !== pair.core ||
    parsed.core.workerVersionId !== pair.core ||
    parsed.core.gitRevision !== pair.revision
  ) {
    return yield* new ReleaseFailure({
      message: "Dormant Core marker identifies a different version or revision",
    });
  }

  if (
    serving &&
    storageOwners.some((owner) => parsed.markers[owner].workerVersionId !== pair.core)
  ) {
    return yield* new ReleaseFailure({
      message: "A serving Durable Object marker identifies a different version",
    });
  }
});

const serviceUnavailableStatus = 503;

const controlRequests = new Map([
  ["/web/pairings", "pairing start"],
  ["/web/providers/google/start", "provider start"],
  ["/providers/google/callback", "provider callback"],
  ["/web/providers/google/status", "provider status"],
  ["/web/providers/google/complete", "provider completion"],
  ["/web/pairings/redeem", "pairing redemption"],
  ["/web/session/binding", "session binding"],
  ["/transactions", "transaction history"],
]);

const canonicalUnavailable = new TextEncoder().encode(
  JSON.stringify({
    error: { code: "unavailable", message: "The operation is unavailable. Retry later." },
    next: [],
  })
);

const matchesCanonicalUnavailable = Effect.fn(function* (response: Response) {
  const internal = HttpClientResponse.fromWeb(
    HttpClientRequest.get(installedOrigins.acceptance.api),
    response
  );

  let offset = 0;

  const matchesSegment = (chunk: Uint8Array): boolean =>
    chunk.length <= canonicalUnavailable.length - offset &&
    chunk.every((value, index) => value === canonicalUnavailable[offset + index]);

  const read = yield* internal.stream.pipe(
    Stream.runForEachWhile((chunk) =>
      Effect.sync(() => {
        if (!matchesSegment(chunk)) {
          offset = -1;

          return false;
        }

        offset += chunk.length;

        return true;
      })
    ),
    Effect.timeoutOption("2 seconds"),
    Effect.tapError((error) =>
      Effect.logWarning("Canonical unavailable body was unreadable", { reason: error._tag })
    ),
    Effect.orElseSucceed(() => Option.none())
  );

  return Option.isSome(read) && offset === canonicalUnavailable.length;
});

export const observePairingStart = Effect.fn(function* (
  pair: Coordinates,
  body: "json" | "empty",
  send: Parameters<typeof retainedFinancialControls>[0]["send"]
) {
  const { api, browser } = installedOrigins.acceptance;

  const request = new Request(api + "/web/pairings", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: browser, ...fallbackHeaders(pair) },
    body: body === "json" ? "{}" : null,
  });

  const signature = yield* signAcceptanceRequest({
    request,
    boundary: "ingress",
    deadline: (yield* Clock.currentTimeMillis) + acceptanceLifetimeMs,
    environment: {
      BROWSER_ORIGIN: browser,
      RECOVERY_ISOLATION: "isolated",
      NATIVE_STORAGE_ADMISSION: "closed",
      RELEASE_GIT_SHA: pair.revision,
      SMOKE_PROOF: pair.proof,
    },
  });

  request.headers.set(acceptanceProofHeader, signature);
  const response = yield* send(request);
  const status = "HTTP " + response.status;

  if (
    response.status === serviceUnavailableStatus &&
    (yield* matchesCanonicalUnavailable(response))
  ) {
    return status + ", canonical admission unavailable";
  }

  const stream = response.body;

  if (stream !== null && !response.bodyUsed) yield* Effect.tryPromise(() => stream.cancel());

  return response.headers.get("x-fidy-recovery-isolation") === "isolated"
    ? status + ", isolated admission"
    : status;
});

const isIsolationResponse = (request: Request, response: Response): boolean =>
  response.status === serviceUnavailableStatus &&
  request.method === "GET" &&
  request.url === installedOrigins.acceptance.api + "/transactions" &&
  !request.headers.has(acceptanceProofHeader);

const controlResponse = Effect.fn(function* (request: Request, response: Response) {
  if (response.status < clientError || isIsolationResponse(request, response)) return response;
  const operation = controlRequests.get(new URL(request.url).pathname) ?? "control identity";

  const error =
    operation === "pairing start" &&
    response.status === serviceUnavailableStatus &&
    (yield* matchesCanonicalUnavailable(response))
      ? ", canonical admission unavailable"
      : "";

  const isolation =
    response.headers.get("x-fidy-recovery-isolation") === "isolated" ? ", isolated admission" : "";

  return yield* new ReleaseFailure({
    message:
      "Retained control refused at " + operation + ", HTTP " + response.status + error + isolation,
  });
});

export const controlsDigest = Effect.fn(function* (
  pair: Coordinates,
  send: Parameters<typeof retainedFinancialControls>[0]["send"],
  routing: "ordinary" | "pinned" = "pinned"
) {
  const route = routing === "ordinary" ? { [smokeProofHeader]: pair.proof } : fallbackHeaders(pair);

  const controls = yield* retainedFinancialControls({
    revision: pair.revision,
    origins: installedOrigins.acceptance,
    proof: Redacted.make(pair.proof),
    send: (request) => {
      for (const [name, value] of Object.entries(route)) request.headers.set(name, value);

      return send(request).pipe(Effect.flatMap((response) => controlResponse(request, response)));
    },
  });

  if (controls.length !== 2 || new Set(controls.map((control) => control.id)).size !== 2) {
    return yield* Effect.fail(Error("Original controls are not distinct"));
  }

  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({ id: Schema.String, historyDigest: SmokeIdentity.fields.contractDigest })
      )
    )
  )(controls);

  return new Bun.CryptoHasher("sha256").update(encoded).digest("hex");
});

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
